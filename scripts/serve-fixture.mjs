import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || 'evidence/local-update');
await mkdir(directory, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const artifacts = new Map([['/a', Buffer.from('Town local fixture A\n')], ['/b', Buffer.from('Town local fixture B\n')]]);
const requests = [];
const server = createServer((req, res) => {
  requests.push({ path: req.url, range: req.headers.range || null });
  const data = artifacts.get(req.url);
  if (!data) { res.writeHead(404); res.end(); return; }
  const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
  if (offset) res.writeHead(206, { 'Content-Range': 'bytes ' + offset + '-' + (data.length - 1) + '/' + data.length });
  res.end(data.subarray(offset));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
for (const id of ['a', 'b']) {
  const data = artifacts.get('/' + id);
  const release = { schemaVersion: 1, releaseId: 'fixture-' + id, channel: 'dev', activation: 'active',
    minecraft: '1.21.1', neoforge: '21.1.250', platforms: ['win32-x64','linux-x64','darwin-x64','darwin-arm64'],
    files: [{ path: 'mods/town-update-demo.txt', size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      policy: 'managed', urls: [base + '/' + id] }] };
  const payload = JSON.stringify(release);
  await writeFile(path.join(directory, 'release-' + id + '.json'), JSON.stringify({ keyId, payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString('base64') }, null, 2));
}
await writeFile(path.join(directory, 'fixture-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
console.log(JSON.stringify({ directory, base, keyId, note: 'Private signing key exists only in this fixture process' }));
async function stop() { await writeFile(path.join(directory, 'requests.json'), JSON.stringify(requests, null, 2)); server.closeAllConnections(); server.close(); }
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
