/**
 * 黑话库组件的可执行回归：只读降级、人工增删改、AI 提交限频、
 * 学习会话（提取 → 收集 turn → 入库）以及控制台路由。
 *
 * 钉住的坑：
 *  - 库文件坏了绝不能回写成空库；
 *  - AI 重复提交只累计次数，不重复建词条；
 *  - 学习会话的 turn 只能由学习会话自己的 collector 消费，不能污染 QQ 主链路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSlangComponent } from '../src/qq/features/slang.js';

function setup({ store, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-slang-'));
  const stateFile = path.join(dir, 'slang.json');
  const sessionFile = path.join(dir, 'slang-session.json');
  const configFile = path.join(dir, 'config.json');
  if (store !== undefined) fs.writeFileSync(stateFile, typeof store === 'string' ? store : JSON.stringify(store));
  fs.writeFileSync(configFile, JSON.stringify(config ?? { agentPreset: 'safe', slang: { enabled: true, extractMinMessages: 10, injectMax: 8, autoResearch: false } }));
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  cfg.slang = cfg.slang ?? { enabled: true, extractMinMessages: 10, injectMax: 8, autoResearch: false };

  const calls = { prompted: [], followed: [] };
  const api = {
    events: { follow: (id) => calls.followed.push(id) },
    workspace: { create: async () => ({ result: { ok: true, value: { created: false, workspace: { workspaceId: 'ws1' } } } }) },
    sessions: {
      create: async () => ({ result: { ok: true, value: { sessionId: 'learner-1' } } }),
      prompt: async () => { calls.prompted.push(1); return { result: { ok: true } }; },
    },
  };
  let turnText = '';
  const createTurnCollector = () => ({
    push(event) {
      if (event.type === 'delta') turnText += event.text ?? '';
      if (event.type === 'turn/end') return { reason: { kind: 'completed' }, text: turnText };
      return null;
    },
  });
  const deps = {
    stateFile,
    sessionFile,
    configFile,
    log: () => {},
    getConfig: () => cfg,
    isDshReady: () => true,
    getApi: () => api,
    resolvePresetName: () => 'safe',
    ensureChatModel: async () => 'ok',
    learnerBudgetBlock: () => false,
    createTurnCollector,
  };
  const component = createSlangComponent(deps);
  return { dir, stateFile, sessionFile, configFile, cfg, calls, deps, component };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('库文件损坏时降级只读，人工新增不会覆盖原文件', async () => {
  const broken = '{ 这不是 json';
  const { stateFile, component } = setup({ store: broken });
  const api = await component.init({});
  assert.equal(api.writable(), false);
  const before = fs.readFileSync(stateFile, 'utf8');
  api.addManual({ content: '绷不住了', meaning: '忍不住笑' });
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('人工新增、确认与删除都会落盘', async () => {
  const { stateFile, component } = setup({ store: [] });
  const api = await component.init({});
  const entry = api.addManual({ content: '绷不住了', status: 'candidate' });
  assert.equal(api.list().length, 1);
  assert.throws(() => api.confirm(entry.id), /请先填写含义/);
  api.confirm(entry.id, { meaning: '忍不住笑' });
  assert.equal(api.confirmedList()[0].content, '绷不住了');
  api.remove(entry.id);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).length, 0);
});

test('批量确认跳过没有含义的候选，批量拒绝生效', async () => {
  const { component } = setup({ store: [] });
  const api = await component.init({});
  const withMeaning = api.addManual({ content: 'yyds', meaning: '永远的神', status: 'candidate' });
  const without = api.addManual({ content: 'xswl', status: 'candidate' });
  const result = api.batchConfirm([withMeaning.id, without.id]);
  assert.equal(result.confirmedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(api.batchReject([without.id]), 1);
});

test('AI 提交：新词入候选，重复提交累计次数，拒绝词不再收录', async () => {
  const { component } = setup({ store: [] });
  const api = await component.init({});
  const first = api.submitCandidate({ key: 'group:1', content: '绝绝子' });
  assert.equal(first.ok, true);
  assert.equal(first.entry.count, 1);
  const second = api.submitCandidate({ key: 'group:1', content: '绝绝子' });
  assert.equal(second.duplicate, true);
  assert.equal(second.entry.count, 2);

  const rejected = api.addManual({ content: '烂梗', meaning: '无意义', status: 'candidate' });
  api.reject(rejected.id);
  const retry = api.submitCandidate({ key: 'group:3', content: '烂梗' });
  assert.equal(retry.ok, false);
  assert.equal(retry.statusCode, 403);
});

test('AI 提交限频：每分钟最多 2 次', async () => {
  const { component } = setup({ store: [] });
  const api = await component.init({});
  assert.equal(api.submitCandidate({ key: 'group:2', content: 'a' }).ok, true);
  assert.equal(api.submitCandidate({ key: 'group:2', content: 'b' }).ok, true);
  const third = api.submitCandidate({ key: 'group:2', content: 'c' });
  assert.equal(third.ok, false);
  assert.equal(third.statusCode, 429);
});

test('学习窗口忽略命令与角色控制语；关闭后不再收集', async () => {
  const { cfg, deps, component } = setup({ store: [] });
  const api = await component.init({});
  api.feedWindow('group:1', '甲', '/help');
  api.feedWindow('group:1', '甲', '进入角色扮演');
  assert.equal(api.hasWindow('group:1'), false);
  api.feedWindow('group:1', '甲', '这波操作太抽象了');
  assert.equal(api.hasWindow('group:1'), true);
  api.resetKey('group:1');
  cfg.slang.enabled = false;
  api.feedWindow('group:1', '甲', '再来一句');
  assert.equal(api.hasWindow('group:1'), false);
  assert.equal(deps.getConfig().slang.enabled, false);
});

test('学习会话：提取输出经 turn 收集后写入候选库', async () => {
  const { calls, deps, component } = setup({ store: [] });
  deps.getConfig().slang.extractMinMessages = 1;
  const api = await component.init({});
  api.feedWindow('group:9', '甲', '这也太抽象了吧');
  for (let i = 0; i < 200 && calls.prompted.length === 0; i += 1) await sleep(5);
  assert.equal(calls.prompted.length, 1);
  assert.equal(calls.followed[0], 'learner-1');
  api.collectLearnerEvent('learner-1', { type: 'turn/start' });
  api.collectLearnerEvent('learner-1', { type: 'delta', text: '[{"content":"抽象","source_id":"1"}]' });
  api.collectLearnerEvent('learner-1', { type: 'turn/end' });
  for (let i = 0; i < 200 && !api.findByContent('抽象'); i += 1) await sleep(5);
  assert.equal(api.findByContent('抽象')?.status, 'candidate');
});

test('collectLearnerEvent 只接管本组件创建的会话', async () => {
  const { component } = setup({ store: [] });
  const api = await component.init({});
  assert.equal(api.ownsSession('qq-session'), false);
  assert.equal(api.collectLearnerEvent('qq-session', { type: 'turn/start' }), false);
});

test('控制台路由：GET/POST/PATCH 走组件路由表', async () => {
  const { component } = setup({ store: [] });
  await component.init({});
  const routes = component.routes;
  const find = (method, pathname) => routes.find((r) => r.method === method && (r.path === pathname || (r.pattern && r.pattern.test(pathname))));

  const getRoute = find('GET', '/api/slang');
  let got = null;
  const getIo = { url: new URL('http://x/api/slang?status=candidate'), sendJson: (obj) => { got = obj; } };
  await getRoute.handle({}, getIo);
  assert.equal(got.writable, true);
  assert.ok(Array.isArray(got.entries));

  const postRoute = find('POST', '/api/slang');
  let created = null;
  await postRoute.handle({}, { readBody: async () => ({ content: '绷不住了', meaning: '忍不住笑' }), sendJson: (obj) => { created = obj; } });
  assert.equal(created.ok, true);

  const patchRoute = find('PATCH', `/api/slang/${created.entry.id}`);
  let patched = null;
  await patchRoute.handle({}, { params: [created.entry.id], readBody: async () => ({ meaning: '忍不住笑出声' }), sendJson: (obj) => { patched = obj; } });
  assert.equal(patched.entry.meaning, '忍不住笑出声');
});

test('更新配置会写回 config.json 并同步运行时配置', async () => {
  const { configFile, deps, component } = setup({ store: [] });
  const api = await component.init({});
  const saved = api.updateConfig({ injectMax: 12, inferenceThresholds: '2,4, 8' });
  assert.equal(saved.injectMax, 12);
  const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(onDisk.slang.injectMax, 12);
  assert.deepEqual(onDisk.slang.inferenceThresholds, [2, 4, 8]);
  assert.equal(deps.getConfig().slang.injectMax, 12);
});
