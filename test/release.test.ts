import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { parseRelease, safeRelativePath, safeUrl, verifyEnvelope } from '../src/release.ts';
const release = () => ({ schemaVersion: 1, releaseId: 'dev-1', channel: 'dev', activation: 'active',
  minecraft: '1.21.1', neoforge: '21.1.250', platforms: ['darwin-arm64'], files: [
    { path: 'mods/town.jar', size: 4, sha256: 'a'.repeat(64), policy: 'managed', urls: ['https://example.com/town.jar'] }] });
test('baseline and platform contracts', () => { assert.equal(parseRelease(release()).files.length, 1);
  assert.throws(() => parseRelease({ ...release(), neoforge: 'latest' })); });
test('path traversal, reserved paths and platform aliases', () => {
  for (const path of ['mods/../options.txt', '/mods/x.jar', 'mods/C:evil', 'mods/a\\b', 'mods/CON.jar',
    'config/.town_mcp/token.json', 'mods/x.', 'mods//x']) assert.throws(() => safeRelativePath(path), path);
  const r = release(); r.files.push({ ...r.files[0], path: 'mods/TOWN.jar' }); assert.throws(() => parseRelease(r));
});
test('HTTPS and explicit loopback fixtures only', () => {
  assert.throws(() => safeUrl('http://example.com/x', true)); assert.throws(() => safeUrl('http://localhost/x'));
  assert.equal(safeUrl('http://127.0.0.1/x', true), 'http://127.0.0.1/x');
});
test('signed release requires locally trusted Ed25519 key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const payload = JSON.stringify(release());
  const keys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const e = { keyId: 'fixture', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
  assert.equal(verifyEnvelope(e, keys).releaseId, 'dev-1');
  assert.throws(() => verifyEnvelope({ ...e, payload: payload + ' ' }, keys));
  assert.throws(() => verifyEnvelope(e, {}));
});
