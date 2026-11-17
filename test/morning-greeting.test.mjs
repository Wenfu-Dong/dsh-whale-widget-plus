/**
 * 早安问候组件的可执行回归：白名单、DSH 离线重试、当日去重、试发接口。
 *
 * 这是「功能搬出 main() 但行为不变」的验收用例：拆完之后它只依赖注入的
 * deliverPrompt / sendToQQ / 在线状态，测试可以完整跑一遍真实分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMorningGreetingComponent } from '../src/qq/features/morning-greeting.js';
import { localDateKey } from '../src/greeting-schedule.js';

const UIN = '12345';

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-greeting-'));
  const configFile = path.join(dir, 'config.json');
  const cfg = {
    ownerQQ: null,
    greetings: { enabled: true, morning: { time: '08:00', uin: UIN, name: '小肥鱼' } },
  };
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const calls = { deliver: [], send: [] };
  const deps = {
    stateDir: dir,
    configFile,
    log: () => {},
    getConfig: () => cfg,
    allowed: (kind, id) => String(id) === UIN,
    deliverPrompt: async (key, text) => { calls.deliver.push({ key, text }); },
    sendToQQ: async (key, text) => { calls.send.push({ key, text }); },
    isDshReady: () => true,
    getMode: () => 'chat',
    socialV2State: () => null,
    getBot: () => ({ raw: async () => [{ user_id: UIN }] }),
    withTimeout: (p) => p,
    ...overrides,
  };
  return { dir, configFile, cfg, calls, deps };
}

test('发送成功后写入当日标记，同一天第二次不再投递', async () => {
  const { deps, calls } = setup();
  const api = createMorningGreetingComponent(deps);
  const ctx = { provide() {}, get() { throw new Error('n/a'); } };
  const { fire } = await api.init(ctx);

  assert.deepEqual(await fire(), { ok: true });
  assert.equal(calls.deliver.length, 1);
  assert.equal(calls.deliver[0].key, `private:${UIN}`);

  const state = JSON.parse(fs.readFileSync(path.join(deps.stateDir, 'greetings.json'), 'utf8'));
  assert.equal(state.lastMorningDate, localDateKey());
  assert.equal(state.lastMorningOk, true);

  assert.deepEqual(await fire(), { ok: true, reason: '已发过' });
  assert.equal(calls.deliver.length, 1);
});

test('不在白名单时明确拒绝，不投递', async () => {
  const { deps, calls } = setup({ allowed: () => false });
  const api = createMorningGreetingComponent(deps);
  const { fire } = await api.init({});
  assert.deepEqual(await fire(), { ok: false, reason: '不在白名单' });
  assert.equal(calls.deliver.length, 0);
});

test('DSH 离线时标记可重试，而不是丢掉当天', async () => {
  const { deps, calls } = setup({ isDshReady: () => false });
  const api = createMorningGreetingComponent(deps);
  const { fire } = await api.init({});
  assert.deepEqual(await fire(), { ok: false, retry: true, reason: 'DSH 离线' });
  assert.equal(calls.deliver.length, 0);
});

test('目标不是好友时给管理员发一次告警，并当天不再重试', async () => {
  const { deps, calls } = setup({
    getBot: () => ({ raw: async () => [{ user_id: '99999' }] }),
  });
  deps.getConfig().ownerQQ = '66666';
  const api = createMorningGreetingComponent(deps);
  const { fire } = await api.init({});

  const result = await fire();
  assert.equal(result.ok, false);
  assert.match(result.reason, /不在机器人好友列表/);
  assert.equal(calls.send.length, 1);
  assert.match(calls.send[0].key, /^private:66666$/);
  assert.equal(calls.deliver.length, 0);

  await fire();
  assert.equal(calls.send.length, 1); // 当天只告警一次
});

test('POST /api/greeting/test：白名单外的临时目标被拒绝', async () => {
  const { deps } = setup();
  const api = createMorningGreetingComponent(deps);
  await api.init({});
  const route = api.routes[0];
  const sent = [];
  await route.handle({}, {
    readBody: async () => ({ uin: '77777' }),
    sendJson: (obj, status) => sent.push({ obj, status }),
  });
  assert.equal(sent[0].status, 400);
  assert.match(sent[0].obj.error, /不在私聊白名单/);
});

test('POST /api/greeting/test：试发成功且不占用当日名额', async () => {
  const { deps, calls } = setup();
  const api = createMorningGreetingComponent(deps);
  await api.init({});
  const sent = [];
  await api.routes[0].handle({}, {
    readBody: async () => ({ uin: UIN }),
    sendJson: (obj, status) => sent.push({ obj, status }),
  });
  assert.equal(sent[0].status, undefined);
  assert.equal(sent[0].obj.ok, true);
  assert.match(sent[0].obj.message, /已投递早安问候/);
  assert.equal(calls.deliver.length, 1);

  const state = JSON.parse(fs.readFileSync(path.join(deps.stateDir, 'greetings.json'), 'utf8'));
  assert.equal(state.lastMorningDate, undefined);
  assert.equal(state.lastManualOk, true);
});

test('缺依赖时构造即报错，错误信息指名缺哪个', () => {
  const { deps } = setup();
  delete deps.deliverPrompt;
  assert.throws(() => createMorningGreetingComponent(deps), /缺少依赖：deliverPrompt/);
});
