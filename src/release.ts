import { createPublicKey, verify } from 'node:crypto';

export type Platform = 'win32-x64' | 'linux-x64' | 'darwin-arm64' | 'darwin-x64';
export type ReleaseFile = { path: string; size: number; sha256: string; policy: 'managed' | 'default'; urls: string[] };
export type Release = {
  schemaVersion: 1; releaseId: string; channel: 'dev' | 'stable'; activation: 'preview' | 'active';
  minecraft: string; neoforge: string; platforms: Platform[]; files: ReleaseFile[];
  sequence?: number;
};
const platforms = new Set(['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']);
const protectedSegments = /^(?:\.town_mcp|town-chunk-cache|Distant_Horizons_server_data|townui-cache|saves|screenshots|logs)$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected non-empty string');
  return value;
}
export function safeRelativePath(value: unknown): string {
  const path = string(value);
  if (path.length > 240 || !/^(mods|resourcepacks|defaultconfigs|config)\//.test(path)) throw new Error('Unmanaged path');
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      || protectedSegments.test(part)) throw new Error('Unsafe path');
  }
  return path;
}
export function safeUrl(value: unknown, allowLoopback = false): string {
  const url = new URL(string(value));
  if (url.username || url.password || url.hash) throw new Error('Invalid download URL');
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:'
    && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('HTTPS required');
  return url.href;
}
export function parseRelease(value: unknown, allowLoopback = false): Release {
  const r = record(value);
  if (r.schemaVersion !== 1 || !['dev', 'stable'].includes(String(r.channel))
    || !['preview', 'active'].includes(String(r.activation))) throw new Error('Unsupported release');
  const releaseId = string(r.releaseId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(releaseId)) throw new Error('Invalid release ID');
  if ((r.sequence!==undefined || r.channel==='stable') && (!Number.isSafeInteger(r.sequence) || Number(r.sequence)<1)) throw new Error('Stable release requires a positive sequence');
  if (r.minecraft !== '1.21.1' || r.neoforge !== '21.1.250') throw new Error('Unsupported runtime baseline');
  if (!Array.isArray(r.platforms) || !r.platforms.length || r.platforms.some(p => !platforms.has(p))) throw new Error('Unsupported platform');
  if (!Array.isArray(r.files) || r.files.length > 10000) throw new Error('Invalid files');
  const names = new Set<string>();
  let total = 0;
  const files = r.files.map(value => {
    const f = record(value);
    const path = safeRelativePath(f.path);
    const normalized = path.normalize('NFC').toLowerCase();
    if (names.has(normalized)) throw new Error('Duplicate file path');
    names.add(normalized);
    if (!Number.isSafeInteger(f.size) || Number(f.size) < 0 || Number(f.size) > 2 * 1024 ** 3) throw new Error('Invalid file size');
    total += Number(f.size);
    if (total > 64 * 1024 ** 3) throw new Error('Release exceeds size limit');
    if (!/^[a-f0-9]{64}$/.test(string(f.sha256)) || !['managed', 'default'].includes(String(f.policy))) throw new Error('Invalid file metadata');
    if (!Array.isArray(f.urls) || !f.urls.length || f.urls.length > 4) throw new Error('Invalid sources');
    return { path, size: Number(f.size), sha256: String(f.sha256), policy: f.policy as ReleaseFile['policy'],
      urls: f.urls.map(url => safeUrl(url, allowLoopback)) };
  });
  for (const path of names) {
    const segments = path.split('/');
    while (segments.length > 1) { segments.pop(); if (names.has(segments.join('/'))) throw new Error('Path prefix collision'); }
  }
  return { schemaVersion: 1, releaseId, channel: r.channel as Release['channel'], activation: r.activation as Release['activation'],
    minecraft: '1.21.1', neoforge: '21.1.250', platforms: r.platforms as Platform[], files,
    ...(r.sequence!==undefined ? {sequence:Number(r.sequence)} : {}) };
}
export function verifyEnvelope(value: unknown, trustedKeys: Record<string, string>, allowLoopback = false): Release {
  const envelope = record(value);
  const keyId = string(envelope.keyId);
  if (!Object.hasOwn(trustedKeys, keyId)) throw new Error('Untrusted signing key');
  const payload = string(envelope.payload);
  if (Buffer.byteLength(payload) > 4 * 1024 ** 2) throw new Error('Manifest too large');
  const signature = Buffer.from(string(envelope.signature), 'base64');
  const key = createPublicKey(trustedKeys[keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64
    || !verify(null, Buffer.from(payload), key, signature)) throw new Error('Invalid signature');
  return parseRelease(JSON.parse(payload), allowLoopback);
}
