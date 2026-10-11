import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch, generateArguments, Version } from '@xmcl/core';
import { getVersionList, install, installNeoForged, installDependencies, fetchJavaRuntimeManifest, installJavaRuntimeTask } from '@xmcl/installer';
import { acquireLock, assertWorkspace, atomicJson, digest, exists, privateDirectory, safeTarget } from './workspace.ts';
import { recover } from './updater.ts';
import type { Settings } from './contracts.ts';
import type { GameLogin } from './auth.ts';
import { authenticatedOptions } from './game-auth.ts';
import type { LaunchOption } from '@xmcl/core';

export type GameAuthentication = {login:GameLogin;agent?:LaunchOption['yggdrasilAgent']};

const exec = promisify(execFile);
export async function findJava(): Promise<string> {
  if (process.platform === 'darwin') {
    try { const { stdout } = await exec('/usr/libexec/java_home', ['-v', '21']); return path.join(stdout.trim(), 'bin', 'java'); } catch {}
  }
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  return process.platform === 'win32' ? 'java.exe' : 'java';
}
export async function checkJava(java: string): Promise<void> {
  const { stdout, stderr } = await exec(java, ['-version'], { timeout: 10000 });
  if (!/version\s+"21(?:[."])/.test(stdout + stderr)) throw new Error('Select a Java 21 executable');
}
export function offlineProfile(name: string): { id: string; name: string } {
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) throw new Error('Development name must have 3–16 letters, numbers or underscores');
  const uuid = createHash('md5').update('OfflinePlayer:' + name).digest();
  uuid[6] = (uuid[6] & 15) | 48; uuid[8] = (uuid[8] & 63) | 128;
  return { name, id: uuid.toString('hex') };
}
export async function validateVersion(game: string, id: string): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(id)) throw new Error('Invalid game version ID');
  const version = await Version.parse(game, id);
  const args = version.arguments?.game || [];
  if (version.javaVersion?.majorVersion !== 21 || args[args.indexOf('--fml.mcVersion') + 1] !== '1.21.1'
    || args[args.indexOf('--fml.neoForgeVersion') + 1] !== '21.1.250') throw new Error('Client does not match the approved NeoForge baseline');
}
export async function installManagedJava(root: string, log: (line: string) => void): Promise<string> {
  const lock = await acquireLock(root);
  try {
    const manifest = await fetchJavaRuntimeManifest({ target: 'java-runtime-delta' });
    if (!/^21(?:\.|$)/.test(manifest.version.name)) throw new Error('Official runtime is not Java 21');
    const destination = await privateDirectory(root, 'jre');
    log('Installing official Java ' + manifest.version.name);
    await installJavaRuntimeTask({ destination, manifest }).startAndWait();
    const find = async (dir: string, depth: number): Promise<string | undefined> => {
      if (!depth) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === (process.platform === 'win32' ? 'java.exe' : 'java')) return file;
        if (entry.isDirectory()) { const found = await find(file, depth - 1); if (found) return found; }
      }
    };
    const java = await find(destination, 7);
    if (!java) throw new Error('Java executable not found');
    await checkJava(java); return java;
  } finally { await lock.release(); }
}
export async function importClient(root: string, source: string, log: (line: string) => void): Promise<string> {
  await assertWorkspace(root);
  const real = await fs.realpath(source);
  if (real === root || real.startsWith(root + path.sep) || root.startsWith(real + path.sep)) throw new Error('Source and workspace must be separate');
  const lock = await acquireLock(root);
  try {
    await recover(root);
    const game = path.join(root, 'game');
    if ((await fs.readdir(game)).length) throw new Error('Import requires a fresh empty workspace');
    const ids = (await fs.readdir(path.join(real, 'versions'))).filter(id => /^[a-zA-Z0-9_.-]+$/.test(id));
    let chosen = '';
    for (const id of ids) { try { await validateVersion(real, id); chosen = id; break; } catch {} }
    if (!chosen) throw new Error('No matching NeoForge 21.1.250 client found');
    const pending = path.join(root, '.launcher', 'import-pending.json');
    await atomicJson(pending, { sourceVerified: true, startedAt: new Date().toISOString() });
    const copy = async (from: string, to: string): Promise<void> => {
      const stat = await fs.lstat(from);
      if (stat.isSymbolicLink()) throw new Error('Import contains a symbolic link');
      if (stat.isDirectory()) {
        await fs.mkdir(to, { recursive: true });
        for (const name of await fs.readdir(from)) {
          if (/^(\.DS_Store|\.town_mcp|\.hmcl|accounts.*|authlib-injector.*)$/i.test(name)) continue;
          await copy(path.join(from, name), path.join(to, name));
        }
      } else if (stat.isFile()) await fs.copyFile(from, to, 1);
      else throw new Error('Import contains a non-regular file');
    };
    for (const folder of ['assets', 'libraries', 'versions', 'mods', 'config', 'defaultconfigs', 'resourcepacks',
      'rinku-libraries', 'fancymenu_data', 'spiffy_instance_data', 'tlm_custom_pack']) {
      const from = path.join(real, folder);
      if (!await exists(from)) continue;
      log('Copying ' + folder); await copy(from, path.join(game, folder));
    }
    const owned = [];
    for (const name of (await fs.readdir(path.join(game, 'mods'))).filter(n => n.endsWith('.jar'))) {
      const relative = 'mods/' + name; const file = await safeTarget(root, relative);
      owned.push({ path: relative, size: (await fs.stat(file)).size, sha256: await digest(file) });
    }
    await atomicJson(path.join(root, '.launcher', 'installed.json'), { releaseId: 'local-import', channel: 'dev', owned });
    await fs.unlink(pending);
    log('Imported ' + owned.length + ' Mods without accounts, worlds or caches');
    return chosen;
  } finally { await lock.release(); }
}
export async function bootstrap(root: string, java: string, log: (line: string) => void): Promise<string> {
  await checkJava(java); const lock = await acquireLock(root);
  try {
    await recover(root);
    const game = path.join(root, 'game');
    const pending = path.join(root, '.launcher', 'bootstrap-pending.json');
    if ((await fs.readdir(game)).length && !await exists(pending)) throw new Error('Bootstrap requires an empty workspace');
    await atomicJson(pending, { minecraft: '1.21.1', neoforge: '21.1.250' });
    log('Installing official Minecraft 1.21.1 dependencies');
    const version = (await getVersionList()).versions.find(v => v.id === '1.21.1');
    if (!version) throw new Error('Minecraft version unavailable');
    await install(version, game);
    log('Installing NeoForge 21.1.250');
    const id = await installNeoForged('neoforge', '21.1.250', game, { java });
    await installDependencies(await Version.parse(game, id));
    await validateVersion(game, id);
    await fs.unlink(pending);
    return id;
  } finally { await lock.release(); }
}
export async function startMinecraft(settings: Settings, log: (line: string) => void, ended: (code: number | null) => void, authentication?:GameAuthentication): Promise<number> {
  offlineProfile(settings.playerName);
  await checkJava(settings.javaPath);
  await assertWorkspace(settings.workspace);
  const lock = await acquireLock(settings.workspace);
  let transferred = false;
  try {
    await recover(settings.workspace);
    if (await exists(path.join(settings.workspace, '.launcher', 'import-pending.json'))) throw new Error('Import was interrupted; choose a new workspace');
    if (await exists(path.join(settings.workspace, '.launcher', 'bootstrap-pending.json'))) throw new Error('Runtime installation is incomplete; retry installation');
    const game = path.join(settings.workspace, 'game');
    await validateVersion(game, settings.versionId);
    const version = await Version.parse(game, settings.versionId);
    const options = {
      javaPath: settings.javaPath, gamePath: game, resourcePath: game, version: settings.versionId,
      ...(authentication ? authenticatedOptions(authentication.login,authentication.agent)
        : {gameProfile:offlineProfile(settings.playerName),accessToken:'0',userType:'legacy' as const}),
      launcherName: 'Town Launcher', launcherBrand: 'TownLife', gameName: 'RCT '+settings.channel.toUpperCase(),
      minMemory: 512, maxMemory: settings.memoryMiB, extraJVMArgs: ['-XX:+UseG1GC'],
      resolution: { width: 1280, height: 800 },
      extraMCArgs: settings.autoConnect ? ['--quickPlayMultiplayer', settings.serverAddress + ':' + settings.serverPort] : [],
      extraExecOption: { cwd: game, shell: false },
      features: { town_launcher_values: { primary_jar_name: version.minecraftVersion + '.jar',
        clientid: authentication?.login.clientId || '00000000-0000-0000-0000-000000000000', auth_xuid: authentication?.login.xuid || '0' } }
    };
    const args = await generateArguments(options);
    if (args.some(arg => arg.includes('${'))) throw new Error('Unresolved launcher placeholder');
    const child = await launch(options);
    if (!child.pid) throw new Error('Game process did not start');
    await lock.gamePid(child.pid);
    transferred = true;
    child.stdout?.on('data', data => log(String(data)));
    child.stderr?.on('data', data => log(String(data)));
    let finished = false;
    const finish = async (code: number | null) => {
      if (finished) return; finished = true;
      try { await lock.release(); } catch (error) { log(String(error)); }
      ended(code);
    };
    child.once('error', error => { log(String(error)); void finish(null); });
    child.once('close', code => { void finish(code); });
    return child.pid;
  } finally { if (!transferred) await lock.release(); }
}
