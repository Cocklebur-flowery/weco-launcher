import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeRelativePath, safeUrl } from './release.ts';
import { checkedFetch } from './download.ts';

export type Candidate = { path: string; size: number; sha256: string; sha512: string;
  category: 'mod' | 'resourcepack' | 'config'; reviewRequired: boolean };
export type Inventory = { schemaVersion: 1; files: Candidate[];
  excluded: { path: string; reason: string }[]; blockers: string[] };
export type Origin = { kind: 'unknown'; reason: string }
  | { kind: 'project'; project: string; artifact: string; urls: string[] }
  | { kind: 'modrinth'; projectId: string; versionId: string; pageUrl: string; urls: string[];
      gameVersions: string[]; loaders: string[]; compatibilityReviewed?: boolean }
  | { kind: 'manual'; pageUrl: string; urls: string[]; reviewed: boolean }
  | { kind: 'local-test'; urls: string[] };
export type ProjectBuild = { project: string; artifact: string };
export type Lookup = (file: Candidate) => Promise<Origin>;

// Only reviewed release roots are traversed; worlds, accounts and runtime caches are not read.
export async function fingerprint(file: string): Promise<Pick<Candidate, 'size' | 'sha256' | 'sha512'>> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 ** 3) throw new Error('Non-regular or oversized source');
  const sha256 = createHash('sha256'); const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) { sha256.update(chunk); sha512.update(chunk); }
  const after = await fs.lstat(file);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Source changed while hashing');
  return { size: after.size, sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

export async function inventoryClient(directory: string): Promise<Inventory> {
  const root = await fs.realpath(directory);
  const result: Inventory = { schemaVersion: 1, files: [], excluded: [], blockers: [] };
  const roots = new Set(['mods', 'resourcepacks', 'config', 'defaultconfigs']);
  const privateName = /(?:^\.|(?:^|[-_.])(accounts?|auth|credentials?|passwords?|secrets?|tokens?|cache|localstorage|user_variables)(?:[-_.]|$)|\.(?:db|sqlite|nbt|bak|log)$)/i;
  const visit = async (relative: string): Promise<void> => {
    if (result.files.length + result.excluded.length >= 10000) throw new Error('Inventory exceeds file limit');
    const file = path.join(root, relative);
    const stat = await fs.lstat(file);
    if (privateName.test(path.posix.basename(relative)) || relative.startsWith('mods/plugins/')) {
      result.excluded.push({ path: relative, reason: 'Private/runtime state or server plugin' });
      if (relative.startsWith('mods/') && !relative.startsWith('mods/plugins/')
        && (stat.isDirectory() || relative.endsWith('.jar'))) result.blockers.push(relative);
      return;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      result.excluded.push({ path: relative, reason: 'Non-regular path' });
      if (relative.startsWith('mods/')) result.blockers.push(relative); return;
    }
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) await visit(relative + '/' + name);
      return;
    }
    try { safeRelativePath(relative); } catch {
      result.excluded.push({ path: relative, reason: 'Unsafe release path' });
      if (relative.startsWith('mods/')) result.blockers.push(relative); return;
    }
    if (relative.startsWith('mods/') && !relative.endsWith('.jar')) {
      result.excluded.push({ path: relative, reason: 'Not a Mod JAR' }); return;
    }
    const category = relative.startsWith('mods/') ? 'mod' : relative.startsWith('resourcepacks/') ? 'resourcepack' : 'config';
    result.files.push({ path: relative, ...await fingerprint(file), category, reviewRequired: category !== 'mod' });
  };
  for (const name of (await fs.readdir(root)).sort()) {
    if (roots.has(name)) await visit(name);
    else result.excluded.push({ path: name, reason: 'Outside release roots; not traversed' });
  }
  result.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}

export async function lookupModrinth(file: Candidate, request = checkedFetch): Promise<Origin> {
  const response = await request('https://api.modrinth.com/v2/version_file/' + file.sha512 + '?algorithm=sha512',
    { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'TownLauncher/0.1.0 (release tooling)' } });
  if (response.status === 404) { await response.body?.cancel(); return { kind: 'unknown', reason: 'No exact Modrinth hash match' }; }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Modrinth HTTP ' + response.status); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const value = await reader.read(); if (value.done) break;
      size += value.value.length; if (size > 2 * 1024 ** 2) throw new Error('Modrinth metadata too large');
      chunks.push(value.value);
    }
  } finally { await reader.cancel(); }
  const version = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!/^[a-zA-Z0-9]+$/.test(version.id) || !/^[a-zA-Z0-9]+$/.test(version.project_id)
    || !Array.isArray(version.files)) throw new Error('Invalid Modrinth version metadata');
  const matched = version.files.find((f: { hashes?: { sha512?: string }; size?: number }) =>
    f.hashes?.sha512 === file.sha512 && f.size === file.size);
  if (!matched) throw new Error('Modrinth metadata does not match the local file');
  const url = new URL(safeUrl(matched.url));
  if (url.hostname !== 'cdn.modrinth.com' || !url.pathname.startsWith('/data/' + version.project_id + '/')) throw new Error('Unexpected Modrinth download host/path');
  const strings = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 1000 || v.some(x => typeof x !== 'string')) throw new Error('Invalid Modrinth compatibility metadata');
    return v;
  };
  return { kind: 'modrinth', projectId: version.project_id, versionId: version.id,
    pageUrl: 'https://modrinth.com/mod/' + version.project_id + '/version/' + version.id,
    urls: [url.href], gameVersions: strings(version.game_versions), loaders: strings(version.loaders) };
}

// Build hashes prove exact-byte project provenance; filenames never establish ownership.
export async function resolveInventory(inventory: Inventory, builds: ProjectBuild[] = [], lookup: Lookup = lookupModrinth) {
  if (builds.length > 100) throw new Error('Too many project proofs');
  const projects = new Map<string, Origin>();
  for (const build of builds) {
    if (!build.project || !path.isAbsolute(build.artifact)) throw new Error('Invalid project build proof');
    const hash = await fingerprint(build.artifact);
    if (projects.has(hash.sha256)) throw new Error('Ambiguous project ownership');
    projects.set(hash.sha256, { kind: 'project', ...build, urls: [] });
  }
  const files = [];
  for (const file of inventory.files) {
    let origin: Origin = projects.get(file.sha256) || { kind: 'unknown', reason: 'Explicit review/source binding required' };
    if (origin.kind === 'unknown' && file.category !== 'config') {
      try { origin = await lookup(file); }
      catch (e) { origin = { kind: 'unknown', reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) }; }
    }
    files.push({ ...file, policy: file.category === 'config' ? 'default' as const : 'managed' as const,
      reviewed: false, source: origin });
  }
  return { schemaVersion: 1 as const, files, excluded: inventory.excluded, blockers: inventory.blockers };
}
