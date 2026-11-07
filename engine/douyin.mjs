/**
 * 抖音原生解析：短视频走分享页 SSR（iesdouyin.com），不依赖 yt-dlp 的 msToken。
 *
 * 链路：v.douyin.com 短链 → 跟跳拿 aweme_id → 分享页 HTML
 *      → window._ROUTER_DATA → videoInfoRes.item_list[0]
 *      → video.play_addr（把 /playwm/ 换成 /play/ 即无水印）
 */
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJob, publicJob, imageExtFrom, findFfmpeg } from './bili.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const COOKIE_FILE = process.env.MEDIADL_COOKIE_FILE || join(homedir(), '.dsh', 'bili-dl', 'cookies.txt');

export const looksLikeDouyin = (url) => /(^|\/\/)([a-z0-9-]+\.)?(douyin|iesdouyin)\.com\//i.test(String(url));

const TTWID_FILE = join(homedir(), '.dsh', 'bili-dl', 'ttwid.json');
let ttwidCache = null;

/** 从 cookies.txt 里捞一个现成的 ttwid（有就用，省一次注册） */
function ttwidFromJar() {
  try {
    const text = readFileSync(COOKIE_FILE, 'utf8');
    const rows = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    const hit = rows.find((r) => r.length >= 7 && r[5] === 'ttwid' && /douyin/.test(r[0]));
    return hit ? hit[6] : '';
  } catch {
    return '';
  }
}

/**
 * 抖音只需要一个匿名访客标识 ttwid，不需要登录。
 * 本地没有就向字节的 union register 接口领一个，并缓存 7 天。
 */
async function getTtwid() {
  if (ttwidCache) return ttwidCache;

  try {
    const saved = JSON.parse(readFileSync(TTWID_FILE, 'utf8'));
    if (saved?.ttwid && Date.now() - (saved.at || 0) < 7 * 86400_000) {
      ttwidCache = saved.ttwid;
      return ttwidCache;
    }
  } catch { /* 没有缓存 */ }

  const fromJar = ttwidFromJar();
  if (fromJar) {
    ttwidCache = fromJar;
    return ttwidCache;
  }

  try {
    const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA_MOBILE },
      body: JSON.stringify({
        region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of cookies) {
      const m = /^ttwid=([^;]+)/.exec(sc);
      if (m) {
        ttwidCache = m[1];
        try { writeFileSync(TTWID_FILE, JSON.stringify({ ttwid: m[1], at: Date.now() }), 'utf8'); } catch { /* ignore */ }
        return ttwidCache;
      }
    }
  } catch { /* 签发失败就退回空 cookie */ }

  return '';
}

async function douyinCookieHeader() {
  /* 优先用同步下来的完整 Cookie（sessionid / uifid / odin_tt 等），签名与鉴权都需要 */
  try {
    const text = readFileSync(COOKIE_FILE, 'utf8');
    const rows = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    const pairs = rows
      .filter((r) => r.length >= 7 && /douyin\.com$/.test(String(r[0]).replace(/^\./, '')))
      .map((r) => r[5] + '=' + r[6]);
    if (pairs.length) return pairs.join('; ');
  } catch {}

  const tw = await getTtwid().catch(() => '');
  return tw ? 'ttwid=' + tw : '';
}

async function follow(url, jar) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': UA_MOBILE, Cookie: jar, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const location = res.headers.get('location');
    if (!location) return current;
    current = new URL(location, current).toString();
  }
  return current;
}

/** 从任意抖音链接里拿到 aweme_id。 */
export async function resolveAwemeId(input) {
  const text = String(input || '').trim();
  const direct = text.match(/(?:video|note|share\/video)\/(\d{15,25})/);
  if (direct) return direct[1];
  const jar = await douyinCookieHeader();
  const finalUrl = await follow(text, jar);
  const m = finalUrl.match(/(?:video|note|share\/video)\/(\d{15,25})/);
  if (!m) throw new Error('没能从链接里解析出视频 ID');
  return m[1];
}

/**
 * Web 接口探测：/aweme/v1/web/aweme/detail/
 * 需要登录 Cookie（含 uifid），能拿到 bit_rate 多档画质，
 * 以及实况图 images[i].video 的动态流。
 */
/** 把抖音原始 item 归一化成面板数据结构（分享页 / Web 接口共用） */
export function normalizeAwemeItem(item, id) {
  const br = item?.video?.bit_rate || [];
  const videos = br
    .map((b) => {
      const w = b.play_addr?.width || 0;
      const h = b.play_addr?.height || 0;
      const url = (b.play_addr?.url_list || [])[0];
      if (!url) return null;
      return {
        qn: h || Math.min(w, h) || 720,
        label: b.gear_name || (h ? h + 'P' : '视频'),
        codec: 'H.264',
        height: h,
        vip: false,
        bandwidth: b.bit_rate || 0,
        url,
        backups: (b.play_addr?.url_list || []).slice(1),
      };
    })
    .filter(Boolean)
    .sort((x, y) => (y.height || 0) - (x.height || 0));

  const images = (item?.images || []).map((img, i) => ({
    id: 'img' + (i + 1),
    label: '图 ' + (i + 1),
    url: (img.url_list || [])[0] || (img.download_url_list || [])[0] || '',
    video: (img.video?.play_addr?.url_list || [])[0]
      || (img.video?.play_addr_h264?.url_list || [])[0]
      || (img.video?.download_addr?.url_list || [])[0] || '',
  })).filter((x) => x.url);

  const playList = item?.video?.play_addr?.url_list || [];
  const slideshow = !playList.length || !Number(item?.video?.duration || 0);
  const usable = slideshow ? [] : (videos.length ? videos : [{
    qn: 720, label: '无水印', codec: 'H.264', height: 0, vip: false, bandwidth: 0,
    url: playList[0].replace('/playwm/', '/play/'), backups: playList.slice(1),
  }]);

  return {
    source: 'douyin', bvid: '', aid: 0, cid: 0,
    title: item?.desc || ('抖音 ' + id),
    desc: item?.desc || '',
    partTitle: '', page: 1, pageCount: 1,
    duration: Math.round((item?.video?.duration || 0) / 1000) || 0,
    cover: (item?.video?.origin_cover?.url_list || [])[0] || (item?.video?.cover?.url_list || [])[0] || (images[0]?.url || ''),
    up: { mid: 0, name: item?.author?.nickname || '', face: (item?.author?.avatar_thumb?.url_list || [])[0] || '' },
    videos: images.length ? [] : usable,
    audios: [],
    images,
    covers: [],
    awemeId: id,
    maxQn: usable[0]?.qn || 0,
    hasDurl: false,
  };
}

/* ── 内置 Python 签名器（a_bogus + x-secsdk-web-signature） ── */
const PY_CHILD = { proc: null, buf: '', queue: [] };

function pythonExePath() {
  const cands = [];
  if (process.resourcesPath) cands.push(join(process.resourcesPath, 'vendor', 'python', 'python.exe'));
  cands.push(join(process.cwd(), 'vendor', 'python', 'python.exe'));
  cands.push(join(__dirname, '..', 'vendor', 'python', 'python.exe'));
  for (const c of cands) { try { if (existsSync(c)) return c; } catch {} }
  return '';
}

function signScriptPath() {
  const cands = [];
  if (process.resourcesPath) cands.push(join(process.resourcesPath, 'app.asar.unpacked', 'engine', 'pysign', 'sign.py'));
  cands.push(join(__dirname, 'pysign', 'sign.py'));
  for (const c of cands) { try { if (existsSync(c)) return c; } catch {} }
  return '';
}

function ensureSigner() {
  if (PY_CHILD.proc) return PY_CHILD.proc;
  const exe = pythonExePath();
  const script = signScriptPath();
  if (!exe || !script) return null;

  const child = spawn(exe, [script], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdout.on('data', (chunk) => {
    PY_CHILD.buf += chunk.toString('utf8');
    let idx;
    while ((idx = PY_CHILD.buf.indexOf('__SIG__')) >= 0) {
      const end = PY_CHILD.buf.indexOf('\n', idx);
      if (end < 0) break;
      const line = PY_CHILD.buf.slice(idx + 7, end).trim();
      PY_CHILD.buf = PY_CHILD.buf.slice(end + 1);
      const resolve = PY_CHILD.queue.shift();
      if (resolve) {
        try { resolve(JSON.parse(line)); } catch { resolve({ ok: false }); }
      }
    }
  });
  child.on('exit', () => { PY_CHILD.proc = null; });
  PY_CHILD.proc = child;
  return child;
}

function pySign(query, uifid) {
  return new Promise((resolve) => {
    const child = ensureSigner();
    if (!child) { resolve({ ok: false, error: 'no python' }); return; }
    PY_CHILD.queue.push(resolve);
    try {
      child.stdin.write(JSON.stringify({ query, uifid }) + '\n');
    } catch { resolve({ ok: false, error: 'stdin' }); }
    setTimeout(() => {
      const i = PY_CHILD.queue.indexOf(resolve);
      if (i >= 0) { PY_CHILD.queue.splice(i, 1); resolve({ ok: false, error: 'timeout' }); }
    }, 8000);
  });
}

async function probeWeb(id) {
  const jar = await douyinCookieHeader();
  const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  /* 从 cookie 里取 uifid / msToken / ttwid（webid），签名需要 */
  const pick = (name) => {
    const m = new RegExp('(?:^|;\\\\s*)' + name + '=([^;]*)', 'i').exec(jar || '');
    return m ? m[1] : '';
  };
  const uifid = pick('uifid');
  const msToken = pick('msToken');
  const webid = pick('ttwid');

  const params = new URLSearchParams({
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', aweme_id: id,
    pc_client_type: '1', pc_libra_divert: 'Windows', support_h265: '1', support_dash: '1',
    version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
    screen_width: '1440', screen_height: '900', browser_language: 'zh-CN',
    browser_platform: 'Win32', browser_name: 'Chrome', browser_version: '138.0.0.0',
    browser_online: 'true', engine_name: 'Blink', engine_version: '138.0.0.0',
    os_name: 'Windows', os_version: '10', cpu_core_num: '8', device_memory: '8',
    platform: 'PC', downlink: '10', effective_type: '4g', round_trip_time: '50',
  });
  if (uifid) params.set('uifid', uifid);
  if (msToken) params.set('msToken', msToken);
  if (webid) params.set('webid', webid);

  const signed = await pySign(params.toString(), uifid);
  if (!signed.ok || !signed.query) throw new Error('抖音签名器不可用');

  const res = await fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?' + signed.query, {
    headers: {
      'User-Agent': UA_DESKTOP,
      Referer: 'https://www.douyin.com/',
      Cookie: jar,
      Accept: 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(15000),
  });
  const text0 = await res.text();
  if (!res.ok) { try { writeFileSync(join(require('node:os').tmpdir(), 'douyin-web-err.txt'), 'JAR=' + (jar || '').length + ' UIFID=' + uifid.length + ' MS=' + msToken.length + ' WEB=' + webid.length + '\nQUERY=' + signed.query.slice(0, 300)); } catch {} throw new Error('web ' + res.status); }
  const text = text0;
  if (!text.trim().startsWith('{')) throw new Error('web blocked');
  const j = JSON.parse(text);
  const a = j.aweme_detail || (j.aweme_details || [])[0];
  if (!a) throw new Error('web 无详情');
  const info = normalizeAwemeItem(a, id);
  info.viaWeb = true;
  return info;
}

function toNoWatermark(u) {
  return String(u).replace('/playwm/', '/play/');
}

/** 探测：返回与面板通用的 info 结构。 */
export async function douyinProbe(input) {
  const id = await resolveAwemeId(input);

  /* 有 Cookie 时优先走 Web 接口：能拿到多档画质与实况图动态流 */
  try {
    const web = await probeWeb(id);
    if (web.videos.length || web.images.length) return web;
  } catch (err) { try { writeFileSync(join(process.env.TEMP || '.', 'douyin-web-err.txt'), String(err && err.stack || err) + '\nPY=' + pythonExePath() + '\nSIGN=' + signScriptPath()); } catch {} }

  const jar = await douyinCookieHeader();
  const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
  const res = await fetch(shareUrl, {
    headers: { 'User-Agent': UA_MOBILE, Cookie: jar, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`分享页返回 HTTP ${res.status}`);
  const html = await res.text();

  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) throw new Error('分享页里没找到数据（可能改版）');

  let data;
  try { data = JSON.parse(m[1]); }
  catch { throw new Error('分享页数据结构无法解析'); }

  const loader = data.loaderData || {};
  let item = null;
  for (const value of Object.values(loader)) {
    const list = value?.videoInfoRes?.item_list;
    if (Array.isArray(list) && list.length) { item = list[0]; break; }
  }
  if (!item) throw new Error('没有拿到视频信息（可能已删除、私密，或需要登录）');

  const playList = item.video?.play_addr?.url_list || [];
  /* 实况图（Live Photo）：一张静态图 + 一段短视频。
     抖音把视频藏在图片对象的各个位置，这里做深度扫描，找出所有可能的 URL。 */
  const deepVideoUrl = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 4) return '';
    const p2 = obj.play_addr || obj.play_addr_h264 || obj.play_addr_265 || obj.download_addr
      || obj.play_addr_lowbr || obj.playApi || obj.video;
    const list = p2?.url_list || p2?.play_addr?.url_list;
    if (Array.isArray(list) && list[0]) return list[0];
    for (const key of ['bit_rate', 'bitrate', 'video', 'live_photo', 'live_photo_info', 'dynamic', 'animated', 'image_thumb']) {
      const v = obj[key];
      if (Array.isArray(v)) {
        for (const it of v) { const u = deepVideoUrl(it, depth + 1); if (u) return u; }
      } else if (v && typeof v === 'object') {
        const u = deepVideoUrl(v, depth + 1);
        if (u) return u;
      }
    }
    return '';
  };

  const imageEntries = (item.images || []).map((img) => ({
    url: (img.url_list || [])[0] || (img.download_url_list || [])[0] || '',
    video: deepVideoUrl(img),
  })).filter((x) => x.url);

  /* 诊断日志：记录首张图的字段与抓到的视频地址 */
  try {
    const first = (item.images || [])[0];
    if (first) {
      const info = {
        keys: Object.keys(first),
        videoLike: Object.keys(first).filter((k) => /video|live|dynamic|anim/i.test(k)),
        got: imageEntries[0]?.video ? String(imageEntries[0].video).slice(0, 60) : '',
        itemVideo: !!(item.video && item.video.play_addr),
      };
      require('node:fs').appendFileSync(
        require('node:path').join(require('node:os').tmpdir(), 'lodown-debug.log'),
        new Date().toISOString() + ' DOUYIN_IMG ' + JSON.stringify(info) + '\n',
      );
    }
  } catch {}

  const images = imageEntries.map((x) => x.url);

  /* 图集 / 实况图：带图片就按图集处理。
     抖音的实况图作品会附带一条 duration=0 的 slideshow「视频」，
     它的播放地址取回来是 0 字节（实测 HTTP 200 + 空 body），不能当视频下。 */
  const slideshow = !playList.length || !Number(item.video?.duration || 0)
    || (!item.video?.play_addr?.width && !item.video?.play_addr?.height);
  if (images.length || slideshow) {
    if (!images.length) throw new Error('这个作品既没有视频也没有图片');
    return {
      source: 'douyin', bvid: '', aid: 0, cid: 0,
      title: item.desc || `抖音 ${id}`,
      partTitle: '', page: 1, pageCount: 1,
      duration: 0,
      cover: images[0],
      up: { mid: 0, name: item.author?.nickname || '', face: (item.author?.avatar_thumb?.url_list || [])[0] || '' },
      videos: [], audios: [],
      images: imageEntries.map((x, i) => ({ id: `img${i + 1}`, label: `图 ${i + 1}`, url: x.url, video: x.video })),
      covers: [],
      awemeId: id, maxQn: 0, hasDurl: false,
    };
  }
  const watermarked = playList[0];
  const clean = toNoWatermark(watermarked);
  const height = /ratio=(\d+)p/.exec(watermarked)?.[1] || '';

  return {
    source: 'douyin',
    bvid: '', aid: 0, cid: 0,
    title: item.desc || `抖音 ${id}`,
    desc: item.desc || '',
    partTitle: '',
    page: 1, pageCount: 1,
    duration: Math.round((item.video?.duration || 0) / 1000) || 0,
    cover: item.video?.origin_cover?.url_list?.[0] || item.video?.cover?.url_list?.[0] || '',
    /* 抖音同时可能给 3:4 / 4:3 / 动态封面，逐份列出来 */
    covers: [
      { id: 'origin', label: '原图', url: item.video?.origin_cover?.url_list?.[0] },
      { id: 'cover', label: '封面', url: item.video?.cover?.url_list?.[0] },
      { id: 'dynamic', label: '动态封面', url: item.video?.dynamic_cover?.url_list?.[0] },
    ].filter((c, i, arr) => c.url && arr.findIndex((x) => x.url === c.url) === i),
    up: { mid: 0, name: item.author?.nickname || '', face: (item.author?.avatar_thumb?.url_list || [])[0] || '' },
    videos: [{
      qn: Number(height) || 720,
      label: `无水印${height ? ' ' + height + 'P' : ''}`,
      codec: 'H.264',
      height: Number(height) || 720,
      vip: false,
      bandwidth: 0,
      url: clean,
      backups: [watermarked],
    }],
    audios: [],
    images,
    awemeId: id,
    maxQn: Number(height) || 720,
    hasDurl: false,
  };
}

/* ── 下载 ────────────────────────────────────────────────────────────── */

const STREAM_HEADERS = { 'User-Agent': UA_MOBILE, Referer: 'https://www.douyin.com/' };

async function streamTo(urls, filePath, onProgress, signal) {
  let lastErr;
  for (const url of urls.filter(Boolean)) {
    try {
      const res = await fetch(url, { headers: STREAM_HEADERS, signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const out = createWriteStream(filePath);
      let received = 0;
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress?.(received, total);
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (total && received !== total) throw new Error('下载不完整');
      return received;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`下载失败：${lastErr?.message || 'unknown'}`);
}

const safe = (s, n = 80) => String(s || 'douyin').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, n) || 'douyin';

export async function startDouyinDownload(req, { info, onUpdate } = {}) {
  const controller = new AbortController();
  const job = createJob(info.title, req.outDir, controller);
  const notify = () => onUpdate?.(publicJob(job));
  const pick = req.pick || {};

  (async () => {
    try {
      await mkdir(req.outDir, { recursive: true });
      const base = `${safe(info.title, 45)}[${info.awemeId}]`;

      if (pick.videoQn && info.videos[0]) {
        const v = info.videos[0];
        const item = { kind: 'video', label: `视频 ${v.label}`, status: 'working', file: null, error: null, parts: [{ name: 'download', received: 0, total: 0 }] };
        job.items.push(item); notify();
        const target = join(req.outDir, `${base}.mp4`);
        await streamTo([v.url, ...v.backups], target, (r, t) => {
          item.parts[0].received = r;
          if (t) item.parts[0].total = t;
          notify();
        }, controller.signal);
        if (!item.parts[0].received) {
          /* 空流（实况图的 slideshow）：删掉空文件，回退为下载图片 */
          try { const { unlink } = await import('node:fs/promises'); await unlink(target); } catch {}
          job.items = job.items.filter((x) => x !== item);
          try {
            const { unlink } = await import('node:fs/promises');
            await unlink(target).catch(() => {});
          } catch {}
          notify();
          if (!(info.images || []).length) throw new Error('视频流为空，且这个作品没有图片');
          pick.imageIds = (info.images || []).map((x) => x.id);
        } else {
          item.file = target;
          item.status = 'done';
          notify();
        }
      }

      /* 图文作品：按选中的图片下载 */
      const wantedImages = (info.images || []).filter((c) => (pick.imageIds || []).includes(c.id));
      for (const img of wantedImages) {
        const label = img.video ? img.label + '（动图）' : img.label;
        const item = { kind: 'image', label, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          if (img.video) {
            /* 实况图：先取原始视频流，再用 ffmpeg 转成会动的 WebP */
            const mp4 = join(req.outDir, `${base}_${safe(img.label, 12)}.mp4`);
            let got = 0;
            await streamTo([img.video], mp4, (r) => { got = r; }, controller.signal);

            let finalFile = mp4;
            try {
              const ff = await findFfmpeg('');
              if (ff) {
                const webp = join(req.outDir, `${base}_${safe(img.label, 12)}_动图.webp`);
                await new Promise((resolve, reject) => {
                  const cp = spawn(ff, ['-y', '-i', mp4, '-vf', 'fps=15,scale=720:-1:flags=lanczos',
                    '-loop', '0', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '75', webp],
                  { windowsHide: true });
                  cp.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg ' + code))));
                  cp.on('error', reject);
                });
                finalFile = webp;
              }
            } catch { /* ffmpeg 不可用就保留 mp4 */ }

            item.file = finalFile;
            item.parts = [{ name: 'video', received: got, total: got }];
            item.status = 'done';
            notify();
            continue;
          }
          const res = await fetch(img.url, { headers: STREAM_HEADERS, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const ext = buf.subarray(0, 4).toString() === 'RIFF' ? '.webp'
            : buf.subarray(1, 4).toString() === 'PNG' ? '.png' : '.jpg';
          const target = join(req.outDir, `${base}_${safe(img.label, 12)}${ext}`);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, buf);
          item.file = target; item.status = 'done';
        } catch (err) { item.status = 'error'; item.error = err.message; }
        notify();
      }

      const wantedCovers = (info.covers || []).filter((c) =>
        pick.coverIds ? pick.coverIds.includes(c.id) : pick.cover);
      for (const c of wantedCovers) {
        const item = { kind: 'cover', label: `封面 · ${c.label}`, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        try {
          const res = await fetch(c.url, { headers: STREAM_HEADERS, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const target = join(req.outDir, `${base}_封面_${safe(c.label, 12)}${imageExtFrom(buf)}`);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(target, buf);
          item.file = target;
          item.status = 'done';
        } catch (err) {
          item.status = 'error';
          item.error = err.message;
        }
        notify();
      }

      if (pick.avatar && info.up?.face) {
        const item = { kind: 'avatar', label: `作者头像 · ${info.up.name}`, status: 'working', file: null, error: null, parts: [] };
        job.items.push(item); notify();
        const res = await fetch(info.up.face, { headers: STREAM_HEADERS, signal: controller.signal });
        if (!res.ok) throw new Error(`头像 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const target = join(req.outDir, `${safe(info.up.name, 40)}_头像${imageExtFrom(buf)}`);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(target, buf);
        item.file = target;
        item.status = 'done';
        notify();
      }

      if (!job.items.length) throw new Error('没有勾选任何项目');
      job.status = 'done';
      job.endedAt = Date.now();
      notify();
    } catch (err) {
      for (const it of job.items) {
        if (it.status === 'working') { it.status = 'error'; it.error = controller.signal.aborted ? '已取消' : err.message; }
      }
      job.status = controller.signal.aborted ? 'canceled' : 'error';
      job.error = controller.signal.aborted ? '已取消' : err.message;
      job.endedAt = Date.now();
      notify();
    }
  })();

  return publicJob(job);
}