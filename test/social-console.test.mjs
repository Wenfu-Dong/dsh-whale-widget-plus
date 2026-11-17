/**
 * 二代控制台组件的边界回归：依赖契约 + 只读路由 + 配置归一化 + 群策略。
 * 运行时状态与唤醒算法由 bridge 注入，这里只验证组件自己的 HTTP 形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSocialConsoleComponent } from '../src/qq/features/social-console.js';

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-social-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ownerQQ: '1', socialV2: { tools: { sendGroup: true } } }));
  const cfg = { ownerQQ: '1', socialV2: { tools: { sendGroup: true }, wake: {} } };
  const state = { key: 'group:1', wakeConfig: { mode: 'diving', infinite: true, triggers: {} }, unread: [], recentMessages: [], closure: null };
  const deps = {
    log: () => {},
    getConfig: () => cfg,
    configFile,
    socialV2: { paused: false, conversations: new Map([['group:1', state]]) },
    getSocialV2State: () => state,
    flushSocialV2State: () => {},
    saveState: () => {},
    clearAllSocialV2Timers: () => {},
    setupSleepTimerV2: () => {},
    scheduleProactiveCheckV2: () => {},
    refreshAllDefaultWakeConfigsV2: () => {},
    cancelReplyCheckV2: () => {},
    agentTokenOk: () => true,
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    getMode: () => 'reserved2',
    modeAllowed: () => true,
    stickers: { sync: async () => {}, suggest: () => null, entries: () => [], context: () => '', strategy: () => '', enabled: () => true },
    slang: { enabled: () => true, confirmedList: () => [], context: () => '' },
    voice: { listLibrary: () => [], cfg: () => ({ maxSeconds: 300 }) },
    readRoleState: () => ({ role: null, mode: 'active' }),
    selfName: () => '',
    selfUserId: () => '',
    selfIdentityText: () => '',
    currentRoleHint: () => '',
    currentRoleHintV2: () => '',
    memoryCardPaths: { promptQq: '', promptBili: '' },
    memoryCardPromptBlock: () => '',
    groupPolicyFile: path.join(dir, 'group-policy.json'),
    readGroupPolicy: () => ({ overrides: {}, tiers: {} }),
    ensureGroupMeta: async () => {},
    groupProfile: () => ({ name: '', memberCount: 0, activityCount: 0, tier: 'auto', source: 'auto' }),
    setGroupPolicyCache: () => {},
    limitMuteFile: path.join(dir, 'limit-mutes.json'),
    readLimitMutes: () => ({ muted: {} }),
    gateEvents: { list: () => ({ events: [] }), ack: () => {} },
    sendWakePromptV2: async () => {},
    runHistoryCatchUp: async () => ({ ok: true }),
    closeConversation: () => ({ ok: true }),
    initialPrompts: new Map(),
    initialPromptMaxChars: () => 2000,
    isInitialPromptsWritable: () => true,
    setInitialPrompt: (key, text) => ({ ok: true, key, chars: text.length, deleted: !text, entry: null }),
    acknowledgeMessagesV2: () => 0,
    assessClosureV2: () => ({ verdict: 'continue', score: 0, reasons: [] }),
    closureConfigV2: () => ({}),
    closureStatus: () => null,
    computeWakeSafetyV2: () => ({ guaranteed: true }),
    ensureWakeableV2: () => {},
    formatMemoryV2: () => ({}),
    formatParticipationV2: () => ({}),
    isSleepingConfigV2: () => false,
    normalizeSpeakerIdsV2: (v) => v ?? [],
    noteModelMessagesV2: () => 0,
    pickWakeTriggersV2: () => ({}),
    preSleepWaitBlockedV2: () => false,
    readThroughSeqV2: () => 0,
    replyTimingV2: () => ({}),
    requestedReadThroughSeqV2: () => 0,
    unreadNoticeV2: () => null,
    markReadCalledKeys: new Set(),
    wakeConfigUpdatedKeys: new Set(),
    wakeConfigMissCount: new Map(),
    ...overrides,
  };
  return { deps, cfg, configFile, state, dir };
}

test('缺少注入依赖时构造即失败', () => {
  assert.throws(() => createSocialConsoleComponent({}), /social-console 缺少依赖/);
});

test('GET /api/socialV2/states 汇总会话', async () => {
  const { deps } = makeDeps();
  const component = createSocialConsoleComponent(deps);
  const route = component.routes.find((r) => r.path === '/api/socialV2/states');
  let body = null;
  await route.handle({}, { sendJson: (obj) => { body = obj; } });
  assert.equal(body.ok, true);
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].key, 'group:1');
});

test('活动开关会暂停并持久化', async () => {
  const { deps } = makeDeps();
  const component = createSocialConsoleComponent(deps);
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/activity');
  let body = null;
  await route.handle({}, { readBody: async () => ({ paused: true }), sendJson: (obj) => { body = obj; } });
  assert.equal(body.paused, true);
  assert.equal(deps.socialV2.paused, true);
});

test('POST /api/socialV2/config 归一化并写盘', async () => {
  const { deps, cfg, configFile } = makeDeps();
  const component = createSocialConsoleComponent(deps);
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/config');
  let body = null;
  await route.handle({}, {
    readBody: async () => ({ send: { maxSendPerMinute: '7' }, wake: { defaultMode: 'active' }, enabled: true }),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, true);
  assert.equal(body.config.send.maxSendPerMinute, 7);
  assert.equal(body.config.wake.defaultMode, 'active');
  assert.equal(body.config.enabled, true);
  assert.equal(cfg.socialV2.send.maxSendPerMinute, 7);
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.socialV2.send.maxSendPerMinute, 7);
});

test('GET /api/socialV2/state 返回唤醒与未读摘要', async () => {
  const { deps } = makeDeps();
  const component = createSocialConsoleComponent(deps);
  const route = component.routes.find((r) => r.method === 'GET' && r.path === '/api/socialV2/state');
  let body = null;
  await route.handle({}, {
    req: { headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/state?key=group:1'),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, true);
  assert.equal(body.unreadCount, 0);
  assert.equal(body.wakeSafety.guaranteed, true);
});
