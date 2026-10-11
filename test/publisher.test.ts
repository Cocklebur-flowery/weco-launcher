import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { inventoryClient, lookupModrinth, resolveInventory, type Candidate, type Origin } from '../src/catalog.ts';
import { buildRelease, signRelease, writePublication, compareReleases, assertOutputOutside, type PublishPlan } from '../src/publisher.ts';
import { verifyEnvelope } from '../src/release.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-publish-test-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const source = path.join(directory, 'source'); await fs.mkdir(path.join(source, 'mods'), { recursive: true });
  await fs.writeFile(path.join(source, 'mods', 'vehicle.jar'), 'test payload, not an actual mod');
  const inventory = await inventoryClient(source); const file = inventory.files[0];
  const plan: PublishPlan = { schemaVersion: 1, releaseId: 'local-a', platforms: ['darwin-arm64'],
    files: [{ path: file.path, sha256: file.sha256, policy: 'managed', source: { kind: 'local-test', urls: ['http://127.0.0.1:1234/vehicle'] } }] };
  return { directory, source, file, plan };
}

test('inventory excludes private state and never traverses worlds/runtime roots', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'config', 'apricityui'), { recursive: true });
  await fs.writeFile(path.join(f.source, 'config', 'apricityui', 'localStorage.nbt'), 'private');
  await fs.writeFile(path.join(f.source, 'config', 'password.properties'), 'private');
  await fs.writeFile(path.join(f.source, 'config', 'safe.toml'), 'setting=true');
  await fs.mkdir(path.join(f.source, 'saves')); await fs.symlink('/not-readable', path.join(f.source, 'saves', 'world'));
  const inventory = await inventoryClient(f.source);
  assert.deepEqual(inventory.files.map(x => x.path), ['config/safe.toml', 'mods/vehicle.jar']);
  assert.equal(inventory.files[0].reviewRequired, true);
  assert.ok(inventory.excluded.some(x => x.path === 'saves'));
  assert.ok(inventory.excluded.some(x => x.path.endsWith('localStorage.nbt')));
  assert.equal(await fs.readFile(path.join(f.source, 'config', 'password.properties'), 'utf8'), 'private');
  await fs.writeFile(path.join(f.source, 'mods', 'accounts.jar'), 'possible authentication mod');
  assert.ok((await inventoryClient(f.source)).blockers.includes('mods/accounts.jar'));
});

test('Modrinth resolver requires exact hash/size and official HTTPS CDN', async t => {
  const f = await fixture(t);
  const metadata = { id: 'version1', project_id: 'project1', game_versions: ['1.21.1'], loaders: ['neoforge'],
    files: [{ size: f.file.size, hashes: { sha512: f.file.sha512 }, url: 'https://cdn.modrinth.com/data/project1/versions/version1/a.jar' }] };
  const request = async (url: string) => { assert.ok(url.includes(f.file.sha512)); return new Response(JSON.stringify(metadata)); };
  assert.equal((await lookupModrinth(f.file, request)).kind, 'modrinth');
  metadata.files[0].size++; await assert.rejects(lookupModrinth(f.file, request), /does not match/);
  metadata.files[0].size--; metadata.files[0].url = 'https://untrusted.example/a.jar';
  await assert.rejects(lookupModrinth(f.file, request), /Unexpected/);
  assert.equal((await lookupModrinth(f.file, async () => new Response(null, { status: 404 }))).kind, 'unknown');
});

test('project provenance matches build bytes, not the installed filename', async t => {
  const f = await fixture(t); const artifact = path.join(f.directory, 'different-name.jar');
  await fs.copyFile(path.join(f.source, f.file.path), artifact);
  const report = await resolveInventory(await inventoryClient(f.source), [{ project: 'TownVehicle', artifact }],
    async () => { throw new Error('Must not query matching project build'); });
  assert.equal(report.files[0].source.kind, 'project');
  f.plan.releaseId = 'dev-project'; f.plan.files[0].source = report.files[0].source;
  if (f.plan.files[0].source.kind === 'project') f.plan.files[0].source.urls = ['https://downloads.example.test/vehicle.jar'];
  await buildRelease(f.source, f.plan);
  await fs.writeFile(artifact, 'new build');
  await assert.rejects(buildRelease(f.source, f.plan), /does not match/);
  const unmatched = await resolveInventory(await inventoryClient(f.source), [{ project: 'TownVehicle', artifact }],
    async () => ({ kind: 'unknown', reason: 'not found' }));
  assert.equal(unmatched.files[0].source.kind, 'unknown');
});

test('publisher rejects omitted Mods, unknown sources, unreviewed configuration and stale bytes', async t => {
  const f = await fixture(t);
  await assert.rejects(buildRelease(f.source, { ...f.plan, files: [] }), /omitted/);
  const unknown = structuredClone(f.plan); unknown.files[0].source = { kind: 'unknown', reason: 'unknown' };
  await assert.rejects(buildRelease(f.source, unknown), /Unresolved/);
  await assert.rejects(buildRelease(f.source, f.plan), /test-only/);
  const badId = { ...f.plan, releaseId: 'dev-a' }; await assert.rejects(buildRelease(f.source, badId, { localTest: true }), /local-/);
  await fs.mkdir(path.join(f.source, 'config')); await fs.writeFile(path.join(f.source, 'config', 'safe.toml'), 'value=true');
  const config = (await inventoryClient(f.source)).files[0];
  f.plan.files.push({ path: config.path, sha256: config.sha256, policy: 'default', source: { kind: 'local-test', urls: ['http://127.0.0.1:1234/config'] } });
  await assert.rejects(buildRelease(f.source, f.plan, { localTest: true }), /explicit review/);
  f.plan.files[1].reviewed = true;
  await buildRelease(f.source, f.plan, { localTest: true });
  await fs.writeFile(path.join(f.source, f.file.path), 'different bytes');
  await assert.rejects(buildRelease(f.source, f.plan, { localTest: true }), /changed/);
});

test('publisher rechecks Modrinth identity and bridge compatibility', async t => {
  const f = await fixture(t);
  const origin: Origin = { kind: 'modrinth', projectId: 'p1', versionId: 'v1', pageUrl: 'https://modrinth.com/mod/p1/version/v1',
    urls: ['https://cdn.modrinth.com/data/p1/versions/v1/a.jar'], gameVersions: ['1.21.1'], loaders: ['fabric'] };
  f.plan.releaseId = 'dev-a'; f.plan.files[0].source = origin;
  const lookup = async (_: Candidate) => origin;
  await assert.rejects(buildRelease(f.source, f.plan, { lookup }), /compatibility/);
  origin.compatibilityReviewed = true;
  await buildRelease(f.source, f.plan, { lookup });
  await assert.rejects(buildRelease(f.source, f.plan, { lookup: async () => ({ ...origin, versionId: 'different' }) }), /provenance changed/);
});

test('signed publication is deterministic, immutable and contains no private key/operator paths', async t => {
  const f = await fixture(t); const built = await buildRelease(f.source, f.plan, { localTest: true });
  const { privateKey } = generateKeyPairSync('ed25519'); const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signed = signRelease(built.release, pem);
  assert.deepEqual(signRelease(built.release, pem), signed);
  assert.deepEqual(verifyEnvelope(signed.envelope, { [signed.envelope.keyId]: signed.publicKey }, true), built.release);
  const output = path.join(f.directory, 'publication'); await writePublication(output, built, pem);
  await assert.rejects(writePublication(output, built, pem), /EEXIST/);
  for (const name of await fs.readdir(output)) {
    const text = await fs.readFile(path.join(output, name), 'utf8'); assert.ok(!text.includes('PRIVATE KEY')); assert.ok(!text.includes(f.directory));
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(output, 'COMPLETE.json'), 'utf8')).localTest, true);
});

test('publisher blocks symlinked Mods and output under the source without creating directories', async t => {
  const f = await fixture(t);
  await assert.rejects(assertOutputOutside(f.source, path.join(f.source, 'new', 'report.json')), /outside/);
  await assert.rejects(fs.stat(path.join(f.source, 'new')), /ENOENT/);
  const alias = path.join(f.directory, 'alias'); await fs.symlink(f.source, alias);
  await assert.rejects(assertOutputOutside(f.source, path.join(alias, 'new', 'report.json')), /outside/);
  await fs.symlink(path.join(f.source, f.file.path), path.join(f.source, 'mods', 'alias.jar'));
  await assert.rejects(buildRelease(f.source, f.plan, { localTest: true }), /Unsafe Mod inventory/);
});

test('release difference counts content/policy changes but not URL-only changes', async t => {
  const f = await fixture(t); const a = (await buildRelease(f.source, f.plan, { localTest: true })).release;
  const b = structuredClone(a); b.files[0].urls = ['http://127.0.0.1:1234/another'];
  assert.deepEqual(compareReleases(a, b), { added: [], changed: [], removed: [], reused: [f.file.path] });
  b.files[0].sha256 = '0'.repeat(64); assert.deepEqual(compareReleases(a, b).changed, [f.file.path]);
});
test('Stable producer checks installed server bytes and explicit client/server-only review',async t=>{
  const f=await fixture(t);const plan={...f.plan,channel:'stable' as const,sequence:1};
  await assert.rejects(buildRelease(f.source,plan,{localTest:true}),/server baseline/);
  const server=path.join(f.directory,'server');await fs.mkdir(path.join(server,'mods'),{recursive:true});
  await fs.copyFile(path.join(f.source,f.file.path),path.join(server,'mods','server-name.jar'));
  const stable:PublishPlan={...plan,stableBaseline:{serverRoot:server,serverOnly:[],clientOnly:[]}};
  assert.equal((await buildRelease(f.source,stable,{localTest:true})).release.channel,'stable');
  await fs.writeFile(path.join(server,'mods','server-name.jar'),'newer server build');
  await assert.rejects(buildRelease(f.source,stable,{localTest:true}),/diverges/);
  stable.stableBaseline!.serverOnly=['mods/server-name.jar'];
  await assert.rejects(buildRelease(f.source,stable,{localTest:true}),/client-only/);
  stable.stableBaseline!.clientOnly=[f.file.path];
  await buildRelease(f.source,stable,{localTest:true});
  stable.stableBaseline!.clientOnly=['mods/nonexistent.jar'];
  await assert.rejects(buildRelease(f.source,stable,{localTest:true}),/Unknown client-only/);
});
