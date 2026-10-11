import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '');
const version = process.argv[3];
if (!version || !process.argv[2]) throw new Error('Usage: npm run baseline -- GAME_ROOT VERSION_ID [OUTPUT]');
const metadata = JSON.parse(await readFile(path.join(root, 'versions', version, version + '.json'), 'utf8'));
const game = metadata.arguments?.game || [];
const index = game.indexOf('--fml.neoForgeVersion');
const mods = [];
for (const filename of (await readdir(path.join(root, 'mods'))).filter(n => n.endsWith('.jar')).sort()) {
  const file = path.join(root, 'mods', filename);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  mods.push({ path: 'mods/' + filename, size: (await stat(file)).size, sha256: hash.digest('hex') });
}
const report = { observedAt: new Date().toISOString(), version, minecraft: game[game.indexOf('--fml.mcVersion') + 1],
  neoforge: game[index + 1], javaMajor: metadata.javaVersion.majorVersion, modCount: mods.length, mods,
  credentialsImported: false, sourceModified: false };
if (process.argv[4]) {
  const out = path.resolve(process.argv[4]); await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ version, minecraft: report.minecraft, neoforge: report.neoforge, mods: mods.length, credentialsImported: false }));
