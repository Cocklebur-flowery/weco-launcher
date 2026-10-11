import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { inventoryClient } from '../src/catalog.ts';
import { assertOutputOutside, buildRelease, writePublication, compareReleases } from '../src/publisher.ts';
import { initializeWorkspace, digest, readInstalled } from '../src/workspace.ts';
import { installRelease } from '../src/updater.ts';
import { verifyEnvelope } from '../src/release.ts';

const [input, destination] = process.argv.slice(2);
if (!input || !destination || process.argv.length !== 4) throw new Error('Usage: test:release CLIENT_ROOT NEW_EVIDENCE_DIRECTORY');
await assertOutputOutside(input, path.join(destination, 'report.json'));
await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true }); await fs.mkdir(destination);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'town-real-release-'));
const routes = new Map(); const requests = [];
const server = createServer((req, res) => {
  const file = routes.get(req.url);
  if (!file) { res.writeHead(404); res.end(); return; }
  requests.push({ url: req.url, size: file.size }); res.writeHead(200, { 'Content-Length': file.size });
  const stream = createReadStream(file.absolute); stream.on('error', () => res.destroy()); stream.pipe(res);
});
let result;
try {
  const before = await inventoryClient(input);
  const selected = before.files.filter(f => f.category === 'mod' ||
    ['resourcepacks/townroads-p1.zip', 'config/seamlesschunks.properties', 'config/neoforge-client.toml'].includes(f.path));
  assert.ok(selected.some(f => f.category === 'mod'), 'Actual Mod JAR input required');
  const editedPath = 'config/seamlesschunks.properties'; const defaultPath = 'config/neoforge-client.toml';
  assert.ok(selected.some(f => f.path === editedPath) && selected.some(f => f.path === defaultPath), 'Reviewed fixture configurations required');
  const sourceB = path.join(temporary, 'source-b'); await fs.mkdir(sourceB);
  for (const file of selected) {
    const target = path.join(sourceB, file.path); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(input, file.path), target, 1);
    routes.set('/file/' + file.sha256, { absolute: path.join(input, file.path), size: file.size });
  }
  const config = await fs.readFile(path.join(sourceB, editedPath), 'utf8');
  assert.match(config, /^hideHighSpecNotice=false\r?$/m);
  await fs.writeFile(path.join(sourceB, editedPath), config.replace(/^hideHighSpecNotice=false(?=\r?$)/m, 'hideHighSpecNotice=true'));
  const afterSource = await inventoryClient(sourceB);
  for (const file of afterSource.files) routes.set('/file/' + file.sha256, { absolute: path.join(sourceB, file.path), size: file.size });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const plan = (id, files) => ({ schemaVersion: 1, releaseId: id, platforms: [process.platform + '-' + process.arch],
    files: files.map(f => ({ path: f.path, sha256: f.sha256, policy: f.path === defaultPath ? 'default' : 'managed',
      reviewed: true, source: { kind: 'local-test', urls: [base + '/file/' + f.sha256] } })) });
  const builtA = await buildRelease(input, plan('local-a', selected), { localTest: true });
  const builtB = await buildRelease(sourceB, plan('local-b', afterSource.files), { localTest: true });
  const { privateKey } = generateKeyPairSync('ed25519'); const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signedA = await writePublication(path.join(destination, 'local-a'), builtA, pem);
  const signedB = await writePublication(path.join(destination, 'local-b'), builtB, pem);
  const keys = { [signedA.envelope.keyId]: signedA.publicKey };
  const a = verifyEnvelope(signedA.envelope, keys, true); const b = verifyEnvelope(signedB.envelope, keys, true);
  const diff = compareReleases(a, b); assert.deepEqual(diff.changed, [editedPath]);
  assert.equal(diff.added.length + diff.removed.length, 0);
  const root = await initializeWorkspace(path.join(temporary, 'workspace'));
  for (const relative of ['options.txt', 'saves/keep.txt', 'town-chunk-cache/keep.txt', '.town_mcp/keep.txt']) {
    const target = path.join(root, 'game', relative); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'player-owned marker');
  }
  await installRelease(root, a, { allowLoopback: true });
  const countA = requests.length; assert.equal(countA, new Set(a.files.map(f => f.sha256)).size);
  const defaultFile = path.join(root, 'game', defaultPath);
  const playerConfig = (await fs.readFile(defaultFile, 'utf8')) + '\n# player-owned setting\n';
  await fs.writeFile(defaultFile, playerConfig);
  await installRelease(root, b, { allowLoopback: true });
  const countB = requests.length - countA; assert.equal(countB, 1);
  for (const file of b.files.filter(f => f.policy === 'managed')) assert.equal(await digest(path.join(root, 'game', file.path)), file.sha256);
  assert.equal(await fs.readFile(defaultFile, 'utf8'), playerConfig);
  for (const relative of ['options.txt', 'saves/keep.txt', 'town-chunk-cache/keep.txt', '.town_mcp/keep.txt'])
    assert.equal(await fs.readFile(path.join(root, 'game', relative), 'utf8'), 'player-owned marker');
  const beforeRepeat = requests.length; await installRelease(root, b, { allowLoopback: true });
  assert.equal(requests.length, beforeRepeat);
  await assert.rejects(installRelease(root, a, { allowLoopback: true, faultAfter: 1 }), /Injected/);
  assert.equal((await readInstalled(root)).releaseId, 'local-b');
  assert.equal(await digest(path.join(root, 'game', editedPath)), b.files.find(f => f.path === editedPath).sha256);
  assert.deepEqual((await inventoryClient(input)).files, before.files);
  result = { result: 'PASS', mods: selected.filter(f => f.category === 'mod').length, files: a.files.length,
    diff, cold: { requests: countA, bytes: requests.slice(0, countA).reduce((sum, r) => sum + r.size, 0) },
    update: { requests: countB, bytes: requests.slice(countA, countA + countB).reduce((sum, r) => sum + r.size, 0) },
    repeatedUpdateRequests: 0, defaultConfigPreserved: true, playerFilesPreserved: true, rollback: 'PASS',
    originalSourceUnchanged: true, transport: 'loopback-only', privateSigningKeySaved: false, gameplay: 'NOT RUN', requests };
} catch (e) {
  result = { result: 'FAIL', error: e instanceof Error ? e.message : String(e), requests }; process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  await fs.rm(temporary, { recursive: true });
  await fs.writeFile(path.join(destination, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result));
}
