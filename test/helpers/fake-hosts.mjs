/**
 * P0 集成护栏用的「假宿主」：假 SnowLuma（OneBot HTTP + WS）与假 DSH（Web API + remote.mux）。
 *
 * 为什么要手写而不是 mock 模块：桥接的故障大多发生在真实边界上 ——
 * 鉴权换 Cookie、remote.mux 的帧形状、OneBot action 的 HTTP 失败、以及
 * 「停不下来/停完还连」的句柄泄漏。把这些边界换成内存对象，就测不到它们。
 *
 * 只实现桥接真实会调用到的子集；未识别的端点一律回 `{ ok: true, value: {} }`，
 * 这样 DSH 以后新增可选 RPC 不会让这几条护栏无端变红（它们不是协议快照测试）。
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

/** 在 127.0.0.1 上要一个空闲端口（listen 0 让系统分配，再关掉）。 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 轮询直到 predicate 为真；超时抛错（带最后一次的值，方便定位）。 */
export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function wsSend(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

/**
 * 假 SnowLuma：OneBot 的 HTTP 发送端口 + 事件 WebSocket 端口（同一个端口）。
 *
 * 记录所有出站 action；`failNextSends` 可以让接下来的 N 次发送返回失败，
 * 用来验证「发送失败不会被吞成成功」这类稳定性行为。
 */
export async function startFakeSnowluma({ token = '' } = {}) {
  const sent = []; // [{ action, params }]
  const clients = new Set();
  const state = { failNextSends: 0, failActions: new Set(), failNextWsSends: 0 };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 404, { status: 'failed', retcode: 404, wording: 'not found', data: null });
      return;
    }
    const action = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/+/, '');
    let params = {};
    try { params = JSON.parse(await readBody(req) || '{}'); } catch {}
    const shouldFail = state.failNextSends > 0 || state.failActions.has(action);
    if (state.failNextSends > 0) state.failNextSends -= 1;
    sent.push({ action, params, failed: shouldFail });
    if (shouldFail) {
      sendJson(res, 200, { status: 'failed', retcode: 100, wording: 'injected failure', data: null });
      return;
    }
    sendJson(res, 200, { status: 'ok', retcode: 0, wording: '', data: { message_id: sent.length } });
  });

  const wss = new WebSocketServer({ noServer: true });
  const rawSockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { return; }
        const { action, params, echo } = frame ?? {};
        if (!action) return;
        if (token && new URL(req.url, 'http://127.0.0.1').searchParams.get('access_token') !== token) {
          wsSend(ws, { status: 'failed', retcode: 1401, wording: 'bad token', echo, data: null });
          return;
        }
        const shouldFailSend = /^send_/.test(action) && state.failNextWsSends > 0;
        if (shouldFailSend) {
          state.failNextWsSends -= 1;
          sent.push({ action, params, failed: true, transport: 'ws' });
          wsSend(ws, { status: 'failed', retcode: 100, wording: 'injected ws failure', echo, data: null });
          return;
        }
        const data = action === 'get_login_info'
          ? { user_id: 10000, nickname: '测试机器人' }
          : action === 'get_status'
            ? { online: true, good: true }
            : action === 'send_private_msg' || action === 'send_group_msg'
              ? { message_id: sent.length }
              : {};
        wsSend(ws, { status: 'ok', retcode: 0, wording: '', echo, data });
        // 出站可能走 HTTP（onebotSend）也可能走 WS（SDK 的 sendPrivateMessage/sendGroupMessage），
        // 两条都是真实链路，统一记录，断言才不会只看到「一半」。
        if (/^send_/.test(action)) sent.push({ action, params, failed: false, transport: 'ws' });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    sent,
    state,
    /** 模拟上游推来一条 OneBot 事件。返回实际收到它的连接数。 */
    inject(event) {
      let n = 0;
      for (const ws of clients) { wsSend(ws, event); n += 1; }
      return n;
    },
    hasClient() {
      return clients.size > 0;
    },
    /** 只保留出站记录中的文本 action，便于断言。 */
    outgoing(kind) {
      return sent.filter((item) => item.action === 'send_group_msg' || item.action === 'send_private_msg')
        .filter((item) => (kind ? item.action === kind : true));
    },
    async close() {
      for (const ws of clients) { try { ws.terminate(); } catch {} }
      clients.clear();
      // ws 的关闭握手会挂一个 30s 的 closeTimer；测试进程不该为它等半分钟。
      for (const socket of rawSockets) { try { socket.destroy(); } catch {} }
      rawSockets.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 假 DSH：HTTP RPC（带 launch token → Set-Cookie 换票）+ /api/remote.mux 事件流。
 *
 * 收到 session/prompt 后按真实回合的顺序（turn/start → assistant/message → turn/end）
 * 往该会话已 follow 的流里推事件；没 follow 就排队，等 follow 到达再推。
 */
export async function startFakeDsh({ mode = 'chat', replyText = '我在。', presets = ['qq-chat', 'qq-chat-v2'] } = {}) {
  const prompts = []; // [{ sessionId, payload }]
  const rpcCalls = []; // [{ method, payload }]
  const sessions = [];
  const follows = new Map(); // sessionId -> Set<streamId>
  const streamSession = new Map(); // streamId -> sessionId
  const socketStreams = new Map(); // ws -> Set<streamId>
  const pendingTurns = new Map(); // sessionId -> number（未推送的回合数）
  const state = { created: Math.floor(Math.random() * 1e6) };
  let signCookie = 'dsh-auth-test=v1.test-signature';

  const rpcValue = (method, payload) => {
    switch (method) {
      case 'settings/describe':
        return {
          namespaces: [
            { ns: 'agent-presets', value: { default: presets[0] ?? 'qq-chat' } },
            { ns: 'qq-mode', value: { mode } },
          ],
        };
      case 'agentPresets/list':
        return { presets: presets.map((id) => ({ id, isDefault: id === presets[0] })) };
      case 'session/modelCatalog':
        return {
          groups: [{
            id: 'deepseek-official',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
          }],
        };
      case 'session/create': {
        state.created += 1;
        const sessionId = `sess-${state.created}`;
        sessions.push(sessionId);
        return { sessionId };
      }
      case 'workspace/create':
        return { created: true, workspace: { workspaceId: 'ws-test' } };
      case 'workspace/rename':
      case 'workspace/archiveSession':
      case 'workspace/delete':
      case 'session/rename':
      case 'session/cancel':
      case 'session/updateQueue':
      case '$events/result':
        return {};
      case 'session/selectModel':
        return {
          selected: {
            provider: payload?.provider ?? 'deepseek-official',
            model: payload?.model ?? 'deepseek-flash',
            reasoningEffort: payload?.reasoningEffort,
          },
        };
      case 'session/projections':
        return { asOfSeq: 0, values: {} };
      case 'session/list':
        return { items: [] };
      case 'host/describe':
        return {};
      case 'session/prompt':
        return { accepted: true, requestId: 'req-test' };
      default:
        return {};
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET') {
      // launch token 换票：真实 DSH 回 Set-Cookie，桥接只取分号前的键值。
      if (url.searchParams.get('token')) {
        res.writeHead(200, { 'set-cookie': `${signCookie}; Path=/; HttpOnly` });
        res.end('ok');
        return;
      }
      // 未带 token 的裸请求按真实 DSH 行为回 401：桥接的端口探测（probeDshBaseUrl）
      // 就是靠这个判断「这里有一只活着的 DSH」，回 404 会被判定为不可用并触发端口漂移。
      res.writeHead(401, { server: 'dsh-fake', 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    const method = url.pathname.replace(/^\/api\//, '');
    let envelope = {};
    try { envelope = JSON.parse(await readBody(req) || '{}'); } catch {}
    const payload = envelope?.payload?.args
      ? Object.values(envelope.payload.args)[0]
      : envelope?.payload;
    rpcCalls.push({ method, payload });
    if (method === 'session/prompt') prompts.push({ sessionId: payload?.sessionId, payload });
    sendJson(res, 200, {
      type: 'server-response',
      rpcId: envelope?.rpcId,
      result: { ok: true, value: rpcValue(method, payload) },
    });
    if (method === 'session/prompt' && payload?.sessionId) {
      pendingTurns.set(payload.sessionId, (pendingTurns.get(payload.sessionId) ?? 0) + 1);
      flushTurns(payload.sessionId);
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const rawSockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    rawSockets.add(socket);
    socket.on('close', () => rawSockets.delete(socket));
    if (!String(req.url ?? '').startsWith('/api/remote.mux')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      socketStreams.set(ws, new Set());
      ws.on('close', () => {
        for (const streamId of socketStreams.get(ws) ?? []) {
          streamSession.delete(streamId);
          for (const set of follows.values()) set.delete(streamId);
        }
        socketStreams.delete(ws);
      });
      ws.on('message', (raw) => {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame?.type !== 'open' || typeof frame.streamId !== 'string') return;
        socketStreams.get(ws)?.add(frame.streamId);
        if (frame.endpoint === '$events') {
          wsSend(ws, { type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'client-test' } });
          return;
        }
        if (frame.endpoint === 'session/follow') {
          const sessionId = frame?.payload?.args?.request?.address?.sessionId;
          if (!sessionId) return;
          streamSession.set(frame.streamId, sessionId);
          if (!follows.has(sessionId)) follows.set(sessionId, new Set());
          follows.get(sessionId).add(frame.streamId);
          wsSend(ws, {
            type: 'item',
            streamId: frame.streamId,
            value: { type: 'snapshot', projections: {}, records: [], maxMessages: 200 },
          });
          flushTurns(sessionId);
        }
      });
    });
  });

  function emitToSession(sessionId, event) {
    const streams = follows.get(sessionId);
    if (!streams || streams.size === 0) return false;
    for (const streamId of streams) {
      for (const ws of socketStreams.keys()) {
        if (!socketStreams.get(ws)?.has(streamId)) continue;
        wsSend(ws, { type: 'item', streamId, value: { type: 'event', event } });
      }
    }
    return true;
  }

  /** 把一个待发回合按真实顺序推给已 follow 的流。 */
  function flushTurns(sessionId) {
    const pending = pendingTurns.get(sessionId) ?? 0;
    if (pending <= 0) return;
    const streams = follows.get(sessionId);
    if (!streams || streams.size === 0) return;
    pendingTurns.set(sessionId, 0);
    let turnNo = 0;
    for (let i = 0; i < pending; i += 1) {
      turnNo += 1;
      const turn = `turn-${sessionId}-${Date.now()}-${turnNo}`;
      setTimeout(() => emitToSession(sessionId, { type: 'turn/start', data: { turn } }), 20);
      setTimeout(() => emitToSession(sessionId, {
        type: 'assistant/message',
        data: { turn, message: { content: [{ type: 'text', text: replyText }] } },
      }), 60);
      setTimeout(() => emitToSession(sessionId, {
        type: 'turn/end',
        data: { turn, reason: { kind: 'completed' } },
      }), 100);
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    prompts,
    rpcCalls,
    sessions,
    state,
    /** 已被客户端 follow 的会话（诊断用）。 */
    followedSessions() { return [...follows.keys()]; },
    /** 当前打开的 mux 流数量（诊断用）。 */
    openStreams() { return streamSession.size; },
    /** 仅测试用：改换票 Cookie（模拟 DSH 重启后旧 Cookie 失效）。 */
    setCookie(value) { signCookie = value; },
    close() {
      for (const ws of socketStreams.keys()) { try { ws.terminate(); } catch {} }
      // 同上：ws 的 closeTimer 默认 30s，测试不该为它等。
      for (const socket of rawSockets) { try { socket.destroy(); } catch {} }
      rawSockets.clear();
      return new Promise((resolve) => wss.close(() => resolve()))
        .then(() => new Promise((resolve) => server.close(() => resolve())));
    },
  };
}
