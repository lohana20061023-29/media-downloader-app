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

/* Electron 33 内置 Node 20 没有全局 WebSocket，而 browser-login 用它读浏览器 Cookie，
   不补这一层会在登录窗口打开 2 秒后抛错并关掉窗口。 */
try { globalThis.WebSocket = require('ws'); } catch (err) { console.error('WebSocket polyfill 失败', err); }

const isDev = !app.isPackaged;

/* 内置 ffmpeg：打包后在 resources/vendor 下，开发时在项目 vendor 下 */
function bundledFfmpeg() {
  const p = isDev ? join(__dirname, 'vendor', 'ffmpeg.exe') : join(process.resourcesPath, 'vendor', 'ffmpeg.exe');
  return existsSync(p) ? p : '';
}

/* 登录：与 DSH 插件完全一致 —— 复用 lib/browser-login.mjs，
   启动系统浏览器（专用 profile）→ 用户在浏览器里登录 → 完成后把 Cookie
   写进 ~/.dsh/bili-dl/cookies.txt（插件用的同一个文件），
   yt-dlp 走 --cookies，抖音走 MEDIADL_COOKIE_FILE。 */
/* 只保留真正需要登录的平台：抖音/小红书解析靠匿名或浏览器，Vimeo 用不上 */
const LOGIN_ALLOW = ['youtube', 'bilibili', 'twitter', 'tiktok'];

function wireCookieConsumers(e) {
  try {
    e.ytdlp.setCookieOpts({ file: e.browserLogin.COOKIE_FILE, browser: '' });
    process.env.MEDIADL_COOKIE_FILE = e.browserLogin.COOKIE_FILE;
  } catch (err) { console.error('接线 Cookie 失败', err); }
}

/* ── 设置 ─────────────────────────────────────────────── */
const stateFile = () => join(app.getPath('userData'), 'state.json');
const DEFAULT_OUT = () => join(app.getPath('downloads'), 'LoDown');

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
    width: 1180, height: 820, minWidth: 1000, minHeight: 680,
    title: 'LoDown', backgroundColor: '#f2f4f7', show: false, frame: false,
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
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
  const ffmpeg = await e.bili.findFfmpeg(bundledFfmpeg() || state.ffmpeg);
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
ipcMain.handle('win-min', () => { if (mainWin) mainWin.minimize(); });
ipcMain.handle('win-max', () => {
  if (!mainWin) return false;
  if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
  return mainWin.isMaximized();
});
ipcMain.handle('win-close', () => { app.isQuitting = true; if (mainWin) mainWin.close(); });

ipcMain.handle('bootstrap', async () => {
  const e = await loadEngine();
  const me = await e.bili.loginStatus().catch(() => ({ login: false, uname: '', face: '' }));
  return {
    outDir: state.outDir,
    copyToast: state.copyToast,
    proxy: state.proxy,
    version: app.getVersion(),
    ffmpeg: await e.bili.findFfmpeg(bundledFfmpeg() || state.ffmpeg).catch(() => null),
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


/* ── 内置登录：用应用内的 webview（独立 session）登录，完成后导出 Cookie ── */
ipcMain.handle('login-inline-open', async (_e, key) => {
  const e = await loadEngine();
  const p = e.browserLogin.PLATFORMS[key];
  if (!p) return { ok: false, error: '未知平台' };
  return { ok: true, url: p.url, label: p.label };
});

ipcMain.handle('login-inline-finish', async (_e, key) => {
  const e = await loadEngine();
  const p = e.browserLogin.PLATFORMS[key];
  if (!p) return { ok: false, error: '未知平台' };

  const ses = session.fromPartition('persist:login-' + key);
  let fetched = [];
  for (const d of p.domains) {
    try { fetched = fetched.concat(await ses.cookies.get({ domain: d })); } catch {}
  }
  const map = new Map();
  for (const c of fetched) map.set(c.domain + '|' + c.name, c);
  const list = [...map.values()];
  if (!list.length) return { ok: false, error: '没有拿到 Cookie，确认已经登录了吗？' };

  const hit = list.some((c) => p.check.includes(c.name));
  if (!hit) return { ok: false, error: '还没检测到登录态（' + p.check.join(' / ') + '）' };

  /* 合并写回 cookies.txt：先剔掉本平台旧行，再追加新的 */
  const owns = (domain) => {
    const d = String(domain || '').replace(/^\./, '').toLowerCase();
    return p.domains.some((x) => d === x || d.endsWith('.' + x));
  };
  let rows = [];
  try {
    const txt = require('node:fs').readFileSync(e.browserLogin.COOKIE_FILE, 'utf8');
    rows = txt.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && !owns(l.split('\t')[0]));
  } catch {}

  const expires = (c) => (c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000) + 365 * 86400);
  for (const c of list) {
    const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    rows.push([domain, 'TRUE', '/', c.secure ? 'TRUE' : 'FALSE', expires(c), c.name, c.value].join('\t'));
  }

  try {
    const path = require('node:path');
    const fs = require('node:fs');
    fs.mkdirSync(path.dirname(e.browserLogin.COOKIE_FILE), { recursive: true });
    fs.writeFileSync(e.browserLogin.COOKIE_FILE, '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: '写入失败：' + err.message };
  }

  try { e.browserLogin.cancelLoginSession(); } catch {}
  return { ok: true, count: list.length };
});

ipcMain.handle('login-sites', async () => {
  const e = await loadEngine();
  let status = {};
  try { status = await e.browserLogin.detectLogins(); } catch { status = {}; }
  return {
    platforms: Object.entries(e.browserLogin.PLATFORMS)
      .filter(([id]) => LOGIN_ALLOW.includes(id))
      .map(([id, p]) => ({ id, label: p.label, logged: !!status[id] })),
    cookieFile: e.browserLogin.COOKIE_FILE,
  };
});

ipcMain.handle('login-site-open', async (_e, key) => {
  const e = await loadEngine();
  try {
    await e.browserLogin.startLoginSession(key, (st) => {
      try { require('node:fs').appendFileSync(require('node:path').join(require('node:os').tmpdir(), 'mediadl-login.log'), new Date().toISOString() + ' ' + key + ' ' + JSON.stringify(st) + '\n'); } catch {}
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

/* ── 浏览记录（与下载历史分开）── */
ipcMain.handle('browse-list', () => Array.isArray(state.browse) ? state.browse : []);
ipcMain.handle('browse-add', (_e, item) => {
  if (!item || !item.url || !/^https?:/i.test(item.url)) return Array.isArray(state.browse) ? state.browse : [];
  const clean = cleanUrl(item.url);
  const list = (Array.isArray(state.browse) ? state.browse : []).filter((x) => cleanUrl(x.url) !== clean);
  const next = [{ url: cleanUrl(item.url), title: (item.title || item.url).slice(0, 200), icon: item.icon || '', at: Date.now() }, ...list].slice(0, 500);
  saveState({ browse: next });
  return next;
});
/* 去掉跟踪参数，避免同一条记录被存成好几份 */
function cleanUrl(u) {
  try {
    const url = new URL(u);
    for (const k of ['vd_source', 'share_source', 'share_medium', 'share_plat', 'share_tag', 'spm_id_from', 'trackid', 'unique_k', 'from_source', 'from_spmid', 'timestamp', 'buvid', 'up_id', 'broadcast_type', 'is_room_feed']) {
      url.searchParams.delete(k);
    }
    return url.origin + url.pathname + (url.search || '');
  } catch { return u; }
}

ipcMain.handle('browse-set-title', (_e, payload) => {
  const list = Array.isArray(state.browse) ? state.browse : [];
  const clean = cleanUrl(payload && payload.url || '');
  let changed = false;
  for (const it of list) {
    if (cleanUrl(it.url) === clean && payload.title && it.title !== payload.title) {
      it.title = String(payload.title).slice(0, 200);
      changed = true;
      break;
    }
  }
  if (changed) saveState({ browse: list });
  return list;
});

ipcMain.handle('browse-clear', () => { saveState({ browse: [] }); return []; });
ipcMain.handle('browse-remove', (_e, url) => {
  const list = (Array.isArray(state.browse) ? state.browse : []).filter((x) => x.url !== url);
  saveState({ browse: list });
  return list;
});

/* ── 历史记录 ── */
ipcMain.handle('history-list', () => Array.isArray(state.history) ? state.history : []);
ipcMain.handle('history-add', (_e, item) => {
  const list = Array.isArray(state.history) ? state.history : [];
  const next = [item, ...list.filter((x) => !(x.url === item.url && x.kind === item.kind))].slice(0, 300);
  saveState({ history: next });
  return next;
});
ipcMain.handle('history-clear', () => { saveState({ history: [] }); return []; });
ipcMain.handle('history-remove', (_e, key) => {
  const list = (Array.isArray(state.history) ? state.history : []).filter((x) => x.key !== key);
  saveState({ history: list });
  return list;
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
    tray.setToolTip('LoDown');
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

/* 网页里点开的链接（target=_blank / window.open）：拦下来交给渲染进程开新标签页，
   不生成独立窗口。Electron 33 已经移除 webview 的 new-window 事件，只能在这里拦。 */
app.on('web-contents-created', (_event, contents) => {
  try {
    if (contents.getType() !== 'webview') return;
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && mainWin) mainWin.webContents.send('open-url', url);
      return { action: 'deny' };
    });
  } catch (err) { console.error('window-open 拦截失败', err); }
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => { app.isQuitting = true; });