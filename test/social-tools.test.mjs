/**
 * 二代工具组件的边界回归：依赖契约 + 只读接口 + 反馈写入 + agent token 闸门。
 * 路由体是从 bridge 原样搬出的，这里只验证组件自己的 HTTP 形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSocialToolsComponent } from '../src/qq/features/social-tools.js';

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-tools-'));
  const cfg = { ownerQQ: '1', socialV2: { tools: {}, send: {} } };
  const state = { sessions: {} };
  const feedback = [];
  const deps = {
    getConfig: () => cfg,
    getMode: () => 'reserved2',
    getSocialV2: () => ({ conversations: new Map(), paused: false }),
    agentTokenOk: (key, token) => token === 'ok',
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    modeAllowed: () => true,
    shouldBlockSilentReply: () => false,
    getSocialV2State: () => ({ recentMessages: [], unread: [] }),
    fishGuardSendBlock: () => null,
    tokenGuardSendBlock: () => null,
    sendRateLimitInfo: () => null,
    reportLimitEvent: () => {},
    computeGapsV2: () => [],
    sendMessagesV2: async () => [],
    recordSentMessagesV2: () => {},
    saveSocialV2State: () => {},
    log: () => {},
    appendActivity: () => {},
    scheduleReplyCheckV2: () => {},
    cancelReplyCheckV2: () => {},
    sendNekoAfterReply: async () => {},
    findCjkSpaceWarning: () => null,
    findSplitBoundaryWarning: () => null,
    resolveReplyTargetV2: async () => null,
    resolveReplyInfo: async () => null,
    assertGroupMember: async () => true,
    captureSendGuard: () => () => {},
    getBot: () => ({ raw: async () => ({}) }),
    stickers: { enabled: () => true, suggest: () => null, list: () => [], get: () => null, entries: () => [] },
    sendStickerV2: async () => ({}),
    collectStickerV2: async () => ({}),
    readThroughSeqV2: () => 0,
    waitStreaks: new Map(),
    WAIT_STREAK_RESET_MS: 600000,
    WAIT_STREAK_LIMIT: 2,
    activeWaits: new Map(),
    ACTIVE_WAIT_LEASE_MS: 900000,
    suggestQuietMsV2: () => 0,
    getState: () => state,
    v2TurnStartAt: new Map(),
    sleep: async () => {},
    preSleepWaitBlockedV2: () => false,
    flushSocialV2State: () => {},
    noteModelMessagesV2: () => 0,
    unreadNoticeV2: () => null,
    readToolLog: () => [{ tool: 'qq_send_group_message' }],
    TOOL_LOG_FILE: path.join(dir, 'tool-calls.jsonl'),
    readFeedbackEntries: () => feedback,
    FEEDBACK_FILE: path.join(dir, 'feedback.json'),
    feedbackTimes: new Map(),
    appendFeedbackEntry: (entry) => feedback.push(entry),
    seenForwardIds: new Map(),
    fetchMediaData: async () => [],
    appendMemoryV2: () => {},
    formatMemoryV2: () => ({}),
    redactKnownTokensOnly: (text) => String(text ?? ''),
    MAX_MEDIA_BYTES: 10 * 1024 * 1024,
    MAX_MEDIA_PIXELS: 40 * 1000 * 1000,
    getImageDimensions: () => ({ width: 1, height: 1 }),
    mimeFromBuffer: () => 'image/png',
    mimeFromUrl: () => 'image/png',
    ...overrides,
  };
  return { deps, cfg, state, feedback, dir };
}

test('缺少注入依赖时构造即失败', () => {
  assert.throws(() => createSocialToolsComponent({}), /social-tools 缺少依赖/);
});

test('GET /api/socialV2/tool-log 透传日志条目', async () => {
  const { deps } = makeDeps();
  const component = createSocialToolsComponent(deps);
  const route = component.routes.find((r) => r.method === 'GET' && r.path === '/api/socialV2/tool-log');
  let body = null;
  await route.handle({}, {
    req: { method: 'GET', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/tool-log?limit=10'),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, true);
  assert.equal(body.entries.length, 1);
});

test('POST /api/socialV2/feedback 写入反馈并限频', async () => {
  const { deps, feedback } = makeDeps();
  const component = createSocialToolsComponent(deps);
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/feedback');
  let body = null;
  await route.handle({}, {
    req: { method: 'POST', headers: {} },
    url: new URL('http://127.0.0.1/api/socialV2/feedback'),
    readBody: async () => ({ key: 'group:1', level: 'warning', message: '  这里有问题  ' }),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, true);
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].message, '这里有问题');
  assert.equal(feedback[0].level, 'warning');
});

test('agent token 无效时拒绝写入反馈', async () => {
  const { deps, feedback } = makeDeps();
  const component = createSocialToolsComponent(deps);
  const route = component.routes.find((r) => r.method === 'POST' && r.path === '/api/socialV2/feedback');
  let body = null;
  await route.handle({}, {
    req: { method: 'POST', headers: { 'x-agent-token': 'bad' } },
    url: new URL('http://127.0.0.1/api/socialV2/feedback'),
    readBody: async () => ({ key: 'group:1', message: 'x' }),
    sendJson: (obj) => { body = obj; },
  });
  assert.equal(body.ok, false);
  assert.match(body.error, /token/);
  assert.equal(feedback.length, 0);
});
