/**
 * B 站组件的可执行回归：依赖契约、未启动时的状态、只读状态路由。
 * 真实的网络同步不在这里跑（会依赖 B站 网关），这里钉住组件边界与失败姿态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBilibiliComponent } from '../src/qq/features/bilibili.js';

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-bili-'));
  const unifiedDir = path.join(dir, 'unified');
  fs.mkdirSync(unifiedDir, { recursive: true });
  const cfg = {
    biliBridge: {
      enabled: false,
      memory: { enabled: false, refreshIntervalMs: 60000 },
      dynamics: { enabled: false, groups: [], pollIntervalMs: 60000 },
      share: { enabled: false, groups: [], times: [], gapMs: 0 },
    },
    allow: { groups: [] },
    ...config,
  };
  const calls = { sent: [] };
  const deps = {
    stateDir: path.join(dir, 'state'),
    unifiedDir,
    log: () => {},
    getConfig: () => cfg,
    getMode: () => 'reserved2',
    isDshReady: () => false,
    isGatewayReady: () => false,
    sendToQQ: async (key, msg) => { calls.sent.push({ key, msg }); },
    deliverPrompt: async () => ({ ok: false }),
    sendCard: async () => ({ ok: false }),
    currentRoleHint: () => '小肥鱼',
  };
  return { dir, cfg, calls, deps, component: createBilibiliComponent(deps) };
}

test('缺少依赖时构造即失败', () => {
  assert.throws(() => createBilibiliComponent({}), /bilibili 缺少依赖/);
  const base = setup();
  const broken = { ...base.deps };
  delete broken.sendToQQ;
  assert.throws(() => createBilibiliComponent(broken), /sendToQQ/);
});

test('未启用时 start 不建任何定时器，status 仍可读', async () => {
  const { component } = setup();
  const api = await component.init({});
  api.start();
  const status = api.status();
  assert.equal(status.enabled, false);
  assert.ok(status.memory);
  assert.equal(status.dynamics.enabled, false);
  assert.equal(status.share.enabled, false);
  api.stop();
});

test('GET /api/bili/status 走组件路由表', async () => {
  const { component } = setup();
  const api = await component.init({});
  const route = component.routes.find((r) => r.method === 'GET' && r.path === '/api/bili/status');
  let body = null;
  await route.handle({}, { sendJson: (obj) => { body = obj; } });
  assert.equal(typeof body.enabled, 'boolean');
  assert.ok(Array.isArray(body.groups.allow));
  api.stop();
});

test('分享未启用时手动触发返回 400 而不是静默成功', async () => {
  const { component } = setup();
  await component.init({});
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/bili/share-now');
  let body = null;
  let status = 200;
  await route.handle({}, { sendJson: (obj, code) => { body = obj; status = code; } });
  assert.equal(body.ok, false);
  assert.equal(status, 400);
});
