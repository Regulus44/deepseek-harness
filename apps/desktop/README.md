# dsh-desktop

把 DeepSeek Harness 的 Web UI 打包成一个独立的 Electron 桌面应用（Windows）。

## 原理

DSH 的前后端通过本地 HTTP 解耦：`dsh web` 起一个 host（serve React 前端 +
`/api` 网关）。这个壳做的只是：

1. 定位 `@deepseek-ai/dsh/lib/bin.js`
2. 以子进程拉起 `dsh web --host 127.0.0.1 --port 3090`
3. 轮询 HTTP 就绪后，用 `BrowserWindow` 加载该地址
4. 退出时连同 host 进程树一起杀掉

后端 host 与前端产物**零改动**。

## 自包含（无外部依赖）

打包后的 exe 自带两样关键东西，因此**不依赖系统 Node、不依赖任何已安装的
dsh**：

- `vendor/node/node.exe` —— Node ≥ 22 运行时（DSH 需要 Node 22+ 的
  `node:zlib` zstd 与 `node:module` type-stripping，Electron 内置 Node 20 不够）
- `node_modules/@deepseek-ai/dsh` 及依赖 —— 完整 host

`main.js` 会优先使用这两者，找不到时才回退到开发环境的系统 node / 临时目录。

## 开发运行

```bash
npm install      # 安装 electron + @deepseek-ai/dsh + electron-builder
npm start        # 开发模式启动桌面窗口
```

## 打包成 exe

> 构建前需准备内置 Node 运行时（`vendor/` 不入库，node.exe 约 88 MB）：
>
> ```powershell
> New-Item -ItemType Directory -Force vendor\node | Out-Null
> Copy-Item "C:\Program Files\nodejs\node.exe" vendor\node\node.exe
> ```
>
> 代码签名证书同理不入库：把 `cert/codesign.pfx` 放进 `cert/`，
> 并在 `package.json` 的 `signtoolOptions` 里配置密码与时间戳服务器。

```bash
npm run dist     # electron-builder 构建 Windows 安装器
```

产物在 `dist/`：

| 产物 | 说明 |
|---|---|
| `DeepSeek Harness Setup 0.1.0.exe` | NSIS 安装器（双击安装，自动创建桌面/开始菜单快捷方式） |
| `win-unpacked/DeepSeek Harness.exe` | 免安装版（整个 `win-unpacked` 目录即完整应用） |

> 打包用国内镜像加速 electron-builder 二进制：
> `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`

## 图标

DeepSeek 官方鲸鱼 logo（品牌蓝 `#4D6BFE`）由 `scripts/make-icon.mjs` 从
`build/icon-source.svg` 生成多尺寸 PNG 与 `build/icon.ico`：

```bash
npm run make-icon   # 重新生成图标
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 桌面 host 端口（默认 `3090`，避免与浏览器版 3080 冲突） |
| `DSH_BIN` | 显式指定 `@deepseek-ai/dsh/lib/bin.js` 的完整路径（覆盖自动探测） |
| `DSH_NODE` | 显式指定 node 可执行文件（覆盖内置 `vendor/node/node.exe`） |

## 未做（可继续）

代码签名、自动更新、系统托盘、开机自启、端口占用检测与提示。
