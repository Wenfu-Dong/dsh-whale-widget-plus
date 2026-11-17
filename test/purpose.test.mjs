/**
 * 目的机制组件的可执行回归：依赖契约、状态文件生命周期、载体同步、
 * 模式闸门、控制台状态路由。
 *
 * 这里不测「模型回合里说了什么」——那是引擎与提示词的事；这里钉住的是
 * 组件边界：谁拥有状态文件、什么时候不出发、外部改了状态能否重新载入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPurposeComponent } from '../src/qq/features/purpose.js';

function setup({ mode = 'reserved2', config, deliver } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-purpose-'));
  const stateFile = path.join(dir, 'purpose-outreach.json');
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config ?? { purpose: { enabled: true, ownerUin: '10001' } }));
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const calls = { delivered: [], ticks: 0 };
  const deps = {
    log: () => { calls.ticks += 1; },
    getConfig: () => cfg,
    getMode: () => mode,
    isDshReady: () => true,
    allowed: () => true,
    getSocialV2State: () => ({ agentToken: '', lastIncomingAt: 0, lastAiReplyAt: 0, wakeTimes: [] }),
    getConversations: () => new Map(),
    isConversationBusy: () => false,
    flushSocialV2State: () => {},
    isSocialPaused: () => false,
    readRoleName: () => '小肥鱼',
    readBiliEntries: () => [],
    readMemoryRecords: () => [],
    personaText: () => '一个爱折腾的人格',
    selfIdentityText: () => '',
    adminPromptLine: () => '',
    adminIdentity: () => ({ displayName: '主人' }),
    biliBrief: () => '',
    memoryCardText: () => '',
    tokenGuardWakeBlock: () => null,
    friendCheck: async () => ({ checked: true, ok: true }),
    deliverPrompt: async (key, prompt) => { calls.delivered.push({ key, prompt }); return deliver ? deliver(key, prompt) : { ok: false, error: '测试中不投递' }; },
    resolveStateFile: () => stateFile,
    defaultStateDir: dir,
    configFile,
  };
  return { dir, stateFile, configFile, cfg, calls, deps, component: createPurposeComponent(deps) };
}

test('缺少依赖时构造即失败，而不是运行时 undefined', () => {
  assert.throws(() => createPurposeComponent({}), /purpose 缺少依赖/);
  const base = setup();
  const broken = { ...base.deps };
  delete broken.deliverPrompt;
  assert.throws(() => createPurposeComponent(broken), /deliverPrompt/);
});

test('init 会在角色目录创建并落盘状态文件', async () => {
  const { stateFile, component } = setup();
  const api = await component.init({});
  assert.equal(fs.existsSync(stateFile), true);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok('nextFireAt' in saved);
  assert.ok(Array.isArray(saved.history));
  api.stop();
});

test('非 reserved2 模式不出发（tick 直接返回）', async () => {
  const { calls, component } = setup({ mode: 'initial' });
  const api = await component.init({});
  await api.tick();
  assert.equal(calls.delivered.length, 0);
  api.stop();
});

test('状态文件被外部（桌宠载体）改写后会重新载入', async () => {
  const { stateFile, component } = setup();
  const api = await component.init({});
  const external = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  external.lastOutcome = 'sent';
  external.history = [{ at: Date.now(), text: '桌宠发的', outcome: 'sent' }];
  fs.writeFileSync(stateFile, JSON.stringify(external));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(stateFile, future, future);
  assert.equal(api.reloadIfChanged(), true);
  assert.equal(api.summarize().lastOutcome, 'sent');
  api.stop();
});

test('status 路由返回管理端状态，智能体不可见', async () => {
  const { component } = setup();
  const api = await component.init({});
  const route = component.routes.find((r) => r.method === 'GET' && r.path === '/api/purpose/status');
  let body = null;
  await route.handle({}, { sendJson: (obj) => { body = obj; } });
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true);
  assert.equal(body.mode, 'reserved2');
  assert.equal(body.ownerUin, '10001');
  assert.ok(body.state);
  api.stop();
});

test('stop 可重复调用且不会抛错', async () => {
  const { component } = setup();
  const api = await component.init({});
  api.stop();
  api.stop();
});
