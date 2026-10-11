import { initializeWorkspace } from '../dist/main/workspace.js';
import { bootstrap, checkJava } from '../dist/main/minecraft.js';
const root = await initializeWorkspace(process.argv[2]);
const java = process.argv[3];
if (!java) throw new Error('Usage: node scripts/bootstrap-smoke.mjs EMPTY_WORKSPACE JAVA_EXECUTABLE');
await checkJava(java);
const versionId = await bootstrap(root, java, line => console.log(line));
console.log(JSON.stringify({ result: 'PASS', scope: 'official dependency installation; no game process launched', versionId, root }));
