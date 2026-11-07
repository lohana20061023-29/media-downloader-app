/* LOHANA DX：多标签浏览器
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
/* 同一页面的不同地址（带追踪参数）视为同一个，避免重复解析 */
const canonUrl = (u) => {
  try {
    const url = new URL(u);
    for (const k of ['vd_source', 'spm_id_from', 'trackid', 'share_source', 'share_medium', 'unique_k', 'buvid', 'from_source', 'from_spmid', 'timestamp']) {
      url.searchParams.delete(k);
    }
    url.hash = '';
    return url.origin + url.pathname + (url.search || '');
  } catch { return u; }
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
/* ── 首次使用须知 / 第三方组件确认 ── */
async function legalGate() {
  let st;
  try { st = await window.api.legalStatus(); } catch { return; }

  if (!st.accepted) {
    await new Promise((resolve) => {
      const modal = $('legalModal');
      const chk = $('legalAgree');
      const ok = $('legalOk');
      modal.hidden = false;
      chk.onchange = () => { ok.disabled = !chk.checked; };
      ok.onclick = async () => {
        await window.api.legalAccept('main');
        modal.hidden = true;
        resolve();
      };
      $('legalQuit').onclick = () => { window.api.quitApp(); };
    });
  }

  /* 组件窗在真正解析抖音时再询问 */
}

let compBusy = false;

function openComponentsDialog(onDone) {
  const modal = $('compModal');
  const chk = $('compAgree');
  const ok = $('compOk');
  const status = $('compStatus');

  modal.hidden = false;
  chk.checked = false;
  ok.disabled = true;
  status.textContent = '';
  compBusy = false;

  const sync = () => { ok.disabled = compBusy || !chk.checked; };
  chk.onchange = sync;
  $('compCancel').onclick = () => { modal.hidden = true; };

  if (!window.__compProgressBound) {
    window.api.onComponentsProgress((d) => {
      const el = $('compStatus');
      if (el) el.textContent = d.stage + (d.pct ? ' ' + d.pct + '%' : '');
    });
    window.__compProgressBound = true;
  }

  ok.onclick = async () => {
    if (compBusy) return;
    compBusy = true;
    sync();
    status.textContent = '准备下载…';
    try {
      await window.api.legalAccept('components');
      const r = await window.api.componentsInstall();
      status.textContent = r && r.ok ? '已安装，可直接解析抖音高清' : '安装失败';
      setTimeout(() => {
        modal.hidden = true;
        compBusy = false;
        if (typeof onDone === 'function') onDone(true);
      }, 700);
    } catch (err) {
      status.textContent = '下载失败：' + (err.message || '网络不可用');
      compBusy = false;
      sync();
    }
  };
}

async function boot() {
  await legalGate();
  S.boot = await window.api.bootstrap();
  /* 登录态稍后补，不卡首屏 */
  window.api.bootstrapLogin().then((r) => {
    S.boot.login = r.login;
    S.boot.loginSites = r.loginSites;
    if (S.view === 'settings') renderPage();
  }).catch(() => {});
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

  /* 标题轮询：每秒读一次当前标签的标题。
     站内跳转时 document.title 常常不更新，所以依次尝试：页面 h1 → og:title → document.title */
  /* 标题轮询：每秒探测一次当前标签页，站点标题没跟着换时用 h1 / og:title 兜底 */
  S.titlePoll = setInterval(async () => {
    const tab = active();
    if (!tab || !tab.wv || !tab.ready || S.view !== 'browse') return;

    /* 主路径：getTitle() 稳定，不依赖 webview 脚本通道（该通道常报 reply was never sent） */
    let t = '';
    try { t = tab.wv.getTitle() || ''; } catch {}

    /* 站点标题不跟随时，尝试 h1 / og:title 兜底（失败就忽略） */
    if (!t || t === 'about:blank' || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) {
      try {
        const code = [
          '(function(){',
          "var h=document.querySelector('h1');",
          "var m=document.querySelector('meta[property=\"og:title\"]');",
          "return JSON.stringify({h:(h&&h.innerText||'').trim(),o:(m&&m.content)||'',t:document.title||''});",
          '})()',
        ].join('');
        const raw = await tab.wv.executeJavaScript(code);
        const info = JSON.parse(raw || '{}');
        t = (info.h && info.h.length > 2 && info.h.length < 120) ? info.h : (info.o || info.t || t);
      } catch { /* 通道异常时保持 getTitle 的结果 */ }
    }

    if (!t) return;

    /* 与历史里存的那条比对，不一致就回写 */
    if (tab.histAt) {
      const rec = (S.history || []).find((x) => x.at === tab.histAt);
      if (!rec || rec.title !== t) {
        try {
          S.history = await window.api.browseUpdateAt({ at: tab.histAt, title: t, url: tab.url, icon: tab.icon || '' });
          if (S.view === 'history') renderPage();
        } catch {}
      }
    }

    if (t !== tab.title) {
      tab.title = t;
      renderTabs();
    }
  }, 1000);

  activate(S.homeId);
  refreshSites();
}

function renderSettingsIfOpen() {
  if (S.view === 'settings') renderPage();
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
  /* 抖音等站点会尝试打开 bytedance:// 这类自定义协议，
     交给系统会弹出「获取打开此链接的应用」，这里直接拦掉 */
  wv.addEventListener('will-navigate', (e) => {
    if (!/^https?:/i.test(e.url || '')) { e.preventDefault(); }
  });

  wv.addEventListener('did-navigate', (e) => onNavigate(tab, e.url));
  wv.addEventListener('did-navigate-in-page', (e) => onNavigate(tab, e.url));
  wv.addEventListener('page-title-updated', async () => {
    let nt = tab.title;
    try { nt = wv.getTitle() || tab.title; } catch {}
    if (!nt) return;
    tab.title = nt;
    renderTabs();
    /* 标题变了就同步写回历史记录，按时间戳精确定位，避免 URL 匹配不到 */
    if (nt && nt !== url) {
      try {
        S.history = tab.histAt
          ? await window.api.browseUpdateAt({ at: tab.histAt, title: nt, url: tab.url, icon: tab.icon || '' })
          : await window.api.browseSetTitle({ url: tab.histUrl || tab.url, title: nt, icon: tab.icon || '' });
        if (S.view === 'history') renderPage();
      } catch {}
    }
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
  /* 刚导航时 getTitle() 还是上一页的标题，先用域名占位 */
  try { tab.title = new URL(url).hostname.replace(/^www\./, ''); } catch { tab.title = url; }
  if (tab.id === S.activeId) {
    $('addr').value = url;
  if ($('download')) $('download').disabled = !SUPPORTED.test(url);
  }
  renderTabs();
  let icon = '';
  try { icon = tab.wv.getFavicon() || tab.icon || ''; } catch { icon = tab.icon || ''; }
  if (icon) tab.icon = icon;

  /* SPA 内跳转常常不发标题事件：两个时间点各补抓一次 */

  /* 写浏览记录（标题先用当前拿到的，页面标题定稿后由 page-title-updated 回写） */
  try {
    const list = await window.api.browseAdd({ url, title: tab.title || url, icon });
    S.history = list;
    /* 记住这条记录的写入时间，后面标题 / 图标变化都按它精确更新 */
    if (Array.isArray(list) && list[0]) { tab.histAt = list[0].at; tab.histUrl = list[0].url; }
  } catch { }

  if (SUPPORTED.test(url)) {
    /* 浏览时登录了，就把这套 Cookie 同步给解析/下载引擎 */
    window.api.syncCookies().catch(() => {});
    /* 同一地址重复触发（did-navigate / in-page / 标题更新）时不再重来一遍 */
    if (tab.parseUrl !== url) {
      tab.parseUrl = url;
      tab.info = null; tab.err = ''; tab.panelOpen = true;
      clearTimeout(tab.timer);
      tab.timer = setTimeout(() => parseTab(tab, true), 1200);
      renderSide();
    }
  } else {
    tab.info = null; tab.err = ''; tab.panelOpen = true;
    renderSide();
  }
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
function actIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '16');
  el.setAttribute('height', '16');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.7');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  for (const d of (Array.isArray(paths) ? paths : [paths])) {
    const node = document.createElementNS(ns, 'path');
    node.setAttribute('d', d);
    el.append(node);
  }
  return el;
}

function imgWithFallback(url, alt, extra) {
  const el = h('img', { src: url, referrerPolicy: 'no-referrer', ...(extra || {}) });
  let stage = 0;
  el.onerror = async () => {
    stage += 1;
    if (stage === 1 && alt && alt !== url) { el.src = alt; return; }
    const source = alt || url;
    const data = await window.api.imgProxy(source).catch(() => '');
    if (data) { el.src = data; el.onerror = null; }
    else el.style.visibility = 'hidden';
  };
  return el;
}

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
  if (pick.videoIdx === undefined && vlist.length) pick.videoIdx = 0;
  const cur = vlist[pick.videoIdx] || vlist[0] || null;

  const estSize = (v) => {
    if (!v.bandwidth || !info.duration) return '';
    const mb = (v.bandwidth * info.duration) / 8 / 1024 / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  };

  if (vlist.length) {
    /* 卡片：封面 + 标题 + 当前画质 + 下载按钮 + 下拉列表 */
    const card = h('div', { className: 'mcard' });

    card.append(h('h4', {}, '视频', h('span', {}, cur && cur.height ? '当前 ' + cur.height + 'P' : '')));

    const head = h('div', { className: 'mhead' },
      info.cover ? imgWithFallback(info.cover) : null,
      h('div', { className: 'info' },
        h('div', { className: 'tt' }, info.title || '（无标题）'),
        h('div', { className: 'ss' },
          cur ? [(cur.codec || ''), estSize(cur)].filter(Boolean).join(' · ') : ''),
      ),
    );
    card.append(head);

    const bar = h('div', { className: 'dlbar' });
    const dl = h('button', { className: 'main' }, icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'), cur && cur.height ? '下载 ' + cur.height + 'P' : '下载');
    dl.onclick = () => startDownload(tab);
    const caret = h('button', { className: 'caret' + (tab.menuOpen ? ' open' : ''), title: '选择分辨率' });
    caret.append(icon('M6 9l6 6 6-6'));
    caret.onclick = () => {
      tab.menuOpen = !tab.menuOpen;
      if (tab.menuOpen && tab.pick.videoIdx === undefined && vlist.length) tab.pick.videoIdx = 0;
      renderSide();
    };
    bar.append(dl, caret);
    card.append(bar);

    if (tab.menuOpen) {
      const menu = h('div', { className: 'menu' });
      for (let idx = 0; idx < vlist.length; idx += 1) {
        const v = vlist[idx];
        const on = (pick.videoIdx ?? 0) === idx;
        const row = h('div', { className: 'mrow' + (on ? ' on' : '') },
          h('span', { className: 'tick' }, on ? '✓' : ''),
          h('span', { className: 'q' }, (v.label || v.height + 'P') + (v.codec ? ' · ' + v.codec : '') + (v.vip ? ' · 会员' : '')),
          h('span', { className: 'sz' }, estSize(v)),
        );
        row.onclick = () => { pick.videoIdx = idx; pick.videoUrl = v.url; pick.videoQn = v.qn; renderSide(); };
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
        h('div', { className: 'frame' }, imgWithFallback(url)),
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
        h('div', { className: 'frame' }, imgWithFallback(img.url, img.alt)));
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
  const pageBtn = h('button', {}, info ? '下载勾选项' : '解析此页');
  pageBtn.onclick = () => {
    if (!tab.info) { parseTab(tab, false); return; }
    const pk = tab.pick || {};
    /* 纯图集作品默认全选图片，视为已勾选 */
    const autoImages = (tab.info.images || []).length && !(tab.info.videos || []).length;
    const hasExtras = autoImages || (pk.coverIds || []).length || pk.avatar || pk.audio || (pk.imageIds || []).length;
    if (!hasExtras) {
      const old = pageBtn.textContent;
      pageBtn.textContent = '请先勾选封面 / 头像 / 音频 / 图片';
      setTimeout(() => { pageBtn.textContent = old; }, 1600);
      return;
    }
    /* 视频有自己的「下载 xxxP」按钮，这里只下勾选项 */
    startDownload(tab, { extrasOnly: true });
  };
  foot.append(pageBtn);
  box.append(foot);

}

/* ── 解析 ── */
async function componentsReady(tab) {
  if (!/douyin\.com/.test(tab.url || '')) return true;
  try {
    const st = await window.api.legalStatus();
    if (st.components.installed) return true;
  } catch { return true; }
  tab.err = '抖音高清解析需要先下载「解析组件」';
  renderSide();
  openComponentsDialog(() => { tab.err = ''; parseTab(tab, true); });
  return false;
}

async function parseTab(tab, auto) {
  try { await window.api.syncCookies(); } catch {}
  const dl = $('download');
  if (!(await componentsReady(tab))) return;
  tab.parseUrl = tab.url;
  if (tab.parsing) return;
  tab.parsing = true;
  if (dl && !auto) { dl.disabled = true; dl.textContent = '解析中…'; }
  try {
    let info = null;

    /* 小红书：从当前浏览页读数据。站内打开新笔记时 noteDetailMap 会同时有多条，
       必须按当前地址里的 noteId 精确匹配，否则会拿到上一篇的媒体。 */
    if (/xiaohongshu\.com/.test(tab.url || '')) {
      const m = /(?:explore|discovery\/item|item)\/([0-9a-f]{20,32})/i.exec(tab.url || '');
      const wantId = m ? m[1] : '';
      for (let attempt = 0; attempt < 6 && !info; attempt += 1) {
        try {
          const raw = await tab.wv.executeJavaScript(
            "(function(want){"
            + "var m=window.__INITIAL_STATE__&&window.__INITIAL_STATE__.note&&window.__INITIAL_STATE__.note.noteDetailMap;"
            + "if(!m)return '';"
            + "var keys=Object.keys(m), pick='';"
            + "if(want&&m[want])pick=want;"
            + "if(!pick){for(var i=0;i<keys.length;i++){if(keys[i]===want){pick=keys[i];break;}}}"
            + "if(!pick)return '';"
            + "var e=m[pick], n=e&&(e.note||e);"
            + "if(!n||!n.noteId)return '';"
            + "if(want&&n.noteId!==want)return '';"
            + "return JSON.stringify({id:n.noteId,note:{noteId:n.noteId,type:n.type,title:n.title,desc:n.desc,"
            + "user:{nickName:(n.user&&n.user.nickname)||'',avatar:(n.user&&n.user.avatar)||''},"
            + "imageList:(n.imageList||[]).map(function(i){return {urlDefault:i.urlDefault||i.url,infoList:i.infoList}}),"
            + "video:n.video||null}});"
            + "})(" + JSON.stringify(wantId) + ")",
          );
          if (raw) {
            const parsed = JSON.parse(raw);
            const r = await window.api.xhsFromPage({ note: parsed.note, id: parsed.id });
            if (r && r.ok) info = r.info;
          }
        } catch { /* 继续重试 */ }
        if (!info) await new Promise((res) => setTimeout(res, 400));
      }
    }

    /* 抖音：优先走带签名的 Web 接口（能拿 1080P 与实况图动态流） */
    if (!info && /douyin\.com/.test(tab.url || '')) {
      try { info = await window.api.probe(tab.url); } catch {}
    }

    /* 兜底：浏览缓存 / 隐藏窗口截获 */
    /* 抖音：优先用浏览时缓存下来的详情接口数据（带签名，含 1080P） */
    if (!info && /douyin\.com/.test(tab.url || '')) {
      try {
        const c = await window.api.douyinCached(tab.url);
        if (c && c.ok) info = c.info;
      } catch {}
    }

    /* 抖音：先用隐藏窗口截获页面自己的详情接口（带登录态与签名） */
    if (!info && /douyin\.com/.test(tab.url || '')) {
      try {
        const cap = await window.api.douyinCapture(tab.url);
        if (cap && cap.ok) info = cap.info;
      } catch {}
    }

    if (!info) info = await window.api.probe(tab.url);

    tab.info = info;
    tab.err = '';
    tab.pick = {
      videoQn: info.videos?.[0]?.qn ?? null,
      videoIdx: 0,
      videoUrl: info.videos?.[0]?.url || null,
      audio: false, audioId: null, audioMp3: true,
      coverIds: [], avatar: false, imageIds: [],
    };
  } catch (e) {
    tab.err = e.message || String(e);
    tab.info = null;
  } finally {
    tab.parsing = false;
  }
  if (tab.id === S.activeId) renderSide();
}

/* ── 下载 ── */
async function startDownload(tab, opts) {
  if (!tab.info) return;
  if (opts && opts.extrasOnly) {
    tab.pick.videoQn = null;
    tab.pick.videoUrl = null;
    tab.pick.videoIdx = undefined;
  }
  const info = tab.info;
  /* 图文笔记：用户没勾任何图时默认全选，避免下出个空任务 */
  if (info.images?.length && !(info.videos || []).length && !(tab.pick.imageIds || []).length) {
    tab.pick.imageIds = info.images.map((x) => x.id);
  }
  const cur = (tab.info.videos || [])[tab.pick.videoIdx ?? 0];
  if (!(opts && opts.extrasOnly) && cur && (tab.pick.videoQn === null || tab.pick.videoQn === undefined)) tab.pick.videoQn = cur.qn;
  const job = await window.api.start({ url: tab.url, info: tab.info, pick: tab.pick });
  S.jobs.unshift({ id: job.id, title: tab.info.title, cover: tab.info.cover, items: job.items || [], at: Date.now(), status: job.status || 'running', url: tab.url });
  tab.downloadedAt = Date.now();
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

function fmtBytes(n) {
  if (!n) return '—';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function renderDownloads(box) {
  const wrap = h('div', { className: 'pwrap' });
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
  wrap.append(segs);

  const list = S.jobs.filter((j) => (S.dlFilter === 'all' || statusOf(j) === S.dlFilter) && inTimeRange(j.at, S.dlTime));
  if (!list.length) {
    wrap.append(h('div', { className: 'empty' }, icon('M12 4v10m0 0l-4-4m4 4l4-4M5 18h14'), h('div', {}, '暂无下载')));
    box.append(wrap);
    return;
  }

  wrap.append(h('div', { className: 'dlhead' },
    h('span', {}, ''),
    h('span', {}, '文件名'),
    h('span', {}, '进度'),
    h('span', {}, '已下载'),
    h('span', {}, '文件大小'),
    h('span', {}, '下载时间'),
    h('span', {}, '状态'),
    h('span', {}, '保存地址'),
    h('span', {}, '操作'),
  ));

  for (const job of list) {
    const items = (job.items && job.items.length) ? job.items : [{ label: job.title || job.id, status: job.status, file: job.file || null, parts: [] }];

    items.forEach((it, idx) => {
      const total = (it.parts && it.parts[0] && it.parts[0].total) || 0;
      const got = (it.parts || []).reduce((a, x) => a + (x.received || 0), 0);
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : (it.status === 'done' ? 100 : 0);
      const stText = it.status === 'done' ? '已完成' : it.status === 'error' ? '失败' : it.status === 'working' ? '下载中' : '等待';
      const stCls = it.status === 'done' ? 'ok' : it.status === 'error' ? 'bad' : 'run';
      const dir = it.file ? it.file.replace(/[\\/][^\\/]+$/, '') : '';

      const openBtn = h('button', { className: 'ibtn', title: '查看' }, actIcon([
          'M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z',
          'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
        ]));
      openBtn.onclick = () => { if (it.file) window.api.openFile(it.file); };
      const locBtn = h('button', { className: 'ibtn', title: '打开文件位置' }, actIcon('M3 8.5A2.5 2.5 0 0 1 5.5 6h3.2l1.9 2h8A2.5 2.5 0 0 1 21 10.5v6A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z'));
      locBtn.onclick = () => { if (it.file) window.api.reveal(it.file); };
      const delBtn = h('button', { className: 'ibtn danger', title: '删除' }, actIcon([
          'M4.5 7h15',
          'M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7',
          'M6.6 7l.8 11.1c.05.7.63 1.24 1.33 1.24h6.54c.7 0 1.28-.54 1.33-1.24L17.4 7',
          'M10.2 10.6v5.4M13.8 10.6v5.4',
        ]));
      delBtn.onclick = async () => {
        if (it.file) await window.api.deleteFile(it.file).catch(() => {});
        if (job.items) job.items = job.items.filter((x) => x !== it);
        if (!job.items || !job.items.length) {
          S.jobs = S.jobs.filter((x) => x.id !== job.id);
          await window.api.historyRemove(job.id).catch(() => {});
        }
        renderPage();
      };

      const row = h('div', { className: 'dlrow' },
        (() => {
          const cell = h('span', { className: 'thumb' });
          const remote = idx === 0 && job.cover ? job.cover : '';
          if (it.file && /\.(jpg|jpeg|png|webp|gif)$/i.test(it.file)) {
            const img = h('img', { alt: '' });
            cell.append(img);
            window.api.readImage(it.file).then((d) => { if (d) img.src = d; else if (remote) img.src = remote; }).catch(() => { if (remote) img.src = remote; });
          } else if (remote) {
            cell.append(imgWithFallback(remote));
          }
          return cell;
        })(),
        h('span', { className: 'name', title: it.label || job.title }, (it.kind === 'video' ? (job.title || it.label) : (it.label || job.title || '文件'))),
        h('span', { className: 'prog' },
          h('span', { className: 'track' }, h('i', { style: 'width:' + pct + '%' })),
          h('span', { className: 'pct' }, pct + '%'),
        ),
        h('span', { className: 'num' }, fmtBytes(got)),
        h('span', { className: 'num' }, total ? fmtBytes(total) : (it.status === 'done' ? fmtBytes(got) : '—')),
        h('span', { className: 'time' }, fmtDate(job.at || Date.now())),
        h('span', { className: 'st ' + stCls }, stText),
        h('span', { className: 'path', title: it.file || '' }, dir || '—'),
        h('span', { className: 'acts' }, openBtn, locBtn, delBtn),
      );
      wrap.append(row);
    });
  }

  box.append(wrap);
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
  const wrap = h('div', { className: 'pwrap' });
  const segs = h('div', { className: 'segs' }, h('div', { className: 'seg on' }, '浏览记录', h('span', { className: 'n' }, S.history.length)));
  const clr = h('button', { className: 'ghost' }, '清空');
  clr.onclick = async () => { S.history = await window.api.browseClear(); renderPage(); };
  segs.append(h('div', { className: 'right' }, timeFilter(() => S.histTime, (v) => { S.histTime = v; }), clr));
  wrap.append(segs);

  const list = S.history.filter((it) => inTimeRange(it.at, S.histTime));
  if (!list.length) {
    wrap.append(h('div', { className: 'empty' }, icon('M12 8v4l3 2M4 12a8 8 0 1 1 8 8'), h('div', {}, '这个时间段没有记录')));
    box.append(wrap);
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
    wrap.append(h('div', { className: 'hdate' }, label));

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
          h('div', { className: 'nm' }, (it.title && it.title !== 'about:blank') ? it.title : (it.url || '')),
          h('div', { className: 'u' }, it.url),
        ),
        h('span', { className: 'tm2' }, stamp),
        del,
      );
      row.onclick = () => { setView('browse', true); newTab(it.url); };
      wrap.append(row);
    }
  }
  box.append(wrap);
}

function renderSettings(box) {
  const wrap = h('div', { className: 'pwrap' });
  wrap.append(h('div', { className: 'h1' }, '设置'));
  wrap.append(h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '下载目录'),
      h('span', { className: 'v', title: S.boot.outDir }, S.boot.outDir),
      (() => { const b = h('button', { className: 'ghost' }, '更换'); b.onclick = async () => { const r = await window.api.pickDir(); if (r.dir) { S.boot.outDir = r.dir; renderPage(); } }; return b; })(),
    ),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, 'ffmpeg'), h('span', { className: 'v' }, S.boot.ffmpeg ? '已内置' : '未找到')),
  ));

  wrap.append(h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '解析组件'),
      h('span', { className: 'v', id: 'compState' }, '检查中…'),
      (() => { const b = h('button', { className: 'ghost' }, '下载 / 重装'); b.onclick = () => openComponentsDialog(() => renderPage()); return b; })(),
    ),
  ));
  setTimeout(async () => {
    try {
      const st = await window.api.legalStatus();
      const el = document.getElementById('compState');
      if (el) el.textContent = st.components.installed ? '已安装（抖音高清可用）' : '未安装（抖音仅 720P）';
    } catch {}
  }, 50);

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
  wrap.append(acc);

  wrap.append(h('div', { className: 'card' },
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '版本'), h('span', { className: 'v' }, 'v' + S.boot.version)),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '更新'), h('span', { className: 'v' }, '启动时检查 GitHub Release')),
  ));
  box.append(wrap);
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