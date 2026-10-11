import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { Runtime } from '../src/runtime.ts';
import { offlineProfile } from '../src/minecraft.ts';

test('development profile identity and validation are deterministic', () => {
  assert.equal(offlineProfile('TownTester').id, '79a48dd0a0723587958876a6b721d966');
  assert.throws(() => offlineProfile('bad name')); assert.throws(() => offlineProfile('name\n'));
});
test('runtime API: explicit trusted key, signed update, persist/reload and configuration bounds', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'town-runtime-test-'));
  const body = Buffer.from('runtime fixture');
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true }); });
  const runtime = new Runtime(path.join(directory, 'profile'), () => {});
  await runtime.initialize();
  await assert.rejects(runtime.configure({ memoryMiB: -1 }));
  await assert.rejects(runtime.configure({ serverAddress: 'injected\ncommand' }));
  await assert.rejects(runtime.configure({ shell: true } as never), /Unknown/);
  await runtime.configure({ localFixtures: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const keyFile = path.join(directory, 'public.pem'); await fs.writeFile(keyFile, pem);
  const payload = JSON.stringify({ schemaVersion: 1, releaseId: 'runtime-fixture', channel: 'dev', activation: 'active',
    minecraft: '1.21.1', neoforge: '21.1.250', platforms: ['darwin-arm64','darwin-x64','linux-x64','win32-x64'],
    files: [{ path: 'mods/runtime.txt', size: body.length, sha256: createHash('sha256').update(body).digest('hex'), policy: 'managed',
      urls: ['http://127.0.0.1:' + (server.address() as { port: number }).port + '/artifact'] }] });
  const file = path.join(directory, 'release.json');
  await fs.writeFile(file, JSON.stringify({ keyId, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') }));
  await assert.rejects(runtime.update(file, false), /Untrusted/); assert.equal(hits, 0);
  await runtime.trustKey(keyFile); await runtime.update(file, true);
  assert.equal(runtime.state.releaseId, null);
  await runtime.update(file, false); assert.equal(runtime.state.releaseId, 'runtime-fixture'); assert.equal(hits, 1);
  const reload = new Runtime(path.join(directory, 'profile'), () => {});
  await reload.initialize(); assert.equal(reload.state.releaseId, 'runtime-fixture'); assert.equal(reload.state.trustedKeys, 1);
  assert.equal(await fs.readFile(path.join(runtime.state.settings.workspace, 'game', 'mods', 'runtime.txt'), 'utf8'), body.toString());
});
