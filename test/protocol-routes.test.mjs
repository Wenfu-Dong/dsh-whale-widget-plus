/**
 * 协议邻近端点组件的边界回归：依赖契约 + 桌宠发送闸门 + 嵌入模式重启 + 会话重置。
 * 这里只验证 HTTP 形状与转发语义，真实发送/DSH 调用全部用桩替代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProtocolRoutes } from '../src/qq/features/protocol-routes.js';
import { SENSITIVE_RE, ILLEGAL_CONTENT_RE } from '../src/sensitive.js';

function makeDeps(overrides = {}) {
  const cfg = { ownerQQ: '10001', socialV2: { send: {} }, ...(overrides.cfg ?? {}) };
  const state = overrides.state ?? { sessions: {}, sessionPolicies: {} };
  const social = {
    states: new Map(),
    recentMessages: new Map(),
    pendingSummaries: new Map(),
    silentContext: new Map(),
    silentTurns: new Map(),
    exitingSessions: new Set(),
  };
  const socialV2 = { conversations: new Map(), paused: false };
  const calls = { sent: [], reloads: 0 };
  const deps = {
    log: () => {},
    getConfig: () => cfg,
    getMode: () => 'closed-agent',
    agentTokenOk: () => true,
    v2ToolEnabled: () => true,
    modeAllowed: () => true,
    findMessageMedia: () => [],
    fetchMediaData: async (media) => media,
    sendToQQ: async (key, message) => { calls.sent.push({ key, message }); },
    lastSendSucceeded: () => true,
    scheduleSocialReply: () => {},
    ownerMessageTag: () => '',
    resolveReplyTargetV2: async () => null,
    sendMessagesV2: async () => [],
    recordSentMessagesV2: () => {},
    sendRateLimitInfo: () => null,
    reportLimitEvent: () => {},
    shouldBlockSilentReply: () => false,
    getSocialV2State: () => ({ sendTimes: [], wakeConfig: {} }),
    saveSocialV2State: () => {},
    appendActivity: () => {},
    scheduleReplyCheckV2: () => {},
    cancelPendingEntry: async () => {},
    drainPromptQueue: () => {},
    drainAllPromptQueues: () => {},
    cancelSocialTimers: () => {},
    cancelAllSocialTimers: () => {},
    clearSocialV2Timers: () => {},
    clearAllSocialV2Timers: () => {},
    slang: { resetKey: () => {}, resetAllWindows: () => {} },
    forgetAgentToken: () => {},
    flushSocialV2State: () => {},
    saveState: () => {},
    api: { stopSessionWork: async () => {}, workspace: { archiveSession: async () => {} }, sessions: { list: async () => ({ items: [] }) } },
    withTimeout: (promise) => promise,
    unwrap: (value) => value,
    onebotSend: async () => {},
    releaseLock: () => {},
    auditOwner: () => {},
    DSH_CONTROL_TIMEOUT_MS: 1000,
    SEND_TIMEOUT_MS: 1000,
    embed: false,
    getEmbeddedRuntime: () => ({ reload: async () => { calls.reloads += 1; return { ok: true }; } }),
    state,
    social,
    socialV2,
    pending: new Map(),
    queued: new Map(),
    queuedHintAt: new Map(),
    sessionPromises: new Map(),
    messageMediaStore: new Map(),
    seenForwardIds: new Map(),
    modelAppliedSessions: new Map(),
    reverse: new Map(),
    collectors: new Map(),
    sendToolSucceededSessions: new Set(),
    pendingSendToolCalls: new Map(),
    v2TurnStartAt: new Map(),
    turnLeaseNoted: new Set(),
    toolCallNames: new Map(),
    pendingWakeKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    markReadCalledKeys: new Set(),
    wakeConfigMissCount: new Map(),
    CONVERSATION_TOKENS: new Set(),
    KNOWN_AGENT_TOKENS: new Set(),
    memoryCardNotifyAt: new Map(),
    bumpSessionEpoch: () => {},
    SENSITIVE_RE,
    ILLEGAL_CONTENT_RE,
    unquoteJsonString: (value) => value,
    STATE_DIR: '.',
    ACTIVITY_LOG: 'qq-activity.log',
    ...overrides.deps,
  };
  return { deps, cfg, calls };
}

function makeIo(method, pathname, body) {
  const url = new URL(`http://127.0.0.1${pathname}`);
  const req = { method, headers: {} };
  let status = 200;
  let payload = null;
  const sendJson = (obj, code = 200) => { payload = obj; status = code; };
  const readBody = async () => body ?? {};
  return { req, url, sendJson, readBody, result: () => ({ status, payload }) };
}

test('缺少注入依赖时构造即失败', () => {
  assert.throws(() => createProtocolRoutes({}), /protocol-routes 缺少依赖/);
  const { deps } = makeDeps();
  const broken = { ...deps };
  delete broken.sendToQQ;
  assert.throws(() => createProtocolRoutes(broken), /sendToQQ/);
});

test('POST /api/pet/qq-send：ownerQQ 未配置返回 409', async () => {
  const { deps } = makeDeps({ cfg: { ownerQQ: '' } });
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/pet/qq-send', { key: 'private:10001', text: 'hi' });
  assert.equal(await routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody), true);
  assert.equal(io.result().status, 409);
  assert.equal(io.result().payload.error, '还没配置 ownerQQ');
});

test('POST /api/pet/qq-send：非主人私聊返回 403', async () => {
  const { deps } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/pet/qq-send', { key: 'private:20002', text: 'hi' });
  await routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 403);
  assert.equal(io.result().payload.error, '桌宠只能给主人发私聊');
});

test('POST /api/pet/qq-send：空消息返回 400 且不发送', async () => {
  const { deps, calls } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/pet/qq-send', { key: 'private:10001', text: '   ' });
  await routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 400);
  assert.equal(io.result().payload.error, '消息不能为空');
  assert.equal(calls.sent.length, 0);
});

test('POST /api/pet/qq-send：敏感词返回 403 且不发送', async () => {
  const { deps, calls } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/pet/qq-send', { key: 'private:10001', text: '我的密码是 abc123' });
  await routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 403);
  assert.equal(io.result().payload.error, '消息含敏感信息，已阻止发送');
  assert.equal(calls.sent.length, 0);
});

test('POST /api/pet/qq-send：主人私聊正常发送并返回 ok', async () => {
  const { deps, calls } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/pet/qq-send', { key: 'private:10001', text: '今天吃什么' });
  await routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 200);
  assert.deepEqual(io.result().payload, { ok: true });
  assert.deepEqual(calls.sent, [{ key: 'private:10001', message: '今天吃什么' }]);
});

test('POST /api/restart：嵌入模式走 reload 并透传状态码', async () => {
  const { deps, calls } = makeDeps({ deps: { embed: true } });
  const routes = createProtocolRoutes(deps);
  const okIo = makeIo('POST', '/api/restart', {});
  await routes.handleRestart(okIo.req, {}, okIo.url, okIo.sendJson, okIo.readBody);
  assert.equal(okIo.result().status, 200);
  assert.equal(calls.reloads, 1);

  const failed = makeDeps({
    deps: {
      embed: true,
      getEmbeddedRuntime: () => ({ reload: async () => ({ ok: false, error: '热重载失败' }) }),
    },
  });
  const failedRoutes = createProtocolRoutes(failed.deps);
  const failIo = makeIo('POST', '/api/restart', {});
  await failedRoutes.handleRestart(failIo.req, {}, failIo.url, failIo.sendJson, failIo.readBody);
  assert.equal(failIo.result().status, 500);
  assert.equal(failIo.result().payload.error, '热重载失败');
});

test('POST /api/session/reset：不存在的 key 返回 404', async () => {
  const { deps } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('POST', '/api/session/reset', { key: 'group:123' });
  await routes.handleSessionReset(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 404);
  assert.equal(io.result().payload.error, '会话不存在');
});

test('非目标路径不会被接管', async () => {
  const { deps } = makeDeps();
  const routes = createProtocolRoutes(deps);
  const io = makeIo('GET', '/api/status', null);
  const handled = await Promise.all([
    routes.handleImagesMessage(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handlePetQqSend(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handlePetOwnerMessage(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handleSend(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handleSessionReset(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handleWorkspaceReset(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handleRestart(io.req, {}, io.url, io.sendJson, io.readBody),
    routes.handleMemoryCardNotify(io.req, {}, io.url, io.sendJson, io.readBody),
  ]);
  assert.deepEqual(handled, [false, false, false, false, false, false, false, false]);
  assert.equal(io.result().status, 200);
  assert.equal(io.result().payload, null);
});
