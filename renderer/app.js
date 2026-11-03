/* LoDown：多标签浏览器
   浏览 = 每个标签一个 webview；历史 = 浏览记录；下载 = 分状态列表；
   支持的站点自动解析，资源面板默认展开、可关闭，起始页不显示。 */
let S = {
  boot: null,
  view: 'browse',            // browse | downloads | history | settings
  tabs: [],                  // [{id, url, title, wv, info, pick, err, panelOpen}]
  activeId: null,
  homeId: 'home',
  jobs: [],
  history: [],
  downloads: [],
  sites: [],
  sessionHint: '',
  dlFilter: 'all',
  dlTime: 'all',
  histTime: 'all',
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
const uid = () => Math.random().toString(36).slice(2, 9);
const fmtDate = (t) => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const SUPPORTED = /(bilibili\.com|b23\.tv|xiaohongshu\.com|xhslink\.(com|cn)|douyin\.com|youtube\.com|youtu\.be|(^|\/\/)x\.com|twitter\.com|tiktok\.com|vimeo\.com)/i;
const normalize = (v) => {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(t)) return 'https://' + t;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(t);
};

const active = () => S.tabs.find((t) => t.id === S.activeId) || null;

/* ── 启动 ── */
async function boot() {
  S.boot = await window.api.bootstrap();
  S.history = await window.api.browseList();
  S.downloads = await window.api.historyList();

  $('back').onclick = () => { const t = active(); try { t?.wv.goBack(); } catch {} };
  $('forward').onclick = () => { const t = active(); try { t?.wv.goForward(); } catch {} };
  $('reload').onclick = () => { const t = active(); try { t?.wv.reload(); } catch {} };
  if ($('download')) $('download').onclick = () => { const t = active(); if (t?.url) parseTab(t, false); };
  $('paneltoggle').onclick = () => {
    const t = active();
    if (!t) return;
    t.panelOpen = !t.panelOpen;
    $('paneltoggle').classList.toggle('on', t.panelOpen);
    renderSide();
  };

  $('addr').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const u = normalize($('addr').value);
    if (u) navigate(u);
  });

  for (const v of ['browse', 'downloads', 'history', 'settings']) $('nav-' + v).onclick = () => setView(v);

  for (const b of document.querySelectorAll('[data-win]')) {
    b.onclick = () => {
      const act = b.dataset.win;
      if (act === 'min') window.api.winMin();
      else if (act === 'max') window.api.winMax();
      else window.api.winClose();
    };
  }

  /* 提示框点开 → 总是新开一个标签页，不覆盖当前页 */
  window.api.onOpenUrl((url) => {
    S.view = 'browse';
    setView('browse', true);
    newTab(normalize(url));
  });
  window.api.onLoginSession((d) => {
    if (!d) return;
    if (d.state === 'ok') S.sessionHint = '已保存 Cookie（' + (d.count || 0) + ' 条）';
    else if (d.state === 'waiting') S.sessionHint = '登录窗口已打开…';
    else if (d.state === 'error') S.sessionHint = '登录检测出错：' + (d.message || '');
    if (S.view === 'settings') renderPage();
  });

  activate(S.homeId);
  refreshSites();
}

function refreshSites() {
  return window.api.loginSites().then((r) => { S.sites = r.platforms || []; }).catch(() => {});
}

/* ── 标签管理 ── */
function loadIn(tab, url) {
  tab.url = url;
  tab.title = url.replace(/^https?:\/\//, '').slice(0, 40);
  if (tab.ready) { try { tab.wv.loadURL(url); } catch { tab.pendingUrl = url; } }
  else tab.pendingUrl = url;
}
function newTab(url) {
  const tab = { id: uid(), url: '', title: '新标签页', wv: null, info: null, pick: null, err: '', panelOpen: true };
  const wv = document.createElement('webview');
  wv.className = 'view';
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', 'about:blank');
  /* 页面里点开的链接（target=_blank / window.open）→ 在本应用新标签页打开，不弹独立窗口 */
  wv.addEventListener('new-window', (e) => {
    if (e.url) {
      e.preventDefault();
      if (/^https?:/i.test(e.url)) { S.view = 'browse'; newTab(e.url); }
    }
  });
  wv.addEventListener('did-stop-loading', () => {
    try {
      const t = wv.getTitle();
      if (t && t !== tab.title) {
        tab.title = t;
        renderTabs();
        if (tab.url) window.api.browseSetTitle({ url: tab.url, title: t }).then((l) => { S.history = l; }).catch(() => {});
      }
    } catch {}
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons[0]) { tab.icon = e.favicons[0]; renderTabs(); }
  });
  wv.addEventListener('did-navigate', (e) => onNavigate(tab, e.url));
  wv.addEventListener('did-navigate-in-page', (e) => onNavigate(tab, e.url));
  wv.addEventListener('page-title-updated', () => {
    try { tab.title = wv.getTitle() || tab.title; } catch {}
    renderTabs();
  });
  wv.addEventListener('dom-ready', () => {
    tab.ready = true;
    try { wv.setZoomFactor(1); } catch {}
    if (tab.pendingUrl) { const u = tab.pendingUrl; tab.pendingUrl = ''; try { wv.loadURL(u); } catch {} }
  });

  S.tabs.push(tab);
  tab.wv = wv;
  $('views').append(wv);
  activate(tab.id);
  if (url) loadIn(tab, url);
  return tab;
}

function activate(id) {
  S.activeId = id;
  for (const t of S.tabs) if (t.wv) t.wv.classList.toggle('on', t.id === id);
  const isHome = id === S.homeId;
  $('startpage').style.display = isHome ? '' : 'none';
  if ($('download')) $('download').disabled = isHome || !SUPPORTED.test(active()?.url || '');
  $('addr').value = isHome ? '' : (active()?.url || '');

  setView('browse', true);
  renderTabs();
}

function closeTab(id) {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [tab] = S.tabs.splice(i, 1);
  try { tab.wv?.remove(); } catch {}
  if (S.activeId === id) activate(S.tabs.at(-1)?.id || S.homeId);
  else renderTabs();
}

function renderTabs() {
  const box = $('tablist');
  box.replaceChildren();
  $('tabs').hidden = S.view !== 'browse';

  const svg = (d) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    el.append(path);
    return el;
  };

  const home = h('div', { className: 'tab' + (S.activeId === S.homeId ? ' on' : '') },
    svg('M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'),
    h('span', { className: 't' }, '主页'),
  );
  home.onclick = () => activate(S.homeId);
  box.append(home);

  for (const t of S.tabs) {
    const el = h('div', { className: 'tab' + (t.id === S.activeId ? ' on' : '') },
      (() => {
        let host = '';
        try { host = t.url ? new URL(t.url).hostname : ''; } catch {}
        const src = t.icon || (host ? 'https://' + host + '/favicon.ico' : '');
        if (!src) return svg('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18');
        const img = h('img', { className: 'favicon', src, referrerPolicy: 'no-referrer' });
        img.onerror = () => {
          if (host && !img.dataset.fb) { img.dataset.fb = '1'; img.src = 'https://www.google.com/s2/favicons?domain=' + host + '&sz=32'; }
          else img.style.visibility = 'hidden';
        };
        return img;
      })(),
      h('span', { className: 't' }, t.title || t.url || '新标签页'),
      (() => { const x = h('span', { className: 'x' }, '×'); x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); }; return x; })(),
    );
    el.onclick = () => activate(t.id);
    box.append(el);
  }

  const add = h('button', { className: 'add', title: '新标签页' }, '+');
  add.onclick = () => newTab('');
  box.append(add);
}

function navigate(url) {
  const t = active();
  if (!t) { newTab(url); return; }
  if (!t.wv) { newTab(url); return; }     // 从主页发起 → 新开标签
  $('addr').value = url;
  loadIn(t, url);
  S.view = 'browse';
  setView('browse', true);
}

async function onNavigate(tab, url) {
  if (!/^https?:/i.test(url)) return;
  tab.url = url;
  try { tab.title = tab.wv.getTitle() || url.replace(/^https?:\/\//,'').replace(/\/$/,''); } catch { tab.title = url; }
  if (tab.id === S.activeId) {
    $('addr').value = url;
  if ($('download')) $('download').disabled = !SUPPORTED.test(url);
  }
  renderTabs();
  let icon = '';
  try { icon = tab.wv.getFavicon() || tab.icon || ''; } catch { icon = tab.icon || ''; }
  if (icon) tab.icon = icon;

  /* 写浏览记录（标题先用当前拿到的，页面标题定稿后由 page-title-updated 回写） */
  try {
    S.history = await window.api.browseAdd({ url, title: tab.title || url, icon });
  } catch { }

  if (SUPPORTED.test(url)) {
    tab.info = null; tab.err = ''; tab.panelOpen = true;
    clearTimeout(tab.timer);
    tab.timer = setTimeout(() => parseTab(tab, true), 1200);
    renderSide();
  } else {
    tab.info = null; tab.err = ''; tab.panelOpen = true;
    renderSide();
  }
}

/* 侧栏占位后，把网页缩放到「刚好完整显示」：
   先复位到 1 量一次页面真实宽度，再按可用宽度算缩放比。 */
async function fitZoom(tab) {
  if (!tab || !tab.wv || !tab.ready) return;
  const wv = tab.wv;
  try {
    const avail = wv.getBoundingClientRect().width;
    if (!avail) return;

    /* 在当前缩放比例下量一次版面宽度，直接算出目标比例：
       zoom' = zoom * avail / scrollWidth，全程只改一次缩放，避免闪跳。 */
    const sw = await wv.executeJavaScript(
      'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)',
    );
    if (!sw || sw < 200) return;

    const cur = wv.getZoomFactor();
    const next = Math.max(0.5, Math.min(1, (cur * avail) / sw));
    if (Math.abs(next - cur) > 0.01) wv.setZoomFactor(next);
  } catch { /* 页面没就绪就跳过 */ }
}

/* ── 视图 ── */
function setView(v, keepTab) {
  S.view = v;
  for (const x of ['browse', 'downloads', 'history', 'settings']) $('nav-' + x).classList.toggle('on', x === v);

  const isBrowse = v === 'browse';
  $('toolbar').style.display = isBrowse ? '' : 'none';
  $('workspace').hidden = !isBrowse;
  $('page').hidden = isBrowse;
  $('tabs').hidden = !isBrowse;
  $('winbar').classList.toggle('on', !isBrowse);

  if (isBrowse) { renderSide(); renderTabs(); }
  else renderPage();
}

/* ── 资源面板 ── */
function renderSide() {
  const box = $('side');
  box.replaceChildren();
  const tab = active();
  const show = S.view === 'browse' && tab && tab.wv && tab.panelOpen;
  box.hidden = !show;
  if (!show) return;

  const head = h('div', { className: 'sideHead' }, '媒体资源');
  const close = h('span', { className: 'x', title: '关闭面板' }, '×');
  close.onclick = () => { tab.panelOpen = false; renderSide(); };
  head.append(close);
  box.append(head);

  if (tab.err) { box.append(h('div', { className: 'err' }, '解析失败：' + tab.err)); return; }
  const info = tab.info;
  if (!info) {
    box.append(h('div', { className: 'empty', style: 'padding:34px 0' },
      icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'),
      h('div', {}, '正在读取这个页面的媒体…'),
    ));
    return;
  }
  const pick = tab.pick;

  /* 默认选最高画质（info.videos 已按画质从高到低排好） */
  const vlist = info.videos || [];
  const cur = vlist.find((v) => v.qn === pick.videoQn) || vlist[0] || null;

  const estSize = (v) => {
    if (!v.bandwidth || !info.duration) return '';
    const mb = (v.bandwidth * info.duration) / 8 / 1024 / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  };

  if (vlist.length) {
    /* 卡片：封面 + 标题 + 当前画质 + 下载按钮 + 下拉列表 */
    const card = h('div', { className: 'mcard' });

    card.append(h('h4', {}, '视频', h('span', {}, cur ? '当前 ' + (cur.label || cur.height + 'P') : '')));

    const head = h('div', { className: 'mhead' },
      info.cover ? h('img', { src: info.cover, referrerPolicy: 'no-referrer' }) : null,
      h('div', { className: 'info' },
        h('div', { className: 'tt' }, info.title || '（无标题）'),
        h('div', { className: 'ss' },
          cur ? [(cur.codec || ''), estSize(cur)].filter(Boolean).join(' · ') : ''),
      ),
    );
    card.append(head);

    const bar = h('div', { className: 'dlbar' });
    const dl = h('button', { className: 'main' }, icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'), cur ? '下载 ' + (cur.label || cur.height + 'P') : '下载');
    dl.onclick = () => startDownload(tab);
    const caret = h('button', { className: 'caret' + (tab.menuOpen ? ' open' : ''), title: '选择分辨率' });
    caret.append(icon('M6 9l6 6 6-6'));
    caret.onclick = () => {
      tab.menuOpen = !tab.menuOpen;
      if (tab.menuOpen && !tab.pick.videoQn) tab.pick.videoQn = vlist[0].qn;
      renderSide();
    };
    bar.append(dl, caret);
    card.append(bar);

    if (tab.menuOpen) {
      const menu = h('div', { className: 'menu' });
      for (const v of vlist) {
        const on = pick.videoQn === v.qn;
        const row = h('div', { className: 'mrow' + (on ? ' on' : '') },
          h('span', { className: 'tick' }, on ? '✓' : ''),
          h('span', { className: 'q' }, (v.label || v.height + 'P') + (v.codec ? ' · ' + v.codec : '') + (v.vip ? ' · 会员' : '')),
          h('span', { className: 'sz' }, estSize(v)),
        );
        row.onclick = () => { pick.videoQn = v.qn; tab.menuOpen = false; renderSide(); };
        menu.append(row);
      }
      card.append(menu);
    }

    box.append(card);
  }

  if (info.audios?.length || info.videos?.length) {
    const a = h('input', { type: 'checkbox' }); a.checked = pick.audio;
    a.onchange = (e) => { pick.audio = e.target.checked; };
    const m = h('input', { type: 'checkbox' }); m.checked = pick.audioMp3;
    m.onchange = (e) => { pick.audioMp3 = e.target.checked; };
    box.append(h('div', { className: 'sec' }, h('h4', {}, '音频'),
      h('div', { className: 'opts' }, h('label', { className: 'chk' }, a, '独立音频'), h('label', { className: 'chk' }, m, '转 MP3'))));
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

  /* 底部固定：下载此页（未解析时按钮变为解析） */
  const foot = h('div', { className: 'sideFoot' });
  const pageBtn = h('button', {}, info ? '下载此页' : '解析此页');
  pageBtn.onclick = () => { if (tab.info) startDownload(tab); else parseTab(tab, false); };
  foot.append(pageBtn);
  box.append(foot);

}

/* ── 解析 ── */
async function parseTab(tab, auto) {
  const dl = $('download');
  if (dl && !auto) { dl.disabled = true; dl.textContent = '解析中…'; }
  try {
    const info = await window.api.probe(tab.url);
    tab.info = info;
    tab.err = '';
    tab.pick = {
      videoQn: info.videos?.[0]?.qn ?? null,
      audio: false, audioId: null, audioMp3: true,
      coverIds: [], avatar: false, imageIds: [],
    };
  } catch (e) {
    tab.err = e.message || String(e);
    tab.info = null;
  } finally {
    if (dl) { dl.textContent = '下载此页'; dl.disabled = false; }

  }
  if (tab.id === S.activeId) renderSide();
}

/* ── 下载 ── */
async function startDownload(tab) {
  if (!tab.info) return;
  const job = await window.api.start({ url: tab.url, info: tab.info, pick: tab.pick });
  S.jobs.unshift({ id: job.id, title: tab.info.title, cover: tab.info.cover, items: job.items || [], at: Date.now(), status: job.status || 'running', url: tab.url });
  tab.info = null; tab.pick = null;
  setView('downloads');
  poll(S.jobs[0]);
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
          key: rec.id, url: rec.url, title: rec.title, cover: rec.cover,
          kind: 'media', outDir: S.boot.outDir, at: Date.now(),
        });
      }
      return;
    }
    setTimeout(tick, 700);
  };
  tick();
}

/* ── 下载 / 历史 / 设置 ── */
function statusOf(job) {
  if (job.status === 'error') return 'failed';
  if (job.status === 'done') return 'done';
  const items = job.items || [];
  return items.some((i) => i.status === 'running' || i.received > 0) ? 'running' : 'waiting';
}

const TIME_OPTIONS = [
  ['all', '全部时间'],
  ['today', '今天'],
  ['yesterday', '昨天'],
  ['7d', '最近 7 天'],
  ['30d', '最近 30 天'],
];

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function inTimeRange(ts, key) {
  if (!ts) return true;
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (key === 'today') return day === today;
  if (key === 'yesterday') return day === today - 86400000;
  if (key === '7d') return day >= today - 6 * 86400000;
  if (key === '30d') return day >= today - 29 * 86400000;
  return true;
}

function timeFilter(getVal, setVal) {
  const wrap = h('div', { className: 'tfilter' });
  const cur = TIME_OPTIONS.find(([k]) => k === getVal()) || TIME_OPTIONS[0];
  const btn = h('div', { className: 'tb' + (S.tmOpen ? ' open' : '') }, cur[1]);
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  caret.append(path);
  btn.append(caret);
  btn.onclick = (e) => { e.stopPropagation(); S.tmOpen = !S.tmOpen; renderPage(); };

  wrap.append(btn);
  if (S.tmOpen) {
    const menu = h('div', { className: 'tm' });
    for (const [k, label] of TIME_OPTIONS) {
      const item = h('div', { className: 'ti' + (k === getVal() ? ' on' : '') }, label);
      item.onclick = (e) => { e.stopPropagation(); setVal(k); S.tmOpen = false; renderPage(); };
      menu.append(item);
    }
    wrap.append(menu);
  }
  return wrap;
}

function renderPage() {
  const box = $('page');
  box.replaceChildren();
  if (S.view === 'downloads') renderDownloads(box);
  else if (S.view === 'history') renderHistory(box);
  else if (S.view === 'settings') renderSettings(box);
}

function renderDownloads(box) {
  const counts = { all: S.jobs.length, waiting: 0, running: 0, done: 0, failed: 0 };
  for (const j of S.jobs) counts[statusOf(j)]++;

  const segs = h('div', { className: 'segs' });
  for (const [k, label] of [['all', '全部'], ['waiting', '等待下载'], ['running', '下载中'], ['done', '已完成'], ['failed', '下载失败']]) {
    const s = h('div', { className: 'seg' + (S.dlFilter === k ? ' on' : '') }, label, h('span', { className: 'n' }, counts[k]));
    s.onclick = () => { S.dlFilter = k; renderPage(); };
    segs.append(s);
  }
  const clear = h('button', { className: 'ghost' }, '清除已结束');
  clear.onclick = () => { S.jobs = S.jobs.filter((j) => !['done', 'error'].includes(j.status)); renderPage(); };
  segs.append(h('div', { className: 'right' }, timeFilter(() => S.dlTime, (v) => { S.dlTime = v; }), clear));
  box.append(segs);

  const list = S.jobs.filter((j) => (S.dlFilter === 'all' || statusOf(j) === S.dlFilter) && inTimeRange(j.at, S.dlTime));
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

function dayLabel(ts) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ts);
  if (day === today) return '今天';
  if (day === today - 86400000) return '昨天';
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderHistory(box) {
  const segs = h('div', { className: 'segs' }, h('div', { className: 'seg on' }, '浏览记录', h('span', { className: 'n' }, S.history.length)));
  const clr = h('button', { className: 'ghost' }, '清空');
  clr.onclick = async () => { S.history = await window.api.browseClear(); renderPage(); };
  segs.append(h('div', { className: 'right' }, timeFilter(() => S.histTime, (v) => { S.histTime = v; }), clr));
  box.append(segs);

  const list = S.history.filter((it) => inTimeRange(it.at, S.histTime));
  if (!list.length) {
    box.append(h('div', { className: 'empty' }, icon('M12 8v4l3 2M4 12a8 8 0 1 1 8 8'), h('div', {}, '这个时间段没有记录')));
    return;
  }

  /* 按日期分组：每天一个独立框，日期标签在框外 */
  const groups = new Map();
  for (const it of list) {
    const key = dayLabel(it.at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  for (const [label, items] of groups) {
    box.append(h('div', { className: 'hdate' }, label));

    for (const it of items) {
      let host = '';
      try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch {}
      const iconUrl = it.icon || (host ? 'https://' + host + '/favicon.ico' : '');

      const del = h('span', { className: 'del', title: '删除这条' }, '×');
      del.onclick = async (e) => { e.stopPropagation(); S.history = await window.api.browseRemove(it.url); renderPage(); };

      const when = new Date(it.at);
      const stamp = when.getFullYear() + '/' + String(when.getMonth() + 1).padStart(2, '0') + '/' +
        String(when.getDate()).padStart(2, '0') + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');

      const row = h('div', { className: 'hcard', title: it.url },
        h('img', {
          className: 'fav',
          src: iconUrl,
          referrerPolicy: 'no-referrer',
          onerror: (e) => { e.target.style.visibility = 'hidden'; },
        }),
        h('div', { className: 'ht' },
          h('div', { className: 'nm' }, it.title || it.url),
          h('div', { className: 'u' }, it.url),
        ),
        h('span', { className: 'tm2' }, stamp),
        del,
      );
      row.onclick = () => { setView('browse', true); newTab(it.url); };
      box.append(row);
    }
  }
}

function renderSettings(box) {
  box.append(h('div', { className: 'h1' }, '设置'));
  box.append(h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '下载目录'),
      h('span', { className: 'v', title: S.boot.outDir }, S.boot.outDir),
      (() => { const b = h('button', { className: 'ghost' }, '更换'); b.onclick = async () => { const r = await window.api.pickDir(); if (r.dir) { S.boot.outDir = r.dir; renderPage(); } }; return b; })(),
    ),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, 'ffmpeg'), h('span', { className: 'v' }, S.boot.ffmpeg ? '已内置' : '未找到')),
  ));

  const acc = h('div', { className: 'card' });
  for (const p of S.sites) {
    const login = h('button', { className: 'ghost' }, '登录');
    login.onclick = () => openInlineLogin(p.id, p.label);
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

boot();


/* ── 内置登录窗口 ───────────────────────────────────── */
let loginKey = '';

async function openInlineLogin(key, label) {
  const r = await window.api.loginInlineOpen(key);
  if (!r.ok) { alert('无法打开登录：' + r.error); return; }
  loginKey = key;
  $('lmTitle').textContent = '登录 · ' + r.label;
  $('lmHint').textContent = '在下方窗口完成登录，然后点「完成登录」';
  const wv = $('lmView');
  wv.setAttribute('partition', 'persist:login-' + key);
  wv.setAttribute('src', r.url);
  $('loginModal').hidden = false;
}

async function finishInlineLogin() {
  if (!loginKey) return;
  $('lmHint').textContent = '正在读取 Cookie…';
  const r = await window.api.loginInlineFinish(loginKey);
  if (!r.ok) { $('lmHint').textContent = '失败：' + r.error; return; }
  $('loginModal').hidden = true;
  S.sessionHint = '已保存 Cookie（' + r.count + ' 条）';
  try { $('lmView').setAttribute('src', 'about:blank'); } catch {}
  await refreshSites();
  renderPage();
}

function closeInlineLogin() {
  $('loginModal').hidden = true;
  try { $('lmView').setAttribute('src', 'about:blank'); } catch {}
}

$('lmDone').onclick = finishInlineLogin;
$('lmCancel').onclick = closeInlineLogin;