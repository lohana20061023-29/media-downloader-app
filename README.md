# 媒体下载 · 桌面版

DSH 媒体下载插件的独立版本：不用打开 DSH，粘一条链接就能下视频、原图、封面和头像。

## 支持

| 平台 | 能力 |
|---|---|
| B 站 | 多画质（最高 1080P60 / 4K，需登录）、独立音轨（可转 MP3）、封面、作者头像 |
| 小红书 | 图文原图（无水印）、视频笔记、作者头像 |
| 抖音 | 无水印视频、封面、头像 |
| 其它 | YouTube / X / TikTok / Vimeo 等，走 yt-dlp |

## 安装

从 [Releases](../../releases) 下载 `MediaDownloader-Setup-x.y.z.exe`，双击安装。

> 未做代码签名，Windows 可能提示「未知发布者」，选择「更多信息 → 仍要运行」即可。

## 用法

1. 粘贴链接，回车解析
2. 勾选需要的画质 / 音频 / 封面 / 头像
3. 点「开始下载」，文件进设置里的目录（默认 `下载\媒体下载`）

复制链接时，屏幕右下角会弹出提示，点一下直接打开并解析。

## 特性

- **托盘常驻**：关窗口不退出，右键托盘可打开或退出
- **登录复用**：直接读 DSH 插件的 B 站登录态（`~/.dsh/bili-dl/state.json`），没装 DSH 也能在设置里扫码登录（后续版本）
- **自动更新**：启动时检查 GitHub Release，有新版本自动下载并提示重启
- **ffmpeg**：音视频合流与 MP3 转换需要 ffmpeg，程序会自动在 PATH / 常见安装位置查找

## 开发

```bash
pnpm install
pnpm start        # 开发运行（会先解压内置 ffmpeg）
pnpm dist         # 打包 NSIS 安装包
```

> `ffmpeg-win64.zip`（37 MB）放在本仓库 Release 附件里，`scripts/prepare-ffmpeg.mjs` 会自动下载并解成
> `vendor/ffmpeg.exe`（100 MB，不进 git）。首次 `pnpm start` / `pnpm dist` 自动完成。

引擎代码在 `engine/`，与 DSH 插件同源（`lib/*.mjs`），两边保持同步。

## 目录

```
main.cjs        Electron 主进程（窗口 / 托盘 / 剪贴板 / IPC）
preload.cjs     contextBridge 暴露的 api
renderer/       界面（index.html + app.js + toast.html）
engine/         解析与下载引擎（ESM，来自 DSH 插件）
```

## 许可

MIT
