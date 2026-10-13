// codex-panels 主进程运行时 v3:由 asar 内的 ext-loader.cjs 在 App 最早期加载。
// 职责:
//   1. 给所有窗口页面注册 page-preload.cjs(左侧栏按钮 + 编辑器桥)
//   2. 编辑器窗口:无边框自绘标题栏、窗口控制、返回 Codex
//   3. 项目联动:读 Codex 当前会话的工作目录(~/.codex/sessions 最新 Codex Desktop 会话)
//   4. VS Code Web 服务生命周期(--extensions-dir 挂载我们的聊天扩展)
//   5. 聊天后端:chat.cjs(app-server 客户端)+ HTTP/SSE 服务(127.0.0.1:8391,给 VS Code 扩展用)
'use strict';
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');

const HOME = process.env.CODEX_PANELS_HOME || path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'codex-panels');
const RUNTIME_DIR = __dirname;
const PRELOAD_PATH = path.join(RUNTIME_DIR, 'page-preload.cjs');
const EDITOR_PAGE = path.join(RUNTIME_DIR, 'editor', 'index.html');
const SETTINGS_PATH = path.join(HOME, 'settings.json');
const SERVER_ROOT = path.join(HOME, 'openvscode-server');
const EXTENSIONS_DIR = path.join(HOME, 'vscode-extensions');
const CODEX_HOME = path.join(process.env.USERPROFILE || app.getPath('home'), '.codex');
const EDITOR_PORT = Number(process.env.CODEX_PANELS_EDITOR_PORT || 8398);
const CHAT_HTTP_PORT = Number(process.env.CODEX_PANELS_CHAT_PORT || 8391);
const APP_DIR = path.join(HOME, 'app'); // Codex 副本(内置 codex.exe)

const log = (...args) => console.log('[codex-panels]', ...args);

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// 1. 注册页面 preload
// ---------------------------------------------------------------------------
log('主进程运行时已加载, HOME =', HOME, '| electron =', (process.versions && process.versions.electron) || '未知');

const registeredSessions = new WeakSet();
app.on('web-contents-created', (_event, contents) => {
  const type = typeof contents.getType === 'function' ? contents.getType() : 'unknown';
  if (type === 'webview' || type === 'service-worker') return;
  try {
    const session = contents.session;
    if (registeredSessions.has(session)) return;
    registeredSessions.add(session);
    if (typeof session.registerPreloadScript === 'function') {
      session.registerPreloadScript({ id: 'codex-panels-page', filePath: PRELOAD_PATH });
    } else if (typeof session.setPreloads === 'function') {
      const current = typeof session.getPreloads === 'function' ? session.getPreloads() : [];
      if (current.indexOf(PRELOAD_PATH) === -1) session.setPreloads([...current, PRELOAD_PATH]);
    }
  } catch (err) {
    log('preload 注册失败:', err.message);
  }
});

// ---------------------------------------------------------------------------
// 2. 项目联动:读 Codex 当前会话的工作目录
// ---------------------------------------------------------------------------
function currentCodexWorkspace() {
  try {
    const sessionsRoot = path.join(CODEX_HOME, 'sessions');
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            files.push({ full, mtime: fs.statSync(full).mtimeMs });
          } catch {}
        }
      }
    };
    walk(sessionsRoot, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    // 取最近的若干个,找 originator=Codex Desktop 的会话(排除我们自己 codex-panels 建的)
    for (const { full } of files.slice(0, 12)) {
      try {
        const firstLine = String(fs.readFileSync(full, 'utf8').split('\n')[0] || '');
        const meta = JSON.parse(firstLine);
        const payload = meta && meta.payload ? meta.payload : {};
        if (payload.originator === 'Codex Desktop' && payload.cwd) {
          if (fs.existsSync(payload.cwd)) return payload.cwd;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// 3. VS Code Web 服务生命周期
// ---------------------------------------------------------------------------
function findBundledServerCommand() {
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^(openvscode-server|code|codium)(\.cmd|\.bat|\.exe)?$/i.test(entry.name)) candidates.push(full);
    }
  };
  walk(SERVER_ROOT, 0);
  return candidates.find((c) => /openvscode-server|codium/i.test(c)) || candidates[0] || null;
}

function findSystemCodeCli() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('where code', { encoding: 'utf8', windowsHide: true });
    const lines = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((p) => /code\.cmd$/i.test(p)) || lines[0] || null;
  } catch {
    return null;
  }
}

function resolveServerCommand() {
  const settings = readSettings();
  const configured = settings.vscodeServer && settings.vscodeServer.command;
  if (configured) return { command: configured, viaCmd: /\.(cmd|bat)$/i.test(configured) };
  const bundled = findBundledServerCommand();
  if (bundled) return { command: bundled, viaCmd: /\.(cmd|bat)$/i.test(bundled) };
  const codeCli = findSystemCodeCli();
  if (codeCli) return { command: codeCli, viaCmd: /\.(cmd|bat)$/i.test(codeCli) };
  return null;
}

let serverProcess = null;
let serverStarting = null;

// 扩展源目录(HOME\vscode-extensions)同步到目标扩展目录,并注册进其 extensions.json 索引
// (原生 VS Code 与 serve-web 都以该索引为准,手动放文件夹不会被加载)
function deployExtensionTo(targetExtensionsDir) {
  try {
    fs.mkdirSync(targetExtensionsDir, { recursive: true });
    let entries = [];
    try {
      entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(EXTENSIONS_DIR, entry.name);
      const dst = path.join(targetExtensionsDir, entry.name);
      const srcPkg = fs.readFileSync(path.join(src, 'package.json'));
      let dstPkg = null;
      try {
        dstPkg = fs.readFileSync(path.join(dst, 'package.json'));
      } catch {}
      if (!dstPkg || Buffer.compare(Buffer.from(srcPkg), Buffer.from(dstPkg)) !== 0) {
        fs.rmSync(dst, { recursive: true, force: true });
        fs.cpSync(src, dst, { recursive: true });
        log('已部署 VS Code 扩展到', targetExtensionsDir, ':', entry.name);
      }
      // 注册索引
      try {
        const pkg = JSON.parse(srcPkg.toString('utf8'));
        const id = (pkg.publisher || 'codex-panels') + '.' + pkg.name;
        const version = pkg.version || '0.0.0';
        const indexPath = path.join(targetExtensionsDir, 'extensions.json');
        let list = [];
        try {
          list = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        } catch {}
        if (!Array.isArray(list)) list = [];
        const already = list.some((e) => e && e.identifier && e.identifier.id === id && e.version === version);
        if (!already) {
          const abs = path.join(targetExtensionsDir, entry.name);
          const forward = abs.replace(/\\/g, '/');
          const drive = forward.slice(0, 2);
          list.push({
            identifier: { id },
            version,
            // 原生 VS Code 反序列化 URI 需要完整字段(fsPath/external/_sep),精简形态会被静默丢弃
            location: {
              $mid: 1,
              fsPath: abs,
              _sep: 1,
              external: 'file:///' + encodeURIComponent(drive) + forward.slice(2),
              path: '/' + forward,
              scheme: 'file',
            },
            relativeLocation: entry.name,
            metadata: { installedTimestamp: Date.now(), source: 'gallery', targetPlatform: 'undefined', updated: false, private: false, isPreReleaseVersion: false, hasPreReleaseVersion: false },
          });
          fs.writeFileSync(indexPath, JSON.stringify(list));
          log('已在扩展索引注册:', id, version, '->', indexPath);
        }
      } catch (err) {
        log('扩展索引注册失败:', err.message);
      }
    }
  } catch (err) {
    log('扩展部署失败:', err.message);
  }
}

// 原生 VS Code 的用户扩展目录
const NATIVE_VSCODE_EXTENSIONS = path.join(process.env.USERPROFILE || app.getPath('home'), '.vscode', 'extensions');
const NATIVE_VSCODE_USER_SETTINGS = path.join(process.env.APPDATA || app.getPath('appData'), 'Code', 'User', 'settings.json');

// 原生 VS Code 首次打开新文件夹会进「受限模式」(workspace 扩展被禁用,我们的扩展不激活)。
// 关闭工作区信任(本机个人编辑器,打开的都是自己的项目,可接受;JSONC 注释场景下保守处理)。
function ensureNativeVscodeTrustOff() {
  try {
    let text = '';
    try {
      text = fs.readFileSync(NATIVE_VSCODE_USER_SETTINGS, 'utf8');
    } catch {}
    if (/workspace\.trust\.enabled/.test(text)) return;
    if (!text.trim()) {
      fs.mkdirSync(path.dirname(NATIVE_VSCODE_USER_SETTINGS), { recursive: true });
      fs.writeFileSync(NATIVE_VSCODE_USER_SETTINGS, JSON.stringify({ 'workspace.trust.enabled': false }, null, 4));
    } else {
      try {
        const settings = JSON.parse(text);
        settings['workspace.trust.enabled'] = false;
        fs.writeFileSync(NATIVE_VSCODE_USER_SETTINGS, JSON.stringify(settings, null, 4));
      } catch {
        // 含注释的 JSONC:整块追加一个键(够用且不会破坏原文)
        fs.writeFileSync(NATIVE_VSCODE_USER_SETTINGS, text.trimEnd().replace(/\}\s*$/, '') + '\n, "workspace.trust.enabled": false\n}\n');
      }
    }
    log('已关闭原生 VS Code 工作区信任(workspace.trust.enabled=false)');
  } catch (err) {
    log('写入 VS Code 设置失败:', err.message);
  }
}

async function ensureEditorServer() {
  if (await portOpen(EDITOR_PORT)) return true;
  if (serverStarting) return serverStarting;
  serverStarting = (async () => {
    const resolved = resolveServerCommand();
    if (!resolved) {
      return { error: '未找到可用的 VS Code 服务:请安装 VS Code,或将 openvscode-server 解压到 ' + SERVER_ROOT + ',或在 settings.json 配置 vscodeServer.command' };
    }
    const serverDataDir = path.join(HOME, 'vscode-server-data');
    deployExtensions(serverDataDir);
    const args = [
      'serve-web',
      '--host', '127.0.0.1',
      '--port', String(EDITOR_PORT),
      '--without-connection-token',
      '--server-data-dir', serverDataDir,
    ];
    const { spawn } = require('child_process');
    // 把 serve-web 的输出落到日志文件便于排查(扩展激活错误等)
    fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
    const out = fs.openSync(path.join(HOME, 'logs', 'serve-web.log'), 'a');
    serverProcess = resolved.viaCmd
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', resolved.command, ...args], { cwd: path.dirname(resolved.command), stdio: ['ignore', out, out], windowsHide: true })
      : spawn(resolved.command, args, { cwd: path.dirname(resolved.command), stdio: ['ignore', out, out], windowsHide: true });
    log('VS Code 服务已拉起:', resolved.command, 'port =', EDITOR_PORT);
    serverProcess.on('exit', (code) => log('VS Code 服务退出, code =', code));
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (await portOpen(EDITOR_PORT)) return true;
    }
    return { error: 'VS Code 服务启动超时(详见 ' + path.join(HOME, 'logs', 'serve-web.log') + ')' };
  })();
  try {
    return await serverStarting;
  } finally {
    serverStarting = null;
  }
}

// ---------------------------------------------------------------------------
// 4. 编辑器窗口(无边框,自绘标题栏)
// ---------------------------------------------------------------------------
let editorWindow = null;

async function chooseFolder() {
  const picked = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择要在编辑器中打开的项目文件夹' });
  return picked.canceled ? null : picked.filePaths[0];
}

function broadcastToEditor(eventName, payload) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send(eventName, payload);
  }
}

async function openEditorWindow(options) {
  try {
    let folder = null;
    if (options && options.chooseFolder) {
      // 强制重新选择
      folder = await chooseFolder();
      if (!folder) return { error: '未选择文件夹' };
    } else {
      // 优先取 Codex 当前项目;没有则回退上次文件夹;再没有则弹选择框
      folder = currentCodexWorkspace();
      if (!folder) folder = readSettings().editorFolder || null;
      if (!folder) {
        folder = await chooseFolder();
        if (!folder) return { error: '未选择文件夹' };
      }
    }
    if (folder) {
      const settings = readSettings();
      if (settings.editorFolder !== folder) {
        settings.editorFolder = folder;
        writeSettings(settings);
      }
    }

    if (chatApi) chatApi.setWorkspace(folder);

    // 优先:原生 VS Code(启动快、原生窗口自带控制按钮、零注入)
    // settings.vscodeServer 显式配置时才走 serve-web 窗口回退
    if (!readSettings().vscodeServer) {
      deployExtensionTo(NATIVE_VSCODE_EXTENSIONS);
      ensureNativeVscodeTrustOff();
      const codeCli = findSystemCodeCli();
      if (codeCli) {
        const { spawn } = require('child_process');
        const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', codeCli, folder], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log('已用原生 VS Code 打开项目:', folder);
        return { ok: true, folder, mode: 'native-vscode' };
      }
    }

    // 回退:serve-web 窗口(直接加载 VS Code Web,不经宿主页/iframe)
    const serverUp = await ensureEditorServer();
    if (serverUp !== true) return serverUp;
    if (chatApi) chatApi.setWorkspace(folder);

    // 直接加载 VS Code Web(不经宿主页/iframe,避免 iframe 下的存储限制)
    const editorUrl = 'http://127.0.0.1:' + EDITOR_PORT + '/?folder=' + encodeURIComponent(folder);
    if (!editorWindow || editorWindow.isDestroyed()) {
      editorWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        // 原生标题栏:系统自带的 最小化/最大化/关闭,不与 VS Code 原生界面冲突
        backgroundColor: '#1b1b1f',
        title: 'codex-panels · 编辑器',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      editorWindow.on('closed', () => {
        editorWindow = null;
      });
      await editorWindow.loadURL(editorUrl);
    } else if (editorWindow.webContents.getURL() !== editorUrl) {
      // 工作区变了:直接切换 URL(VS Code 状态在 server 端,刷新代价可接受)
      await editorWindow.loadURL(editorUrl);
      editorWindow.focus();
    } else {
      editorWindow.focus();
    }
    return { ok: true, folder };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

ipcMain.handle('codex-panels:open-editor', (_event, options) => openEditorWindow(options || {}));
ipcMain.handle('codex-panels:editor-state', () => {
  const settings = readSettings();
  return { folder: settings.editorFolder || '', port: EDITOR_PORT, chatPort: CHAT_HTTP_PORT };
});

// 无边框窗口的标题栏控制
ipcMain.handle('codex-panels:win:control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return false;
  try {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    return true;
  } catch {
    return false;
  }
});

// 返回 Codex:聚焦主 App 窗口(除编辑器窗口外的第一个可见窗口)
ipcMain.handle('codex-panels:focus-codex', () => {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win !== editorWindow && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return true;
      }
    }
  } catch {}
  return false;
});

// ---------------------------------------------------------------------------
// 5. 聊天后端:app-server 客户端 + HTTP/SSE 服务(给 VS Code 扩展用)
// ---------------------------------------------------------------------------
let chatApi = null;
let workspaceRoot = '';
try {
  const chatModule = path.join(RUNTIME_DIR, 'chat.cjs');
  if (fs.existsSync(chatModule)) {
    chatApi = require(chatModule)({ HOME, APP_DIR, log, broadcast: broadcastToEditor });
  } else {
    log('chat.cjs 不存在,AI 对话不可用');
  }
} catch (err) {
  log('chat 模块加载失败:', err);
}

function startChatHttpServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!chatApi) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat 后端不可用' }));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/workspace-root')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (payload.root) workspaceRoot = payload.root;
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/workspace-root')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ root: workspaceRoot }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/projects')) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, '.codex-global-state.json'), 'utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            projects: Object.values(d['local-projects'] || {}).map((p) => ({
              id: p.id,
              name: p.name,
              rootPaths: p.rootPaths || [],
            })),
            assignments: d['thread-project-assignments'] || {},
          })
        );
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ projects: [], assignments: {} }));
      }
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/threads')) {
      chatApi
        .listThreads(25)
        .then((threads) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ threads }));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/models')) {
      chatApi
        .listModels()
        .then((models) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ models }));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/chat')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {}
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
        write({ type: 'status', text: 'connected' });
        const result = await chatApi.startTurn(String(payload.message || ''), {
          model: payload.model || undefined,
          effort: payload.effort || undefined,
          cwd: payload.cwd || undefined,
          threadId: payload.threadId || undefined,
          onEvent: (ev) => {
            try {
              write(ev);
            } catch {}
          },
        });
        if (result && result.error) write({ type: 'error', text: result.error });
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.on('error', (err) => log('聊天 HTTP 服务错误:', err.message));
  server.listen(CHAT_HTTP_PORT, '127.0.0.1', () => log('聊天 HTTP 后端已就绪: http://127.0.0.1:' + CHAT_HTTP_PORT));
}
if (chatApi) startChatHttpServer();

// ---------------------------------------------------------------------------
// 6. 新会话互相通知:监视 ~/.codex/sessions(新 rollout 文件即新会话)
//    → App 主窗口弹 toast(page-preload 渲染,点击跳转该会话)
//    → VS Code 端的 codex-panels 扩展轮询 /threads 自行发现并弹通知
// ---------------------------------------------------------------------------
const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const knownThreadIds = new Set();
(function initKnownThreads() {
  try {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else {
          const m = entry.name.match(/-([0-9a-f-]{36})\.jsonl$/);
          if (m) knownThreadIds.add(m[1]);
        }
      }
    };
    walk(SESSIONS_ROOT);
    log('会话监视就绪,已知会话', knownThreadIds.size, '个');
  } catch {}
})();

function notifyNewThread(info) {
  // Codex 桌面端自己建的会话无需通知本 App(用户就在这个窗口里操作);
  // VS Code 侧的发现由扩展轮询负责(它只通知 Codex Desktop 来源)
  if ((info.originator || '') === 'Codex Desktop') return;
  log('新会话通知:', info.id, info.originator || '?');
  injectedThreadIds.add(info.id);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('codex-panels:new-thread', info);
  }
}

// 归档同步:已注入的线程从活跃列表消失(被归档/删除)→ 通知页面撤下注入行
const injectedThreadIds = new Set();
setInterval(async () => {
  try {
    if (!chatApi || injectedThreadIds.size === 0) return;
    const threads = await chatApi.listThreads(30);
    const active = new Set((threads || []).map((t) => t.id));
    for (const id of [...injectedThreadIds]) {
      if (!active.has(id)) {
        injectedThreadIds.delete(id);
        log('线程已归档/删除,撤下注入行:', id);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('codex-panels:thread-archived', { id });
        }
      }
    }
  } catch {}
}, 3000);

// preload 侧补查会话名(会话刚创建时 thread/list 还没索引出 name)
ipcMain.handle('codex-panels:lookup-thread-name', async (_event, threadId) => {
  try {
    if (!chatApi) return '';
    const threads = await chatApi.listThreads(30);
    const hit = (threads || []).find((t) => t.id === threadId);
    return (hit && hit.name) || '';
  } catch {
    return '';
  }
});

// 读全局共享对象(项目归属等在 .codex-global-state.json 顶层键;UI 原子在 electron-persisted-atom-state)
ipcMain.handle('codex-panels:read-global-atom', (_event, key) => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, '.codex-global-state.json'), 'utf8'));
    if (key in d) return d[key];
    return (d['electron-persisted-atom-state'] || {})[key] ?? null;
  } catch {
    return null;
  }
});

// 按根目录匹配 Codex 项目(大小写不敏感;项目在文件顶层 local-projects)
function matchProjectByRoot(cwd) {
  if (!cwd) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, '.codex-global-state.json'), 'utf8'));
    const projects = d['local-projects'] || {};
    const norm = (p) => String(p).replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '');
    const target = norm(cwd);
    for (const project of Object.values(projects)) {
      const roots = project.rootPaths || project.roots || [];
      if (roots.some((r) => norm(r) === target)) return project.id;
    }
  } catch {}
  return null;
}

// 把归属请求发到 App 主窗口(preload 走原生 shared-object-set 写入)
function sendAssignProject(threadId, projectId) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('codex-panels:assign-project', { threadId, projectId });
  }
}

// 对账:把外部线程(cwd 匹配项目但没分配)补上归属——启动时跑一次,之后周期跑,
// 抵御官方扩展的 app-server 与我们之间的共享状态写入竞争(数据始终收敛到正确)。
async function reconcileAssignments() {
  try {
    if (!chatApi) return;
    const threads = await chatApi.listThreads(30);
    const d = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, '.codex-global-state.json'), 'utf8'));
    const assigned = d['thread-project-assignments'] || {};
    let fixed = 0;
    for (const t of threads || []) {
      if (t.originator === 'Codex Desktop') continue; // App 自建的自己管
      if (assigned[t.id]) continue;
      const projectId = matchProjectByRoot(t.cwd);
      if (projectId) {
        sendAssignProject(t.id, projectId);
        fixed += 1;
      }
    }
    if (fixed) log('对账补归:', fixed, '个线程');
  } catch {}
}

setTimeout(reconcileAssignments, 15000);
setInterval(reconcileAssignments, 45000);

let newThreadDebounce = null;
try {
  fs.watch(SESSIONS_ROOT, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const base = path.basename(String(filename).replace(/\\/g, '/'));
    const m = base.match(/-([0-9a-f-]{36})\.jsonl$/);
    if (!m || knownThreadIds.has(m[1])) return;
    // 文件刚创建还在写入,稍等后读 session_meta
    const id = m[1];
    clearTimeout(newThreadDebounce);
    newThreadDebounce = setTimeout(async () => {
      try {
        const first = String(fs.readFileSync(path.join(SESSIONS_ROOT, String(filename)), 'utf8').split('\n')[0] || '');
        const payload = (JSON.parse(first) || {}).payload || {};
        knownThreadIds.add(id);
        const info = {
          id: payload.id || payload.session_id || id,
          originator: payload.originator || '',
          project: (payload.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '',
          name: '',
        };
        // 立即:注入侧栏 + 项目归属(不等标题,标题由 preload 侧异步补查)
        notifyNewThread(info);
        const projectId = matchProjectByRoot(payload.cwd || '');
        if (projectId) {
          sendAssignProject(info.id, projectId);
          log('项目归属:', info.id, '→', projectId);
        }
        // 异步:补标题(成功则立即重发一次带名字的通知,preload 会更新注入条目标题)
        if (chatApi) {
          chatApi
            .listThreads(30)
            .then((threads) => {
              const hit = (threads || []).find((t) => t.id === info.id);
              if (hit && hit.name) {
                info.name = hit.name;
                notifyNewThread(info);
              }
            })
            .catch(() => {});
        }
      } catch (err) {
        log('新会话解析失败:', err.message);
      }
    }, 400);
  });
} catch (err) {
  log('会话目录监视失败:', err.message);
}

// App 内 toast 点击 → 通过深链接打开指定会话(OS 协议 → 单实例转交回本应用)
ipcMain.handle('codex-panels:open-thread', (_event, threadId) => {
  try {
    const { spawn } = require('child_process');
    spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', 'codex://threads/' + threadId], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
});

app.on('before-quit', () => {
  try {
    if (serverProcess) serverProcess.kill();
  } catch {}
});
