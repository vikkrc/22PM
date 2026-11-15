// Bridge between the page and the desktop shell. The page sees this as `window.native`.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  project: {
    info: () => ipcRenderer.invoke('project:info'),
    reveal: (rel) => ipcRenderer.invoke('project:reveal', rel),
    choose: (create) => ipcRenderer.invoke('project:choose', create),
  },
  fs: {
    read: (rel) => ipcRenderer.invoke('fs:read', rel),
    write: (rel, data) => ipcRenderer.invoke('fs:write', rel, data),
    remove: (rel) => ipcRenderer.invoke('fs:remove', rel),
  },
  out: {
    saveDialog: (name, filters) => ipcRenderer.invoke('dialog:save', { name, filters }),
    dirDialog: () => ipcRenderer.invoke('dialog:dir'),
    write: (handle, data, position) => ipcRenderer.invoke('out:write', handle, data, position),
    writeFile: (handle, name, data) => ipcRenderer.invoke('out:writeFile', handle, name, data),
    close: (handle) => ipcRenderer.invoke('out:close', handle),
    reveal: (p) => ipcRenderer.invoke('out:reveal', p),
  },
  displays: () => ipcRenderer.invoke('displays'),
  setOutputDisplay: (id) => ipcRenderer.invoke('output:display', id),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onFlush: (cb) => ipcRenderer.on('app:flush', async () => {
    try { await cb(); } finally { ipcRenderer.send('app:flushed'); }
  }),
});
