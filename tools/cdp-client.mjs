// 连接本机 CDP 调试端口(默认 9222)上的页面目标,提供 evaluate 等基础操作。
// 注意用 localhost 而不是 127.0.0.1:被强杀的旧实例可能在 IPv4 上留下僵尸监听,
// 新实例只能绑 IPv6 [::1];localhost 两者都能解析到活的那个。
// 用法:const page = await connectToPage(); await page.evaluate('document.title');
export async function connectToPage(matchFn, port) {
  const targetPort = port || Number(process.env.CODEX_PANELS_DEBUG_PORT) || 9222;
  const matcher = matchFn || ((t) => t.type === 'page' && t.url.startsWith('app://'));
  const list = await (await fetch(`http://localhost:${targetPort}/json/list`)).json();
  const target = list.find(matcher);
  if (!target) {
    throw new Error('找不到匹配的调试目标。现有目标: ' + list.map((t) => `${t.type}:${t.url}`).join(' | '));
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'));
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.result && result.result.exceptionDetails) {
      throw new Error('页面执行异常: ' + JSON.stringify(result.result.exceptionDetails).slice(0, 300));
    }
    return result.result ? result.result.result.value : undefined;
  };
  return { ws, send, evaluate, target, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
