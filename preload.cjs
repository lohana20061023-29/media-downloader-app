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
  finishSiteLogin: () => ipcRenderer.invoke('login-site-finish'),
  cancelSiteLogin: () => ipcRenderer.invoke('login-site-cancel'),
  onLoginSession: (fn) => ipcRenderer.on('login-session', (_e, d) => fn(d)),
  loginStatus: () => ipcRenderer.invoke('login-status'),
  loginQr: () => ipcRenderer.invoke('login-qr'),
  loginPoll: (key) => ipcRenderer.invoke('login-poll', key),
  logout: () => ipcRenderer.invoke('logout'),
  toastOpen: (url) => ipcRenderer.invoke('toast-open', url),
  onOpenUrl: (fn) => ipcRenderer.on('open-url', (_e, url) => fn(url)),
});
