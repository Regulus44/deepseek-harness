'use strict';

// Electron desktop shell for DeepSeek Harness.
//
// What it does:
//   1. Locate the `dsh` CLI (lib/bin.js) and a Node >= 22 runtime.
//   2. Spawn `dsh web --host 127.0.0.1 --port <PORT>` as the backend host
//      (auto-avoiding occupied ports).
//   3. Show a splash window instantly, then swap to the real UI once the
//      host is serving.
//   4. Keep a single instance: a second launch focuses the existing window.
//   5. Closing the window hides it to the system tray (the host stays up,
//      so reopening is instant); "Exit" in the tray menu really quits.
//
// The backend (host) and the React frontend are untouched.
//
// NOTE on the Node runtime: DSH needs Node >= 22 (it imports node:zlib's
// createZstdDecompress and node:module's stripTypeScriptTypes). Electron 33
// embeds Node 20, which is too old, so the host must run under the bundled
// Node (vendor/node/node.exe) — never the Electron binary itself.

const {
  app,
  BrowserWindow,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.DSH_DESKTOP_PORT || 3090);
const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');

let PORT = DEFAULT_PORT;
let BASE_URL = `http://${HOST}:${PORT}`;
let hostProc = null;
let hostOutput = '';
let mainWindow = null;
let tray = null;
let isQuitting = false;

// Resolve the path of @deepseek-ai/dsh/lib/bin.js.
// Priority: DSH_BIN env > this project's node_modules > auto-detect the
// per-machine temp install dir (dsh-install-*) > give up with a clear error.
function findDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }

  const local = path.join(
    __dirname,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  if (fs.existsSync(local)) return local;

  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith('dsh-install-')) continue;
    const candidate = path.join(
      tmp,
      entry,
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js',
    );
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

// Pick a Node >= 22 to run the host. Priority:
// DSH_NODE (explicit) > bundled vendor/node/node.exe (packaged) >
// the node npm used to start us (dev) > `node` on PATH.
function resolveNode() {
  if (process.env.DSH_NODE) return process.env.DSH_NODE;
  const bundled = path.join(__dirname, 'vendor', 'node', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (process.env.npm_node_execpath) return process.env.npm_node_execpath;
  return 'node';
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, HOST);
  });
}

// Pick a free port for the host. An explicit DSH_DESKTOP_PORT disables
// avoidance; otherwise scan upward from the default.
async function pickPort() {
  if (process.env.DSH_DESKTOP_PORT) return DEFAULT_PORT;
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 100; p++) {
    if (!(await isPortInUse(p))) return p;
  }
  return DEFAULT_PORT;
}

function waitForHttp(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      // Fail fast with the host's own output when it died before serving.
      if (hostProc === null) {
        reject(
          new Error(
            `host process exited before becoming ready.\n\n${hostOutput.trim() || '(no output captured)'}`,
          ),
        );
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(
            new Error(
              `host did not become ready at ${url} within ${timeoutMs}ms.\n\n${hostOutput.trim() || '(no output captured)'}`,
            ),
          );
          return;
        }
        setTimeout(attempt, 250);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

function startHost() {
  const bin = findDshBin();
  if (!bin) {
    throw new Error(
      'Cannot locate @deepseek-ai/dsh/lib/bin.js. Set DSH_BIN to its full path.',
    );
  }

  const node = resolveNode();
  const args = [bin, 'web', '--host', HOST, '--port', String(PORT)];

  console.log(`[dsh-desktop] starting host: ${node} ${args.join(' ')}`);

  hostOutput = '';
  hostProc = spawn(node, args, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  // Relay host output to our console and keep it for failure diagnostics.
  hostProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    hostOutput += text;
    process.stdout.write(text);
  });
  hostProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    hostOutput += text;
    process.stderr.write(text);
  });

  hostProc.on('exit', (code, signal) => {
    if (hostProc === null) return; // already handled by stopHost
    hostProc = null;
    console.log(`[dsh-desktop] host exited code=${code} signal=${signal}`);
  });
  hostProc.on('error', (err) => {
    console.error('[dsh-desktop] failed to spawn host:', err);
  });
}

function stopHost() {
  if (!hostProc) return;
  const pid = hostProc.pid;
  hostProc = null;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(ICON_PATH);
    tray = new Tray(
      image.isEmpty() ? ICON_PATH : image.resize({ width: 16, height: 16 }),
    );
    tray.setToolTip('DeepSeek Harness');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 DeepSeek Harness', click: showMainWindow },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  } catch (err) {
    console.error('[dsh-desktop] failed to create tray:', err);
  }
}

// Splash shown while the host boots. The window opens instantly with this,
// then swaps to the real UI once the host is serving. Light theme to match
// the product's white UI.
const LOADING_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #ffffff; color: #5f6368;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    user-select: none;
  }
  .box { text-align: center; }
  .spinner {
    display: inline-block; width: 32px; height: 32px;
    border: 3px solid #e8eaed; border-top-color: #4D6BFE;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { margin-top: 18px; font-size: 13px; letter-spacing: 0.02em; }
</style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p>DeepSeek Harness 正在启动…</p>
  </div>
</body>
</html>`;

async function boot() {
  // Avoid occupied ports so a second dsh web process never collides.
  PORT = await pickPort();
  BASE_URL = `http://${HOST}:${PORT}`;
  if (PORT !== DEFAULT_PORT) {
    console.log(
      `[dsh-desktop] port ${DEFAULT_PORT} is in use, using ${PORT} instead`,
    );
  }

  // Open the window immediately with a splash, so the user gets instant
  // feedback; the host boots in the background and the real UI loads after.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: ICON_PATH,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Native right-click menu: edit controls for inputs, copy for selections.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: 'copy', label: '复制' });
    }
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it to the tray; only a real quit closes it.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`,
  );

  createTray();

  startHost();
  await waitForHttp(`${BASE_URL}/`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(`${BASE_URL}/`);
  }
}

// ── single-instance guard + lifecycle ────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is running: let it bring its window forward instead.
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  // Windows: pin the taskbar icon to our .ico with a stable app id.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.deepseek.dsh-desktop');
  }

  app.whenReady().then(boot).catch((err) => {
    console.error('[dsh-desktop] boot failed:', err);
    dialog.showErrorBox(
      'DeepSeek Harness failed to start',
      String((err && err.stack) || err),
    );
    isQuitting = true;
    app.exit(1);
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopHost();
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray: the window hides instead of closing.
  });

  app.on('activate', showMainWindow);
}
