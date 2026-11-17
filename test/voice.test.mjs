/**
 * 语音组件的可执行回归：依赖契约、触发规则、限流记账、控制台规则路由。
 * 真实合成/发送需要外部服务，这里只钉住组件边界与判定逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createVoiceComponent } from '../src/qq/features/voice.js';

function setup(voiceOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-voice-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = {
    ownerQQ: '10001',
    socialV2: {
      voice: {
        enabled: true,
        maxPerMinute: 2,
        maxPerHour: 10,
        trigger: { who: 'owner', members: [], groups: [] },
        tts: { enabled: true },
        ...voiceOverrides,
      },
    },
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(cfg));
  const calls = { sent: [] };
  const deps = {
    stateDir,
    dataRoot: dir,
    rootDir: dir,
    configFile,
    log: () => {},
    getConfig: () => cfg,
    getMode: () => 'reserved2',
    appendActivity: () => {},
    shouldAuditKey: () => true,
    captureSendGuard: () => () => {},
    enqueueSend: (fn) => { calls.sent.push(fn); },
    getSocialV2State: () => ({ recentMessages: [], wakeConfig: {} }),
    saveSocialV2State: () => {},
    modeAllowed: () => true,
  };
  return { dir, stateDir, cfg, configFile, calls, deps, component: createVoiceComponent(deps) };
}

test('缺少依赖时构造即失败', () => {
  assert.throws(() => createVoiceComponent({}), /voice 缺少依赖/);
  const base = setup();
  const broken = { ...base.deps };
  delete broken.captureSendGuard;
  assert.throws(() => createVoiceComponent(broken), /captureSendGuard/);
});

test('私聊触发：仅主人可发，名单模式按成员放行', async () => {
  const { component } = setup({ trigger: { who: 'owner', members: [], groups: [] } });
  const api = await component.init({});
  assert.equal(api.triggerBlock('private:10001', 'private', 10001), null);
  assert.match(api.triggerBlock('private:20002', 'private', 20002), /仅主人/);

  const listed = setup({ trigger: { who: 'list', members: ['20002'], groups: [] } });
  const api2 = await listed.component.init({});
  assert.equal(api2.triggerBlock('private:20002', 'private', 20002), null);
  assert.equal(api2.triggerBlock('private:10001', 'private', 10001), null);
  assert.match(api2.triggerBlock('private:30003', 'private', 30003), /不在语音触发名单/);
});

test('群聊触发：需要主人近期发言，一条主人消息只换一条语音', async () => {
  const { component } = setup();
  const api = await component.init({});
  const key = 'group:90001';
  assert.match(api.triggerBlock(key, 'group', 90001), /还没有主人发言记录/);
  api.noteSpeaker(key, { userId: '10001', isOwner: true, at: Date.now() });
  assert.equal(api.triggerBlock(key, 'group', 90001), null);

  api.markSent(key);
  assert.match(api.triggerBlock(key, 'group', 90001), /已经发过语音/);

  // 主人再说一句后重新放行
  api.noteSpeaker(key, { userId: '10001', isOwner: true, at: Date.now() + 1 });
  assert.equal(api.triggerBlock(key, 'group', 90001), null);
});

test('别人发言不会冲掉主人授权', async () => {
  const { component } = setup();
  const api = await component.init({});
  const key = 'group:90001';
  api.noteSpeaker(key, { userId: '10001', isOwner: true, at: Date.now() });
  api.noteSpeaker(key, { userId: '20002', isOwner: false, at: Date.now() + 1 });
  assert.equal(api.triggerBlock(key, 'group', 90001), null);
});

test('限流只检查不占额度，记账后才计数', async () => {
  const { component } = setup({ maxPerMinute: 1, maxPerHour: 10 });
  const api = await component.init({});
  api.budgetCheck('group:1', api.cfg());
  api.budgetCheck('group:1', api.cfg());
  api.budgetCommit('group:1');
  assert.throws(() => api.budgetCheck('group:1', api.cfg()), /频率超限/);
  // 另一个会话的额度独立
  api.budgetCheck('group:2', api.cfg());
});

test('GET/POST /api/voice/rules 走组件路由表', async () => {
  const { component, configFile } = setup({ trigger: { who: 'owner', members: [], groups: [] }, maxPerMinute: 3 });
  await component.init({});
  const getRoute = component.routes.find((r) => r.path === '/api/voice/rules');
  let body = null;
  await getRoute.handle({}, { req: { method: 'GET' }, sendJson: (obj) => { body = obj; } });
  assert.equal(body.ok, true);
  assert.equal(body.maxPerMinute, 3);
  assert.equal(body.triggerWho, 'owner');

  await getRoute.handle({}, {
    req: { method: 'POST' },
    readBody: async () => ({ triggerWho: 'anyone', maxPerMinute: 5, maxPerHour: 20, aiEnabled: true }),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, true);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.socialV2.voice.trigger.who, 'anyone');
  assert.equal(saved.socialV2.voice.maxPerMinute, 5);
  assert.equal(saved.socialV2.voice.tts.enabled, true);
});

test('操作者接口带 agent token 时拒绝 /api/send/voice', async () => {
  const { component } = setup();
  await component.init({});
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/send/voice');
  let body = null;
  let status = 200;
  await route.handle({}, {
    req: { method: 'POST', headers: { 'x-agent-token': 'abc' } },
    url: new URL('http://127.0.0.1/api/send/voice'),
    readBody: async () => ({}),
    sendJson: (obj, code) => { body = obj; status = code; },
  });
  assert.equal(status, 403);
  assert.match(body.error, /socialV2\/send-voice/);
});
