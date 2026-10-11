import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { safeRelativePath } from './release.ts';

export type OwnedFile = { path: string; sha256: string; size: number };
export type Installed = { releaseId: string; channel: string; owned: OwnedFile[]; sequence?:number; releaseHash?:string };
export async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
export async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function initializeWorkspace(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await fs.mkdir(absolute, { recursive: true });
  const root = await fs.realpath(absolute);
  const marker = path.join(root, '.town-launcher-workspace.json');
  if (!await exists(marker)) {
    if ((await fs.readdir(root)).length) throw new Error('Choose an empty folder; existing clients are never adopted in place');
    await fs.writeFile(marker, JSON.stringify({ schemaVersion: 1, owner: 'town-launcher', id: randomUUID() }), { flag: 'wx', mode: 0o600 });
  }
  await assertWorkspace(root);
  await fs.mkdir(path.join(root, 'game'), { recursive: true });
  await fs.mkdir(path.join(root, '.launcher'), { recursive: true });
  return root;
}
export async function assertWorkspace(root: string): Promise<void> {
  const entry = await fs.lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid workspace root');
  const marker = path.join(root, '.town-launcher-workspace.json');
  if (!(await fs.lstat(marker)).isFile()) throw new Error('Invalid workspace marker');
  const data = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (data.owner !== 'town-launcher' || data.schemaVersion !== 1) throw new Error('Unowned workspace');
  for (const part of ['game', '.launcher']) {
    const target = path.join(root, part);
    if (await exists(target)) {
      const s = await fs.lstat(target);
      if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('Workspace directory replaced');
    }
  }
}
export async function safeTarget(root: string, relative: string): Promise<string> {
  safeRelativePath(relative);
  await assertWorkspace(root);
  const base = path.join(root, 'game');
  let current = base;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!await exists(current)) continue;
    const s = await fs.lstat(current);
    if (s.isSymbolicLink() || (i < parts.length - 1 ? !s.isDirectory() : !s.isFile())) throw new Error('Non-regular managed path');
  }
  return current;
}
export async function readInstalled(root: string): Promise<Installed | null> {
  await assertWorkspace(root);
  const file = path.join(root, '.launcher', 'installed.json');
  if (!await exists(file)) return null;
  if (!(await fs.lstat(file)).isFile()) throw new Error('Invalid installed state');
  return validateInstalled(JSON.parse(await fs.readFile(file, 'utf8')));
}
export function validateInstalled(input: unknown): Installed {
  const value = input as Installed;
  if (!value || typeof value.releaseId !== 'string' || !['dev', 'stable'].includes(value.channel) || !Array.isArray(value.owned) || value.owned.length > 10000) throw new Error('Invalid installed state');
  if ((value.sequence!==undefined || value.releaseHash!==undefined)
    && (!Number.isSafeInteger(value.sequence) || Number(value.sequence)<1 || !/^[a-f0-9]{64}$/.test(value.releaseHash || ''))) throw new Error('Invalid installed sequence');
  const names = new Set<string>();
  for (const f of value.owned) {
    safeRelativePath(f.path);
    if (!/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0 || names.has(f.path.toLowerCase())) throw new Error('Invalid ownership state');
    names.add(f.path.toLowerCase());
  }
  return value;
}
function alive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function acquireLock(root: string): Promise<{ gamePid(pid: number): Promise<void>; release(): Promise<void> }> {
  await assertWorkspace(root);
  const file = path.join(root, '.launcher', 'lock.json');
  const token = randomUUID();
  const repair = path.join(root, '.launcher', 'lock-repair');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await exists(repair)) throw new Error('Workspace lock recovery is running');
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid })); } finally { await handle.close(); }
      return {
        async gamePid(pid) { await atomicJson(file, { token, pid: process.pid, gamePid: pid }); },
        async release() {
          if (!await exists(file)) return;
          const state = JSON.parse(await fs.readFile(file, 'utf8'));
          if (state.token !== token) throw new Error('Lock ownership changed');
          await fs.unlink(file);
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { await fs.mkdir(repair); } catch { throw new Error('Workspace busy: another lock recovery is running'); }
      try {
        if (!await exists(file)) continue;
        const s = await fs.lstat(file);
        if (!s.isFile() || s.isSymbolicLink()) throw new Error('Invalid workspace lock');
        const old = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof old.token !== 'string' || !Number.isInteger(old.pid) || old.pid <= 0) throw new Error('Invalid workspace lock');
        if (alive(old.pid) || alive(old.gamePid)) throw new Error('Workspace busy: game or updater is running');
        await fs.unlink(file);
      } finally { await fs.rmdir(repair); }
    }
  }
  throw new Error('Could not acquire workspace lock');
}
export async function privateDirectory(root: string, name: string): Promise<string> {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error('Invalid private directory');
  const directory = path.join(root, '.launcher', name);
  if (await exists(directory) && ((await fs.lstat(directory)).isSymbolicLink() || !(await fs.lstat(directory)).isDirectory())) throw new Error('Invalid private directory');
  await fs.mkdir(directory, { recursive: true });
  return directory;
}
export async function copyRegular(source: string, destination: string): Promise<void> {
  const s = await fs.lstat(source);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Expected regular source file');
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
}
