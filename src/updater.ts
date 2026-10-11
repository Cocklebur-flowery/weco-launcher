import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseRelease, safeRelativePath, type Release, type Platform } from './release.ts';
import { download, type TransferProgress } from './download.ts';
import { acquireLock, assertWorkspace, atomicJson, copyRegular, digest, exists, privateDirectory, readInstalled,
  safeTarget, validateInstalled, type Installed, type OwnedFile } from './workspace.ts';

type Operation = { path: string; existed: boolean };
type Journal = { schemaVersion: 1; status: 'applying' | 'committed'; previous: Installed | null; operations: Operation[] };
type Options = { platform?: Platform; channel?: 'dev' | 'stable'; signal?: AbortSignal; allowLoopback?: boolean;
  progress?: (value: TransferProgress) => void; availableBytes?: () => Promise<number>; faultAfter?: number };
export function currentPlatform(): Platform { return (process.platform + '-' + process.arch) as Platform; }
async function restore(root: string, directory: string, journal: Journal): Promise<void> {
  const backupRoot = await fs.lstat(path.join(directory, 'backup'));
  if (!backupRoot.isDirectory() || backupRoot.isSymbolicLink()) throw new Error('Invalid recovery directory');
  for (let i = journal.operations.length - 1; i >= 0; i--) {
    const op = journal.operations[i];
    const target = await safeTarget(root, op.path);
    if (op.existed) {
      const backup = path.join(directory, 'backup', String(i));
      if (!(await fs.lstat(backup)).isFile() || (await fs.lstat(backup)).isSymbolicLink()) throw new Error('Invalid recovery backup');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = target + '.restore-' + randomUUID();
      try { await copyRegular(backup, temp); await fs.rename(temp, target); }
      finally { await fs.rm(temp, { force: true }); }
    } else await fs.rm(target, { force: true });
  }
  const installed = path.join(root, '.launcher', 'installed.json');
  if (journal.previous) await atomicJson(installed, journal.previous);
  else await fs.rm(installed, { force: true });
}
// The caller must hold the workspace lease, including during startup recovery.
export async function recover(root: string): Promise<boolean> {
  await assertWorkspace(root);
  const directory = path.join(root, '.launcher', 'transaction');
  if (!await exists(directory)) return false;
  if (!(await fs.lstat(directory)).isDirectory() || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Invalid transaction directory');
  const journalFile = path.join(directory, 'journal.json');
  if (!await exists(journalFile)) {
    if ((await fs.readdir(directory)).some(n => n !== 'backup')) throw new Error('Incomplete transaction requires inspection');
    await fs.rm(directory, { recursive: true }); return true;
  }
  if (!(await fs.lstat(journalFile)).isFile()) throw new Error('Invalid recovery journal');
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8')) as Journal;
  if (journal.schemaVersion !== 1 || !['applying', 'committed'].includes(journal.status)
    || !Array.isArray(journal.operations) || journal.operations.length > 10000) throw new Error('Invalid recovery journal');
  for (const operation of journal.operations) {
    safeRelativePath(operation.path); if (typeof operation.existed !== 'boolean') throw new Error('Invalid recovery operation');
  }
  if (journal.previous) validateInstalled(journal.previous);
  if (journal.status === 'applying') await restore(root, directory, journal);
  await fs.rm(directory, { recursive: true });
  return true;
}
async function prepare(root: string, raw: Release, options: Options): Promise<Map<string, string>> {
  const release = parseRelease(raw, options.allowLoopback);
  if (!release.platforms.includes(options.platform || currentPlatform()) || release.channel !== (options.channel || 'dev')) throw new Error('Release channel or platform mismatch');
  options.signal?.throwIfAborted();
  const space = options.availableBytes ? await options.availableBytes() : await fs.statfs(root).then(s => s.bavail * s.bsize);
  const installed = await readInstalled(root);
  if (installed?.channel==='stable' && release.channel!=='stable') throw new Error('Stable workspace cannot switch to DEV; choose a separate workspace');
  if (installed?.channel==='stable' && installed.sequence!==undefined) {
    if (release.sequence===undefined || release.sequence<installed.sequence) throw new Error('Stable release rollback refused');
    if (release.sequence===installed.sequence && createHash('sha256').update(JSON.stringify(release)).digest('hex')!==installed.releaseHash) throw new Error('Stable sequence reused for different release content');
  }
  const required = release.files.reduce((n, f) => n + f.size * 2, 16 * 1024 ** 2)
    + (installed?.owned.reduce((n, f) => n + f.size, 0) || 0);
  if (space < required) throw new Error('Insufficient disk space');
  const cache = await privateDirectory(root, 'cache');
  const result = new Map<string, string>();
  for (const file of release.files) {
    const target = await safeTarget(root, file.path);
    if (await exists(target) && (file.policy === 'default'
      || ((await fs.stat(target)).size === file.size && await digest(target) === file.sha256))) {
      options.progress?.({ phase: 'reused', path: file.path, bytes: file.size, total: file.size, reused: true });
    } else result.set(file.path, await download(file, cache, options));
  }
  return result;
}
export async function prepareRelease(root: string, release: Release, options: Options = {}): Promise<void> {
  const lock = await acquireLock(root);
  try { await recover(root); await prepare(root, release, options); } finally { await lock.release(); }
}
export async function installRelease(root: string, raw: Release, options: Options = {}): Promise<Installed> {
  const release = parseRelease(raw, options.allowLoopback);
  if (release.activation !== 'active') throw new Error('Preview releases cannot be activated');
  const lock = await acquireLock(root);
  try {
    await recover(root);
    const sources = await prepare(root, release, options);
    const previous = await readInstalled(root);
    const priorNames = new Map(previous?.owned.map(f => [f.path.normalize('NFC').toLowerCase(), f.path]) || []);
    for (const file of release.files) {
      const prior = priorNames.get(file.path.normalize('NFC').toLowerCase());
      if (prior && prior !== file.path) throw new Error('Cross-release path alias: ' + file.path);
    }
    const old = new Map(previous?.owned.map(f => [f.path, f]) || []);
    const desired = new Set(release.files.map(f => f.path));
    const expected = new Map(release.files.map(f => [f.path, f]));
    const changes: { path: string; source?: string }[] = [];
    const owned: OwnedFile[] = [];
    for (const file of release.files) {
      const target = await safeTarget(root, file.path);
      const present = await exists(target);
      if (file.policy === 'default') { if (!present) changes.push({ path: file.path, source: sources.get(file.path) }); continue; }
      const existingHash = present ? await digest(target) : null;
      const before = old.get(file.path);
      if (present && existingHash !== file.sha256 && (!before || existingHash !== before.sha256)) throw new Error('Unowned or user-modified file: ' + file.path);
      if (existingHash !== file.sha256) changes.push({ path: file.path, source: sources.get(file.path) });
      owned.push({ path: file.path, sha256: file.sha256, size: file.size });
    }
    for (const file of previous?.owned || []) {
      if (desired.has(file.path)) continue;
      const target = await safeTarget(root, file.path);
      if (!await exists(target)) continue;
      if (await digest(target) !== file.sha256) throw new Error('User-modified obsolete file: ' + file.path);
      changes.push({ path: file.path });
    }
    options.signal?.throwIfAborted();
    const directory = await privateDirectory(root, 'transaction');
    const backup = path.join(directory, 'backup');
    await fs.mkdir(backup);
    const journal: Journal = { schemaVersion: 1, status: 'applying', previous, operations: [] };
    await atomicJson(path.join(directory, 'journal.json'), journal);
    try {
      for (const change of changes) {
        options.signal?.throwIfAborted();
        const target = await safeTarget(root, change.path);
        const present = await exists(target);
        const index = journal.operations.length;
        if (present) await copyRegular(target, path.join(backup, String(index)));
        journal.operations.push({ path: change.path, existed: present });
        // Persist undo information before touching a managed file.
        await atomicJson(path.join(directory, 'journal.json'), journal);
        if (change.source) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const tmp = target + '.install-' + randomUUID();
          try {
            await copyRegular(change.source, tmp);
            const file = expected.get(change.path)!;
            if ((await fs.stat(tmp)).size !== file.size || await digest(tmp) !== file.sha256) throw new Error('Staged file changed');
            await fs.rename(tmp, target);
          }
          finally { await fs.rm(tmp, { force: true }); }
        } else await fs.rm(target, { force: true });
        options.progress?.({ phase: 'installing', path: change.path, bytes: index + 1, total: changes.length });
        if (options.faultAfter === index + 1) throw new Error('Injected installation failure');
      }
      const installed: Installed = { releaseId: release.releaseId, channel: release.channel, owned,
        ...(release.sequence!==undefined ? {sequence:release.sequence,releaseHash:createHash('sha256').update(JSON.stringify(release)).digest('hex')} : {}) };
      await atomicJson(path.join(root, '.launcher', 'installed.json'), installed);
      journal.status = 'committed'; await atomicJson(path.join(directory, 'journal.json'), journal);
      await fs.rm(directory, { recursive: true });
      return installed;
    } catch (error) { await recover(root); throw error; }
  } finally { await lock.release(); }
}
