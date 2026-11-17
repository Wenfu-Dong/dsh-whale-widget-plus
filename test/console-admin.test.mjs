/**
 * 控制台管理端点回归：只验证读视图、白名单归一化与配置写入，不启动 HTTP 服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConsoleAdminRoutes } from '../src/qq/features/console-admin.js';
import { normalizeOwnerQQ, normalizeReasoningEffort, REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT } from '../src/qq/config.js';
import { normalizeAllowlist } from '../src/allowlist.js';
import { atomicWriteJson, readConfigObject } from '../src/qq/json-io.js';

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-admin-'));
  const configFile = path.join(dir, 'config.json');
  atomicWriteJson(configFile, { ownerQQ: '10001', allow: { private: [10001], groups: [20001] } });
  const cfg = {
    ownerQQ: '10001',
    allow: { private: [10001], groups: [20001] },
    deny: { users: [], private: [], groups: [] },
    dsh: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' },
    security: { interceptNotify: true },
    ...(overrides.cfg ?? {}),
  };
  const state = { sessions: { 'private:10001': 'sid-owner', 'group:20001': 'sid-group' }, sessionPolicies: {} };
  const pending = new Map([
    ['group:20001', { kind: 'approval', sessionId: 'sid-group', toolName: 'shell', reason: '需要确认', approvalId: 'ap-1' }],
    ['private:10001', { kind: 'question', sessionId: 'sid-owner', questions: [{ q: '?' }] }],
  ]);
  const calls = { hardened: 0, bumped: 0, reconciled: 0 };
  const deps = {
    log: () => {},
    getConfig: () => cfg,
    state,
    pending,
    CONFIG_FILE: configFile,
    readConfigObject,
    atomicWriteJson,
    normalizeOwnerQQ,
    normalizeAllowlist,
    getSelfUserId: () => '99999',
    reconcileSessionPolicies: () => { calls.reconciled += 1; },
    fetchModelCatalog: overrides.fetchModelCatalog ?? (async () => { throw new Error('offline'); }),
    withTimeout: (promise) => promise,
    unwrap: (value) => value,
    REASONING_EFFORT_OPTIONS,
    REASONING_EFFORT_DEFAULT,
    normalizeReasoningEffort,
    bumpModelSelectionEpoch: () => { calls.bumped += 1; },
    STATE_DIR: path.join(dir, 'state'),
    getStateDirHardened: () => overrides.hardened ?? false,
    rehardenStateDir: () => { calls.hardened += 1; return true; },
    manualDirCommand: (dirPath) => `icacls "${dirPath}" /inheritance:r`,
  };
  return { deps: { ...deps, ...(overrides.deps ?? {}) }, cfg, calls, configFile, state };
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
  assert.throws(() => createConsoleAdminRoutes({}), /console-admin 缺少依赖/);
});

test('GET /api/sessions：标记管理员私聊', async () => {
  const { deps } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('GET', '/api/sessions');
  await routes.handleSessions(io.req, {}, io.url, io.sendJson, io.readBody);
  const sessions = io.result().payload.sessions;
  assert.deepEqual(sessions.find((s) => s.key === 'private:10001').owner, true);
  assert.deepEqual(sessions.find((s) => s.key === 'group:20001').owner, false);
});

test('GET /api/pending：审批与提问字段分开输出', async () => {
  const { deps } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('GET', '/api/pending');
  await routes.handlePending(io.req, {}, io.url, io.sendJson, io.readBody);
  const list = io.result().payload.pending;
  assert.equal(list.length, 2);
  const approval = list.find((x) => x.kind === 'approval');
  const question = list.find((x) => x.kind === 'question');
  assert.equal(approval.toolName, 'shell');
  assert.equal(approval.questions, undefined);
  assert.equal(question.approvalId, undefined);
  assert.deepEqual(question.questions, [{ q: '?' }]);
});

test('POST /api/whitelist：去重、剔除自身、自动补管理员并热更新', async () => {
  const { deps, cfg, configFile, calls } = makeDeps();
  cfg.ownerQQ = '10001';
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('POST', '/api/whitelist', {
    allow: { private: ['10001', '99999'], groups: ['20001', '20001', 'abc'] },
    deny: { groups: ['30001'] },
    ownerQQ: '10001',
  });
  await routes.handleWhitelist(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 200);
  assert.deepEqual(io.result().payload.allow.private, [10001]);
  assert.deepEqual(io.result().payload.allow.groups, [20001]);
  assert.deepEqual(cfg.allow, { private: [10001], groups: [20001] });
  // 未提交 users 时保留原值，不能被旧控制台清空
  assert.deepEqual(cfg.deny.users, []);
  assert.deepEqual(cfg.deny.groups, [30001]);
  assert.equal(calls.reconciled, 1);
  assert.deepEqual(readConfigObject(configFile).allow.groups, [20001]);
});

test('POST /api/whitelist：非法 ownerQQ 拒绝写盘', async () => {
  const { deps, calls } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('POST', '/api/whitelist', { allow: {}, ownerQQ: '-1' });
  await routes.handleWhitelist(io.req, {}, io.url, io.sendJson, io.readBody);
  assert.equal(io.result().status, 400);
  assert.equal(calls.reconciled, 0);
});

test('GET /api/dsh/model：目录不可用时退回内置档位', async () => {
  const { deps } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('GET', '/api/dsh/model');
  await routes.handleDshModel(io.req, {}, io.url, io.sendJson, io.readBody);
  const payload = io.result().payload;
  assert.equal(payload.catalogSource, 'fallback');
  assert.deepEqual(payload.options, REASONING_EFFORT_OPTIONS);
  assert.equal(payload.default, REASONING_EFFORT_DEFAULT);
  assert.equal(payload.globalSideEffect, true);
});

test('GET /api/dsh/model：采用 DSH 公布的档位', async () => {
  const { deps } = makeDeps({
    fetchModelCatalog: async () => ({
      groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { efforts: [{ id: 'low', name: '低' }], defaultEffort: 'low' } }] }],
    }),
  });
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('GET', '/api/dsh/model');
  await routes.handleDshModel(io.req, {}, io.url, io.sendJson, io.readBody);
  const payload = io.result().payload;
  assert.equal(payload.catalogSource, 'dsh');
  assert.deepEqual(payload.options, ['low']);
  assert.equal(payload.providerDefault, 'low');
});

test('POST /api/dsh/effort：非法值 400，合法值落盘并递增代号', async () => {
  const { deps, cfg, calls, configFile } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const bad = makeIo('POST', '/api/dsh/effort', { reasoningEffort: 'turbo' });
  await routes.handleDshModel(bad.req, {}, bad.url, bad.sendJson, bad.readBody);
  assert.equal(bad.result().status, 400);

  const ok = makeIo('POST', '/api/dsh/effort', { reasoningEffort: 'high' });
  await routes.handleDshModel(ok.req, {}, ok.url, ok.sendJson, ok.readBody);
  assert.equal(ok.result().payload.reasoningEffort, 'high');
  assert.equal(cfg.dsh.reasoningEffort, 'high');
  assert.equal(readConfigObject(configFile).dsh.reasoningEffort, 'high');
  assert.equal(calls.bumped, 1);
});

test('GET/POST /api/security：reharden 走依赖，interceptNotify 写盘', async () => {
  const { deps, cfg, calls } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const get = makeIo('GET', '/api/security');
  await routes.handleSecurity(get.req, {}, get.url, get.sendJson, get.readBody);
  assert.equal(get.result().payload.stateDir.hardened, false);
  assert.match(get.result().payload.stateDir.manualCommand, /icacls/);

  const reharden = makeIo('POST', '/api/security', { rehardenStateDir: true });
  await routes.handleSecurity(reharden.req, {}, reharden.url, reharden.sendJson, reharden.readBody);
  assert.equal(reharden.result().payload.hardened, true);
  assert.equal(calls.hardened, 1);

  const update = makeIo('POST', '/api/security', { interceptNotify: false });
  await routes.handleSecurity(update.req, {}, update.url, update.sendJson, update.readBody);
  assert.equal(update.result().payload.security.interceptNotify, false);
  assert.equal(cfg.security.interceptNotify, false);
});

test('未知路径不接管', async () => {
  const { deps } = makeDeps();
  const routes = createConsoleAdminRoutes(deps);
  const io = makeIo('GET', '/api/status');
  assert.equal(await routes.dispatch(io.req, {}, io.url, io.sendJson, io.readBody), false);
});
