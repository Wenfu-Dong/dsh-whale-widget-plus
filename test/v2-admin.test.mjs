/**
 * 二代管理 / AI 工具端点回归：鉴权闸门、重置清理、语音 dry-run 与黑话提交。
 * 不启动 HTTP 服务，全部依赖用桩替代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createV2AdminRoutes } from '../src/qq/features/v2-admin.js';
import { atomicWriteJson } from '../src/qq/json-io.js';

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-admin-'));
  const socialV2File = path.join(dir, 'social-v2.json');
  const cfg = { ownerQQ: '10001', slang: { enabled: true }, ...(overrides.cfg ?? {}) };
  const state = { sessions: { 'group:1': 'sid-1' }, sessionPolicies: { 'group:1': {} } };
  const socialV2 = { conversations: new Map([['group:1', { agentToken: 'tok' }]]), paused: true };
  const calls = {
    epoch: 0, timersCleared: 0, drained: [], saves: 0,
    forgotten: [], retired: [], audits: [], activities: [], markedSent: [],
  };
  const voice = {
    cfg: () => ({ enabled: true, dir, maxBytes: 1000, maxSeconds: 10, maxPerMinute: 3, maxPerHour: 10 }),
    triggerBlock: () => null,
    budgetCheck: () => {},
    resolvePathForV2: () => ({ path: path.join(dir, 'a.wav') }),
    synthesizeText: async () => ({ path: path.join(dir, 'tts.wav'), ttsCached: false }),
    sendForV2: async () => ({ messageId: 'm1', file: path.join(dir, 'a.wav'), detail: {}, warnings: [] }),
    markSent: (key) => calls.markedSent.push(key),
  };
  const slang = {
    confirmedList: () => [
      { content: '典', meaning: '经典', usage: '形容词', example: '太典了' },
      { content: '绷', meaning: '忍不住', usage: '动词', example: '绷不住了' },
    ],
    context: () => '- 典：经典',
    submitCandidate: overrides.submitCandidate ?? (() => ({ ok: true, duplicate: false })),
  };
  const deps = {
    log: () => {},
    getConfig: () => cfg,
    getMode: () => overrides.mode ?? 'reserved2',
    modeAllowed: () => true,
    agentTokenOk: (key, token) => key === 'group:1' && token === 'tok',
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    shouldBlockSilentReply: () => false,
    voice,
    auditOwner: (...args) => calls.audits.push(args),
    fishGuardSendBlock: () => null,
    tokenGuardSendBlock: () => null,
    getSocialV2State: () => ({ agentToken: 'tok' }),
    bumpSessionEpoch: () => { calls.epoch += 1; },
    sessionPromises: new Map([['group:1', Promise.resolve()]]),
    clearAllSocialV2Timers: () => { calls.timersCleared += 1; },
    drainAllPromptQueues: (reason) => calls.drained.push(reason),
    socialV2,
    state,
    stopRetiredSessionWork: (sid, key) => calls.retired.push([sid, key]),
    sessionModels: new Map([['sid-1', 'm']]),
    modelAppliedSessions: new Set(['sid-1']),
    reverse: new Map([['sid-1', 'group:1']]),
    collectors: new Map([['sid-1', {}]]),
    v2TurnStartAt: new Map([['sid-1', 1]]),
    turnLeaseNoted: new Set(['sid-1']),
    toolCallNames: new Map([['sid-1', 'x']]),
    pendingSendToolCalls: new Map([['sid-1', []]]),
    sendToolSucceededSessions: new Set(['sid-1']),
    api: { events: { forget: (sid) => calls.forgotten.push(sid) } },
    forgetAgentToken: (key) => calls.forgotten.push(`token:${key}`),
    seenForwardIds: new Set(['group:1']),
    saveState: () => { calls.saves += 1; },
    pendingWakeKeys: new Set(['group:1']),
    clearAllPendingWakeLeases: () => {},
    wakeConfigUpdatedKeys: new Set(['group:1']),
    markReadCalledKeys: new Set(['group:1']),
    wakeConfigMissCount: new Map([['group:1', 1]]),
    cancelSocialV2PendingSave: () => {},
    atomicWriteJson,
    SOCIAL_V2_FILE: socialV2File,
    slang,
    appendActivity: (line) => calls.activities.push(line),
    redactKnownTokensOnly: (text) => text.replace(/secret/g, '***'),
    inspectAudio: async () => ({ ok: true, size: 12, duration: 2 }),
    describeAudio: () => '12B / 2s',
    listAudioFiles: () => [path.join(dir, 'a.wav')],
  };
  return { deps: { ...deps, ...(overrides.deps ?? {}) }, cfg, state, socialV2, calls, dir, socialV2File };
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
  assert.throws(() => createV2AdminRoutes({}), /v2-admin 缺少依赖/);
});

test('POST /api/socialV2/reset：清理会话/映射并直写空状态', async () => {
  const { deps, state, socialV2, calls, socialV2File } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const io = makeIo('POST', '/api/socialV2/reset');
  assert.equal(await routes.handleReset(io.req, {}, io.url, io.sendJson, io.readBody), true);
  assert.equal(calls.epoch, 1);
  assert.equal(calls.timersCleared, 1);
  assert.deepEqual(calls.drained, ['二代状态已重置']);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.sessionPolicies, {});
  assert.equal(socialV2.conversations.size, 0);
  assert.equal(socialV2.paused, false);
  assert.equal(calls.markedSent.length, 0);
  assert.deepEqual(calls.retired, [['sid-1', 'group:1']]);
  assert.equal(calls.saves, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(socialV2File, 'utf8')), { conversations: {} });
});

test('POST /api/socialV2/send-voice：功能关闭/缺令牌/令牌错误分别拒绝', async () => {
  const disabled = makeDeps({ deps: { voice: { ...makeDeps().deps.voice, cfg: () => ({ enabled: false }) } } });
  const routesDisabled = createV2AdminRoutes(disabled.deps);
  const off = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', token: 'tok', text: 'hi' });
  await routesDisabled.handleSendVoice(off.req, {}, off.url, off.sendJson, off.readBody);
  assert.equal(off.result().status, 403);
  assert.equal(off.result().payload.code, 'VOICE_DISABLED');

  const { deps } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const noToken = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', text: 'hi' });
  await routes.handleSendVoice(noToken.req, {}, noToken.url, noToken.sendJson, noToken.readBody);
  assert.equal(noToken.result().status, 403);

  const badToken = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', token: 'bad', text: 'hi' });
  await routes.handleSendVoice(badToken.req, {}, badToken.url, badToken.sendJson, badToken.readBody);
  assert.match(badToken.result().payload.error, /无效/);
});

test('POST /api/socialV2/send-voice：text 与 voice 互斥，dry-run 只探测不发送', async () => {
  const { deps, calls } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const both = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', token: 'tok', text: 'hi', voice: 'a.wav' });
  await routes.handleSendVoice(both.req, {}, both.url, both.sendJson, both.readBody);
  assert.equal(both.result().status, 400);

  const dry = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', token: 'tok', voice: 'a.wav', dryRun: true });
  await routes.handleSendVoice(dry.req, {}, dry.url, dry.sendJson, dry.readBody);
  assert.equal(dry.result().status, 200);
  assert.equal(dry.result().payload.dryRun, true);
  assert.equal(calls.markedSent.length, 0);
  // both 请求也在过闸时记一次授权审计，dry-run 再加一次
  assert.equal(calls.audits.length, 2);
});

test('POST /api/socialV2/send-voice：非 reserved2 模式拒绝', async () => {
  const { deps } = makeDeps({ mode: 'chat' });
  const routes = createV2AdminRoutes(deps);
  const io = makeIo('POST', '/api/socialV2/send-voice', { key: 'group:1', token: 'tok', text: 'hi' });
  await routes.handleSendVoice(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 403);
  assert.match(io.result().payload.error, /仅 reserved2/);
});

test('GET /api/voice/list：AI 通道校验 key 与令牌，控制台通道返回目录', async () => {
  const { deps, dir } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const agentNoKey = makeIo('GET', '/api/voice/list');
  agentNoKey.req.headers['x-agent-token'] = 'tok';
  await routes.handleVoices(agentNoKey.req, {}, agentNoKey.url, agentNoKey.sendJson, agentNoKey.readBody);
  assert.equal(agentNoKey.result().status, 400);

  const agentOk = makeIo('GET', '/api/socialV2/voices?key=group:1&probe=1');
  agentOk.req.headers['x-agent-token'] = 'tok';
  await routes.handleVoices(agentOk.req, {}, agentOk.url, agentOk.sendJson, agentOk.readBody);
  assert.equal(agentOk.result().payload.dir, undefined);
  assert.equal(agentOk.result().payload.count, 1);

  const consoleCall = makeIo('GET', '/api/voice/list?probe=0');
  await routes.handleVoices(consoleCall.req, {}, consoleCall.url, consoleCall.sendJson, consoleCall.readBody);
  assert.equal(consoleCall.result().payload.dir, dir);
});

test('GET /api/socialV2/slang/query：按关键词过滤并附带黑话块', async () => {
  const { deps } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const io = makeIo('GET', '/api/socialV2/slang/query?key=group:1&q=%E5%85%B8');
  await routes.handleSlangQuery(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().payload.total, 1);
  assert.equal(io.result().payload.entries[0].content, '典');
  assert.equal(io.result().payload.block, '- 典：经典');
});

test('POST /api/socialV2/slang/submit：脱敏、长度与重复提交', async () => {
  const duplicate = makeDeps({ submitCandidate: () => ({ ok: true, duplicate: true }) });
  const routesDup = createV2AdminRoutes(duplicate.deps);
  const dup = makeIo('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: 'secret' });
  dup.req.headers['x-agent-token'] = 'tok';
  await routesDup.handleSlangSubmit(dup.req, {}, dup.url, dup.sendJson, dup.readBody);
  assert.equal(dup.result().payload.duplicate, true);
  assert.equal(duplicate.calls.activities.length, 0);

  const { deps, calls } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const ok = makeIo('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: '典', context: '语境' });
  ok.req.headers['x-agent-token'] = 'tok';
  await routes.handleSlangSubmit(ok.req, {}, ok.url, ok.sendJson, ok.readBody);
  assert.equal(ok.result().status, 200);
  assert.equal(calls.activities.length, 1);

  const tooLong = makeIo('POST', '/api/socialV2/slang/submit', { key: 'group:1', content: 'x'.repeat(51) });
  tooLong.req.headers['x-agent-token'] = 'tok';
  await routes.handleSlangSubmit(tooLong.req, {}, tooLong.url, tooLong.sendJson, tooLong.readBody);
  assert.equal(tooLong.result().status, 400);
});

test('POST /api/authorize/read：空令牌一律拒绝，有效令牌放行', async () => {
  const { deps } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const noToken = makeIo('POST', '/api/authorize/read', { key: 'group:1' });
  await routes.handleAuthorizeRead(noToken.req, {}, noToken.url, noToken.sendJson, noToken.readBody);
  assert.equal(noToken.result().status, 403);
  assert.match(noToken.result().payload.error, /缺少会话令牌/);

  const ok = makeIo('POST', '/api/authorize/read', { key: 'group:1', token: 'tok' });
  await routes.handleAuthorizeRead(ok.req, {}, ok.url, ok.sendJson, ok.readBody);
  assert.deepEqual(ok.result().payload, { ok: true, key: 'group:1' });
});

test('未知路径不接管', async () => {
  const { deps } = makeDeps();
  const routes = createV2AdminRoutes(deps);
  const io = makeIo('GET', '/api/status');
  assert.equal(await routes.dispatch(io.req, {}, io.url, io.sendJson, io.readBody), false);
});
