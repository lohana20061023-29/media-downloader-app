/* 渲染进程：状态驱动的最小 UI，复用引擎返回的 info 结构 */
let state = { info: null, pick: { videoQn: null, audio: true, audioId: null, audioMp3: true, coverIds: [], avatar: false }, busy: false, job: null, dir: '' };
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  for (const k of kids) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

async function boot() {
  const s = await window.api.bootstrap();
  state.dir = s.outDir;
  if (s.version) { const v = document.getElementById('ver'); if (v) v.textContent = 'v' + s.version; }
  $('dir').textContent = '📁 ' + s.outDir;
  $('dir').title = s.outDir + '（点击修改）';
  $('dir').onclick = pickDir;
  $('pick').onclick = pickDir;
  $('go').onclick = doProbe;
  $('start').onclick = doStart;
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') doProbe(); });
  window.api.onOpenUrl((url) => { $('url').value = url; doProbe(); });
  initLogin(s.login);
  initAccounts(s.loginSites);
}

async function pickDir() {
  const res = await window.api.pickDir();
  if (res.dir) { state.dir = res.dir; $('dir').textContent = '📁 ' + res.dir; }
}

async function doProbe() {
  const url = $('url').value.trim();
  if (!url || state.busy) return;
  state.busy = true; $('go').disabled = true;
  $('out').replaceChildren(h('div', { className: 'empty' }, '解析中…'));
  try {
    const info = await window.api.probe(url);
    state.info = info;
    state.pick = { videoQn: info.videos?.[0]?.qn ?? null, audio: true, audioId: null, audioMp3: true, coverIds: [], avatar: false };
    render();
  } catch (e) {
    $('out').replaceChildren(h('div', { className: 'err' }, '解析失败：' + (e.message || e)));
  } finally {
    state.busy = false; $('go').disabled = false;
  }
}

function render() {
  const info = state.info;
  if (!info) return;
  const out = $('out');
  out.replaceChildren();

  /* 标题卡 */
  const cover = info.cover || info.covers?.[0]?.url || '';
  out.append(h('div', { className: 'card meta' },
    h('img', { className: 'cover', src: cover, referrerPolicy: 'no-referrer' }),
    h('div', {},
      h('div', { className: 't' }, info.title || '（无标题）'),
      h('div', { className: 's' }, [info.up?.name || '', info.duration ? ' · ' + fmt(info.duration) : '', info.source ? ' · ' + info.source : ''].join('')),
      info.desc ? (() => {
        const d = h('div', { className: 'desc' }, info.desc);
        d.onclick = () => d.classList.toggle('open');
        d.title = '点击展开 / 收起';
        return d;
      })() : null,
    ),
  ));


  /* 视频画质 */
  if (info.videos?.length) {
    const sec = h('div', { className: 'card sec' }, h('h4', {}, '视频', h('span', {}, state.pick.videoQn ? '点一下取消' : '未选择 = 只要音频/图')));
    const opts = h('div', { className: 'opts' });
    for (const v of info.videos) {
      const on = state.pick.videoQn === v.qn;
      opts.append(h('div', { className: 'opt', 'data-on': on ? '1' : '0', onclick: () => { state.pick.videoQn = on ? null : v.qn; render(); } }, v.label || `${v.height}P`));
    }
    sec.append(opts); out.append(sec);
  }

  /* 音频 */
  if (info.audios?.length || info.videos?.length) {
    const sec = h('div', { className: 'card sec' }, h('h4', {}, '音频', h('span', {}, '视频自带音轨')));
    const row = h('div', { className: 'opts' });
    const label = h('label', { className: 'chk' },
      (() => { const i = h('input', { type: 'checkbox' }); i.checked = state.pick.audio; i.onchange = (e) => { state.pick.audio = e.target.checked; render(); }; return i; })(),
      '下载为额外音频文件');
    row.append(label);

    const mp3 = h('label', { className: 'chk' },
      (() => { const i = h('input', { type: 'checkbox' }); i.checked = state.pick.audioMp3; i.onchange = (e) => { state.pick.audioMp3 = e.target.checked; }; return i; })(),
      '转成 MP3');
    if (!state.pick.audio) mp3.style.opacity = '.45';
    row.append(mp3);
    if (info.audios?.length) {
      const sel = h('select', {});
      for (const a of info.audios) { const o = h('option', { value: String(a.id) }, `${a.label || a.id} · ${Math.round((a.bandwidth || 0) / 1000)}kbps`); sel.append(o); }
      sel.onchange = (e) => { state.pick.audioId = Number(e.target.value); };
      row.append(sel);
    }
    sec.append(row); out.append(sec);
  }

  /* 封面 / 头像：统一用带勾选框的卡片，和头像一致的选中反馈 */
  if (info.covers?.length || info.images?.length || info.up?.face) {
    const sec = h('div', { className: 'card sec' }, h('h4', {}, '封面 / 头像', h('span', {}, '点击选择，右上角打勾')));
    const picks = h('div', { className: 'picks' });

    const pickCard = (url, on, caption, round, onToggle) => {
      const box = h('div', { className: 'pick' + (round ? ' round' : '') + (on ? ' on' : ''), title: caption + (on ? '（已选）' : '（点击选择）') },
        h('img', { src: url, referrerPolicy: 'no-referrer', draggable: false }),
        h('span', { className: 'tick' }, '✓'),
        h('span', { className: 'cap' }, caption),
      );
      box.onclick = () => { onToggle(); render(); };
      return box;
    };

    for (const c of info.covers || []) {
      const on = state.pick.coverIds.includes(c.id);
      picks.append(pickCard(c.url, on, c.label || '封面', false, () => {
        state.pick.coverIds = on ? state.pick.coverIds.filter((x) => x !== c.id) : [...state.pick.coverIds, c.id];
      }));
    }

    if (info.up?.face) {
      const on = state.pick.avatar;
      picks.append(pickCard(info.up.face, on, '作者头像', true, () => { state.pick.avatar = !on; }));
    }

    sec.append(picks); out.append(sec);
  }

  /* 图文图片 */
  if (info.images?.length) {
    const sec = h('div', { className: 'card sec' }, h('h4', {}, `图文图片 · ${info.images.length} 张`));
    const thumbs = h('div', { className: 'thumbs' });
    for (const img of info.images) {
      const on = (state.pick.imageIds || []).includes(img.id);
      thumbs.append(h('img', { className: 'thumb', src: img.url, 'data-on': on ? '1' : '0', referrerPolicy: 'no-referrer', onclick: () => {
        const cur = state.pick.imageIds || [];
        state.pick.imageIds = on ? cur.filter((x) => x !== img.id) : [...cur, img.id];
        render();
      } }));
    }
    sec.append(thumbs); out.append(sec);
  }

  $('start').disabled = false;
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function doStart() {
  if (!state.info) return;
  $('start').disabled = true;
  const job = await window.api.start({ url: $('url').value.trim(), info: state.info, pick: state.pick });
  poll(job.id);
}

async function poll(id) {
  const box = h('div', { className: 'jobs' });
  $('out').prepend(box);
  const tick = async () => {
    const job = await window.api.job(id);
    if (!job) return;
    box.replaceChildren();
    for (const it of job.items) {
      const pct = it.total ? Math.round((it.received / it.total) * 100) : (it.status === 'done' ? 100 : 0);
      box.append(h('div', { className: 'job' },
        h('span', {}, `${it.label} ${it.status === 'done' ? '✓' : pct + '%'}`),
        h('div', { className: 'bar2' }, Object.assign(h('i'), { style: `width:${pct}%` })),
      ));
    }
    if (job.status === 'done' || job.status === 'error') { $('start').disabled = false; return; }
    setTimeout(tick, 700);
  };
  tick();
}

boot();


/* ── 登录 ─────────────────────────────────────────────── */
let loginTimer = 0;

function paintLogin(me) {
  const btn = $('login');
  if (!btn) return;
  if (me && me.login) {
    btn.textContent = me.uname || '已登录';
    btn.classList.add('on');
    btn.onclick = async () => {
      if (!confirm('退出登录？')) return;
      await window.api.logout();
      paintLogin({ login: false });
      $('out').replaceChildren(h('div', { className: 'empty' }, '已退出登录'));
    };
  } else {
    btn.textContent = '登录 B 站';
    btn.classList.remove('on');
    btn.onclick = openLogin;
  }
}

async function initLogin(me) {
  paintLogin(me);
  if (!me) {
    const m = await window.api.loginStatus().catch(() => null);
    if (m) paintLogin(m);
  }
}

async function openLogin() {
  const modal = $('loginModal');
  modal.hidden = false;
  $('qrBox').innerHTML = '<div class="empty">正在获取二维码…</div>';
  $('qrTip').textContent = '';
  try {
    const { key, svg } = await window.api.loginQr();
    $('qrBox').innerHTML = svg;
    $('qrTip').textContent = '用 B 站手机客户端扫码';
    clearInterval(loginTimer);
    loginTimer = setInterval(async () => {
      const r = await window.api.loginPoll(key).catch(() => ({ state: 'unknown' }));
      if (r.state === 'scanned') $('qrTip').textContent = '已扫码，请在手机上确认';
      else if (r.state === 'expired') { $('qrTip').textContent = '二维码已过期，点击刷新'; clearInterval(loginTimer); }
      else if (r.state === 'ok') {
        clearInterval(loginTimer);
        $('loginModal').hidden = true;
        paintLogin({ login: true, uname: r.uname });
        const cur = $('url').value.trim();
        if (cur) doProbe();
      }
    }, 1500);
  } catch (e) {
    $('qrBox').innerHTML = '';
    $('qrTip').textContent = '二维码获取失败：' + (e.message || e);
  }
}

$('loginClose').onclick = () => { $('loginModal').hidden = true; clearInterval(loginTimer); };
$('qrBox').addEventListener('click', () => { if (!$('qrTip').textContent.includes('过期')) return; openLogin(); });


/* ── 各平台登录（复用插件的 browser-login：打开系统浏览器登录）───── */
let platformList = [];
let sessionActive = false;

const PLATFORM_NOTE = {
  douyin: '解析无需登录（匿名 ttwid）',
  xiaohongshu: '解析无需登录（浏览器读取）',
  bilibili: '扫码登录，可选高画质',
  youtube: '登录后可看会员 / 私享内容',
  twitter: '登录后可看受保护内容',
  tiktok: '登录后可看部分区域内容',
  vimeo: '一般不需要登录',
};

function renderAccounts() {
  const box = $('accList');
  if (!box) return;
  box.replaceChildren();
  for (const p of platformList) {
    const note = PLATFORM_NOTE[p.id];
    const row = h('div', { className: 'arow' },
      h('div', { className: 'nmbox' },
        h('span', { className: 'nm' }, p.label),
        note ? h('span', { className: 'note' }, note) : null,
      ),
      h('span', { className: 'st' + (p.logged ? ' on' : '') }, p.logged ? '已登录' : '未登录'),
    );
    const open = h('button', {}, '打开登录');
    open.onclick = async () => {
      const r = await window.api.openSiteLogin(p.id);
      if (!r.ok) return alert('打开失败：' + r.error);
      sessionActive = true;
      $('accHint').textContent = '已在浏览器中打开 ' + p.label + '，登录完成后回到这里点「完成登录」';
    };
    row.append(open);
    box.append(row);
  }
  const spacer = h('div', { style: 'height:8px' });
  box.append(spacer);
}

async function refreshAccounts() {
  const r = await window.api.loginSites();
  platformList = r.platforms || [];
  renderAccounts();
  $('accTop').textContent = '链接解析本身都不需要登录：抖音只用匿名 ttwid，小红书走浏览器读取。登录只影响需要账号的内容。';
  if (r.cookieFile) $('accHint').textContent = 'Cookie 存于 ' + r.cookieFile + '（与 DSH 插件共用）';
}

async function initAccounts(sites) {
  const btn = $('accounts');
  if (btn) btn.onclick = async () => { $('accountsModal').hidden = false; await refreshAccounts(); };
  if ($('accClose')) $('accClose').onclick = () => { $('accountsModal').hidden = true; };

  /* 打开面板时先按 bootstrap 的值填一遍 */
  if (sites && typeof sites === 'object') {
    platformList = Object.entries(sites).map(([id, logged]) => ({ id, label: id, logged: !!logged }));
  }

  /* 引擎后台轮询，检测到登录会把 Cookie 写进文件；不刷新面板就会一直显示「未登录」 */
  if (window.api.onLoginSession) {
    window.api.onLoginSession(async (d) => {
      if (!d) return;
      if (d.state === 'ok') {
        await refreshAccounts();
        $('accHint').textContent = '已检测到登录并保存 Cookie（' + (d.count || 0) + ' 条）';
        sessionActive = false;
        const cur = $('url').value.trim();
        if (cur) doProbe();
      } else if (d.state === 'closed') {
        $('accHint').textContent = '登录窗口被关闭了；如果已经登录，请再点一次「打开登录」后点「完成登录」';
      } else if (d.state === 'error') {
        $('accHint').textContent = '登录检测出错：' + (d.message || '');
      } else if (d.state === 'timeout') {
        $('accHint').textContent = '等待超时（8 分钟）';
      } else if (d.state === 'waiting') {
        $('accHint').textContent = '窗口已打开，请在里面完成登录…';
      }
    });
  }

  $('accFinish').onclick = async () => {
    const r = await window.api.finishSiteLogin();
    if (!r.ok) return alert('保存 Cookie 失败：' + r.error);
    sessionActive = false;
    await refreshAccounts();
    $('accHint').textContent = '已保存 Cookie' + (r.count ? '（' + r.count + ' 条）' : '') + ' 到 ' + (r.cookieFile || 'cookies.txt');
    const cur = $('url').value.trim();
    if (cur) doProbe();
  };

  $('accCancel').onclick = async () => {
    await window.api.cancelSiteLogin();
    sessionActive = false;
    $('accHint').textContent = '已取消登录会话';
  };
}
