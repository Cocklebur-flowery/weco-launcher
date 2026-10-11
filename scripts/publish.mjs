import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inventoryClient, resolveInventory } from '../src/catalog.ts';
import { buildRelease, writePublication, compareReleases, assertOutputOutside } from '../src/publisher.ts';
import { verifyEnvelope } from '../src/release.ts';
import { download } from '../src/download.ts';
import { createHash, createPublicKey } from 'node:crypto';

const [command, ...args] = process.argv.slice(2);
const json = async file => {
  if ((await fs.stat(file)).size > 8 * 1024 ** 2) throw new Error('Input JSON too large');
  return JSON.parse(await fs.readFile(file, 'utf8'));
};
const save = async (file, value, source) => {
  await assertOutputOutside(source, file);
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
};
try {
  if (command === 'scan' && args.length === 2) {
    const report = await inventoryClient(args[0]); await save(args[1], report, args[0]);
    console.log(JSON.stringify({ files: report.files.length, mods: report.files.filter(f => f.category === 'mod').length,
      excluded: report.excluded.length, blockers: report.blockers }));
  } else if (command === 'resolve' && [2, 3].includes(args.length)) {
    const report = await resolveInventory(await inventoryClient(args[0]), args[2] ? await json(args[2]) : []);
    await save(args[1], report, args[0]);
    console.log(JSON.stringify({ matched: report.files.filter(f => f.source.kind !== 'unknown').length,
      unresolved: report.files.filter(f => f.source.kind === 'unknown').map(f => ({ path: f.path, reason: f.source.reason })) }));
  } else if (command === 'build' && [4, 5].includes(args.length)) {
    if (args.length === 5 && args[4] !== '--local-test') throw new Error('Unknown build option');
    const key = await fs.lstat(args[2]);
    if (!key.isFile() || key.isSymbolicLink() || key.size > 16384 || (process.platform !== 'win32' && (key.mode & 0o077))) throw new Error('Signing key must be a private regular file (0600)');
    const built = await buildRelease(args[0], await json(args[1]), { localTest: args[4] === '--local-test' });
    await assertOutputOutside(args[0], args[3]); const output = path.resolve(args[3]);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await writePublication(output, built, await fs.readFile(args[2], 'utf8'));
    console.log(JSON.stringify({ releaseId: built.release.releaseId, files: built.release.files.length, localTest: built.localTest, output }));
  } else if (['compare', 'verify'].includes(command) && [3, 4].includes(args.length)) {
    if (args.length === 4 && args[3] !== '--local-test') throw new Error('Unknown verification option');
    const local = args[3] === '--local-test'; const pem = await fs.readFile(args[2], 'utf8'); const key = createPublicKey(pem);
    const id = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
    const release = verifyEnvelope(await json(args[0]), { [id]: pem }, local);
    if (command === 'compare') {
      const other = verifyEnvelope(await json(args[1]), { [id]: pem }, local);
      console.log(JSON.stringify(compareReleases(release, other), null, 2));
    } else {
      const cache = path.resolve(args[1]); await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.mkdir(cache);
      for (const file of release.files) {
        await download(file, cache, { allowLoopback: local }); console.log(JSON.stringify({ verified: file.path, size: file.size }));
      }
    }
  } else throw new Error('Usage: publish scan ROOT REPORT | resolve ROOT REPORT [PROJECT_PROOFS] | build ROOT PLAN KEY_PEM NEW_OUTPUT [--local-test] | compare MANIFEST_A MANIFEST_B PUBLIC_KEY [--local-test] | verify MANIFEST CACHE PUBLIC_KEY [--local-test]');
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
