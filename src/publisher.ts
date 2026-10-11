import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { parseRelease, safeRelativePath, safeUrl, type Release, type Platform } from './release.ts';
import { fingerprint, inventoryClient, lookupModrinth, type Origin, type Lookup } from './catalog.ts';

export type PlanFile = { path: string; sha256: string; policy: 'managed' | 'default'; reviewed?: boolean; source: Origin };
export type PublishPlan = { schemaVersion: 1; releaseId: string; platforms: Platform[]; files: PlanFile[];
  channel?:'dev'|'stable';sequence?:number;stableBaseline?:{serverRoot:string;serverOnly:string[];clientOnly:string[]} };
type Options = { localTest?: boolean; lookup?: Lookup };

export async function assertOutputOutside(source: string, output: string): Promise<void> {
  const root = await fs.realpath(source); let parent = path.dirname(path.resolve(output)); const missing: string[] = [];
  for (;;) {
    try { parent = path.join(await fs.realpath(parent), ...missing.reverse()); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.push(path.basename(parent)); parent = path.dirname(parent);
    }
  }
  if (parent === root || parent.startsWith(root + path.sep)) throw new Error('Output must be outside the source client');
}

export async function buildRelease(directory: string, plan: PublishPlan, options: Options = {}) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.files) || plan.files.length > 10000) throw new Error('Invalid publish plan');
  const inventory = await inventoryClient(directory);
  if (inventory.blockers.length) throw new Error('Unsafe Mod inventory: ' + inventory.blockers.join(', '));
  const indexed = new Map(inventory.files.map(f => [f.path, f]));
  const included = new Set(plan.files.map(f => f.path));
  const missing = inventory.files.filter(f => f.category === 'mod' && !included.has(f.path));
  if (missing.length) throw new Error('Required Mods omitted: ' + missing.map(f => f.path).join(', '));
  if (plan.channel==='stable') {
    const baseline=plan.stableBaseline;
    if(!baseline || !path.isAbsolute(baseline.serverRoot) || !Array.isArray(baseline.serverOnly) || !Array.isArray(baseline.clientOnly)) throw new Error('Stable publication requires an explicitly reviewed server baseline');
    const mods=path.join(await fs.realpath(baseline.serverRoot),'mods');const entries=await fs.lstat(mods);
    if(!entries.isDirectory() || entries.isSymbolicLink()) throw new Error('Invalid Stable server Mod directory');
    const server=new Map<string,string>();
    for(const name of await fs.readdir(mods)) {
      if(!name.endsWith('.jar'))continue;const relative='mods/'+name;safeRelativePath(relative);
      server.set(relative,(await fingerprint(path.join(mods,name))).sha256);
    }
    if(!server.size)throw new Error('Stable server baseline has no Mods');
    const clientMods=inventory.files.filter(f=>f.category==='mod');
    for(const name of baseline.serverOnly)if(!server.has(name))throw new Error('Unknown server-only baseline entry: '+name);
    for(const name of baseline.clientOnly)if(!clientMods.some(f=>f.path===name))throw new Error('Unknown client-only baseline entry: '+name);
    const requiredHashes=new Set([...server].filter(([name])=>!baseline.serverOnly.includes(name)).map(([,hash])=>hash));
    for(const hash of requiredHashes)if(!clientMods.some(f=>f.sha256===hash))throw new Error('Client is missing or diverges from the Stable server baseline');
    for(const file of clientMods)if(!requiredHashes.has(file.sha256) && !baseline.clientOnly.includes(file.path))throw new Error('Unreviewed client-only Mod: '+file.path);
  }
  if (options.localTest && !/^local-[a-zA-Z0-9._-]+$/.test(plan.releaseId)) throw new Error('Local-test release ID must start with local-');
  const files = []; const provenance = [];
  for (const selected of [...plan.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    safeRelativePath(selected.path);
    const file = indexed.get(selected.path);
    if (!file || file.sha256 !== selected.sha256) throw new Error('Missing/changed/unpublishable source: ' + selected.path);
    if (file.reviewRequired && selected.reviewed !== true) throw new Error('File needs explicit review: ' + file.path);
    if (file.category === 'mod' && selected.policy !== 'managed') throw new Error('Mods must be managed files');
    const source = selected.source;
    if (!source || source.kind === 'unknown') throw new Error('Unresolved source: ' + file.path);
    let verified: Origin = source;
    if (source.kind === 'local-test') {
      if (!options.localTest || source.urls.some(u => new URL(safeUrl(u, true)).protocol !== 'http:')) throw new Error('Local source is test-only');
    } else if (source.kind === 'project') {
      if (!source.project || !path.isAbsolute(source.artifact)) throw new Error('Missing project build proof');
      const proof = await fingerprint(source.artifact);
      if (proof.sha256 !== file.sha256 || proof.size !== file.size) throw new Error('Project build does not match: ' + file.path);
    } else if (source.kind === 'modrinth') {
      verified = await (options.lookup || lookupModrinth)(file);
      if (verified.kind !== 'modrinth' || verified.projectId !== source.projectId || verified.versionId !== source.versionId) throw new Error('Modrinth provenance changed: ' + file.path);
      const compatible = verified.gameVersions.includes('1.21.1') && (file.category === 'resourcepack' || verified.loaders.includes('neoforge'));
      if (!compatible && source.compatibilityReviewed !== true) throw new Error('Loader/version compatibility needs review: ' + file.path);
    } else if (source.kind === 'manual') {
      if (source.reviewed !== true) throw new Error('Manual source has not been reviewed');
      safeUrl(source.pageUrl);
    } else throw new Error('Unsupported source kind');
    const urls = source.kind === 'modrinth' && verified.kind === 'modrinth' ? verified.urls : source.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 4) throw new Error('No usable download source: ' + file.path);
    files.push({ path: file.path, size: file.size, sha256: file.sha256, policy: selected.policy,
      urls: urls.map(url => safeUrl(url, Boolean(options.localTest))) });
    // Absolute operator paths stay in the private input plan, not in publication metadata.
    provenance.push({ path: file.path, kind: source.kind, sha256: file.sha256,
      ...(verified.kind === 'modrinth' ? { projectId: verified.projectId, versionId: verified.versionId, pageUrl: verified.pageUrl } : {}),
      ...(source.kind === 'project' ? { project: source.project, proofSha256: file.sha256 } : {}),
      ...(source.kind === 'manual' ? { pageUrl: source.pageUrl } : {}) });
  }
  const release = parseRelease({ schemaVersion: 1, releaseId: plan.releaseId, channel: plan.channel || 'dev', activation: 'active',
    minecraft: '1.21.1', neoforge: '21.1.250', platforms: plan.platforms, files,
    ...(plan.sequence!==undefined ? {sequence:plan.sequence} : {}) }, options.localTest);
  return { release, provenance, localTest: Boolean(options.localTest) };
}

export function signRelease(release: Release, pem: string) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required');
  const publicKey = createPublicKey(privateKey);
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const payload = JSON.stringify(release);
  return { envelope: { keyId, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

// Publication directories are immutable. An incomplete directory lacks COMPLETE.json.
export async function writePublication(output: string, built: Awaited<ReturnType<typeof buildRelease>>, pem: string) {
  const signed = signRelease(built.release, pem);
  await fs.mkdir(output);
  const manifest = JSON.stringify(signed.envelope, null, 2);
  await fs.writeFile(path.join(output, 'manifest.json'), manifest, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify({ releaseId: built.release.releaseId,
    localTest: built.localTest, files: built.provenance }, null, 2), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(output, 'public-key.pem'), signed.publicKey, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(output, 'COMPLETE.json'), JSON.stringify({ releaseId: built.release.releaseId,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'), localTest: built.localTest }), { flag: 'wx', mode: 0o600 });
  return signed;
}

export function compareReleases(before: Release, after: Release) {
  const old = new Map(before.files.map(f => [f.path, f])); const current = new Set(after.files.map(f => f.path));
  return { added: after.files.filter(f => !old.has(f.path)).map(f => f.path),
    changed: after.files.filter(f => old.has(f.path) && (old.get(f.path)!.sha256 !== f.sha256 || old.get(f.path)!.policy !== f.policy)).map(f => f.path),
    reused: after.files.filter(f => old.get(f.path)?.sha256 === f.sha256 && old.get(f.path)?.policy === f.policy).map(f => f.path),
    removed: before.files.filter(f => !current.has(f.path)).map(f => f.path) };
}
