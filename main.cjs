function bootMark(label) {
  try {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    fs.appendFileSync(path.join(os.tmpdir(), 'lodown-boot.log'),
      Date.now() + ' ' + (process.uptime() * 1000).toFixed(0) + 'ms ' + label + '\n');
  } catch {}
}

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
const LOGIN_ALLOW = ['youtube', 'bilibili', 'twitter', 'tiktok', 'xiaohongshu', 'douyin'];

function wireCookieConsumers(e) {
  try {
    e.ytdlp.setCookieOpts({ file: e.browserLogin.COOKIE_FILE, browser: '' });
    process.env.MEDIADL_COOKIE_FILE = e.browserLogin.COOKIE_FILE;
  } catch (err) { console.error('接线 Cookie 失败', err); }
}

/* ── 设置 ─────────────────────────────────────────────── */
const stateFile = () => join(app.getPath('userData'), 'state.json');
const DEFAULT_OUT = () => join(app.getPath('downloads'), 'LOHANA DX');

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
    title: 'LOHANA DX', backgroundColor: '#f2f4f7', show: true, frame: false,
    icon: join(__dirname, 'renderer', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });
  mainWin.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWin.webContents.on('did-finish-load', () => bootMark('renderer-loaded'));
  bootMark('window-created');
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
ipcMain.handle('debug-log', (_e, line) => {
  try {
    const path = require('node:path');
    const fs = require('node:fs');
    const file = path.join(require('node:os').tmpdir(), 'lodown-debug.log');
    fs.appendFileSync(file, new Date().toISOString() + ' ' + String(line).slice(0, 800) + '\n', 'utf8');
  } catch {}
});

ipcMain.handle('win-min', () => { if (mainWin) mainWin.minimize(); });
ipcMain.handle('win-max', () => {
  if (!mainWin) return false;
  if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
  return mainWin.isMaximized();
});
ipcMain.handle('win-close', () => { app.isQuitting = true; if (mainWin) mainWin.close(); });

ipcMain.handle('xhs-from-page', async (_e, payload) => {
  const e = await loadEngine();
  const note = payload && payload.note;
  const id = (payload && payload.id) || (note && note.noteId) || '';
  if (!note) return { ok: false, error: '没有页面数据' };
  try {
    const info = { ...e.xhs.normalizeNoteObject(note, id), source: 'xhs' };
    e.bili.registerImage(info.cover);
    (info.covers || []).forEach((c) => e.bili.registerImage(c.url));
    (info.images || []).forEach((c) => e.bili.registerImage(c.url));
    e.bili.registerImage(info.up?.face);
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const imgCache = new Map();

ipcMain.handle('img-proxy', async (_e, url) => {
  if (!url || !/^https?:/i.test(url)) return '';
  if (imgCache.has(url)) return imgCache.get(url);
  try {
    const host = new URL(url).hostname;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Referer: /xhscdn|xhscdn\.com|xiaohongshu/.test(host) ? 'https://www.xiaohongshu.com/' : new URL(url).origin + '/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return '';
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const data = 'data:' + ct + ';base64,' + buf.toString('base64');
    if (imgCache.size > 120) imgCache.clear();
    imgCache.set(url, data);
    return data;
  } catch { return ''; }
});

/* 把浏览/登录窗口里的 Cookie 同步进共享 cookies.txt，
   让「浏览用的登录态」和「解析/下载用的登录态」是同一套 */
const COOKIE_HOSTS = ['bilibili.com', 'douyin.com', 'xiaohongshu.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com'];

/* Netscape 行格式化：yt-dlp 对「.domain + FALSE」这种组合会直接报 invalid Netscape format */
function jarLine(domain, path, secure, expires, name, value) {
  const host = String(domain || '').replace(/^\./, '');
  const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ').slice(0, 4000);
  return [host, 'TRUE', path || '/', secure ? 'TRUE' : 'FALSE', String(expires || 0), clean(name), clean(value)].join('\t');
}

/* 读入的旧行也顺手规范化，坏的直接丢掉 */
function normalizeJar(text) {
  const out = ['# Netscape HTTP Cookie File', '# https://curl.haxx.se/docs/http-cookies.html', ''];
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c.length !== 7 || !c[5] || !c[6] || !c[0]) continue;
    out.push(jarLine(c[0], c[2], c[3] === 'TRUE', c[4], c[5], c[6]));
  }
  return out.join('\n') + '\n';
}

/* 把 cookies.txt 里的 Cookie 灌进默认会话，解决登录态与浏览页不同步 */
async function importJarToSession() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { session } = require('electron');
    const jarPath = path.join(require('node:os').homedir(), '.dsh', 'bili-dl', 'cookies.txt');
    if (!fs.existsSync(jarPath)) return 0;
    const ses = session.defaultSession;
    const rows = fs.readFileSync(jarPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    let n = 0;
    for (const line of rows) {
      if (!line || line.startsWith('#')) continue;
      const c = line.split('\t');
      if (c.length !== 7 || !c[5] || !c[6]) continue;
      const host = String(c[0]).replace(/^\./, '');
      const expires = Number(c[4]);
      const opt = {
        url: 'https://' + host + (c[2] || '/'),
        name: c[5], value: c[6], path: c[2] || '/',
        secure: c[3] === 'TRUE',
      };
      if (Number.isFinite(expires) && expires > 0) opt.expirationDate = expires;
      const r = await ses.cookies.set(opt).catch(() => null);
      if (r) n += 1;
    }
    await ses.cookies.flushStore().catch(() => {});
    return n;
  } catch { return 0; }
}

async function syncCookiesToJar() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { session } = require('electron');
    const jarPath = path.join(require('node:os').homedir(), '.dsh', 'bili-dl', 'cookies.txt');

    const sessions = [session.defaultSession];
    for (const key of LOGIN_ALLOW) {
      try { sessions.push(session.fromPartition('persist:login-' + key)); } catch {}
    }

    const collected = [];
    for (const sess of sessions) {
      let list = [];
      try { list = await sess.cookies.get({}); } catch { continue; }
      for (const c of list) {
        const host = String(c.domain || '').replace(/^\./, '');
        if (!COOKIE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) continue;
        /* 已退登的平台不再同步回来 */
        const marks = state.logoutAt || {};
        const blocked = Object.keys(marks).some((k) => {
          if (Date.now() - marks[k] > 30 * 86400000) return false;
          const ds = PLATFORM_DOMAINS[k] || [];
          return ds.some((d) => host === d || host.endsWith('.' + d));
        });
        if (blocked) continue;
        collected.push(c);
      }
    }
    if (!collected.length) return 0;

    let lines = [];
    try { lines = fs.readFileSync(jarPath, 'utf8').split(/\r?\n/); } catch { lines = []; }

    const keyOf = (domain, name, p2) => domain + '|' + name + '|' + (p2 || '/');
    const existing = new Map();
    const kept = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) { kept.push(line); continue; }
      const cols = line.split('\t');
      if (cols.length < 7) { kept.push(line); continue; }
      existing.set(keyOf(cols[0], cols[5], cols[2]), true);
      kept.push(line);
    }

    let added = 0;
    for (const c of collected) {
      const domain = c.domain && c.domain.startsWith('.') ? c.domain : '.' + (c.domain || '');
      const key = keyOf(domain, c.name, c.path);
      if (existing.has(key)) continue;
      existing.set(key, true);
      const expiry = Math.round(c.expirationDate || (Date.now() / 1000 + 86400));
      kept.push(jarLine(domain, c.path, c.secure, expiry, c.name, c.value));
      added += 1;
    }

    if (added) {
      fs.mkdirSync(path.dirname(jarPath), { recursive: true });
      /* 去重：同一 domain|path|name 只保留最后一条，避免文件无限膨胀 */
      const seen = new Map();
      for (const line of kept) {
        if (!line || line.startsWith('#')) continue;
        const c = line.split('\t');
        if (c.length !== 7) continue;
        seen.set(c[0] + '|' + c[2] + '|' + c[5], line);
      }
      fs.writeFileSync(jarPath, normalizeJar([...seen.values()].join('\n')), 'utf8');
    }
    return added;
  } catch { return 0; }
}

ipcMain.handle('sync-cookies', async () => syncCookiesToJar());

/* ── 首次使用须知 / 第三方组件 ── */
const LEGAL_VERSION = '1.0.0';
const COMPONENT_VERSION = '1';

function componentsDir() {
  return require('node:path').join(app.getPath('userData'), 'components');
}

ipcMain.handle('app-quit', () => {
  app.isQuitting = true;
  try { if (tray) { tray.destroy(); tray = null; } } catch {}
  app.quit();
  setTimeout(() => app.exit(0), 800);
  return true;
});

ipcMain.handle('legal-status', () => ({
  version: LEGAL_VERSION,
  accepted: state.legalVersion === LEGAL_VERSION,
  acceptedAt: state.legalAt || 0,
  components: {
    version: COMPONENT_VERSION,
    accepted: state.componentsVersion === COMPONENT_VERSION,
    installed: existsSync(require('node:path').join(componentsDir(), 'python', 'python.exe')),
    dir: componentsDir(),
  },
  platforms: ['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'twitter', 'tiktok', 'vimeo'],
}));

ipcMain.handle('legal-accept', (_e, kind) => {
  if (kind === 'components') {
    state.componentsVersion = COMPONENT_VERSION;
    state.componentsAt = Date.now();
  } else {
    state.legalVersion = LEGAL_VERSION;
    state.legalAt = Date.now();
  }
  saveState(state);
  return true;
});

/* 下载第三方组件包（抖音签名器：内置 Python + TikTokDownloader 签名实现） */
ipcMain.handle('components-install', async (event) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFile } = require('node:child_process');

  const dir = componentsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const zipPath = path.join(os.tmpdir(), 'lodown-components-' + COMPONENT_VERSION + '.zip');

  const origin = 'https://github.com/lohana20061023-29/media-downloader-app/releases/download/components-v' + COMPONENT_VERSION + '/lodown-components-' + COMPONENT_VERSION + '.zip';
  /* 国内直连 GitHub 常失败/极慢：镜像优先 */
  const urls = [
    ['gh-proxy.com', 'https://gh-proxy.com/' + origin],
    ['ghfast.top', 'https://ghfast.top/' + origin],
    ['GitHub', origin],
  ];

  const send = (stage, pct) => { try { event.sender.send('components-progress', { stage, pct }); } catch {} };

  let okFile = false;
  let lastErr = '';
  for (const [host, u] of urls) {
    try {
      send('连接 ' + host + '…', 3);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240000);
      const res = await fetch(u, { redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const totalLen = Number(res.headers.get('content-length') || 0);
      const chunks = [];
      let got = 0;
      let lastPct = -1;
      for await (const chunk of res.body) {
        chunks.push(chunk);
        got += chunk.length;
        if (totalLen) {
          const pct = Math.min(65, 5 + Math.round((got / totalLen) * 60));
          if (pct !== lastPct) { lastPct = pct; send('下载组件包 ' + (got / 1048576).toFixed(1) + ' / ' + (totalLen / 1048576).toFixed(1) + ' MB', pct); }
        }
      }
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      if (buf.length < 1024 * 1024) throw new Error('文件不完整');
      await fs.promises.writeFile(zipPath, buf);
      okFile = true;
      break;
    } catch (err) {
      lastErr = err.message;
    }
  }

  if (!okFile) throw new Error('组件包下载失败（已尝试镜像）：' + lastErr);

  send('解压组件包…', 75);
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zipPath, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
  send('完成', 100);
  return { ok: true, dir };
});
/* ── 解析组件（分项管理） ── */
const COMPONENTS = [
  { id: 'python', name: 'Python 3.11 运行时', license: 'PSF License', sub: 'python' },
  { id: 'sign', name: 'TikTokDownloader 签名实现', license: 'Apache-2.0', sub: 'sign' },
  { id: 'ytdlp', name: 'yt-dlp 通用解析', license: 'Unlicense', sub: 'ytdlp' },
];

function compPath(c) {
  const dir = componentsDir();
  const base = require('node:path').join(dir, c.sub);
  if (c.id === 'python') return require('node:path').join(base, 'python.exe');
  if (c.id === 'sign') return require('node:path').join(base, 'sign.py');
  return require('node:path').join(base, 'yt-dlp.exe');
}

function compState(c) {
  const dir = componentsDir();
  const on = compPath(c);
  const off = require('node:path').join(dir, c.sub + '.off');
  return {
    id: c.id,
    name: c.name,
    license: c.license,
    installed: existsSync(on),
    disabled: !existsSync(on) && existsSync(off),
  };
}

ipcMain.handle('components-status', () => COMPONENTS.map(compState));

ipcMain.handle('components-action', async (event, payload) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const id = payload && payload.id;
  const action = payload && payload.action;
  const c = COMPONENTS.find((x) => x.id === id);
  if (!c) return { ok: false, error: '未知组件' };

  const dir = componentsDir();
  const live = path.join(dir, c.sub);
  const off = path.join(dir, c.sub + '.off');

  const send = (stage, pct) => { try { event.sender.send('components-progress', { stage, pct }); } catch {} };

  const grab = async (urls, minSize) => {
    let lastErr = '';
    for (const u of urls) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 240000);
        const res = await fetch(u, { redirect: 'follow', signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < (minSize || 1024)) throw new Error('内容过小');
        return buf;
      } catch (err) { lastErr = err.message; }
    }
    throw new Error(lastErr || '下载失败');
  };

  try {
    if (action === 'disable') {
      if (fs.existsSync(live)) fs.renameSync(live, off);
    } else if (action === 'enable') {
      if (fs.existsSync(off)) fs.renameSync(off, live);
    } else if (action === 'remove') {
      for (const d of [live, off]) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } else if (action === 'install') {
      const origin = 'https://github.com/lohana20061023-29/media-downloader-app/releases/download/components-v1/lodown-components-1.zip';
      const mirrors = ['https://gh-proxy.com/' + origin, 'https://ghfast.top/' + origin, origin];

      if (c.id === 'python' || c.id === 'sign') {
        send('下载组件包…', 5);
        const buf = await grab(mirrors, 1024 * 1024);
        const zipPath = path.join(os.tmpdir(), 'lodown-components-1.zip');
        fs.writeFileSync(zipPath, buf);
        send('解压…', 70);
        await new Promise((resolve, reject) => {
          execFile('tar', ['-xf', zipPath, '-C', dir], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
        });
        if (c.id === 'sign' && !fs.existsSync(path.join(dir, 'sign', 'sign.py'))) {
          return { ok: false, error: '组件包里没有签名实现', list: COMPONENTS.map(compState) };
        }
        if (c.id === 'python' && !fs.existsSync(path.join(dir, 'python', 'python.exe'))) {
          return { ok: false, error: '组件包里没有 Python 运行时', list: COMPONENTS.map(compState) };
        }
      } else if (c.id === 'ytdlp') {
        send('下载 yt-dlp…', 5);
        const yt = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
        const buf = await grab(['https://gh-proxy.com/' + yt, 'https://ghfast.top/' + yt, yt], 1024 * 1024);
        fs.mkdirSync(path.join(dir, 'ytdlp'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ytdlp', 'yt-dlp.exe'), buf);
      }
      send('完成', 100);
    }
    return { ok: true, list: COMPONENTS.map(compState) };
  } catch (err) {
    return { ok: false, error: err.message, list: COMPONENTS.map(compState) };
  }
});

/* ── 平台退登：清 Cookie 与站点存储 ── */
const PLATFORM_DOMAINS = {
  bilibili: ['bilibili.com', 'bilivideo.com', 'biliapi.net', 'hdslb.com', 'biliapi.com'],
  douyin: ['douyin.com', 'iesdouyin.com', 'douyinpic.com', 'douyinvod.com', 'bytedance.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhscdn.com', 'xhs.cn'],
  youtube: ['youtube.com', 'googlevideo.com', 'ytimg.com', 'google.com'],
  twitter: ['twitter.com', 'x.com', 'twimg.com'],
  tiktok: ['tiktok.com', 'tiktokcdn.com', 'ttwstatic.com'],
  vimeo: ['vimeo.com', 'vimeocdn.com'],
};

ipcMain.handle('logout-platform', async (_e, key) => {
  const fs = require('node:fs');
  const domains = PLATFORM_DOMAINS[key] || [];
  if (!domains.length) return { ok: false, error: '未知平台' };

  /* 0) 清掉旧版登录分区（persist:login-*）里的同平台数据，否则会被重新同步回 jar */
  for (const key of LOGIN_ALLOW) {
    try {
      const ses = session.fromPartition('persist:login-' + key);
      const cs = await ses.cookies.get({});
      for (const c of cs) {
        const host = String(c.domain || '').replace(/^\./, '');
        if (!domains.some((d) => host === d || host.endsWith('.' + d))) continue;
        try { await ses.cookies.remove('https://' + host + (c.path || '/'), c.name); } catch {}
      }
    } catch {}
  }

  /* 1) 清默认会话里的 cookie / 存储 */
  try {
    const ses = session.defaultSession;
    const cookies = await ses.cookies.get({});
    for (const c of cookies) {
      if (domains.some((d) => String(c.domain || '').replace(/^\./, '').endsWith(d))) {
        try { await ses.cookies.remove('https://' + String(c.domain).replace(/^\./, '') + c.path, c.name); } catch {}
      }
    }
    for (const d of domains) {
      try { await ses.clearStorageData({ origin: 'https://' + d }); } catch {}
      try { await ses.clearStorageData({ origin: 'https://www.' + d }); } catch {}
    }
  } catch {}

  /* 2) 从共享 cookies.txt 里删掉对应行 */
  try {
    const jar = require('node:path').join(require('node:os').homedir(), '.dsh', 'bili-dl', 'cookies.txt');
    if (fs.existsSync(jar)) {
      const text = fs.readFileSync(jar, 'utf8');
      const kept = text.split(/\r?\n/).filter((line) => {
        if (!line || line.startsWith('#')) return true;
        const domain = String(line.split('\t')[0] || '').replace(/^\./, '');
        return !domains.some((d) => domain.endsWith(d));
      });
      fs.writeFileSync(jar, kept.join('\n'), 'utf8');
    }
  } catch {}

  /* 2.5) 记录退登时间，后续自动同步跳过该平台 */
  try {
    const marks = state.logoutAt || {};
    marks[key] = Date.now();
    saveState({ logoutAt: marks });
  } catch {}

  /* 3) 重新计算状态（不再把旧 Cookie 同步回来） */
  try {
    const e = await loadEngine();
    let st = {};
    try { st = await e.browserLogin.detectLogins(); } catch {}
    const platforms = Object.entries(e.browserLogin.PLATFORMS)
      .filter(([id]) => LOGIN_ALLOW.includes(id))
      .map(([id, p2]) => ({ id, label: p2.label, logged: !!st[id] }));
    return { ok: true, platforms };
  } catch (err) {
    return { ok: true, platforms: [] };
  }
});

ipcMain.handle('bootstrap', () => {
  /* 不加载引擎、不发网络请求：只回本地状态，保证首屏秒开 */
  const bundled = bundledFfmpeg();
  let ffmpeg = null;
  try {
    if (bundled && require('node:fs').existsSync(bundled)) ffmpeg = bundled;
    else if (state.ffmpeg && require('node:fs').existsSync(state.ffmpeg)) ffmpeg = state.ffmpeg;
  } catch {}
  return {
    outDir: state.outDir,
    copyToast: state.copyToast,
    proxy: state.proxy,
    version: app.getVersion(),
    ffmpeg,
  };
});

/* 登录态单独查，前端拿到后再刷新，不阻塞首屏 */
ipcMain.handle('bootstrap-login', async () => {
  const e = await loadEngine();
  const me = await Promise.race([
    e.bili.loginStatus().catch(() => ({ login: false, uname: '', face: '' })),
    new Promise((r) => setTimeout(() => r({ login: false, uname: '', face: '' }), 1500)),
  ]);
  let sites = {};
  try { sites = await e.browserLogin.detectLogins(); } catch {}
  return { login: me, loginSites: sites };
});

/* 抖音：开一个隐藏窗口加载笔记页，用调试协议截获页面自己发出的
   aweme/detail 响应（带真实登录态与签名），拿到 1080P 画质与实况图动态流 */
ipcMain.handle('douyin-capture', async (_e, target) => {
  const { BrowserWindow, session } = require('electron');
  const id = (/(?:note|video)\/(\d{15,25})/.exec(String(target)) || [])[1] || '';
  if (!id) return { ok: false, error: '无法解析作品 ID' };

  const urls = [
    'https://www.douyin.com/note/' + id,
    'https://www.douyin.com/video/' + id,
  ];

  const capture = (url) => new Promise((resolve) => {
    let win;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { win.webContents.debugger.detach(); } catch {}
      try { win.destroy(); } catch {}
      resolve(payload);
    };

    win = new BrowserWindow({
      show: true, x: -32000, y: -32000, skipTaskbar: true, width: 1280, height: 900,
      webPreferences: { session: session.defaultSession, offscreen: false, backgroundThrottling: false },
    });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    const dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); } catch { finish(null); return; }
    (async () => {
      try {
        await dbg.sendCommand('Network.enable');
      } catch {}
      dbg.on('message', async (_event, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const u = params?.response?.url || '';
        if (!/aweme\/detail|aweme\/v1\/web\/aweme/.test(u)) return;
        try {
          const body = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          finish(JSON.parse(text));
        } catch { finish(null); }
      });
    })();

    win.loadURL(url).catch(() => finish(null));
    setTimeout(() => finish(null), 22000);
  });

  for (const url of urls) {
    const json = await capture(url);
    const a = json && (json.aweme_detail || (json.aweme_details || [])[0]);
    if (a) {
      try {
        const e = await loadEngine();
        const info = e.douyin.normalizeAwemeItem(a, id);
        e.bili.registerImage(info.cover);
        (info.images || []).forEach((x) => e.bili.registerImage(x.url));
        e.bili.registerImage(info.up?.face);
        return { ok: true, info };
      } catch (err) { return { ok: false, error: err.message }; }
    }
  }
  return { ok: false, error: '没截到详情数据' };
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

  /* 登录窗口现在跑在默认会话里 */
  const ses = session.defaultSession;
  /* cookies.get({domain}) 只做精确匹配，拿不到 .youtube.com / accounts.google.com 这类，
     这里改成取全量再按域名后缀筛 */
  let fetched = [];
  /* 默认会话 + 历史登录分区都读一遍，避免分区迁移时丢登录态 */
  const sessList = [ses];
  for (const k of [...LOGIN_ALLOW, 'pending']) {
    try { sessList.push(session.fromPartition('persist:login-' + k)); } catch {}
  }
  for (const s2 of sessList) {
    try {
      const all = await s2.cookies.get({});
      fetched = fetched.concat(all.filter((c) => {
        const host = String(c.domain || '').replace(/^\./, '').toLowerCase();
        return p.domains.some((d) => host === d || host.endsWith('.' + d));
      }));
    } catch {}
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
    rows.push(jarLine(domain, c.path, c.secure, expires(c), c.name, c.value));
  }

  try {
    const path = require('node:path');
    const fs = require('node:fs');
    fs.mkdirSync(path.dirname(e.browserLogin.COOKIE_FILE), { recursive: true });
    fs.writeFileSync(e.browserLogin.COOKIE_FILE, normalizeJar(rows.join('\n')), 'utf8');
  } catch (err) {
    return { ok: false, error: '写入失败：' + err.message };
  }

  /* 重新登录 → 清除该平台的退登标记 */
  try {
    const marks = { ...(state.logoutAt || {}) };
    delete marks[key];
    saveState({ logoutAt: marks });
  } catch {}

  /* 注入默认会话，让浏览页的 webview 也处于登录态 */
  try {
    const ses0 = session.defaultSession;
    for (const c of list) {
      const host = String(c.domain || '').replace(/^\./, '');
      /* 不传 domain，让 Electron 按 url 自己推导，避免 host-only / 域 cookie 冲突 */
      const url = 'https://' + host + (c.path || '/');
      await ses0.cookies.set({
        url, name: c.name, value: c.value, path: c.path || '/',
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate,
      }).catch(() => {});
    }
    await ses0.cookies.flushStore().catch(() => {});
  } catch {}

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
function cleanTitle(t) {
  const v = String(t || '').trim();
  if (!v || v === 'about:blank' || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return '';
  return v.slice(0, 200);
}

ipcMain.handle('browse-add', (_e, item) => {
  if (!item || !item.url || !/^https?:/i.test(item.url)) return Array.isArray(state.browse) ? state.browse : [];
  const clean = cleanUrl(item.url);
  const list = (Array.isArray(state.browse) ? state.browse : []).filter((x) => cleanUrl(x.url) !== clean);
  const next = [{ url: cleanUrl(item.url), title: cleanTitle(item.title) || cleanUrl(item.url), icon: item.icon || '', at: Date.now() }, ...list].slice(0, 500);
  saveState({ browse: next });
  return next;
});
/* 去掉跟踪参数，避免同一条记录被存成好几份 */
function cleanUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '');
    const keep = {};

    /* 各站点只保留真正区分内容的参数 */
    const KEEP = {
      'youtube.com': ['v', 'list', 'index', 't'],
      'youtu.be': ['t'],
      'bilibili.com': ['p'],
      'twitter.com': [],
      'x.com': [],
      'douyin.com': [],
      'xiaohongshu.com': ['xsec_token'],
    };
    const keys = KEEP[host] || null;
    if (keys) {
      for (const k of keys) if (url.searchParams.has(k)) keep[k] = url.searchParams.get(k);
      const q = new URLSearchParams(keep).toString();
      return url.origin + url.pathname + (q ? '?' + q : '');
    }

    /* 其它站点：只删掉明确的跟踪参数 */
    for (const k of ['vd_source', 'share_source', 'share_medium', 'share_plat', 'share_tag', 'spm_id_from', 'trackid', 'unique_k', 'from_source', 'from_spmid', 'timestamp', 'buvid', 'up_id', 'broadcast_type', 'is_room_feed', 'feature', 'si', 'pp']) {
      url.searchParams.delete(k);
    }
    return url.origin + url.pathname + (url.search || '');
  } catch { return u; }
}


ipcMain.handle('browse-update-at', (_e, payload) => {
  const list = Array.isArray(state.browse) ? state.browse : [];
  const at = Number(payload && payload.at);
  if (!at) return list;
  const hit = list.find((x) => x.at === at);
  if (!hit) return list;
  let changed = false;
  if (payload.title && payload.title !== hit.title) { hit.title = String(payload.title).slice(0, 200); changed = true; }
  if (payload.url && payload.url !== hit.url) { hit.url = String(payload.url); changed = true; }
  if (payload.icon && payload.icon !== hit.icon) { hit.icon = payload.icon; changed = true; }
  if (changed) saveState({ browse: list });
  return list;
});

ipcMain.handle('browse-title-at', (_e, payload) => {
  const list = Array.isArray(state.browse) ? state.browse : [];
  const at = Number(payload && payload.at);
  const title = payload && payload.title;
  if (!at || !title) return list;
  const hit = list.find((x) => x.at === at);
  if (hit && hit.title !== title) {
    hit.title = String(title).slice(0, 200);
    if (payload.icon) hit.icon = payload.icon;
    saveState({ browse: list });
  }
  return list;
});

ipcMain.handle('browse-set-title', (_e, payload) => {
  const url = payload && payload.url;
  const title = payload && payload.title;
  if (!url || !title) return Array.isArray(state.browse) ? state.browse : [];

  const clean = cleanUrl(url);
  const list = Array.isArray(state.browse) ? state.browse : [];
  const idx = list.findIndex((it) => cleanUrl(it.url) === clean);

  if (idx >= 0) {
    if (list[idx].title !== title) {
      list[idx].title = String(title).slice(0, 200);
      if (payload.icon) list[idx].icon = payload.icon;
      saveState({ browse: list });
    }
  } else {
    /* 标题事件比 browse-add 先到：直接补一条 */
    list.unshift({ url: clean, title: String(title).slice(0, 200), icon: payload.icon || '', at: Date.now() });
    saveState({ browse: list.slice(0, 500) });
  }
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
ipcMain.handle('read-image', async (_e, file) => {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const buf = await fs.promises.readFile(file);
    if (!buf.length || buf.length > 12 * 1024 * 1024) return '';
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch { return ''; }
});

ipcMain.handle('open-file', async (_e, file) => {
  try { const { shell } = require('electron'); const err = await shell.openPath(file); return !err; } catch { return false; }
});

ipcMain.handle('delete-file', async (_e, file) => {
  try { await require('node:fs').promises.unlink(file); return true; } catch { return false; }
});

ipcMain.handle('reveal', (_e, p) => { if (p) shell.showItemInFolder(p); });

ipcMain.handle('toast-open', (_e, url) => {
  if (toastWin) { try { toastWin.close(); } catch {} }
  showMain();
  if (mainWin) mainWin.webContents.send('open-url', url);
});

/* ── 托盘 / 生命周期 ──────────────────────────────────── */
function createTray() {
  try {
    let icon = nativeImage.createFromPath(join(__dirname, 'renderer', 'icon.ico'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(join(__dirname, 'renderer', 'icon.png'));
  icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('LOHANA DX');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开窗口', click: showMain },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', showMain);
  } catch (e) { console.error('托盘创建失败', e); }
}

/* 改名后仍沿用旧的数据目录，历史记录与设置不丢 */
try {
  const path = require('node:path');
  app.setName('LOHANA DX');
  app.setPath('userData', path.join(app.getPath('appData'), 'LoDown'));
} catch {}

/* 单实例：已经开着时再双击图标，只把现有窗口唤到前面 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    try {
      if (mainWin.isMinimized()) mainWin.restore();
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    } catch {}
  });
}

app.whenReady().then(async () => {
  try { process.env.LODOWN_COMPONENTS = require('node:path').join(app.getPath('userData'), 'components'); } catch {}
  bootMark('app-ready');
  try { await importJarToSession(); } catch {}
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
/* 抖音详情缓存：浏览时页面自己发出的 aweme/detail 响应（带签名与登录态）会被截下来，
   解析时优先用它，从而拿到 1080P 与实况图动态流 */
const awemeCache = new Map();

ipcMain.handle('douyin-cached', async (_e, target) => {
  const id = (/(?:note|video)\/(\d{15,25})/.exec(String(target)) || [])[1];
  if (!id || !awemeCache.has(id)) return { ok: false };
  try {
    const e = await loadEngine();
    const info = e.douyin.normalizeAwemeItem(awemeCache.get(id), id);
    e.bili.registerImage(info.cover);
    (info.images || []).forEach((x) => e.bili.registerImage(x.url));
    return { ok: true, info };
  } catch (err) { return { ok: false, error: err.message }; }
});

app.on('web-contents-created', (_event, contents) => {
  try {
    if (contents.getType() !== 'webview') return;

    /* 调试协议：抓页面自己发出的抖音详情请求 */
    try {
      const dbg = contents.debugger;
      dbg.attach('1.3');
      dbg.sendCommand('Network.enable').catch(() => {});
      dbg.on('message', async (_e2, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const u = params?.response?.url || '';
        const m2 = /aweme\/v1\/web\/aweme\/detail/.test(u);
        if (!m2) return;
        try {
          const body = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          const j = JSON.parse(text);
          const a = j.aweme_detail || (j.aweme_details || [])[0];
          if (a && a.aweme_id) awemeCache.set(String(a.aweme_id), a);
        } catch {}
      });
    } catch {}
    /* 有些站点用协议相对地址（//space.bilibili.com/…），补成 https 再判断 */
    const abs = (u) => (String(u || '').startsWith('//') ? 'https:' + u : String(u || ''));

    contents.on('will-frame-navigate', (e) => {
      const u = abs(e.url);
      if (!/^https?:/i.test(u)) e.preventDefault();
    });

    contents.on('will-navigate', (e, url) => {
      const u = abs(url);
      if (/^https?:/i.test(u)) return;
      e.preventDefault();
    });

    contents.setWindowOpenHandler(({ url }) => {
      const target = abs(url);
      if (/^https?:/i.test(target) && mainWin) mainWin.webContents.send('open-url', target);
      return { action: 'deny' };
    });
  } catch (err) { console.error('window-open 拦截失败', err); }
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => { app.isQuitting = true; });