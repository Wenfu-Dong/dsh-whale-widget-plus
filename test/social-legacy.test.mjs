/**
 * 一代社交 / 测试发送 / 后台提醒路由的边界回归。
 * 只验证 HTTP 形状、白名单闸门与配置净化，真实发送与 DSH 投递全部用桩替代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSocialLegacyRoutes } from '../src/qq/features/social-legacy.js';
import { SENSITIVE_RE } from '../src/sensitive.js';
import { atomicWriteJson, readConfigObject } from '../src/qq/json-io.js';

function makeDeps(overrides = {}) {
  const dir = overrides.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'social-legacy-'));
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) atomicWriteJson(configFile, { social: { triggerProbability: 0.5 } });
  const cfg = { ownerQQ: '10001', social: { triggerProbability: 0.5 }, ...(overrides.cfg ?? {}) };
  const state = overrides.state ?? { sessions: {}, sessionPolicies: {} };
  const social = {
    states: new Map(),
    recentMessages: new Map(),
    pendingSummaries: new Map(),
    silentTurns: new Map(),
  };
  const calls = { sent: [], flushed: [], active: [], left: [], delivered: [], activities: [] };
  const deps = {
    log: () => {},
    getConfig: () => cfg,
    getMode: () => overrides.mode ?? 'chat',
    modeAllowed: overrides.modeAllowed ?? (() => true),
    allowed: overrides.allowed ?? (() => true),
    onebotSend: async (...args) => { calls.sent.push(args); return { message_id: 42 }; },
    withTimeout: (promise) => promise,
    SEND_TIMEOUT_MS: 1000,
    SENSITIVE_RE,
    CONFIG_FILE: configFile,
    readConfigObject,
    atomicWriteJson,
    social,
    state,
    enterActive: (key) => calls.active.push(key),
    leaveActive: (key) => calls.left.push(key),
    flushSummaries: async (key) => { calls.flushed.push(key); },
    getDshReady: () => overrides.dshReady ?? true,
    readRoleState: () => ({ role: '测试角色' }),
    getSocialV2State: () => ({ agentToken: 'token-1' }),
    ensureSession: async () => 'sid-1',
    deliverPrompt: async (key) => { calls.delivered.push(key); return { ok: true }; },
    appendActivity: (line) => calls.activities.push(line),
  };
  return { deps: { ...deps, ...(overrides.deps ?? {}) }, cfg, state, social, calls, configFile, dir };
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
  assert.throws(() => createSocialLegacyRoutes({}), /social-legacy 缺少依赖/);
  const { deps } = makeDeps();
  const broken = { ...deps };
  delete broken.onebotSend;
  assert.throws(() => createSocialLegacyRoutes(broken), /onebotSend/);
});

test('POST /api/test-send：白名单外 403，命中时不发送', async () => {
  const { deps, calls } = makeDeps({ allowed: () => false });
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('POST', '/api/test-send', { kind: 'group', id: 123, message: 'hi' });
  assert.equal(await routes.handleTestSend(io.req, {}, io.url, io.sendJson, io.readBody), true);
  assert.equal(io.result().status, 403);
  assert.match(io.result().payload.error, /不在白名单/);
  assert.equal(calls.sent.length, 0);
});

test('POST /api/test-send：敏感信息与空消息分别拒绝', async () => {
  const { deps, calls } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const empty = makeIo('POST', '/api/test-send', { kind: 'group', id: 123, message: '  ' });
  await routes.handleTestSend(empty.req, {}, empty.url, empty.sendJson, empty.readBody);
  assert.equal(empty.result().status, 400);

  const risky = makeIo('POST', '/api/test-send', { kind: 'group', id: 123, message: 'token=abcdefghijklmnop' });
  await routes.handleTestSend(risky.req, {}, risky.url, risky.sendJson, risky.readBody);
  assert.equal(risky.result().status, 403);
  assert.equal(calls.sent.length, 0);
});

test('POST /api/test-send：成功路径走 onebotSend', async () => {
  const { deps, calls } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('POST', '/api/test-send', { kind: 'private', id: 10001, message: '你好' });
  await routes.handleTestSend(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 200);
  assert.equal(io.result().payload.message_id, 42);
  assert.deepEqual(calls.sent[0], ['private', 10001, '你好']);
});

test('POST /api/social/state：active/idle 分发，非法 phase 400', async () => {
  const { deps, calls } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const active = makeIo('POST', '/api/social/state', { key: 'group:1', phase: 'active' });
  await routes.handleSocialState(active.req, {}, active.url, active.sendJson, active.readBody);
  assert.equal(active.result().payload.phase, 'active');
  assert.deepEqual(calls.active, ['group:1']);

  const idle = makeIo('POST', '/api/social/state', { key: 'group:1', phase: 'idle' });
  await routes.handleSocialState(idle.req, {}, idle.url, idle.sendJson, idle.readBody);
  assert.deepEqual(calls.left, ['group:1']);

  const bad = makeIo('POST', '/api/social/state', { key: 'group:1', phase: 'x' });
  await routes.handleSocialState(bad.req, {}, bad.url, bad.sendJson, bad.readBody);
  assert.equal(bad.result().status, 400);
});

test('GET /api/social：汇总各会话状态', async () => {
  const { deps, social } = makeDeps();
  social.states.set('group:1', { phase: 'active' });
  social.recentMessages.set('group:2', []);
  social.pendingSummaries.set('group:1', { items: [1, 2] });
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('GET', '/api/social');
  assert.equal(await routes.handleSocialConfig(io.req, {}, io.url, io.sendJson, io.readBody), true);
  const payload = io.result().payload;
  assert.equal(payload.pendingSummaries['group:1'], 2);
  assert.equal(payload.states['group:1'].phase, 'active');
  assert.equal(payload.states['group:2'].phase, 'idle');
});

test('POST /api/social：概率/区间/上下文窗口净化并落盘', async () => {
  const { deps, cfg, configFile } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('POST', '/api/social', {
    triggerProbability: 5,
    contextWindow: 0,
    burstIntervalMinMs: -1,
    activeCheckMinMs: 900,
    activeCheckMaxMs: 100,
    mustReplyKeywords: ['在吗'],
  });
  assert.equal(await routes.handleSocialConfig(io.req, {}, io.url, io.sendJson, io.readBody), true);
  assert.equal(io.result().status, 200);
  assert.equal(cfg.social.triggerProbability, 1);
  assert.equal(cfg.social.contextWindow, 1);
  assert.equal(cfg.social.burstIntervalMinMs, 0);
  assert.equal(cfg.social.activeCheckMinMs, 100);
  assert.equal(cfg.social.activeCheckMaxMs, 900);
  assert.deepEqual(cfg.social.mustReplyKeywords, ['在吗']);
  assert.deepEqual(readConfigObject(configFile).social.mustReplyKeywords, ['在吗']);
});

test('POST /api/social/flush：按 key 触发摘要落盘', async () => {
  const { deps, calls } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('POST', '/api/social/flush', { key: 'group:9' });
  await routes.handleSocialFlush(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.deepEqual(calls.flushed, ['group:9']);
});

test('POST /api/console/notify-ai：DSH 未就绪 503；就绪时投递并登记静默名额', async () => {
  const noDsh = makeDeps({ dshReady: false });
  const routesNoDsh = createSocialLegacyRoutes(noDsh.deps);
  const blocked = makeIo('POST', '/api/console/notify-ai', { key: 'group:1', message: '提醒' });
  await routesNoDsh.handleConsoleNotifyAi(blocked.req, {}, blocked.url, blocked.sendJson, blocked.readBody);
  assert.equal(blocked.result().status, 503);

  const ok = makeDeps();
  const routes = createSocialLegacyRoutes(ok.deps);
  const io = makeIo('POST', '/api/console/notify-ai', { key: 'group:1', message: '提醒' });
  await routes.handleConsoleNotifyAi(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 200);
  assert.deepEqual(ok.calls.delivered, ['group:1']);
  assert.equal(ok.social.silentTurns.get('sid-1').length, 1);
  assert.equal(ok.calls.activities.length, 1);
});

test('未知路径不接管', async () => {
  const { deps } = makeDeps();
  const routes = createSocialLegacyRoutes(deps);
  const io = makeIo('GET', '/api/status');
  assert.equal(await routes.dispatch(io.req, {}, io.url, io.sendJson, io.readBody), false);
});
