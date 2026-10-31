const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  probe: (url) => ipcRenderer.invoke('probe', url),
  start: (payload) => ipcRenderer.invoke('start', payload),
  job: (id) => ipcRenderer.invoke('job', id),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  config: (patch) => ipcRenderer.invoke('config', patch),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  toastOpen: (url) => ipcRenderer.invoke('toast-open', url),
  onOpenUrl: (fn) => ipcRenderer.on('open-url', (_e, url) => fn(url)),
});
