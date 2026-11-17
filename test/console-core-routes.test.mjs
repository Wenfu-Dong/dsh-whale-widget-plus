/**
 * 控制台核心路由（console-core-routes）边界回归：状态视图分流、模式切换副作用、
 * 访问令牌校验与落盘、审计尾部读取。路由体从 bridge 原样搬出，这里只验证行为形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createConsoleCoreRoutes } from '../src/qq/features/console-core-routes.js';

function makeDeps(overrides = {}) {
  const writes = [];
  const texts = [];
  const logs = [];
  const calls = [];
  let mode = 'chat';
  let preset = '';
  let token = 'console-token-value-123';
  const cfg = { dsh: { baseUrl: 'http://dsh' }, ownerQQ: '10001', allow: { groups: ['1'], private: [] }, purpose: {} };
  const conversations = new Map();
  const deps = {
    log: (m) => logs.push(String(m)),
    getConfig: () => cfg,
    getMode: () => mode,
    setMode: (v) => { mode = v; },
    getClosedAgentPreset: () => preset,
    setClosedAgentPreset: (v) => { preset = v; },
    getConsoleToken: () => token,
    setConsoleToken: (v) => { token = v; },
    VALID_MODES: ['chat', 'closed-agent', 'reserved', 'reserved2'],
    normalizeModeInput: (v) => (v === 'simulation' ? 'reserved2' : (['chat', 'closed-agent', 'reserved', 'reserved2'].includes(v) ? v : null)),
    readJsonSafe: () => ({ closedAgentPreset: 'old-preset' }),
    atomicWriteJson: (file, obj) => { writes.push({ file, obj }); return true; },
    atomicWriteText: (file, text) => { texts.push({ file, text }); return true; },
    CONFIG_FILE: 'config.json',
    STATE_DIR: 'state',
    MODE_FILE: 'state/mode.json',
    CONSOLE_TOKEN_FILE: 'state/console-token',
    readConfigObject: () => ({ consoleToken: 'old' }),
    crypto: { randomBytes: () => ({ toString: () => 'a'.repeat(48) }) },
    readRoleState: () => ({ role: 'role-a', mode: 'active' }),
    getDshReady: () => true,
    ROOT: 'root',
    ownerAudit: { readTail: (n) => [{ n }], health: { ok: true }, path: 'audit.log' },
    purpose: { summarize: () => ({ total: 2 }) },
    closureConfigV2: () => ({ enabled: true }),
    assessClosureV2: () => ({ verdict: 'natural', score: 0.9, reasons: ['x'] }),
    getSocialV2State: (key) => conversations.get(key),
    closureStatus: (record) => ({ closedAt: record.at }),
    snowlumaHealthSnapshot: () => ({ good: true }),
    readActivityTail: (n) => [{ n }],
    socialV2: { paused: false, conversations },
    api: { settings: { update: async () => ({ ok: true }) } },
    unwrap: (result) => { if (result && result.ok === false) throw new Error('unwrap'); return result; },
    cleanupSocialForModeChange: () => calls.push('cleanupSocial'),
    clearAllSocialV2Timers: () => calls.push('clearV2Timers'),
    drainAllPromptQueues: () => calls.push('drainQueues'),
    reconcileSessionPolicies: () => calls.push('reconcile'),
    setupSleepTimerV2: (key) => calls.push(`sleep:${key}`),
    scheduleProactiveCheckV2: (key) => calls.push(`proactive:${key}`),
    ...overrides,
  };
  return { deps, writes, texts, logs, calls, cfg, conversations, getMode: () => mode, getPreset: () => preset, getToken: () => token };
}

function fakeReq(method, headers = {}) {
  return { method, headers };
}

function makeRes() {
  const out = {};
  const sendJson = (obj, status = 200) => { out.body = obj; out.status = status; };
  return { out, sendJson };
}

const url = (pathname, search = '') => ({ pathname, searchParams: new URLSearchParams(search) });
const readBody = (obj) => async () => obj;

test('缺少依赖时构造即失败', () => {
  assert.throws(() => createConsoleCoreRoutes({}), /console-core-routes 缺少依赖/);
});

test('owner-audit：limit 夹在 1..200，返回尾部与健康度', async () => {
  const { deps } = makeDeps();
  const routes = createConsoleCoreRoutes(deps);
  const { out, sendJson } = makeRes();

  assert.equal(routes.handleOwnerAudit(fakeReq('GET'), null, url('/api/owner-audit', 'limit=999'), sendJson), true);
  assert.equal(out.body.entries[0].n, 200);
  assert.equal(out.body.path, 'audit.log');

  assert.equal(routes.handleOwnerAudit(fakeReq('POST'), null, url('/api/owner-audit'), sendJson), false);
});

test('status：智能体调用只给受限字段，管理端给完整对象与收尾卡片', () => {
  const { deps, conversations } = makeDeps();
  conversations.set('group:1', { closure: { at: 100 } });
  conversations.set('group:2', { closure: { at: 300 } });
  const routes = createConsoleCoreRoutes(deps);

  const agentRes = makeRes();
  routes.handleStatus(fakeReq('GET', { 'x-agent-call': '1' }), null, url('/api/status'), agentRes.sendJson);
  assert.equal(agentRes.out.body.mode, 'chat');
  assert.equal(agentRes.out.body.role, 'role-a');
  assert.equal(agentRes.out.body.ownerQQ, undefined, '智能体视图不能带 ownerQQ');
  assert.equal(agentRes.out.body.activity, undefined, '智能体视图不能带全局收发摘要');

  const adminRes = makeRes();
  routes.handleStatus(fakeReq('GET'), null, url('/api/status'), adminRes.sendJson);
  const body = adminRes.out.body;
  assert.equal(body.ownerQQ, '10001');
  assert.equal(body.closedAgentPreset, '');
  assert.deepEqual(body.purpose, { enabled: true, total: 2 });
  assert.equal(body.closure.active.key, 'group:2', '应选最近一次收尾');
  assert.equal(body.closure.active.verdict, 'natural');
  assert.deepEqual(body.closure.recentlyClosed.map((x) => x.key), ['group:2', 'group:1']);
  assert.equal(body.activity[0].n, 100);
});

test('mode：写入模式文件、保留/清空 preset、离开仿真模式清理定时器', async () => {
  const { deps, writes, calls, getMode, getPreset } = makeDeps();
  const routes = createConsoleCoreRoutes(deps);
  const { out, sendJson } = makeRes();

  assert.equal(await routes.handleMode(fakeReq('POST'), null, url('/api/mode'), sendJson, readBody({ mode: 'simulation' })), true);
  assert.equal(out.body.mode, 'reserved2');
  assert.equal(out.body.dshSynced, true);
  assert.equal(writes[0].file, 'state/mode.json');
  assert.equal(writes[0].obj.mode, 'reserved2');
  assert.equal(writes[0].obj.closedAgentPreset, 'old-preset', '未传 preset 时保留原值');
  assert.equal(getMode(), 'reserved2');
  assert.ok(calls.includes('reconcile'));

  // 显式清空 preset（空串也要生效）
  await routes.handleMode(fakeReq('POST'), null, url('/api/mode'), sendJson, readBody({ mode: 'chat', closedAgentPreset: '' }));
  assert.equal(getPreset(), '');

  // 离开 reserved/reserved2 才清理
  const deps2 = makeDeps({
    getMode: () => 'reserved2',
    socialV2: { paused: false, conversations: new Map([['group:1', {}]]) },
  });
  const routes2 = createConsoleCoreRoutes(deps2.deps);
  await routes2.handleMode(fakeReq('POST'), null, url('/api/mode'), makeRes().sendJson, readBody({ mode: 'chat' }));
  assert.ok(deps2.calls.includes('clearV2Timers'));
  assert.ok(deps2.calls.includes('drainQueues'));

  const deps3 = makeDeps({ getMode: () => 'reserved' });
  const routes3 = createConsoleCoreRoutes(deps3.deps);
  await routes3.handleMode(fakeReq('POST'), null, url('/api/mode'), makeRes().sendJson, readBody({ mode: 'chat' }));
  assert.ok(deps3.calls.includes('cleanupSocial'));
});

test('mode：非法模式 400；进入 reserved2 重建每个会话的定时器；DSH 写穿失败只记日志', async () => {
  const { deps, calls } = makeDeps({
    api: { settings: { update: async () => { throw new Error('dsh down'); } } },
    socialV2: { paused: false, conversations: new Map([['group:1', {}], ['private:2', {}]]) },
  });
  const routes = createConsoleCoreRoutes(deps);

  const bad = makeRes();
  await routes.handleMode(fakeReq('POST'), null, url('/api/mode'), bad.sendJson, readBody({ mode: 'nope' }));
  assert.equal(bad.out.status, 400);

  const ok = makeRes();
  await routes.handleMode(fakeReq('POST'), null, url('/api/mode'), ok.sendJson, readBody({ mode: 'reserved2' }));
  assert.equal(ok.out.body.dshSynced, false);
  assert.ok(calls.includes('sleep:group:1'));
  assert.ok(calls.includes('proactive:private:2'));
});

test('console token：空值随机生成、长度/字符校验、手动值写 config 并落 state', async () => {
  const { deps, writes, texts, getToken, cfg } = makeDeps();
  const routes = createConsoleCoreRoutes(deps);

  const generated = makeRes();
  await routes.handleConsoleToken(fakeReq('POST'), null, url('/api/console/token'), generated.sendJson, readBody({ token: '' }));
  assert.equal(generated.out.body.generated, true);
  assert.equal(generated.out.body.token.length, 48);
  assert.equal(writes[0].obj.consoleToken, '', '随机令牌要清空 config 里的手动值');
  assert.equal(texts[0].file, 'state/console-token');
  assert.equal(getToken(), 'a'.repeat(48));

  for (const [token, error] of [['short', '至少需要 16 位'], ['x'.repeat(129), '不能超过 128 位'], ['bad token with space', '只能包含字母']]) {
    const res = makeRes();
    await routes.handleConsoleToken(fakeReq('POST'), null, url('/api/console/token'), res.sendJson, readBody({ token }));
    assert.equal(res.out.status, 400);
    assert.ok(res.out.body.error.includes(error), `${token} 应命中 ${error}`);
  }

  const manual = makeRes();
  await routes.handleConsoleToken(fakeReq('POST'), null, url('/api/console/token'), manual.sendJson, readBody({ token: 'manual_token-123456' }));
  assert.equal(manual.out.body.generated, false);
  assert.equal(cfg.consoleToken, 'manual_token-123456');
  assert.equal(getToken(), 'manual_token-123456');
});
