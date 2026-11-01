import { existsSync, mkdirSync, statSync, createWriteStream, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/* 准备内置 ffmpeg：
   1. vendor/ffmpeg.exe 已存在 → 直接用
   2. vendor/ffmpeg-win64.zip 存在 → 解开
   3. 都没有 → 从本仓库 Release 附件下载压缩包（37 MB），再解开
   exe 有 100 MB，超过 GitHub 单文件限制，所以仓库里只能存压缩包 / 附件。 */

const REPO = 'lohana20061023-29/media-downloader-app';
const TAG = 'v0.2.0';
const URL = `https://github.com/${REPO}/releases/download/${TAG}/ffmpeg-win64.zip`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const exe = join(vendor, 'ffmpeg.exe');
const zip = join(vendor, 'ffmpeg-win64.zip');

const ok = (p) => existsSync(p) && statSync(p).size > 50 * 1024 * 1024;

if (ok(exe)) {
  console.log('ffmpeg.exe 已就绪（' + (statSync(exe).size / 1024 / 1024).toFixed(1) + ' MB）');
  process.exit(0);
}

mkdirSync(vendor, { recursive: true });

if (!existsSync(zip)) {
  console.log('下载 ffmpeg 压缩包（37 MB）…');
  const res = await fetch(URL, { redirect: 'follow', headers: { 'User-Agent': 'lodown-build' } });
  if (!res.ok) {
    console.error(`下载失败 HTTP ${res.status}，请手动放置 vendor/ffmpeg-win64.zip`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
  console.log('下载完成：' + (statSync(zip).size / 1024 / 1024).toFixed(1) + ' MB');
}

console.log('解压…');
try {
  execFileSync('tar', ['-xf', zip, '-C', vendor], { stdio: 'inherit' });
} catch {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${vendor}' -Force`], { stdio: 'inherit' });
}

if (!ok(exe)) {
  console.error('解压后没有找到可用的 ffmpeg.exe');
  process.exit(1);
}
console.log('完成：' + (statSync(exe).size / 1024 / 1024).toFixed(1) + ' MB');
