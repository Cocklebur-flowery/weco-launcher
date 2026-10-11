import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { initializeWorkspace, acquireLock, atomicJson, digest, exists, readInstalled } from '../src/workspace.ts';
import { installRelease, prepareRelease, recover } from '../src/updater.ts';
import { download } from '../src/download.ts';
import type { Release, ReleaseFile } from '../src/release.ts';
import { spawn as spawnProcess } from 'node:child_process';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-launcher-test-'));
  const root = await initializeWorkspace(path.join(directory, 'workspace'));
  const bodies = new Map<string, Buffer>();
  const hits: string[] = [];
  const ranges: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url || ''); ranges.push(String(req.headers.range || ''));
    const body = bodies.get(req.url || '');
    if (!body) { res.writeHead(404); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => { res.end(body); }, 150); return; }
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range || ''));
    const offset = range ? Number(range[1]) : 0;
    if (range) res.writeHead(206, { 'Content-Range': 'bytes ' + offset + '-' + (body.length - 1) + '/' + body.length });
    res.end(body.subarray(offset));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = 'http://127.0.0.1:' + address.port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true }); });
  const release = (id: string, values: Record<string, string>, policy: 'managed' | 'default' = 'managed'): Release => ({
    schemaVersion: 1, releaseId: id, channel: 'dev', activation: 'active', minecraft: '1.21.1', neoforge: '21.1.250',
    platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'],
    files: Object.entries(values).map(([target, body]) => {
      const bytes = Buffer.from(body); const key = '/' + id + '/' + target; bodies.set(key, bytes);
      return { path: target, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), policy, urls: [base + key] };
    })
  });
  return { root, directory, bodies, hits, ranges, release, base };
}
const options = { allowLoopback: true, channel: 'dev' as const };
test('fresh install, changed-only reuse, owned deletion, unmanaged preservation', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/a.jar': 'A', 'mods/b.jar': 'B' }), options);
  const before = f.hits.length;
  await fs.writeFile(path.join(f.root, 'game', 'mods', 'personal.jar'), 'personal');
  await installRelease(f.root, f.release('b', { 'mods/a.jar': 'A', 'mods/c.jar': 'C' }), options);
  assert.equal(f.hits.length - before, 1);
  assert.equal(await exists(path.join(f.root, 'game', 'mods', 'b.jar')), false);
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'personal.jar'), 'utf8'), 'personal');
  assert.equal((await readInstalled(f.root))?.releaseId, 'b');
});
test('defaults stay player-owned', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'config/default.json': 'A' }, 'default'), options);
  await fs.writeFile(path.join(f.root, 'game', 'config', 'default.json'), 'player');
  await installRelease(f.root, f.release('b', { 'config/default.json': 'B' }, 'default'), options);
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'config', 'default.json'), 'utf8'), 'player');
});
test('user modifications block replace and remove without losing data', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/a.jar': 'A' }), options);
  await fs.writeFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'player');
  await assert.rejects(installRelease(f.root, f.release('b', { 'mods/a.jar': 'B' }), options), /user-modified/);
  await assert.rejects(installRelease(f.root, f.release('c', {}), options), /User-modified/);
  assert.equal((await readInstalled(f.root))?.releaseId, 'a');
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'utf8'), 'player');
});
test('unowned collision is never overwritten', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'game', 'mods'));
  await fs.writeFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'player');
  await assert.rejects(installRelease(f.root, f.release('a', { 'mods/a.jar': 'A' }), options), /Unowned/);
});
test('cross-release case aliases cannot delete a newly adopted file', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/Case.jar': 'A' }), options);
  await assert.rejects(installRelease(f.root, f.release('b', { 'mods/case.jar': 'A' }), options), /path alias/);
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'Case.jar'), 'utf8'), 'A');
  assert.equal((await readInstalled(f.root))?.releaseId, 'a');
});
test('corrupt download fails before activation', async t => {
  const f = await fixture(t); const release = f.release('a', { 'mods/a.jar': 'right' });
  f.bodies.set('/a/mods/a.jar', Buffer.from('wrong'));
  await assert.rejects(installRelease(f.root, release, options), /checksum/);
  assert.equal(await readInstalled(f.root), null);
  assert.equal(await exists(path.join(f.root, 'game', 'mods', 'a.jar')), false);
});
test('failed install restores prior files, metadata, and deletions', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/a.jar': 'A', 'mods/b.jar': 'B' }), options);
  await assert.rejects(installRelease(f.root, f.release('b', { 'mods/a.jar': 'new', 'mods/c.jar': 'C' }), { ...options, faultAfter: 2 }), /Injected/);
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'utf8'), 'A');
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'b.jar'), 'utf8'), 'B');
  assert.equal(await exists(path.join(f.root, 'game', 'mods', 'c.jar')), false);
  assert.equal((await readInstalled(f.root))?.releaseId, 'a');
});
test('persisted crash journal restores on next update', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/a.jar': 'A' }), options);
  const previous = await readInstalled(f.root);
  const tx = path.join(f.root, '.launcher', 'transaction');
  await fs.mkdir(path.join(tx, 'backup'), { recursive: true });
  await fs.copyFile(path.join(f.root, 'game', 'mods', 'a.jar'), path.join(tx, 'backup', '0'));
  await atomicJson(path.join(tx, 'journal.json'), { schemaVersion: 1, status: 'applying', previous, operations: [{ path: 'mods/a.jar', existed: true }] });
  await fs.writeFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'interrupted');
  const lock = await acquireLock(f.root); try { assert.equal(await recover(f.root), true); } finally { await lock.release(); }
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'utf8'), 'A');
});
test('real process interruption leaves a journal that startup recovery restores', async t => {
  const f = await fixture(t);
  await installRelease(f.root, f.release('a', { 'mods/a.jar': 'A' }), options);
  const release = f.release('b', { 'mods/a.jar': 'B', 'mods/b.jar': 'new' });
  const moduleUrl = new URL('../src/updater.ts', import.meta.url).href;
  const code = 'import {installRelease} from ' + JSON.stringify(moduleUrl) + '; await installRelease('
    + JSON.stringify(f.root) + ',' + JSON.stringify(release)
    + ',{allowLoopback:true,progress:p=>{if(p.phase==="installing")process.exit(42)}});';
  const child = spawnProcess(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { stdio: 'ignore' });
  const exit = await new Promise<number | null>(resolve => child.once('exit', resolve));
  assert.equal(exit, 42);
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'utf8'), 'B');
  const lock = await acquireLock(f.root);
  try { await recover(f.root); } finally { await lock.release(); }
  assert.equal(await fs.readFile(path.join(f.root, 'game', 'mods', 'a.jar'), 'utf8'), 'A');
  assert.equal((await readInstalled(f.root))?.releaseId, 'a');
});
test('same-process and real child-process locks block updates', async t => {
  const f = await fixture(t); const lock = await acquireLock(f.root);
  await assert.rejects(installRelease(f.root, f.release('a', {}), options), /busy/);
  const child = spawnProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)']);
  try {
    await lock.gamePid(child.pid!);
    await atomicJson(path.join(f.root, '.launcher', 'lock.json'), { token: 'fixture', pid: 2147483000, gamePid: child.pid });
    await assert.rejects(acquireLock(f.root), /busy/);
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); await fs.unlink(path.join(f.root, '.launcher', 'lock.json')); }
});
test('stale dead-process locks recover', async t => {
  const f = await fixture(t);
  await atomicJson(path.join(f.root, '.launcher', 'lock.json'), { token: 'fixture', pid: 2147483000 });
  const lock = await acquireLock(f.root); await lock.release();
});
test('low disk space and platform/channel mismatch fail before downloads', async t => {
  const f = await fixture(t); const release = f.release('a', { 'mods/a.jar': 'A' });
  await assert.rejects(installRelease(f.root, release, { ...options, availableBytes: async () => 0 }), /disk space/);
  await assert.rejects(installRelease(f.root, release, { ...options, channel: 'stable' }), /mismatch/);
  await assert.rejects(installRelease(f.root, { ...release, platforms: ['win32-x64'] }, { ...options, platform: 'linux-x64' }), /mismatch/);
  assert.equal(f.hits.length, 0);
});
test('preview preparation never changes active files', async t => {
  const f = await fixture(t); const release = { ...f.release('a', { 'mods/a.jar': 'A' }), activation: 'preview' as const };
  await prepareRelease(f.root, release, options);
  assert.equal(await exists(path.join(f.root, 'game', 'mods', 'a.jar')), false);
  await assert.rejects(installRelease(f.root, release, options), /Preview/);
});
test('range resume, cache hit and cancellation', async t => {
  const f = await fixture(t); const release = f.release('a', { 'mods/a.jar': '0123456789' });
  const file = release.files[0]; const cache = path.join(f.root, '.launcher', 'cache'); await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, file.sha256 + '.part'), '0123');
  await download(file, cache, options); assert.ok(f.ranges.includes('bytes=4-'));
  const before = f.hits.length; await download(file, cache, options); assert.equal(f.hits.length, before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(download({ ...file, sha256: 'b'.repeat(64) }, cache, { ...options, signal: controller.signal }));
});
test('oversized and truncated downloads never activate', async t => {
  const f = await fixture(t); const r = f.release('a', { 'mods/a.jar': '12345' });
  f.bodies.set('/a/mods/a.jar', Buffer.from('123456')); await assert.rejects(installRelease(f.root, r, options), /declared size/);
  f.bodies.set('/a/mods/a.jar', Buffer.from('12')); await assert.rejects(installRelease(f.root, r, options), /checksum/);
  assert.equal(await readInstalled(f.root), null);
});
test('symlink escapes and existing clients are refused', async t => {
  const f = await fixture(t);
  await fs.symlink(f.directory, path.join(f.root, 'game', 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installRelease(f.root, f.release('a', { 'mods/a.jar': 'A' }), options), /Non-regular/);
  const occupied = path.join(f.directory, 'existing'); await fs.mkdir(occupied); await fs.writeFile(path.join(occupied, 'options.txt'), 'player');
  await assert.rejects(initializeWorkspace(occupied), /empty folder/);
});
