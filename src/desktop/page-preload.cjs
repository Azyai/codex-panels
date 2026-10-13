// codex-panels 页面注入 v3:
//   主窗口:左侧栏「编辑器」「终端」按钮(终端支持真正的开/关切换)
//   编辑器窗口:标题栏桥(窗口控制、返回 Codex、文件夹切换)
// 由主进程运行时通过 session.registerPreloadScript 注册,运行在 isolated world;
// 所有 DOM 操作直接建元素(不插内联样式/内联脚本,避开页面 CSP)。
'use strict';
const { ipcRenderer, contextBridge } = require('electron');

const log = (...args) => console.log('[codex-panels:preload]', ...args);

// DOM 是跨 world 共享的,留个标记方便从页面/CDP 验证 preload 是否运行
try {
  if (document.documentElement) document.documentElement.setAttribute('data-codex-panels', 'preload-loaded');
} catch {}

// ---------------------------------------------------------------------------
// 图标(与官方 rail 图标同规格:20x20 viewBox、currentColor 描边)
// ---------------------------------------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent.appendChild(node);
  return node;
}

function makeIcon(draw) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('data-no-autosize', 'true');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  draw(svg);
  return svg;
}

const terminalIcon = () =>
  makeIcon((svg) => {
    el('rect', { x: '2', y: '3.5', width: '16', height: '13', rx: '2.5', stroke: 'currentColor', 'stroke-width': '1.5' }, svg);
    el('path', { d: 'M5.5 8.2 8 10.7 5.5 13.2', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    el('path', { d: 'M10.8 13.2h4', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }, svg);
  });

const editorIcon = () =>
  makeIcon((svg) => {
    el('path', { d: 'M7 4.5 3 10l4 5.5', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    el('path', { d: 'M13 4.5 17 10l-4 5.5', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  });

// ---------------------------------------------------------------------------
// 主窗口:左侧栏按钮
// ---------------------------------------------------------------------------
const RAIL_NAV = 'nav[class*="sidebar-rail"]';
const NAV_LIST = '[class*="group/nav-list"]';

const railButtons = { terminal: null, editor: null };
let mounted = false;

function terminalPanelVisible() {
  const node = document.querySelector('.terminal.xterm, .xterm');
  return Boolean(node && node.offsetWidth > 0 && node.offsetHeight > 0);
}

function findPanelCloseButton() {
  // 官方面板以“标签页”形态出现,关闭按钮 aria-label 形如「关闭 mamba-cn 标签页」
  return [...document.querySelectorAll('button')].find((b) => /^关闭.+标签页/.test(b.getAttribute('aria-label') || ''));
}

function syncTerminalButtonState() {
  const btn = railButtons.terminal;
  if (!btn || !btn.isConnected) return;
  if (terminalPanelVisible()) btn.setAttribute('data-selected', '');
  else btn.removeAttribute('data-selected');
}

// 官方「视图」菜单点终端后,主进程发 {type:'toggle-terminal'},preload 转发成页面消息
// —— 实测该消息只会“打开”;关闭要点面板自己的「关闭××标签页」按钮。
function toggleTerminal() {
  if (terminalPanelVisible()) {
    const close = findPanelCloseButton();
    if (close) close.click();
    else window.dispatchEvent(new MessageEvent('message', { data: { type: 'toggle-terminal' } }));
  } else {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'toggle-terminal' } }));
  }
  setTimeout(syncTerminalButtonState, 400);
  setTimeout(syncTerminalButtonState, 1200);
}

async function openEditorWindow(event) {
  // Shift/Alt+点击 = 强制重新选择文件夹
  const chooseFolder = Boolean(event && (event.shiftKey || event.altKey));
  try {
    const result = await ipcRenderer.invoke('codex-panels:open-editor', { chooseFolder });
    if (result && result.error) log('打开编辑器失败:', result.error);
  } catch (err) {
    log('open-editor IPC 异常:', err);
  }
}

// 克隆官方 rail 项保证观感一致;onclick 用属性赋值(天然幂等,重复绑定不会叠加)
function buildRailItem({ icon, label, onClick }) {
  const nav = document.querySelector(RAIL_NAV);
  const list = nav && nav.querySelector(NAV_LIST);
  if (!list) return null;
  const templateButton = list.querySelector('button');
  if (!templateButton) return null;
  const wrap = templateButton.parentElement && templateButton.parentElement !== list ? templateButton.parentElement : null;
  const item = (wrap || templateButton).cloneNode(true);
  const button = item.querySelector('button') || item;
  ['data-sidebar-destination', 'data-slate-sidebar-peek-area', 'aria-current', 'data-selected', 'data-state', 'aria-expanded'].forEach((attr) => button.removeAttribute(attr));
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.setAttribute('data-codex-panels-item', label);
  const oldSvg = button.querySelector('svg');
  if (oldSvg) oldSvg.replaceWith(icon());
  else button.appendChild(icon());
  button.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick(ev);
  };
  return item;
}

function mountRailButtons() {
  const nav = document.querySelector(RAIL_NAV);
  const list = nav && nav.querySelector(NAV_LIST);
  if (!list || !list.querySelector('button')) return false;

  // 幂等:先清掉可能存在的旧注入项(React 重渲染/重挂载场景)
  [...list.querySelectorAll('[data-codex-panels-item]')].forEach((node) => node.remove());

  const terminalItem = buildRailItem({ icon: terminalIcon, label: '终端', onClick: toggleTerminal });
  const editorItem = buildRailItem({ icon: editorIcon, label: '打开编辑器', onClick: openEditorWindow });
  if (!terminalItem || !editorItem) return false;

  // 编辑器按钮在终端按钮左侧
  list.appendChild(editorItem);
  list.appendChild(terminalItem);
  railButtons.editor = editorItem.querySelector('button') || editorItem;
  railButtons.terminal = terminalItem.querySelector('button') || terminalItem;
  mounted = true;
  log('左侧栏按钮已挂载:编辑器 / 终端');
  return true;
}

function ensureMounted() {
  if (mounted && railButtons.terminal && !railButtons.terminal.isConnected) mounted = false;
  if (!mounted) mountRailButtons();
  if (mounted) {
    // 节点可能被 React 换新而引用未更新:每次顺手按 aria-label 重取并重绑
    const nav = document.querySelector(RAIL_NAV);
    const btns = nav ? [...nav.querySelectorAll('button')] : [];
    const terminal = btns.find((b) => b.getAttribute('aria-label') === '终端' && b.hasAttribute('data-codex-panels-item'));
    const editor = btns.find((b) => b.getAttribute('aria-label') === '打开编辑器' && b.hasAttribute('data-codex-panels-item'));
    if (terminal) {
      railButtons.terminal = terminal;
      terminal.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleTerminal(); };
    }
    if (editor) {
      railButtons.editor = editor;
      editor.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); openEditorWindow(ev); };
    }
    syncTerminalButtonState();
  }
}

// 观察 document 而不是 documentElement:preload 执行时 documentElement 可能还没建出来
const observer = new MutationObserver(ensureMounted);
observer.observe(document, { childList: true, subtree: true });
// 心跳兜底:上下文存活期间持续校验(幂等、开销极小)
setInterval(ensureMounted, 2500);

// ---------------------------------------------------------------------------
// 新会话注入(主进程监视 ~/.codex/sessions 发现新会话时推送):
// 克隆官方会话行(带「归档聊天」按钮的行才是真会话行)插入列表最上,
// 点击经深链接原生打开;官方列表原生包含后自动撤下。
// ---------------------------------------------------------------------------
const injectedThreads = new Map();

function sidebarRows() {
  return [...document.querySelectorAll('div[class*="cursor-interaction"]')].filter((n) =>
    n.querySelector('button[aria-label*="归档"], [title*="归档"]')
  );
}

function rowTitleElement(row) {
  const leaves = [...row.querySelectorAll('span, div, p')].filter(
    (n) => n.children.length === 0 && (n.textContent || '').trim().length > 0
  );
  leaves.sort((a, b) => (b.textContent || '').trim().length - (a.textContent || '').trim().length);
  return leaves[0] || null;
}

function ensureInjected(info) {
  const rows = sidebarRows();
  const official = rows.filter((n) => !n.hasAttribute('data-codex-panels-injected'));
  const title = (info.name || info.project || '新会话').slice(0, 40);
  if (official.some((n) => (n.textContent || '').trim().includes(title))) {
    const mine = document.querySelector('[data-codex-panels-injected="' + info.id + '"]');
    if (mine) mine.remove();
    return;
  }
  const existing = document.querySelector('[data-codex-panels-injected="' + info.id + '"]');
  if (existing) {
    if (info.name) {
      const titleEl = rowTitleElement(existing);
      if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
    }
    return;
  }
  const template = official[0];
  if (!template) return;
  const row = template.cloneNode(true);
  row.setAttribute('data-codex-panels-injected', info.id);
  row.setAttribute('title', title);
  row.querySelectorAll('[class*="opacity-0"]').forEach((n) => n.remove());
  const titleEl = rowTitleElement(row);
  if (titleEl) titleEl.textContent = title;
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ipcRenderer.invoke('codex-panels:open-thread', info.id);
  });
  template.parentElement.insertBefore(row, template);
}

// 归档/删除同步:主进程检测到注入线程已归档 → 撤下注入行
ipcRenderer.on('codex-panels:thread-archived', (_event, { id }) => {
  try {
    injectedThreads.delete(id);
    const mine = document.querySelector('[data-codex-panels-injected="' + id + '"]');
    if (mine) mine.remove();
  } catch {}
});

ipcRenderer.on('codex-panels:new-thread', (_event, info) => {
  try {
    injectedThreads.set(info.id, info);
    ensureInjected(info);
    if (!info.name) {
      const tryCount = { n: 0 };
      const timer = setInterval(async () => {
        tryCount.n += 1;
        try {
          const name = await ipcRenderer.invoke('codex-panels:lookup-thread-name', info.id);
          if (name) {
            info.name = name;
            ensureInjected(info);
            clearInterval(timer);
          }
        } catch {}
        if (tryCount.n >= 6) clearInterval(timer);
      }, 2000);
    }
    if (!window.__codexPanelsSidebarObserver) {
      let lastRun = 0;
      window.__codexPanelsSidebarObserver = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastRun < 300) return;
        lastRun = now;
        for (const item of injectedThreads.values()) {
          try {
            ensureInjected(item);
          } catch {}
        }
      });
      window.__codexPanelsSidebarObserver.observe(document, { childList: true, subtree: true });
    }
  } catch (err) {
    log('新会话注入失败:', err);
  }
});

// ---------------------------------------------------------------------------
// 项目自动归属(主进程按 cwd 匹配到项目后通知):
// 走 App 自己的原生通道 shared-object-set(codex_desktop:message-from-view),
// 与用户在界面里「移动到项目」走的是同一条写入链路。
// ---------------------------------------------------------------------------
ipcRenderer.on('codex-panels:assign-project', async (_event, { threadId, projectId }) => {
  try {
    // 取当前归属表:先经订阅推送拿实时值,失败再从主进程读文件兜底
    let value = await new Promise((resolve) => {
      const handler = (_ev, msg) => {
        if (msg && msg.type === 'shared-object-updated' && msg.key === 'thread-project-assignments') {
          ipcRenderer.removeListener('codex_desktop:message-for-view', handler);
          clearTimeout(timer);
          resolve(msg.value);
        }
      };
      const timer = setTimeout(() => {
        ipcRenderer.removeListener('codex_desktop:message-for-view', handler);
        resolve(null);
      }, 2500);
      ipcRenderer.on('codex_desktop:message-for-view', handler);
      ipcRenderer.invoke('codex_desktop:message-from-view', { type: 'shared-object-subscribe', key: 'thread-project-assignments' });
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      value = await ipcRenderer.invoke('codex-panels:read-global-atom', 'thread-project-assignments');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
    if (value[threadId]) return; // 已有归属
    value[threadId] = { projectKind: 'local', projectId };
    await ipcRenderer.invoke('codex_desktop:message-from-view', {
      type: 'shared-object-set',
      key: 'thread-project-assignments',
      value,
    });
    log('已原生写入项目归属:', threadId, '→', projectId);
  } catch (err) {
    log('项目归属写入失败:', err);
  }
});


// ---------------------------------------------------------------------------
// 编辑器窗口:VS Code Web 页面(由主进程直接 loadURL 本地 serve-web)
// 窗口为原生标题栏(系统 ─ ▢ ✕),无需注入;
// 唯一注入:「返回 Codex」按钮放在侧边栏标题行(.sidebar .composite.title)的最左边
// ---------------------------------------------------------------------------
function setupVscodeUi() {
  const ipcInvoke = (channel, arg) => {
    try {
      ipcRenderer.invoke(channel, arg);
    } catch (err) {
      log('IPC 调用失败:', channel, err);
    }
  };

  function injectSidebarBackButton() {
    const header = document.querySelector('.sidebar .composite.title');
    if (!header) return false;
    if (header.querySelector('.codex-panels-back')) return true;

    if (!document.getElementById('codex-panels-back-style')) {
      const style = document.createElement('style');
      style.id = 'codex-panels-back-style';
      style.textContent = [
        '.codex-panels-back { display: flex; align-items: center; padding: 0 6px 0 10px; height: 100%; cursor: pointer; color: var(--vscode-foreground, #cccccc); }',
        '.codex-panels-back:hover { background: var(--vscode-toolbar-hoverBackground, #2a2a31); }',
        '.codex-panels-back .codicon { font-size: 16px; }',
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
    }

    const btn = document.createElement('div');
    btn.className = 'codex-panels-back';
    btn.title = '返回 Codex';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', '返回 Codex');
    const icon = document.createElement('span');
    icon.className = 'codicon codicon-home';
    btn.appendChild(icon);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ipcInvoke('codex-panels:focus-codex');
    });
    header.insertBefore(btn, header.firstChild);
    return true;
  }

  const observer = new MutationObserver(() => injectSidebarBackButton());
  observer.observe(document, { childList: true, subtree: true });
  const retry = setInterval(() => {
    if (injectSidebarBackButton()) clearInterval(retry);
  }, 1500);
  setTimeout(() => clearInterval(retry), 180000);
}

if (typeof location !== 'undefined' && location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.search.indexOf('folder=') !== -1) {
  try {
    setupVscodeUi();
  } catch (err) {
    log('VS Code 界面注入失败:', err);
  }
}

// 旧宿主页(file://)桥,保留兼容
if (typeof location !== 'undefined' && location.protocol === 'file:' && location.pathname.indexOf('codex-panels') !== -1) {
  try {
    contextBridge.exposeInMainWorld('codexPanels', {
      getState: () => ipcRenderer.invoke('codex-panels:editor-state'),
      chatSend: (text) => ipcRenderer.invoke('codex-panels:chat:send', text),
      onChatEvent: (callback) => {
        ipcRenderer.on('codex-panels:chat:event', (_event, payload) => callback(payload));
        return () => ipcRenderer.removeAllListeners('codex-panels:chat:event');
      },
      winControl: (action) => ipcRenderer.invoke('codex-panels:win:control', action),
      focusCodex: () => ipcRenderer.invoke('codex-panels:focus-codex'),
      onFolderChanged: (callback) => {
        ipcRenderer.on('codex-panels:folder-changed', (_event, folder) => callback(folder));
      },
    });
  } catch (err) {
    log('编辑器桥暴露失败:', err);
  }
}
