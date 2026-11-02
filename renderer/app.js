/* LoDown 界面：左侧细栏（浏览 / 下载 / 历史 / 设置）+ 标签页 + 右侧下载栏 */
let S = {
  boot: null,
  view: 'browse',            // browse | downloads | history | settings
  tabs: [],                  // [{id, url, info, pick, state, done}]
  activeId: 'home',
  jobs: [],                  // [{id, tabId, title, cover, items}]
  history: [],
  err: '',
};

const $ = (id) => document.getElementById(id);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const k of kids) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
};
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const active = () => S.tabs.find((t) => t.id === S.activeId) || null;

/* ── 启动 ───────────────────────────────────────────── */
async function boot() {
  S.boot = await window.api.bootstrap();
  S.history = await window.api.historyList();
  $('dir').textContent = '📁 ' + S.boot.outDir;
  $('dir').onclick = pickDir;
  $('pick').onclick = pickDir;

  for (const view of ['browse', 'downloads', 'history', 'settings']) {
    $('nav-' + view).onclick = () => {
      S.view = view;
      S.activeId = view === 'browse' ? 'home' : view;
      render();
    };
  }

  window.api.onOpenUrl((url) => newTab(url));
  window.api.onLoginSession((d) => {
    if (!d) return;
    if (d.state === 'ok') { sessionHint = '已检测到登录并保存 Cookie（' + (d.count || 0) + ' 条）'; refreshSites(); }
    else if (d.state === 'waiting') { sessionHint = '窗口已打开，请在里面完成登录…'; render(); }
    else if (d.state === 'closed') sessionHint = '登录窗口已关闭';
    else if (d.state === 'error') sessionHint = '登录检测出错：' + (d.message || '');
    render();
  });

  render();
}

async function pickDir() {
  const res = await window.api.pickDir();
  if (res.dir) { S.boot.outDir = res.dir; $('dir').textContent = '📁 ' + res.dir; render(); }
}

async function refreshSites() {
  const r = await window.api.loginSites();
  siteState = r.platforms || [];
  render();
}

/* ── 标签 ───────────────────────────────────────────── */
function newTab(url) {
  S.view = 'browse';
  const tab = { id: uid(), url, info: null, pick: null, state: 'loading' };
  S.tabs.push(tab);
  S.activeId = tab.id;
  render();
  parseTab(tab);
}

async function parseTab(tab) {
  try {
    const info = await window.api.probe(tab.url);
    tab.info = info;
    tab.pick = defaultPick(info);
    tab.state = 'idle';
  } catch (e) {
    tab.state = 'error';
    tab.error = e.message || String(e);
  }
  render();
}

function defaultPick(info) {
  return {
    videoQn: info.videos?.[0]?.qn ?? null,
    audio: true, audioId: null, audioMp3: true,
    coverIds: [], avatar: false, imageIds: [],
  };
}

function closeTab(id) {
  S.tabs = S.tabs.filter((t) => t.id !== id);
  if (S.activeId === id) S.activeId = S.tabs.at(-1)?.id || 'home';
  render();
}

/* ── 渲染 ───────────────────────────────────────────── */
function render() {
  renderTabs();
  renderRail();
  const content = $('content');
  content.replaceChildren();
  const side = $('side');

  if (S.view === 'downloads') { side.hidden = true; renderDownloads(content); return; }
  if (S.view === 'history') { side.hidden = true; renderHistory(content); return; }
  if (S.view === 'settings') { side.hidden = true; renderSettings(content); return; }

  if (S.activeId === 'home') { side.hidden = true; renderHome(content); return; }
  const tab = active();
  if (!tab) { side.hidden = true; renderHome(content); return; }
  renderTabContent(content, tab);
  side.hidden = false;
  renderSide(side, tab);
}

function renderRail() {
  for (const v of ['browse', 'downloads', 'history', 'settings']) $('nav-' + v).classList.toggle('on', S.view === v);
}

function renderTabs() {
  const box = $('tabs');
  box.replaceChildren();
  const home = h('div', { className: 'tab' + (S.view === 'browse' && S.activeId === 'home' ? ' on' : '') },
    h('span', { className: 't' }, '起始页'));
  home.onclick = () => { S.view = 'browse'; S.activeId = 'home'; render(); };
  box.append(home);

  for (const t of S.tabs) {
    const el = h('div', { className: 'tab' + (t.id === S.activeId && S.view === 'browse' ? ' on' : '') },
      h('span', { className: 't' }, t.info?.title || t.url.replace(/^https?:\/\//, '').slice(0, 26)),
      (() => { const x = h('span', { className: 'x' }, '×'); x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); }; return x; })(),
    );
    el.onclick = () => { S.view = 'browse'; S.activeId = t.id; render(); };
    box.append(el);
  }
}

function renderHome(box) {
  const bar = h('div', { className: 'bar' },
    (() => {
      const input = h('input', { type: 'text', id: 'homeUrl', placeholder: 'B 站 / 抖音 / 小红书 / YouTube 链接' });
      setTimeout(() => input.focus(), 30);
      return input;
    })(),
    (() => {
      const go = h('button', {}, '打开');
      go.onclick = () => {
        const v = $('homeUrl').value.trim();
        if (v) newTab(v);
      };
      return go;
    })(),
  );

  const hero = h('div', { className: 'hero' },
    h('div', { className: 'title' }, 'LoDown'),
    h('div', { className: 'tip' }, '粘一条链接开始；在别处复制链接时会自动弹出提示'),
    bar,
    (() => {
      const p = h('div', { className: 'platforms' });
      for (const n of ['B 站', '抖音', '小红书', 'YouTube', 'X', 'TikTok']) p.append(h('span', {}, n));
      return p;
    })(),
  );
  box.append(hero);
  setTimeout(() => {
    const input = $('homeUrl');
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) newTab(v); } });
  }, 0);
}

function renderTabContent(box, tab) {
  if (tab.state === 'loading') { box.append(h('div', { className: 'empty' }, '解析中…')); return; }
  if (tab.state === 'error') { box.append(h('div', { className: 'err' }, '解析失败：' + tab.error)); return; }

  const info = tab.info;
  box.append(h('div', { className: 'sec' },
    h('div', { className: 'meta' },
      info.cover ? h('img', { className: 'cover', src: info.cover, referrerPolicy: 'no-referrer' }) : null,
      h('div', {},
        h('div', { className: 't' }, info.title || '（无标题）'),
        h('div', { className: 's' }, [info.up?.name, info.duration ? fmt(info.duration) : '', info.source].filter(Boolean).join(' · ')),
        info.desc ? (() => {
          const d = h('div', { className: 'desc' }, info.desc);
          d.onclick = () => d.classList.toggle('open');
          return d;
        })() : null,
      ),
    ),
  ));

  const btnRe = h('button', { className: 'ghost' }, '重新解析');
  btnRe.onclick = () => { tab.state = 'loading'; render(); parseTab(tab); };
  const btnCopy = h('button', { className: 'ghost' }, '复制链接');
  btnCopy.onclick = () => navigator.clipboard.writeText(tab.url);

  box.append(h('div', { className: 'sec' },
    h('h4', {}, '这个链接', h('span', {}, '在右侧选择要下载的内容')),
    h('div', { className: 'opts' }, btnRe, btnCopy),
  ));
}

function renderSide(box, tab) {
  box.replaceChildren();
  if (!tab.info) { box.append(h('div', { className: 'empty' }, '解析后在这里选择')); return; }
  const info = tab.info;
  const pick = tab.pick;

  box.append(h('div', { className: 'h1' }, '下载内容', h('span', { className: 'sub' }, info.source || '')));

  if (info.videos?.length) {
    const opts = h('div', { className: 'opts' });
    for (const v of info.videos) {
      const on = pick.videoQn === v.qn;
      const o = h('div', { className: 'opt' + (on ? ' on' : '') }, v.label || `${v.height}P`);
      o.onclick = () => { pick.videoQn = on ? null : v.qn; render(); };
      opts.append(o);
    }
    box.append(h('div', { className: 'sec' }, h('h4', {}, '视频', h('span', {}, pick.videoQn ? '点一下取消' : '未选')), opts));
  }

  if (info.audios?.length || info.videos?.length) {
    const a = h('input', { type: 'checkbox' });
    a.checked = pick.audio;
    a.onchange = (e) => { pick.audio = e.target.checked; render(); };
    const m = h('input', { type: 'checkbox' });
    m.checked = pick.audioMp3;
    m.onchange = (e) => { pick.audioMp3 = e.target.checked; };
    box.append(h('div', { className: 'sec' },
      h('h4', {}, '音频', h('span', {}, '视频自带音轨')),
      h('div', { className: 'opts' }, h('label', { className: 'chk' }, a, '额外音频'), h('label', { className: 'chk' }, m, '转 MP3')),
    ));
  }

  if (info.covers?.length || info.up?.face) {
    const picks = h('div', { className: 'picks' });
    const card = (url, on, cap, round, toggle) => {
      const el = h('div', { className: 'pick' + (round ? ' round' : '') + (on ? ' on' : ''), title: cap },
        h('div', { className: 'frame' }, h('img', { src: url, referrerPolicy: 'no-referrer' })),
        h('span', { className: 'cap' }, cap));
      el.onclick = () => { toggle(); render(); };
      return el;
    };
    for (const c of info.covers || []) {
      const on = pick.coverIds.includes(c.id);
      picks.append(card(c.url, on, c.label || '封面', false, () => {
        pick.coverIds = on ? pick.coverIds.filter((x) => x !== c.id) : [...pick.coverIds, c.id];
      }));
    }
    if (info.up?.face) picks.append(card(info.up.face, pick.avatar, '头像', true, () => { pick.avatar = !pick.avatar; }));
    box.append(h('div', { className: 'sec' }, h('h4', {}, '封面 / 头像', h('span', {}, '点击选中')), picks));
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
        render();
      };
      picks.append(el);
    }
    box.append(h('div', { className: 'sec' }, h('h4', {}, `图文 · ${info.images.length} 张`), picks));
  }

  const start = h('button', { style: 'width:100%' }, tab.state === 'downloading' ? '下载中…' : '开始下载');
  start.disabled = tab.state === 'downloading';
  start.onclick = () => startDownload(tab);
  box.append(start);

  if (tab.done) box.append(h('div', { style: 'color:#1a9c5b;font-size:12.5px;margin-top:8px' }, '已保存到 ' + tab.done));
}

/* ── 下载 ───────────────────────────────────────────── */
async function startDownload(tab) {
  tab.state = 'downloading';
  S.view = 'downloads';
  render();

  try {
    const job = await window.api.start({ url: tab.url, info: tab.info, pick: tab.pick });
    const rec = { id: job.id, tabId: tab.id, title: tab.info.title, cover: tab.info.cover, items: job.items || [] };
    S.jobs.unshift(rec);
    render();
    pollJob(rec, tab);
  } catch (e) {
    tab.state = 'error';
    tab.error = e.message;
    render();
  }
}

async function pollJob(rec, tab) {
  const tick = async () => {
    const job = await window.api.job(rec.id);
    if (!job) return;
    rec.items = job.items;
    if (S.view === 'downloads') render();
    if (job.status === 'done' || job.status === 'error') {
      tab.state = job.status === 'done' ? 'done' : 'error';
      if (job.status === 'done') {
        tab.done = S.boot.outDir;
        S.history = await window.api.historyAdd({
          key: rec.id, url: tab.url, title: tab.info.title, cover: tab.info.cover,
          kind: tab.info.source || 'media', outDir: S.boot.outDir, at: Date.now(),
        });
      }
      render();
      return;
    }
    setTimeout(tick, 700);
  };
  tick();
}

function renderDownloads(box) {
  box.append(h('div', { className: 'h1' }, '下载进度', h('span', { className: 'sub' }, S.jobs.length ? `${S.jobs.length} 个任务` : '')));
  if (!S.jobs.length) { box.append(h('div', { className: 'empty' }, '还没有下载任务')); return; }

  for (const rec of S.jobs) {
    const card = h('div', { className: 'sec' }, h('h4', {}, (rec.title || rec.id).slice(0, 46)));
    for (const it of rec.items || []) {
      const pct = it.total ? Math.round((it.received / it.total) * 100) : (it.status === 'done' ? 100 : 0);
      card.append(h('div', { className: 'item' },
        h('span', { className: 'nm' }, it.label || it.name || '文件'),
        h('div', { className: 'pbar' }, Object.assign(h('i'), { style: `width:${pct}%` })),
        h('span', { className: 'pc' }, it.status === 'done' ? '✓' : pct + '%'),
      ));
    }
    box.append(card);
  }
}

function renderHistory(box) {
  const head = h('div', { className: 'h1' }, '历史记录', h('span', { className: 'sub' }, `${S.history.length} 条`));
  if (S.history.length) {
    const clear = h('button', { className: 'ghost', style: 'margin-left:auto' }, '清空');
    clear.onclick = async () => { S.history = await window.api.historyClear(); render(); };
    head.append(clear);
  }
  box.append(head);

  if (!S.history.length) { box.append(h('div', { className: 'empty' }, '下载过的会记在这里')); return; }

  const card = h('div', { className: 'sec' });
  for (const it of S.history) {
    const open = h('span', { className: 'lnk' }, '打开');
    open.onclick = () => window.api.reveal(it.outDir);
    const again = h('span', { className: 'lnk', style: 'color:var(--sub)' }, '再来');
    again.onclick = () => newTab(it.url);
    card.append(h('div', { className: 'item' },
      it.cover ? h('img', { className: 'thumb-sm', src: it.cover, referrerPolicy: 'no-referrer' }) : null,
      h('span', { className: 'nm' }, it.title || it.url),
      h('span', { className: 'pc', style: 'width:66px' }, new Date(it.at).toLocaleDateString('zh-CN')),
      open, again,
    ));
  }
  box.append(card);
}

/* ── 设置 ───────────────────────────────────────────── */
let siteState = [];
let sessionHint = '';

async function renderSettings(box) {
  box.append(h('div', { className: 'h1' }, '设置'));

  const dirCard = h('div', { className: 'sec' }, h('h4', {}, '下载'));
  dirCard.append(h('div', { className: 'kv' },
    h('span', { className: 'k' }, '保存到'),
    h('span', { className: 'v', title: S.boot.outDir }, S.boot.outDir),
    (() => { const b = h('button', { className: 'ghost' }, '更换'); b.onclick = async () => { await pickDir(); render(); }; return b; })(),
  ));
  dirCard.append(h('div', { className: 'kv' },
    h('span', { className: 'k' }, 'ffmpeg'),
    h('span', { className: 'v' }, S.boot.ffmpeg ? '已内置（' + S.boot.ffmpeg.split('\\').pop() + '）' : '未找到'),
  ));
  box.append(dirCard);

  const acc = h('div', { className: 'sec' }, h('h4', {}, '账号', h('span', {}, '与 DSH 插件共用 Cookie')));
  for (const p of siteState) {
    const row = h('div', { className: 'kv' },
      h('span', { className: 'k' }, p.label),
      h('span', { className: 'v', style: p.logged ? 'color:#1a9c5b;font-weight:600' : 'color:var(--sub)' }, p.logged ? '已登录' : '未登录'),
    );
    const open = h('button', { className: 'ghost' }, '登录');
    open.onclick = async () => {
      const r = await window.api.openSiteLogin(p.id);
      sessionHint = r.ok ? `已打开 ${p.label} 登录窗口，登录完点「完成登录」` : ('打开失败：' + r.error);
      render();
    };
    row.append(open);
    acc.append(row);
  }
  const finish = h('button', { className: 'ghost' }, '完成登录');
  finish.onclick = async () => {
    const r = await window.api.finishSiteLogin();
    sessionHint = r.ok ? `已保存 Cookie${r.count ? '（' + r.count + ' 条）' : ''}` : ('保存失败：' + r.error);
    await refreshSites();
  };
  const cancelBtn = h('button', { className: 'ghost' }, '取消');
  cancelBtn.onclick = async () => { await window.api.cancelSiteLogin(); sessionHint = '已取消'; render(); };
  acc.append(h('div', { className: 'kv' },
    h('span', { className: 'k' }, '状态'),
    h('span', { className: 'v', style: 'color:var(--sub)' }, sessionHint || '未打开登录窗口'),
  ));
  acc.append(h('div', { className: 'kv', style: 'justify-content:flex-end;gap:8px' }, finish, cancelBtn));
  box.append(acc);

  box.append(h('div', { className: 'sec' }, h('h4', {}, '关于'),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '版本'), h('span', { className: 'v' }, 'v' + S.boot.version)),
    h('div', { className: 'kv' }, h('span', { className: 'k' }, '更新'), h('span', { className: 'v' }, '启动时检查 GitHub Release')),
  ));
}

/* 首次进入设置时拉一次平台列表 */
const _renderSettings = renderSettings;
renderSettings = async function (box) {
  if (!siteState.length) {
    const r = await window.api.loginSites().catch(() => ({ platforms: [] }));
    siteState = r.platforms || [];
  }
  return _renderSettings(box);
};

boot();
