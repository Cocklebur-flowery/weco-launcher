const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('town', Object.freeze({
  state: () => ipcRenderer.invoke('town:state'),
  configure: (value: unknown) => ipcRenderer.invoke('town:configure', value),
  action: (name: string) => ipcRenderer.invoke('town:action', name),
  subscribe: (handler: (value: unknown) => void) => {
    const listener = (_event: unknown, value: unknown) => handler(value);
    ipcRenderer.on('town:state', listener);
    return () => ipcRenderer.removeListener('town:state', listener);
  }
}));
