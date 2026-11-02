/* LoDown：真浏览器界面
   浏览 = 内嵌 webview 打开原网页；历史 = 浏览记录；下载 = 分状态列表；
   支持站点在工具栏出现「下载此页」，解析结果在右侧栏选择。 */
let S = {
  boot: null,
  view: 'browse',          // browse | downloads | history | settings
  page: 'home',            // home（起始页） | web
  url: '',
  info: null,
  pick: null,
  parsedUrl: '',
  dlFilter: 'all',         // all | waiting | running | done | failed
  jobs: [],                // [{id,title,status,items,at}]
  history: [],             // 浏览记录
  downloads: [],           // 下载历史
  sites: [],
  sessionHint: '',
  err: '',
};

const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const k of kids) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const icon = (d) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
};
const fmtDate = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const SUPPORTED = /(bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.(com|cn)|douyin\.com|youtube\.com|youtu\.be|(^|\/\/)x\.com|twitter\.com|tiktok\.com|vimeo\.com)/i;
const normalize = (v) => {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(t)) return 'https://' + t;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(t);
};

/* ── 启动 ── */
async function boot() {
  S.boot = await window.api.bootstrap();
  S.history = await window.api.browseList();
  S.downloads = await window.api.historyList();

  $('back').onclick = () => { try { view()?.goBack(); } catch {} };
  $('forward').onclick = () => { try { view()?.goForward(); } catch {} };
  $('reload').onclick = () => { if (S.page === 'web') view()?.reload(); };
  $('home').onclick = goHome;
  $('download').onclick = () => beginParse(S.url);

  $('addr').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const u = normalize($('addr').value);
    if (u) navigate(u);
  });

  for (const v of ['browse', 'downloads', 'history', 'settings']) {
    $('nav-' + v).onclick = () => setView(v);
  }

  const wv = view();
  wv.addEventListener('did-navigate', onNavigate);
  wv.addEventListener('did-navigate-in-page', onNavigate);
  wv.addEventListener('page-title-updated', () => {
    if (S.page === 'web') window.api.browseAdd({ url: S.url, title: view()?.getTitle?.() || S.url });
  });
  wv.addEventListener('new-window', (e) => { e.preventDefault(); navigate(e.url); });

  window.api.onOpenUrl((url) => navigate(normalize(url)));
  window.api.onLoginSession((d) => {
    if (!d) return;
    if (d.state === 'ok') S.sessionHint = '已保存 Cookie（' + (d.count || 0) + ' 条）';
    else if (d.state === 'waiting') S.sessionHint = '登录窗口已打开…';
    else if (d.state === 'error') S.sessionHint = '登录检测出错：' + (d.message || '');
    if (S.view === 'settings') renderPage();
  });

  goHome();
  refreshSites();
  setView('browse');
}

const view = () => $('view');

function goHome() {
  S.page = 'home';
  S.url = '';
  $('addr').value = '';
  $('startpage').style.display = '';
  $('download').disabled = true;
  $('view').style.visibility = 'hidden';
  setView('browse');
}

function navigate(url) {
  S.page = 'web';
  S.url = url;
  $('addr').value = url;
  $('startpage').style.display = 'none';
  $('view').style.visibility = 'visible';
  try { view().loadURL(url); } catch { setTimeout(() => { try { view().loadURL(url); } catch {} }, 300); }
  setView('browse');
}

async function onNavigate(e) {
  const url = e.url || '';
  if (!/^https?:/i.test(url)) return;
  S.url = url;
  $('addr').value = url;
  $('download').disabled = !SUPPORTED.test(url);
  const title = (() => { try { return view().getTitle(); } catch { return ''; } })();
  S.history = await window.api.browseAdd({ url, title: title || url });
}

/* ── 视图切换 ── */
function setView(v) {
  S.view = v;
  for (const x of ['browse', 'downloads', 'history', 'settings']) $('nav-' + x).classList.toggle('on', x === v);

  const isBrowse = v === 'browse';
  $('toolbar').style.display = isBrowse ? '' : 'none';
  $('workspace').hidden = !isBrowse;     // 非浏览时整块收起，page 才能占满
  $('page').hidden = isBrowse;
  $('side').hidden = false;              // 侧栏常驻

  if (isBrowse) renderSide();            // 未解析时渲染占位
  else renderPage();
}

/* ── 页面：下载 / 历史 / 设置 ── */
function renderPage() {
  const box = $('page');
  box.replaceChildren();
  if (S.view === 'downloads') renderDownloads(box);
  else if (S.view === 'history') renderHistory(box);
  else if (S.view === 'settings') renderSettings(box);
}

function statusOf(job) {
  if (job.status === 'error') return 'failed';
  if (job.status === 'done') return 'done';
  const items = job.items || [];
  const started = items.some((i) => i.status === 'running' || i.received > 0);
  return started ? 'running' : 'waiting';
}

function renderDownloads(box) {
  const counts = { all: S.jobs.length, waiting: 0, running: 0, done: 0, failed: 0 };
  for (const j of S.jobs) counts[statusOf(j)]++;

  const segs = h('div', { className: 'segs' });
  const defs = [['all', '全部'], ['waiting', '等待下载'], ['running', '下载中'], ['done', '已完成'], ['failed', '下载失败']];
  for (const [k, label] of defs) {
    const s = h('div', { className: 'seg' + (S.dlFilter === k ? ' on' : '') }, label, h('span', { className: 'n' }, counts[k]));
    s.onclick = () => { S.dlFilter = k; renderPage(); };
    segs.append(s);
  }
  const clear = h('button', { className: 'ghost' }, '清除已结束');
  clear.onclick = () => { S.jobs = S.jobs.filter((j) => !['done', 'error'].includes(j.status)); renderPage(); };
  segs.append(h('div', { className: 'right' }, clear));
  box.append(segs);

  const list = S.jobs.filter((j) => S.dlFilter === 'all' || statusOf(j) === S.dlFilter);
  if (!list.length) {
    box.append(h('div', { className: 'empty' }, icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'), h('div', {}, '暂无下载')));
    return;
  }

  for (const job of list) {
    const card = h('div', { className: 'card' }, h('div', { className: 'item' },
      h('span', { className: 'nm', style: 'font-weight:600' }, job.title || job.id),
      h('span', { className: 'pc', style: 'width:auto;color:var(--sub)' }, fmtDate(job.at || Date.now())),
    ));
    for (const it of job.items || []) {
      const pct = it.total ? Math.round((it.received / it.total) * 100) : (it.status === 'done' ? 100 : 0);
      card.append(h('div', { className: 'item' },
        h('span', { className: 'nm', style: 'font-weight:400;color:var(--sub)' }, it.label || it.name || '文件'),
        h('div', { className: 'pbar' }, Object.assign(h('i'), { style: `width:${pct}%` })),
        h('span', { className: 'pc' }, it.status === 'done' ? '✓' : pct + '%'),
      ));
    }
    box.append(card);
  }
}

function renderHistory(box) {
  const segs = h('div', { className: 'segs' },
    h('div', { className: 'seg on' }, '浏览记录', h('span', { className: 'n' }, S.history.length)),
  );
  if (S.history.length) {
    const clr = h('button', { className: 'ghost' }, '清空');
    clr.onclick = async () => { S.history = await window.api.browseClear(); renderPage(); };
    segs.append(h('div', { className: 'right' }, clr));
  }
  box.append(segs);

  if (!S.history.length) {
    box.append(h('div', { className: 'empty' }, icon('M12 8v4l3 2M4 12a8 8 0 1 1 8 8'), h('div', {}, '还没有浏览记录')));
    return;
  }

  const card = h('div', { className: 'card' });
  for (const it of S.history) {
    const open = h('span', { className: 'lnk' }, '打开');
    open.onclick = () => navigate(it.url);
    const del = h('span', { className: 'lnk', style: 'color:var(--sub)' }, '删除');
    del.onclick = async () => { S.history = await window.api.browseRemove(it.url); renderPage(); };
    card.append(h('div', { className: 'item' },
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { className: 'nm', style: 'font-weight:500' }, it.title || it.url),
        h('div', { className: 'sub2' }, it.url.replace(/^https?:\/\//, '').slice(0, 80)),
      ),
      h('span', { className: 'pc', style: 'width:96px' }, fmtDate(it.at)),
      open, del,
    ));
  }
  box.append(card);
}

async function refreshSites() {
  const r = await window.api.loginSites().catch(() => ({ platforms: [] }));
  S.sites = r.platforms || [];
}

function renderSettings(box) {
  box.append(h('div', { className: 'h1' }, '设置'));

  const dirCard = h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '下载目录'),
      h('span', { className: 'v', title: S.boot.outDir }, S.boot.outDir),
      (() => { const b = h('button', { className: 'ghost' }, '更换'); b.onclick = async () => { const r = await window.api.pickDir(); if (r.dir) { S.boot.outDir = r.dir; renderPage(); } }; return b; })(),
    ),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, 'ffmpeg'),
      h('span', { className: 'v' }, S.boot.ffmpeg ? '已内置' : '未找到')),
  );
  box.append(dirCard);

  const acc = h('div', { className: 'card' });
  for (const p of S.sites) {
    const login = h('button', { className: 'ghost' }, '登录');
    login.onclick = async () => {
      const r = await window.api.openSiteLogin(p.id);
      S.sessionHint = r.ok ? `已打开 ${p.label}，登录完点「完成登录」` : ('打开失败：' + r.error);
      renderPage();
    };
    acc.append(h('div', { className: 'kv' },
      h('span', { className: 'k' }, p.label),
      h('span', { className: 'v', style: p.logged ? 'color:var(--ok);font-weight:600' : 'color:var(--sub)' }, p.logged ? '已登录' : '未登录'),
      login,
    ));
  }
  const finish = h('button', { className: 'ghost' }, '完成登录');
  finish.onclick = async () => {
    const r = await window.api.finishSiteLogin();
    S.sessionHint = r.ok ? `已保存 Cookie${r.count ? '（' + r.count + ' 条）' : ''}` : ('保存失败：' + r.error);
    await refreshSites(); renderPage();
  };
  acc.append(h('div', { className: 'kv' },
    h('span', { className: 'k' }, '登录'),
    h('span', { className: 'v', style: 'color:var(--sub)' }, S.sessionHint || '未打开登录窗口'),
    finish,
  ));
  box.append(acc);

  box.append(h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '版本'), h('span', { className: 'v' }, 'v' + S.boot.version)),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '更新'), h('span', { className: 'v' }, '启动时检查 GitHub Release')),
  ));
}

/* ── 解析与下载 ── */
async function beginParse(url) {
  const dl = $('download');
  dl.disabled = true;
  dl.textContent = '解析中…';
  try {
    const info = await window.api.probe(url);
    S.info = info;
    S.parsedUrl = url;
    S.pick = {
      videoQn: info.videos?.[0]?.qn ?? null,
      audio: true, audioId: null, audioMp3: true,
      coverIds: [], avatar: false, imageIds: [],
    };
    S.err = '';
    renderSide();
  } catch (e) {
    S.err = e.message || String(e);
    renderSide();
  } finally {
    dl.textContent = '下载此页';
    dl.disabled = false;
  }
}

function renderSide() {
  const box = $('side');
  box.replaceChildren();

  if (S.err) { box.append(h('div', { className: 'err' }, '解析失败：' + S.err)); return; }
  const info = S.info;
  if (!info) {
    box.append(h('div', { className: 'h1', style: 'font-size:14px' }, '下载内容'));
    box.append(h('div', { className: 'empty', style: 'padding:38px 0' },
      icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'),
      h('div', {}, '打开支持的站点后，点右上角「下载此页」'),
    ));
    return;
  }
  const pick = S.pick;

  box.append(h('div', { className: 'h1', style: 'font-size:14px' }, '下载内容'));
  box.append(h('div', { style: 'font-size:12px;color:var(--sub);margin:-6px 0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, info.title || ''));

  if (info.videos?.length) {
    const opts = h('div', { className: 'opts' });
    for (const v of info.videos) {
      const on = pick.videoQn === v.qn;
      const o = h('div', { className: 'opt' + (on ? ' on' : '') }, v.label || `${v.height}P`);
      o.onclick = () => { pick.videoQn = on ? null : v.qn; renderSide(); };
      opts.append(o);
    }
    box.append(h('div', { className: 'sec' }, h('h4', {}, '视频', h('span', {}, pick.videoQn ? '点一下取消' : '未选')), opts));
  }

  if (info.audios?.length || info.videos?.length) {
    const a = h('input', { type: 'checkbox' }); a.checked = pick.audio;
    a.onchange = (e) => { pick.audio = e.target.checked; };
    const m = h('input', { type: 'checkbox' }); m.checked = pick.audioMp3;
    m.onchange = (e) => { pick.audioMp3 = e.target.checked; };
    box.append(h('div', { className: 'sec' }, h('h4', {}, '音频'),
      h('div', { className: 'opts' }, h('label', { className: 'chk' }, a, '额外音频'), h('label', { className: 'chk' }, m, '转 MP3'))));
  }

  if (info.covers?.length || info.up?.face) {
    const picks = h('div', { className: 'picks' });
    const card = (url, on, cap, round, toggle) => {
      const el = h('div', { className: 'pick' + (round ? ' round' : '') + (on ? ' on' : ''), title: cap },
        h('div', { className: 'frame' }, h('img', { src: url, referrerPolicy: 'no-referrer' })),
        h('span', { className: 'cap' }, cap));
      el.onclick = () => { toggle(); renderSide(); };
      return el;
    };
    for (const c of info.covers || []) {
      const on = pick.coverIds.includes(c.id);
      picks.append(card(c.url, on, c.label || '封面', false, () => {
        pick.coverIds = on ? pick.coverIds.filter((x) => x !== c.id) : [...pick.coverIds, c.id];
      }));
    }
    if (info.up?.face) picks.append(card(info.up.face, pick.avatar, '头像', true, () => { pick.avatar = !pick.avatar; }));
    box.append(h('div', { className: 'sec' }, h('h4', {}, '封面 / 头像'), picks));
  }

  if (info.images?.length) {
    const picks = h('div', { className: 'picks' });
    for (const img of info.images) {
      const on = (pick.imageIds || []).includes(img.id);
      const el = h('div', { className: 'pick' + (on ? ' on' : '') },
        h('div', { className: 'frame' }, h('img', { src: img.url, referrerPolicy: 'no-referrer' })));
      el.onclick = () => {
        const cur = pick.imageIds || [];
        pick.imageIds = on ? cur.filter((x) => x !== img.id) : [...cur, img.id];
        renderSide();
      };
      picks.append(el);
    }
    box.append(h('div', { className: 'sec' }, h('h4', {}, `图文 · ${info.images.length} 张`), picks));
  }

  const start = h('button', { style: 'width:100%' }, '开始下载');
  start.onclick = () => startDownload();
  box.append(start);
}

async function startDownload() {
  if (!S.info) return;
  const job = await window.api.start({ url: S.parsedUrl, info: S.info, pick: S.pick });
  const rec = { id: job.id, title: S.info.title, cover: S.info.cover, items: job.items || [], at: Date.now(), status: job.status || 'running' };
  S.jobs.unshift(rec);
  S.info = null; S.pick = null; S.err = '';
  setView('downloads');
  poll(rec);
}

async function poll(rec) {
  const tick = async () => {
    const job = await window.api.job(rec.id);
    if (!job) return;
    rec.items = job.items;
    rec.status = job.status;
    if (S.view === 'downloads') renderPage();
    if (job.status === 'done' || job.status === 'error') {
      if (job.status === 'done') {
        S.downloads = await window.api.historyAdd({
          key: rec.id, url: S.parsedUrl || '', title: rec.title, cover: rec.cover,
          kind: 'media', outDir: S.boot.outDir, at: Date.now(),
        });
      }
      return;
    }
    setTimeout(tick, 700);
  };
  tick();
}

boot();
