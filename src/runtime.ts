import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { findJava, importClient, bootstrap, startMinecraft, offlineProfile, installManagedJava } from './minecraft.ts';
import { atomicJson, initializeWorkspace, readInstalled } from './workspace.ts';
import { verifyEnvelope, type Release } from './release.ts';
import { installRelease, prepareRelease } from './updater.ts';
import type { Settings, Snapshot } from './contracts.ts';

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) return '运行环境下载失败：' + errorMessage(error.errors[0]);
  return (error instanceof Error ? error.message || error.name : String(error)).slice(0, 600);
}

export class Runtime {
  private keys: Record<string, string> = {};
  private controller: AbortController | null = null;
  private busy = false;
  private data: string;
  private changed: (state: Snapshot) => void;
  readonly state: Snapshot;
  constructor(data: string, changed: (state: Snapshot) => void) {
    this.data = data;
    this.changed = changed;
    this.state = { settings: { workspace: path.join(data, 'workspaces', 'dev'), javaPath: '', memoryMiB: 4096,
      playerName: 'TownTester', versionId: '', serverAddress: '192.168.31.99', serverPort: 25566,
      autoConnect: false, localFixtures: false }, phase: 'idle', message: '准备你的 RCT 客户端', gamePid: null,
      releaseId: null, logs: [], progress: null, trustedKeys: 0 };
  }
  async initialize() {
    await fs.mkdir(this.data, { recursive: true });
    try { await this.configure(JSON.parse(await fs.readFile(path.join(this.data, 'settings.json'), 'utf8'))); } catch {}
    try { this.keys = JSON.parse(await fs.readFile(path.join(this.data, 'trusted-keys.json'), 'utf8')); } catch {}
    this.state.trustedKeys = Object.keys(this.keys).length;
    if (!this.state.settings.javaPath) this.state.settings.javaPath = await findJava();
    await initializeWorkspace(this.state.settings.workspace);
    this.state.releaseId = (await readInstalled(this.state.settings.workspace))?.releaseId || null;
    this.emit();
  }
  emit() { this.changed(structuredClone(this.state)); }
  log(line: string) {
    for (const item of line.trim().split('\n')) {
      this.state.logs.push(item.slice(0, 1200).replace(/((?:accessToken|authorization|password|token)\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]'));
    }
    this.state.logs = this.state.logs.slice(-100); this.emit();
  }
  async configure(value: Partial<Settings>) {
    if (this.busy || this.state.gamePid) throw new Error('Settings cannot change while busy');
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !Object.hasOwn(this.state.settings, key))) throw new Error('Unknown setting');
    const next = { ...this.state.settings, ...value };
    offlineProfile(next.playerName);
    if (!Number.isInteger(next.memoryMiB) || next.memoryMiB < 1024 || next.memoryMiB > 16384) throw new Error('Memory must be 1024–16384 MiB');
    if (!Number.isInteger(next.serverPort) || next.serverPort < 1 || next.serverPort > 65535) throw new Error('Invalid server port');
    if (typeof next.serverAddress !== 'string' || /[\s/\\]/.test(next.serverAddress) || next.serverAddress.length > 253) throw new Error('Invalid server address');
    if (typeof next.javaPath !== 'string' || next.javaPath.length > 1024 || next.javaPath.includes('\0')) throw new Error('Invalid Java path');
    if (typeof next.workspace !== 'string' || !path.isAbsolute(next.workspace) || next.workspace.length > 1024) throw new Error('Invalid workspace');
    if (next.versionId && !/^[a-zA-Z0-9_.-]{1,100}$/.test(next.versionId)) throw new Error('Invalid version ID');
    if (typeof next.autoConnect !== 'boolean' || typeof next.localFixtures !== 'boolean') throw new Error('Invalid flags');
    this.state.settings = next; await atomicJson(path.join(this.data, 'settings.json'), next); this.emit();
  }
  async task(name: string, operation: () => Promise<void>) {
    if (this.busy || this.state.gamePid) throw new Error('Game or operation is already running');
    this.busy = true; this.state.phase = name; this.state.progress = null; this.state.message = name; this.emit();
    try { await operation(); this.state.phase = this.state.gamePid ? 'playing' : 'idle'; this.state.message = '操作完成'; }
    catch (error) { this.state.phase = 'error'; this.state.message = errorMessage(error); throw new Error(this.state.message); }
    finally { this.busy = false; this.controller = null; this.emit(); }
  }
  async setWorkspace(directory: string) {
    const root = await initializeWorkspace(directory);
    await this.configure({ workspace: root, versionId: '' });
    this.state.releaseId = (await readInstalled(root))?.releaseId || null; this.emit();
  }
  async import(source: string) {
    await this.task('importing', async () => {
      const id = await importClient(this.state.settings.workspace, source, line => this.log(line));
      this.state.settings.versionId = id;
      await atomicJson(path.join(this.data, 'settings.json'), this.state.settings);
      this.state.releaseId = 'local-import';
    });
  }
  async bootstrap() {
    await this.task('bootstrapping', async () => {
      this.state.settings.versionId = await bootstrap(this.state.settings.workspace, this.state.settings.javaPath, line => this.log(line));
      await atomicJson(path.join(this.data, 'settings.json'), this.state.settings);
    });
  }
  async installJava() {
    await this.task('bootstrapping', async () => {
      this.state.settings.javaPath = await installManagedJava(this.state.settings.workspace, line => this.log(line));
      await atomicJson(path.join(this.data, 'settings.json'), this.state.settings);
    });
  }
  async launch() {
    await this.task('launching', async () => {
      this.state.gamePid = await startMinecraft(this.state.settings, line => this.log(line), code => {
        this.state.gamePid = null; this.state.phase = code === 0 ? 'idle' : 'error';
        this.state.message = code === 0 ? '游戏已退出' : '游戏退出，代码 ' + code; this.emit();
      });
    });
  }
  async trustKey(file: string) {
    if ((await fs.stat(file)).size > 16384) throw new Error('Key file too large');
    const pem = await fs.readFile(file, 'utf8'); const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 public key required');
    const id = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
    this.keys[id] = pem; await atomicJson(path.join(this.data, 'trusted-keys.json'), this.keys);
    this.state.trustedKeys = Object.keys(this.keys).length; this.emit();
  }
  async update(file: string, prepareOnly: boolean) {
    await this.task(prepareOnly ? 'preparing' : 'updating', async () => {
      if ((await fs.stat(file)).size > 4 * 1024 ** 2) throw new Error('Manifest too large');
      const release: Release = verifyEnvelope(JSON.parse(await fs.readFile(file, 'utf8')), this.keys, this.state.settings.localFixtures);
      this.controller = new AbortController();
      const options = { channel: 'dev' as const, allowLoopback: this.state.settings.localFixtures,
        signal: this.controller.signal, progress: (value: { path: string; bytes: number; total: number }) => {
          this.state.progress = value; this.state.message = value.path; this.emit();
        } };
      if (prepareOnly) await prepareRelease(this.state.settings.workspace, release, options);
      else this.state.releaseId = (await installRelease(this.state.settings.workspace, release, options)).releaseId;
    });
  }
  cancel() { this.controller?.abort(new Error('Update cancelled by user')); }
}
