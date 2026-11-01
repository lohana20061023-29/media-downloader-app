const { app, BrowserWindow, ipcMain, dialog, clipboard, screen, shell, session, Tray, Menu, nativeImage } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { join, dirname } = require('node:path');

/* Electron 33 的 ESM 主进程有 CJS 互操作 bug（import 'electron' 直接崩），
   主进程保持 CJS；引擎是纯 ESM，用动态 import() 加载。 */
let engine = null;
async function loadEngine() {
  if (engine) return engine;
  const [bili, xhs, douyin, ytdlp, qr, browserLogin] = await Promise.all([
    import('./engine/bili.mjs'),
    import('./engine/xhs.mjs'),
    import('./engine/douyin.mjs'),
    import('./engine/ytdlp.mjs'),
    import('./engine/qr.mjs'),
    import('./engine/browser-login.mjs'),
  ]);
  engine = { bili, xhs, douyin, ytdlp, qr, browserLogin };
  /* 应用自己保存的登录态优先；没有才借 DSH 插件那份 */
  if (state.cookie) {
    bili.setCookie(state.cookie);
    return engine;
  }
  /* 复用 DSH 插件的 B 站登录态（同一份 state.json），否则只能拿 480P */
  try {
    const { homedir } = require('node:os');
    const f = join(homedir(), '.dsh', 'bili-dl', 'state.json');
    if (existsSync(f)) {
      const s = JSON.parse(readFileSync(f, 'utf8'));
      if (s.cookie) bili.setCookie(s.cookie);
    }
  } catch { /* 没登录态就匿名 */ }
  return engine;
}

const isDev = !app.isPackaged;

/* 登录：与 DSH 插件完全一致 —— 复用 lib/browser-login.mjs，
   启动系统浏览器（专用 profile）→ 用户在浏览器里登录 → 完成后把 Cookie
   写进 ~/.dsh/bili-dl/cookies.txt（插件用的同一个文件），
   yt-dlp 走 --cookies，抖音走 MEDIADL_COOKIE_FILE。 */
function wireCookieConsumers(e) {
  try {
    e.ytdlp.setCookieOpts({ file: e.browserLogin.COOKIE_FILE, browser: '' });
    process.env.MEDIADL_COOKIE_FILE = e.browserLogin.COOKIE_FILE;
  } catch (err) { console.error('接线 Cookie 失败', err); }
}

/* ── 设置 ─────────────────────────────────────────────── */
const stateFile = () => join(app.getPath('userData'), 'state.json');
const DEFAULT_OUT = () => join(app.getPath('downloads'), '媒体下载');

let state = { outDir: '', copyToast: true, proxy: '', ffmpeg: '' };
function loadState() {
  state.outDir = DEFAULT_OUT();
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
    state = { ...state, ...raw };
  } catch { /* 首次运行 */ }
  if (!existsSync(state.outDir)) { try { mkdirSync(state.outDir, { recursive: true }); } catch {} }
}
function saveState(patch = {}) {
  state = { ...state, ...patch };
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { console.error('保存设置失败', e); }
  return state;
}

/* ── 窗口 ─────────────────────────────────────────────── */
let mainWin = null;
let toastWin = null;
let tray = null;

function createMain() {
  mainWin = new BrowserWindow({
    width: 620, height: 780, minWidth: 560, minHeight: 640,
    title: '媒体下载', backgroundColor: '#f6f2ea', show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  if (!mainWin) createMain();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function showToast(url) {
  if (toastWin) { try { toastWin.close(); } catch {} toastWin = null; }
  const { workArea } = screen.getPrimaryDisplay();
  const w = 380, h = 92;
  toastWin = new BrowserWindow({
    width: w, height: h,
    x: workArea.x + workArea.width - w - 20,
    y: workArea.y + workArea.height - h - 20,
    frame: false, resizable: false, movable: false, alwaysOnTop: true,
    skipTaskbar: true, show: false, transparent: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  toastWin.loadFile(join(__dirname, 'renderer', 'toast.html'), { query: { url } });
  toastWin.once('ready-to-show', () => toastWin.show());
  toastWin.on('closed', () => { toastWin = null; });
  setTimeout(() => { if (toastWin) { try { toastWin.close(); } catch {} } }, 8000);
}

/* ── 剪贴板监听 ───────────────────────────────────────── */
const LINK_RE = /(BV[0-9A-Za-z]{10})|(av\d{6,})|(bilibili\.com\/video)|(b23\.tv)|(xiaohongshu\.com|xhslink\.(?:com|cn))|(douyin\.com)|youtube\.com|youtu\.be|(?:^|\/\/)x\.com|tiktok\.com|vimeo\.com/i;

let lastClip = '';
function watchClipboard() {
  lastClip = clipboard.readText();
  setInterval(() => {
    const text = clipboard.readText();
    if (!text || text === lastClip) return;
    lastClip = text;
    if (!state.copyToast) return;
    if (!LINK_RE.test(text)) return;
    const hit = /https?:\/\/[^\s"'<>]+/.exec(text);
    showToast(hit ? hit[0] : text.trim());
  }, 300);
}

/* ── 解析 / 下载 ──────────────────────────────────────── */
function applyCookies(e, url) { wireCookieConsumers(e); }

async function probeUniversal(url) {
  const e = await loadEngine();
  applyCookies(e, url);
  const text = String(url || '').trim();
  if (!text) throw new Error('请输入链接');

  if (e.bili.looksLikeBilibili(text)) {
    const target = await e.bili.expandBiliShort(text);
    const info = { ...(await e.bili.probe(target)), source: 'bilibili' };
    e.bili.registerImage(info.cover);
    e.bili.registerImage(info.up?.face);
    (info.covers || []).forEach((c) => e.bili.registerImage(c.url));
    return info;
  }
  if (e.xhs.looksLikeXhs(text)) {
    const info = { ...(await e.xhs.xhsProbe(text)), source: 'xhs' };
    e.bili.registerImage(info.cover);
    (info.covers || []).forEach((c) => e.bili.registerImage(c.url));
    (info.images || []).forEach((c) => e.bili.registerImage(c.url));
    e.bili.registerImage(info.up?.face);
    return info;
  }
  if (e.douyin.looksLikeDouyin(text)) {
    const info = { ...(await e.douyin.douyinProbe(text)), source: 'douyin' };
    e.bili.registerImage(info.cover);
    (info.covers || []).forEach((c) => e.bili.registerImage(c.url));
    e.bili.registerImage(info.up?.face);
    return info;
  }
  return { ...(await e.ytdlp.ytProbe(text)), source: 'ytdlp' };
}

async function startDownload({ url, info, pick }) {
  const e = await loadEngine();
  applyCookies(e, url);
  const outDir = state.outDir;
  const ffmpeg = await e.bili.findFfmpeg(state.ffmpeg);
  const args = { url, outDir, ffmpeg, pick: pick || {} };
  const opts = { info, onUpdate: () => {} };

  switch (info.source) {
    case 'bilibili': return e.bili.startDownload(args, opts);
    case 'xhs': return e.xhs.startXhsDownload(args, opts);
    case 'douyin': return e.douyin.startDouyinDownload(args, opts);
    default: return e.ytdlp.ytStartDownload(args, opts);
  }
}

/* ── IPC ─────────────────────────────────────────────── */
ipcMain.handle('bootstrap', async () => {
  const e = await loadEngine();
  const me = await e.bili.loginStatus().catch(() => ({ login: false, uname: '', face: '' }));
  return {
    outDir: state.outDir,
    copyToast: state.copyToast,
    proxy: state.proxy,
    version: app.getVersion(),
    ffmpeg: await e.bili.findFfmpeg(state.ffmpeg).catch(() => null),
    login: me,
    loginSites: await (async () => { try { return await e.browserLogin.detectLogins(); } catch { return {}; } })(),
  };
});

ipcMain.handle('probe', (_e, url) => probeUniversal(url));

ipcMain.handle('start', async (_e, payload) => {
  const e = await loadEngine();
  if (state.proxy) e.bili.setProxy(state.proxy);
  const job = await startDownload(payload);
  return e.bili.publicJob(job);
});

ipcMain.handle('job', async (_e, id) => {
  const e = await loadEngine();
  const job = e.bili.getJob(id);
  return job ? e.bili.publicJob(job) : null;
});


ipcMain.handle('login-sites', async () => {
  const e = await loadEngine();
  let status = {};
  try { status = await e.browserLogin.detectLogins(); } catch { status = {}; }
  return {
    platforms: Object.entries(e.browserLogin.PLATFORMS).map(([id, p]) => ({ id, label: p.label, logged: !!status[id] })),
    cookieFile: e.browserLogin.COOKIE_FILE,
  };
});

ipcMain.handle('login-site-open', async (_e, key) => {
  const e = await loadEngine();
  try {
    await e.browserLogin.startLoginSession(key, (st) => {
      if (mainWin) mainWin.webContents.send('login-session', { key, ...st });
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('login-site-finish', async () => {
  const e = await loadEngine();
  try {
    const res = await e.browserLogin.finishLoginSession();
    wireCookieConsumers(e);
    const status = await e.browserLogin.detectLogins().catch(() => ({}));
    return { ok: true, ...res, status };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('login-site-cancel', async () => {
  const e = await loadEngine();
  try { e.browserLogin.cancelLoginSession(); } catch {}
  return { ok: true };
});

ipcMain.handle('login-status', async () => {
  const e = await loadEngine();
  try { return await e.bili.loginStatus(); } catch (err) { return { login: false, uname: '', face: '', error: err.message }; }
});

ipcMain.handle('login-qr', async () => {
  const e = await loadEngine();
  const { url, key } = await e.bili.qrGenerate();
  const svg = e.qr.encodeQrSvg(url, { scale: 5, margin: 3 });
  return { key, svg };
});

ipcMain.handle('login-poll', async (_e, key) => {
  const e = await loadEngine();
  const res = await e.bili.qrPoll(key);
  if (res.state === 'ok' && res.cookie) {
    e.bili.setCookie(res.cookie);
    saveState({ cookie: res.cookie });
    const me = await e.bili.loginStatus().catch(() => ({}));
    return { state: 'ok', uname: me.uname || '' };
  }
  return res;
});

ipcMain.handle('logout', async () => {
  const e = await loadEngine();
  e.bili.setCookie('');
  saveState({ cookie: '' });
  return { ok: true };
});

ipcMain.handle('pick-dir', async () => {
  const res = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { dir: '' };
  saveState({ outDir: res.filePaths[0] });
  return { dir: res.filePaths[0] };
});

ipcMain.handle('config', (_e, patch) => saveState(patch));
ipcMain.handle('reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('toast-open', (_e, url) => {
  if (toastWin) { try { toastWin.close(); } catch {} }
  showMain();
  if (mainWin) mainWin.webContents.send('open-url', url);
});

/* ── 托盘 / 生命周期 ──────────────────────────────────── */
function createTray() {
  try {
    const icon = nativeImage.createFromPath(join(__dirname, 'renderer', 'icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('媒体下载');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开窗口', click: showMain },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMain);
  } catch (e) { console.error('托盘创建失败', e); }
}

app.whenReady().then(async () => {
  loadState();
  createMain();
  createTray();
  watchClipboard();

  if (!isDev) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    } catch { /* 未安装或未配置发布源时忽略 */ }
  }
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => { app.isQuitting = true; });
