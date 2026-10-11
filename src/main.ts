import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime.ts';
import type { Settings, Result } from './contracts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow;
  let runtime: Runtime;
  const respond = async (operation: () => Promise<void>): Promise<Result> => {
    try { await operation(); return { ok: true, state: structuredClone(runtime.state) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), state: structuredClone(runtime.state) }; }
  };
  const choose = async (title: string, directory = false): Promise<string | undefined> => {
    const result = await dialog.showOpenDialog(window, { title, properties: [directory ? 'openDirectory' : 'openFile'] });
    return result.canceled ? undefined : result.filePaths[0];
  };
  void app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1220, height: 820, minWidth: 1020, minHeight: 720,
      title: 'Town Launcher', backgroundColor: '#111714', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    runtime = new Runtime(process.env.TOWN_LAUNCHER_TEST_DATA || app.getPath('userData'), state => {
      if (!window.isDestroyed()) window.webContents.send('town:state', state);
    });
    const authorize = (event: Electron.IpcMainInvokeEvent) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Invalid IPC sender');
    };
    ipcMain.handle('town:state', event => { authorize(event); return structuredClone(runtime.state); });
    ipcMain.handle('town:configure', (event, settings: Partial<Settings>) => { authorize(event); return respond(() => runtime.configure(settings)); });
    ipcMain.handle('town:action', (event, action: string) => {
      authorize(event);
      return respond(async () => {
        if (action === 'cancel') { runtime.cancel(); return; }
        if (action === 'launch') { await runtime.launch(); return; }
        if (action === 'bootstrap') { await runtime.bootstrap(); return; }
        if (action === 'install-java') { await runtime.installJava(); return; }
        if (action === 'logs') { await shell.openPath(path.join(runtime.state.settings.workspace, 'game', 'logs')); return; }
        if (!['workspace', 'java', 'import', 'key', 'prepare', 'install'].includes(action)) throw new Error('Unknown action');
        const file = await choose(action === 'import' ? '选择现有客户端的 .minecraft 文件夹（只读复制）' : '选择 ' + action, ['workspace', 'import'].includes(action));
        if (!file) return;
        if (action === 'workspace') await runtime.setWorkspace(file);
        if (action === 'java') await runtime.configure({ javaPath: file });
        if (action === 'import') await runtime.import(file);
        if (action === 'key') await runtime.trustKey(file);
        if (action === 'prepare' || action === 'install') await runtime.update(file, action === 'prepare');
      });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await runtime.initialize();
    await window.loadFile(path.join(here, '..', 'ui', 'index.html'));
    app.on('second-instance', () => { if (!window.isDestroyed()) { window.show(); window.focus(); } });
  }).catch(error => { console.error('Launcher initialization failed:', error); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
