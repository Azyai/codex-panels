// codex-panels Codex Chat —— VS Code 内置 Chat 面板的聊天参与者。
// 通过 codex-panels 主进程的 HTTP 后端(127.0.0.1:8391)转发到 Codex app-server,
// 模型/登录态/工作区上下文全部复用 Codex 本体。
'use strict';
const vscode = require('vscode');

const BACKEND = 'http://127.0.0.1:' + (process.env.CODEX_PANELS_CHAT_PORT || '8391');
const MODEL_STATE_KEY = 'codex-panels.model';
const EFFORT_STATE_KEY = 'codex-panels.effort';
const THREAD_STATE_KEY = 'codex-panels.threadId';

async function fetchThreads() {
  try {
    const res = await fetch(BACKEND + '/threads', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.threads) || [];
  } catch {
    return null;
  }
}

// 选择一个 ~/.codex 里的已有会话(Codex 桌面端的对话可在 VS Code 里接续);
// 每项右侧按钮可在 Codex 桌面端直接打开该会话(深链接经单实例转交到正在运行的 Codex)。
async function pickThread(context) {
  const threads = await fetchThreads();
  if (!threads || !threads.length) {
    vscode.window.showWarningMessage('Codex:后端不可用或没有会话(请确认 codex-panels 扩展版 Codex 正在运行)');
    return;
  }
  const fmtTime = (ts) => {
    const d = new Date(ts * 1000);
    const now = Date.now() / 1000;
    const diffH = (now - ts) / 3600;
    if (diffH < 1) return Math.max(1, Math.round(diffH * 60)) + ' 分钟前';
    if (diffH < 24) return Math.round(diffH) + ' 小时前';
    return d.toLocaleDateString();
  };
  const items = threads.map((t) => ({
    label: (t.name || '(无标题)').slice(0, 60),
    description: t.model || '',
    detail: fmtTime(t.updatedAt) + (t.cwd ? ' · ' + t.cwd : '') + (t.originator ? ' · 来源:' + t.originator : ''),
    id: t.id,
    buttons: [{ iconPath: new vscode.ThemeIcon('link-external'), tooltip: '在 Codex 中打开此会话' }],
  }));
  const quickPick = vscode.window.createQuickPick();
  quickPick.items = items;
  quickPick.placeholder = '选择要继续的 Codex 会话(之后的 @codex 对话都接续到它;右侧按钮=在 Codex 里打开)';
  quickPick.onDidTriggerItemButton(async (event) => {
    const url = 'codex://threads/' + event.item.id;
    quickPick.hide();
    const ok = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!ok) vscode.window.showWarningMessage('无法打开 Codex 深链接:' + url);
  });
  quickPick.onDidAccept(async () => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked) {
      await context.workspaceState.update(THREAD_STATE_KEY, picked.id);
      await context.globalState.update(THREAD_STATE_KEY, picked.id);
      vscode.window.showInformationMessage('已接续会话:「' + picked.label + '」。之后 @codex 的对话都会发到这个会话;新开用命令「Codex: 新建会话」。');
    }
  });
  quickPick.show();
}

async function fetchModels() {
  try {
    const res = await fetch(BACKEND + '/models', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.models) || [];
  } catch {
    return null;
  }
}

function currentModel(context) {
  return context.workspaceState.get(MODEL_STATE_KEY) || '';
}

function updateStatusBar() {
  if (statusBar) {
    statusBar.text = '$(rocket) Codex: ' + (currentModelId || '默认') + (currentEffortId ? ' · ' + currentEffortId : '');
  }
}

async function pickModel(context) {
  const models = await fetchModels();
  if (!models || !models.length) {
    vscode.window.showWarningMessage('Codex:后端不可用或未返回模型(请确认 codex-panels 扩展版 Codex 正在运行)');
    return;
  }
  const current = currentModel(context);
  const items = models.map((m) => ({
    label: m.label || m.id,
    description: m.id,
    detail: m.description || '',
    picked: m.id === current,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: current ? '选择 Codex 模型(当前:' + current + ')' : '选择 Codex 模型',
  });
  if (picked) {
    await context.workspaceState.update(MODEL_STATE_KEY, picked.description);
    currentModelId = picked.description;
    updateStatusBar();
  }
}

// SSE → ChatResponseStream;行缓冲 + 代码块整块输出,避免 markdown 被拆坏
async function streamSSE(body, stream) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let textBuffer = '';
  let inFence = false;
  let sawDelta = false;

  const emit = (text) => {
    if (text) {
      try {
        stream.markdown(text);
      } catch {}
    }
  };
  const feedLine = (line) => {
    textBuffer += line;
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      emit(textBuffer);
      textBuffer = '';
    }
  };
  const feedText = (text) => {
    textBuffer += text;
    let index;
    while ((index = textBuffer.indexOf('\n')) !== -1) {
      const line = textBuffer.slice(0, index + 1);
      textBuffer = textBuffer.slice(index + 1);
      feedLine(line);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = sseBuffer.indexOf('\n\n')) !== -1) {
      const chunk = sseBuffer.slice(0, sep);
      sseBuffer = sseBuffer.slice(sep + 2);
      for (const rawLine of chunk.split('\n')) {
        if (!rawLine.startsWith('data:')) continue;
        let ev;
        try {
          ev = JSON.parse(rawLine.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === 'delta' && ev.text) {
          sawDelta = true;
          feedText(ev.text);
        } else if (ev.type === 'message' && ev.text) {
          if (!sawDelta) feedText(ev.text + '\n'); // 没有 delta 时才用完整消息
        } else if (ev.type === 'command' && ev.text) {
          feedText('\n```bash\n$ ' + ev.text + '\n```\n');
        } else if (ev.type === 'error' && ev.text) {
          feedText('\n> ⚠ ' + ev.text + '\n');
        }
      }
    }
  }
  feedText('\n');
}

// 思考强度选择:跟随当前模型的 supportedReasoningEfforts(与 Codex 桌面端同源,含全部档位)
async function pickEffort(context) {
  const models = await fetchModels();
  if (!models || !models.length) {
    vscode.window.showWarningMessage('Codex:后端不可用(请确认 codex-panels 扩展版 Codex 正在运行)');
    return;
  }
  const targetModelId = currentModel(context) || (models.find((m) => m.isDefault) || {}).id || '';
  const model = models.find((m) => m.id === targetModelId) || models.find((m) => m.isDefault) || models[0];
  const efforts = (model && model.efforts) || [];
  if (!efforts.length) {
    vscode.window.showWarningMessage('Codex:当前模型(' + (model && model.id) + ')没有可用的思考强度档位');
    return;
  }
  const currentEffort = context.workspaceState.get(EFFORT_STATE_KEY) || '';
  const items = efforts.map((e) => ({
    label: String(e.id),
    description: e.description || '',
    picked: e.id === (currentEffort || model.defaultEffort),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择思考强度(' + (model.label || model.id) + ',默认:' + (model.defaultEffort || '未指定') + ')',
  });
  if (picked) {
    currentEffortId = picked.label;
    await context.workspaceState.update(EFFORT_STATE_KEY, picked.label);
    updateStatusBar();
    vscode.window.showInformationMessage('思考强度已设为:' + picked.label + (picked.description ? '(' + picked.description + ')' : ''));
  }
}
let statusBar = null;
let currentModelId = '';
let currentEffortId = '';

// 返回 Codex 主窗口:激活 ChatGPT(Codex)进程的主窗口。
// 仅桌面扩展宿主可用 child_process;web 宿主(serve-web 回退模式)会走 catch 提示。
function focusCodexApp() {
  try {
    const { exec } = require('child_process');
    const script =
      "$p=Get-Process ChatGPT -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowTitle}|Select-Object -First 1;if($p){[void](New-Object -ComObject WScript.Shell).AppActivate($p.Id)}";
    exec('powershell -NoProfile -Command ' + JSON.stringify(script), { windowsHide: true }, () => {});
  } catch (err) {
    vscode.window.showWarningMessage('当前环境无法切换到 Codex 窗口:' + String((err && err.message) || err));
  }
}

// 轮询 ~/.codex 同池的会话:驱动实时树视图。
// 官方扩展的会话列表刷新已由 webview 原生轮询补丁承担(patch-webview-poll.py),
// 本扩展不再需要任何重启/刷新动作。
let threadPollTimer = null;
function startThreadPolling(context, hooks) {
  const seen = new Set();
  let initialized = false;
  threadPollTimer = setInterval(async () => {
    const threads = await fetchThreads();
    if (!threads) return;
    if (hooks && hooks.refreshTree) hooks.refreshTree(threads);
    const fresh = threads.filter((t) => !seen.has(t.id));
    for (const t of threads) seen.add(t.id);
    if (!initialized) {
      initialized = true; // 首轮只建立基线
      return;
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// 实时会话列表(原生树视图):官方扩展的列表缓存在其 app-server 进程里无法追加,
// 这里用我们自己的数据源(~/.codex 同池)提供始终新鲜的会话列表——
// 新会话以「追加一行」的方式出现,不刷新任何页面。
// ---------------------------------------------------------------------------
class ThreadsTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.threads = [];
  }
  refresh(threads) {
    this.threads = threads || [];
    this._onDidChange.fire();
  }
  getTreeItem(entry) {
    const item = new vscode.TreeItem(entry.label);
    item.description = entry.description;
    item.tooltip = entry.tooltip;
    item.command = { command: 'codex-panels.continueThreadById', title: '接续会话', arguments: [entry.thread] };
    item.iconPath = new vscode.ThemeIcon(
      entry.originator === 'Codex Desktop' ? 'comment' : entry.originator === 'codex_vscode' ? 'code' : 'terminal'
    );
    return item;
  }
  getChildren() {
    const fmt = (ts) => {
      const diff = Date.now() / 1000 - (ts || 0);
      if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + ' 分钟前';
      if (diff < 86400) return Math.round(diff / 3600) + ' 小时前';
      return new Date((ts || 0) * 1000).toLocaleDateString();
    };
    return this.threads.map((t) => ({
      label: (t.name || '(无标题)').slice(0, 48),
      description: (t.effort ? t.effort + ' · ' : '') + fmt(t.updatedAt),
      tooltip:
        (t.name || '') + '\n' +
        (t.model || '') + (t.effort ? ' · ' + t.effort : '') + '\n' +
        (t.cwd || '') + '\n来源:' + (t.originator || '') + '\n点击接续到该会话',
      originator: t.originator,
      thread: t,
    }));
  }
}

async function fetchProjects() {
  try {
    const res = await fetch(BACKEND + '/projects', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 会话列表的项目筛选:当前项目 / 所有项目 / 普通对话(不属于任何项目)
const FILTER_STATE_KEY = 'codex-panels.threadFilter';
const FILTER_LABELS = { current: '当前项目', all: '所有项目', plain: '普通对话' };

function applyFilter(threads, filter, projectsInfo, workspaceRoot) {
  if (!filter || filter === 'all') return threads;
  const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').toLowerCase().replace(/\/$/, '');
  if (filter === 'current') {
    const root = norm(workspaceRoot);
    return (threads || []).filter((t) => root && norm(t.cwd) === root);
  }
  // plain:没有归属任何 Codex 项目
  const assignments = (projectsInfo && projectsInfo.assignments) || {};
  return (threads || []).filter((t) => !assignments[t.id]);
}

function activate(context) {
  // 实时会话树视图(带项目筛选)
  const treeProvider = new ThreadsTreeProvider();
  const treeView = vscode.window.createTreeView('codex-panels.threads', { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView);

  let currentProjectsInfo = null;
  const getFilter = () => context.workspaceState.get(FILTER_STATE_KEY) || 'all';

  const refreshTree = async () => {
    const [threads, projectsInfo] = await Promise.all([fetchThreads(), fetchProjects()]);
    if (projectsInfo) currentProjectsInfo = projectsInfo;
    if (threads && threads.length) {
      const workspaceRoot =
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
          ? vscode.workspace.workspaceFolders[0].uri.fsPath
          : '';
      const filtered = applyFilter(threads, getFilter(), currentProjectsInfo, workspaceRoot);
      treeProvider.refresh(filtered);
      treeView.description = FILTER_LABELS[getFilter()] + ' · ' + filtered.length + '/' + threads.length;
    }
  };
  refreshTree();

  // 上报工作区根目录(官方扩展 webview 内的会话筛选按钮需要它)
  const reportRoot = () => {
    const root = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : '';
    if (root) {
      fetch(BACKEND + '/workspace-root', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      }).catch(() => {});
    }
  };
  reportRoot();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(reportRoot));

  // 筛选切换(树视图标题栏的筛选按钮触发)
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.setThreadFilter', async () => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: '当前项目', description: '只显示与当前工作区匹配的会话', value: 'current' },
          { label: '所有项目', description: '显示全部会话', value: 'all' },
          { label: '普通对话', description: '只显示不属于任何项目的会话', value: 'plain' },
        ],
        { placeHolder: '筛选会话列表(当前:' + FILTER_LABELS[getFilter()] + ')' }
      );
      if (picked) {
        await context.workspaceState.update(FILTER_STATE_KEY, picked.value);
        refreshTree();
      }
    })
  );

  // 树视图点击 = 接续该会话
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.continueThreadById', async (thread) => {
      if (!thread || !thread.id) return;
      await context.workspaceState.update(THREAD_STATE_KEY, thread.id);
      await context.globalState.update(THREAD_STATE_KEY, thread.id);
      vscode.window.showInformationMessage('已接续「' + (thread.name || '').slice(0, 40) + '」,之后的 @codex 对话都会发到这个会话。');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.refreshThreads', () => refreshTree())
  );
  // 手动同步官方扩展列表(重启扩展宿主;平时树视图已实时,无需动它)
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.syncOfficialList', async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      } catch (e) {
        vscode.window.showWarningMessage('刷新失败:' + String(e));
      }
    })
  );
  startThreadPolling(context, { refreshTree });
  context.subscriptions.push({ dispose: () => clearInterval(threadPollTimer) });
  // 状态栏左侧:返回 Codex
  const backItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  backItem.text = '$(home) Codex';
  backItem.tooltip = '返回 Codex 主窗口';
  backItem.command = 'codex-panels.focusCodex';
  backItem.show();
  context.subscriptions.push(backItem);
  context.subscriptions.push(vscode.commands.registerCommand('codex-panels.focusCodex', focusCodexApp));

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'codex-panels.selectModel';
  statusBar.tooltip = 'Codex 聊天模型(点击切换;思考强度用命令「Codex: 思考强度」)';
  currentModelId = context.workspaceState.get(MODEL_STATE_KEY) || '';
  currentEffortId = context.workspaceState.get(EFFORT_STATE_KEY) || '';
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.selectModel', () => pickModel(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.selectEffort', () => pickEffort(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.continueThread', () => pickThread(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.openInCodex', async () => {
      const threadId = context.workspaceState.get(THREAD_STATE_KEY) || context.globalState.get(THREAD_STATE_KEY);
      if (!threadId) {
        vscode.window.showWarningMessage('当前没有接续的会话;先用「Codex: 继续 Codex 中的会话」选择一个。');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse('codex://threads/' + threadId));
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-panels.newThread', async () => {
      await context.workspaceState.update(THREAD_STATE_KEY, undefined);
      await context.globalState.update(THREAD_STATE_KEY, undefined);
      vscode.window.showInformationMessage('已切换为新会话:下次 @codex 对话将开启新的 Codex 会话。');
    })
  );

  const handler = async (request, _chatContext, stream, _token) => {
    if (request.command === 'model') {
      await pickModel(context);
      stream.markdown('当前 Codex 模型:**' + (currentModel(context) || '默认(跟随 Codex 配置)') + '**');
      return;
    }
    if (request.command === 'effort') {
      await pickEffort(context);
      stream.markdown('当前思考强度:**' + (context.workspaceState.get(EFFORT_STATE_KEY) || '默认(' + '跟随模型)' ) + '**');
      return;
    }
    const message = (request.prompt || '').trim();
    if (!message) {
      stream.markdown('(空消息,试试:帮我看看这个项目的结构?)');
      return;
    }
    const model = currentModel(context) || undefined;
    const threadId = context.workspaceState.get(THREAD_STATE_KEY) || context.globalState.get(THREAD_STATE_KEY) || undefined;
    const effort = context.workspaceState.get(EFFORT_STATE_KEY) || undefined;
    let res;
    try {
      res = await fetch(BACKEND + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, model, threadId, effort }),
      });
    } catch (err) {
      stream.markdown(
        '⚠ 无法连接 codex-panels 后端(' + String((err && err.message) || err) + ')。\n\n请确认:正在使用 **codex-panels 注入版 Codex**,且编辑器窗口已打开(后端随它启动)。'
      );
      return;
    }
    if (!res.ok || !res.body) {
      stream.markdown('⚠ 后端错误 HTTP ' + res.status);
      return;
    }
    try {
      await streamSSE(res.body, stream);
    } catch (err) {
      stream.markdown('\n\n⚠ 流式输出中断:' + String((err && err.message) || err));
    }
  };

  const participant = vscode.chat.createChatParticipant('codex-panels.codex', handler);
  participant.description = '与 Codex 对话(模型与登录复用 Codex 桌面端)';
  context.subscriptions.push(participant);
}

function deactivate() {}

module.exports = { activate, deactivate };
