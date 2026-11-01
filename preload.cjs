const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  probe: (url) => ipcRenderer.invoke('probe', url),
  start: (payload) => ipcRenderer.invoke('start', payload),
  job: (id) => ipcRenderer.invoke('job', id),
  pickDir: () => ipcRenderer.invoke('pick-dir'),
  config: (patch) => ipcRenderer.invoke('config', patch),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  loginSites: () => ipcRenderer.invoke('login-sites'),
  openSiteLogin: (site) => ipcRenderer.invoke('login-site-open', site),
  clearSiteLogin: (site) => ipcRenderer.invoke('login-site-clear', site),
  onSiteLoginResult: (fn) => ipcRenderer.on('login-site-result', (_e, data) => fn(data)),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  loginQr: () => ipcRenderer.invoke('login-qr'),
  loginPoll: (key) => ipcRenderer.invoke('login-poll', key),
  logout: () => ipcRenderer.invoke('logout'),
  toastOpen: (url) => ipcRenderer.invoke('toast-open', url),
  onOpenUrl: (fn) => ipcRenderer.on('open-url', (_e, url) => fn(url)),
});
