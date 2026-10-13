// codex-panels 聊天桥 v2:驱动 Codex 自带的 app-server(JSON-RPC 2.0 / NDJSON over stdio)。
// 模型、登录态、项目上下文全部复用 Codex 本体(~/.codex)。
// 对外暴露三张脸:
//   1. IPC(codex-panels:chat:send,旧编辑器页兼容)
//   2. 返回 api 对象给 main-runtime:listModels / setWorkspace / startTurn(HTTP/SSE 后端用)
// 由 main-runtime.cjs 在启动时加载。
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHAT_DEBUG = process.env.CODEX_PANELS_CHAT_DEBUG === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 清洗线程名:官方 VS Code 扩展的消息带 IDE 上下文前缀
// (# Context from my IDE setup: ... ## My request: 真实内容)。线程名可能被服务端
// 截断而丢失标记,此时返回空串,由调用方回退到 preview(含完整消息)的清洗结果。
function cleanThreadName(raw) {
  if (!raw) return '';
  const text = String(raw);
  const marker = '## My request:';
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) {
    const cleaned = text.slice(idx + marker.length).trim();
    if (cleaned) return cleaned.slice(0, 80);
  }
  if (text.startsWith('# Context from my IDE')) return '';
  return text.slice(0, 80);
}

module.exports = function setupChat({ HOME, APP_DIR, log, broadcast }) {
  const { ipcMain } = require('electron');

  let child = null; // codex app-server 子进程
  let nextId = 1;
  const pending = new Map(); // JSON-RPC id -> resolve
  let buffer = '';
  let workspace = null; // 当前线程的工作目录(与 threadId 绑定)
  let threadId = null;
  let turnListeners = []; // 本轮事件的订阅者(startTurn 传入)
  let turnBusy = false;
  let turnEndResolver = null; // startTurn 等待 turn/completed 通知用

  function resolveCodexCommand() {
    // 优先级:settings.json 的 codexCommand > 副本内置 codex.exe > PATH 上的 codex
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8'));
      if (settings.codexCommand) return settings.codexCommand;
    } catch {}
    const bundled = path.join(APP_DIR, 'resources', 'codex.exe');
    if (fs.existsSync(bundled)) return bundled;
    return 'codex';
  }

  function start() {
    const command = resolveCodexCommand();
    child = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    log('聊天桥已拉起 app-server:', command);
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => log('[app-server:err]', String(d).slice(0, 300)));
    child.on('exit', (code) => {
      log('app-server 退出, code =', code);
      child = null;
      threadId = null;
    });
    request('initialize', {
      clientInfo: { name: 'codex-panels', title: 'codex-panels', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then((res) => {
      send({ jsonrpc: '2.0', method: 'initialized' });
      log('app-server 握手完成:', res && res.result ? res.result.codexHome : res);
    });
  }

  function send(obj) {
    if (child && child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function request(method, params, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: { message: method + ' 超时' } });
        }
      }, timeoutMs);
    });
  }

  function onChunk(chunk) {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      handleMessage(message);
    }
  }

  function handleMessage(message) {
    if (CHAT_DEBUG) log('[chat:debug]', JSON.stringify(message).slice(0, 240));

    // 1. 我方请求的响应
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    // 2. 服务端反向请求(审批/用户输入):统一自动拒绝,避免会话挂死
    if (message.id !== undefined && message.method) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'codex-panels: not supported' } });
      emitEvent({ type: 'status', text: '一个需要确认的操作被自动拒绝:' + message.method });
      return;
    }
    // 3. 事件通知
    forwardEvent(message);
  }

  function emitEvent(ev) {
    // 同时发给:本轮订阅者(HTTP/SSE)与编辑器窗口(旧桥兼容)
    for (const cb of turnListeners) {
      try {
        cb(ev);
      } catch {}
    }
    broadcast('codex-panels:chat:event', ev);
  }

  function forwardEvent(message) {
    const method = message.method || '';
    const params = message.params || {};
    if (CHAT_DEBUG) log('[chat:event]', method);

    if (/agentMessage\/delta/i.test(method)) {
      const text = params.delta != null ? params.delta : params.text != null ? params.text : '';
      if (text) emitEvent({ type: 'delta', text });
    } else if (/agentMessage\/(updated|completed)/i.test(method)) {
      const item = params.item || {};
      const text = item.text || params.text || '';
      if (text) emitEvent({ type: 'message', text });
    } else if (/item\/(started|completed)/i.test(method)) {
      const item = params.item || {};
      const type = item.type || '';
      if (/commandExecution|exec/i.test(type)) {
        emitEvent({ type: 'command', text: item.command || item.text || type });
      }
    } else if (method === 'turn/completed') {
      turnBusy = false;
      emitEvent({ type: 'turn-end' });
      if (turnEndResolver) {
        turnEndResolver();
        turnEndResolver = null;
      }
    } else if (method === 'turn/failed') {
      turnBusy = false;
      emitEvent({ type: 'status', text: '本轮执行失败:' + JSON.stringify(params.error || params).slice(0, 160) });
      if (turnEndResolver) {
        turnEndResolver();
        turnEndResolver = null;
      }
    }
    // 其余状态类事件(限流、MCP 启动等)噪音较多,静默
  }

  async function ensureThread(cwd) {
    if (!child) start();
    if (workspace !== cwd || !threadId) {
      workspace = cwd;
      threadId = null;
      let res = await request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write' });
      if (!res || !res.result || !res.result.thread) {
        // 参数组合不被接受时退化为最小参数(实测 {cwd} 即可建线程)
        res = await request('thread/start', { cwd });
      }
      if (res && res.result && res.result.thread) {
        threadId = res.result.thread.id;
        emitEvent({ type: 'status', text: '已连接 Codex,模型与登录态复用桌面端配置' });
      } else {
        emitEvent({ type: 'status', text: '会话建立失败:' + JSON.stringify(res && res.error).slice(0, 200) });
        return null;
      }
    }
    return threadId;
  }

  // ---------------------------------------------------------------------------
  // 对外 API(供 main-runtime 的 HTTP 后端 / 项目联动使用)
  // ---------------------------------------------------------------------------
  const api = {
    /** 列出 ~/.codex 里的全部会话(Codex 桌面端 / 官方扩展 / 我们自己建的,同池)。 */
    async listThreads(limit = 20) {
      if (!child) start();
      const res = await request('thread/list', { limit: Math.max(limit, 10), archived: false }, 20000);
      const result = res && res.result;
      const arr = Array.isArray(result)
        ? result
        : result && Array.isArray(result.threads)
          ? result.threads
          : result && Array.isArray(result.data)
            ? result.data
            : [];
      return arr
        .map((t) => {
          const preview = cleanThreadName(t.preview || '');
          return {
            id: t.id,
            name: cleanThreadName(t.name) || preview || '(无标题)',
            preview,
            model: t.model || '',
            effort: t.reasoningEffort || '',
            status: (t.status && (t.status.type || t.status)) || '',
            cwd: t.cwd || '',
            updatedAt: t.updatedAt || t.createdAt || 0,
            originator: t.originator || '',
          };
        })
        .filter((t) => t.id);
    },
    /** 当前模型列表(来自 app-server 的 model/list,实测结构为 result.data 数组)。 */
    async listModels() {
      if (!child) start();
      const res = await request('model/list', {}, 20000);
      const result = res && res.result;
      const list = Array.isArray(result)
        ? result
        : result && Array.isArray(result.data)
          ? result.data
          : result && Array.isArray(result.models)
            ? result.models
            : [];
      return list
        .map((m) => {
          if (typeof m === 'string') return { id: m, label: m };
          return {
            id: m.id || m.model || String(m),
            label: (m.displayName || m.display_name || m.label || m.family || m.id || m.model || '') + (m.isDefault ? '(默认)' : ''),
            description: m.description || '',
            isDefault: Boolean(m.isDefault),
            defaultEffort: m.defaultReasoningEffort || '',
            efforts: (m.supportedReasoningEfforts || []).map((e) => ({
              id: e.reasoningEffort || String(e),
              description: e.description || '',
            })),
          };
        })
        .filter((m) => m.id);
    },

    /** 切换工作区(编辑器打开的文件夹变了 → 下次 startTurn 用新线程)。 */
    setWorkspace(cwd) {
      if (cwd && cwd !== workspace) {
        workspace = cwd;
        threadId = null;
      }
    },

    get workspace() {
      return workspace;
    },

    /** 发起一轮对话。onEvent 收到归一化事件(delta/message/command/status/turn-end)。
     *  options.threadId:继续 ~/.codex 里的已有会话(Codex 桌面端的对话可在 VS Code 里接续)。
     *  返回 Promise 会等到本轮结束(turn/completed 通知)才 resolve,HTTP/SSE 才不会提前关流。 */
    async startTurn(text, options = {}) {
      if (typeof text !== 'string' || !text.trim()) return { error: '空消息' };
      if (turnBusy) return { error: 'Codex 正在回复上一条消息,请稍候' };
      turnBusy = true;
      const turnDone = new Promise((resolve) => {
        turnEndResolver = resolve;
      });
      try {
        let tid;
        if (options.threadId && options.threadId !== threadId) {
          // 继续已有会话:先 thread/resume 加载,再 turn/start
          const res = await request('thread/resume', { threadId: options.threadId, excludeTurns: true }, 30000);
          if (!res || res.error || !res.result) {
            turnBusy = false;
            return { error: '会话恢复失败:' + JSON.stringify(res && res.error).slice(0, 160) };
          }
          threadId = options.threadId;
          workspace = null; // 外部会话的工作区未知,不自动新建
          tid = threadId;
        } else {
          const cwd = options.cwd || workspace || HOME;
          tid = await ensureThread(cwd);
          if (!tid) {
            turnBusy = false;
            return { error: '无法建立 Codex 会话(请确认 Codex 桌面端已登录)' };
          }
        }
        const params = { threadId: tid, input: [{ type: 'text', text }] };
        if (options.model) params.model = options.model;
        if (options.effort) params.effort = options.effort;
        turnListeners = options.onEvent ? [options.onEvent] : [];
        const res = await request('turn/start', params, 300000);
        if (res && res.error) {
          turnBusy = false;
          return { error: JSON.stringify(res.error).slice(0, 200) };
        }
        // 等待本轮完成通知(兜底 4 分钟,防止事件丢失导致永久挂起)
        await Promise.race([turnDone, sleep(240000)]);
        return { ok: true };
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) };
      } finally {
        turnEndResolver = null;
        turnBusy = false;
      }
    },
  };

  // IPC 兼容入口(旧编辑器页面/调试用)
  ipcMain.handle('codex-panels:chat:send', async (_event, text) => api.startTurn(text));

  return api;
};
