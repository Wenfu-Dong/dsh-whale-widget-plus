/**
 * 二代状态存储（social-v2-store）回归：加载归一化、损坏容错、跨进程回写保护、
 * 合并写/取消/立即写。这些语义原先埋在 bridge 的 main() 里，拆分后必须逐条保持。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSocialV2Store } from '../src/qq/features/social-v2-store.js';
import { createCoalescingWriter } from '../src/save-scheduler.js';

function makeDeps(overrides = {}) {
  const writes = [];
  const logs = [];
  const remembered = [];
  const ensureCalls = [];
  const scheduled = [];
  const refreshed = [];
  let tokenSeq = 0;

  const fixture = {
    paused: true,
    conversations: {
      'group:100': {
        agentToken: 'dup',
        lastUnreadSeq: 5,
        lastReadThroughSeq: 9,
        recentMessages: [{ userId: '111', text: 'a' }],
        unread: [{ userId: '111', text: 'b' }, { userId: '222', text: 'c' }],
        memberImpressions: JSON.parse('{"333":{"traits":["稳"]},"__proto__":{"polluted":true}}'),
        wakeConfig: { triggers: { speakerIds: ['123', 'bad', null] } },
        seenForwardIds: ['f1', ''],
      },
      'private:200': { wakeConfig: { triggers: { speakerIds: ['456'] } } },
      'group:300': 'not-an-object',
      'bad-key': { agentToken: 'dup' },
      'group:400': { agentToken: 'dup' },
    },
  };

  const deps = {
    fs: { statSync: () => ({ size: 10, mtimeMs: 1 }) },
    crypto: { randomBytes: () => ({ toString: () => `tok${++tokenSeq}` }) },
    SOCIAL_V2_FILE: 'state/social-v2.json',
    readJsonSafe: () => fixture,
    atomicWriteJson: (file, obj) => { writes.push({ file, obj }); return true; },
    createCoalescingWriter,
    log: (message) => logs.push(String(message)),
    getConfig: () => ({ socialV2: { closure: {} }, deny: { users: ['111'] } }),
    socialV2: { conversations: new Map(), paused: false },
    seenForwardIds: new Map(),
    defaultWakeConfigV2: () => ({ triggers: { keywords: [], speakerIds: [] }, interval: { min: 1 } }),
    pickWakeTriggersV2: (source, fallback) => ({ ...fallback, ...source }),
    normalizeSpeakerIdsV2: (value) => (Array.isArray(value) ? value : [])
      .map((x) => String(x ?? '')).filter((x) => /^\d+$/.test(x)),
    refreshDefaultWakeConfigV2: (st) => { refreshed.push(st); },
    normalizeClosureRecord: (value) => (value && typeof value === 'object' ? value : null),
    sanitizeForwardId: (value) => (typeof value === 'string' && value ? value : null),
    rememberAgentToken: (key, token) => { remembered.push([key, token]); },
    ensureWakeableV2: (st, opts) => { ensureCalls.push({ st, opts }); },
    scheduleProactiveCheckV2: (key) => { scheduled.push(key); },
    ...overrides,
  };

  return { deps, writes, logs, remembered, ensureCalls, scheduled, refreshed, fixture };
}

test('缺少依赖时直接抛 TypeError，而不是运行期才炸', () => {
  assert.throws(() => createSocialV2Store({}), /social-v2-store 缺少依赖/);
  const { deps } = makeDeps();
  for (const name of ['socialV2', 'seenForwardIds', 'ensureWakeableV2', 'getConfig']) {
    const partial = { ...deps };
    delete partial[name];
    assert.throws(() => createSocialV2Store(partial), new RegExp(`缺少依赖：${name}`));
  }
});

test('加载：会话键过滤、令牌去重、水位夹紧、黑名单清缓存、私有会话清发言名单', () => {
  const { deps, writes, logs, remembered, ensureCalls, scheduled, refreshed } = makeDeps();
  const store = createSocialV2Store(deps);

  store.loadState();

  const { socialV2, seenForwardIds } = deps;
  assert.equal(socialV2.paused, true, 'paused 应跟随文件');
  assert.deepEqual([...socialV2.conversations.keys()].sort(), ['group:100', 'group:400', 'private:200']);
  assert.ok(!socialV2.conversations.has('bad-key'), '非法键不应加载');
  assert.ok(!socialV2.conversations.has('group:300'), '非对象值不应加载');

  const g100 = socialV2.conversations.get('group:100');
  assert.equal(g100.lastReadThroughSeq, 5, '读水位不能超过未读序号');
  assert.deepEqual(g100.unread.map((m) => m.userId), ['222'], '黑名单用户的历史未读应被清掉');
  assert.deepEqual(g100.recentMessages, [], '黑名单用户的历史上下文应被清掉');
  assert.ok(logs.some((line) => line.includes('[黑名单]')), '清缓存应留审计日志');
  assert.deepEqual(g100.wakeConfig.triggers.speakerIds, ['123'], '非法名单应被归一化丢弃');
  assert.ok(!Object.prototype.hasOwnProperty.call(g100.memberImpressions, '__proto__'), '__proto__ 键应被剔除');
  assert.deepEqual(g100.memberImpressions['333'], { traits: ['稳'] });
  assert.equal(g100.lastActionAt, 0);
  assert.deepEqual(g100.activeTopics, []);

  const p200 = socialV2.conversations.get('private:200');
  assert.deepEqual(p200.wakeConfig.triggers.speakerIds, [], '私聊会话不应保留群友发言唤醒名单');

  // group:100 保留原令牌；其余两个（缺省/重复）必须重新生成且互不相同。
  assert.equal(g100.agentToken, 'dup');
  const tokens = ['group:100', 'group:400', 'private:200'].map((k) => socialV2.conversations.get(k).agentToken);
  assert.equal(new Set(tokens).size, 3);
  assert.deepEqual(remembered.map(([k]) => k).sort(), ['group:100', 'group:400', 'private:200']);

  // 转发 id 从持久化字段与消息中重建。
  assert.deepEqual([...seenForwardIds.get('group:100')], ['f1']);
  assert.equal(seenForwardIds.has('private:200'), false);

  assert.equal(refreshed.length, 3);
  assert.deepEqual(ensureCalls.map((c) => c.opts.skipSave), [true, true, true]);
  assert.deepEqual(scheduled.sort(), ['group:100', 'group:400', 'private:200']);

  // 加载末尾只统一落盘一次，且落的是 store 的快照。
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, deps.SOCIAL_V2_FILE);
  assert.equal(writes[0].obj.paused, true);
  assert.ok(writes[0].obj.conversations['group:100']);
});

test('加载：文件损坏/不存在时静默降级，不写盘也不抛错', () => {
  const { deps, writes } = makeDeps({ readJsonSafe: () => null });
  const store = createSocialV2Store(deps);

  assert.doesNotThrow(() => store.loadState());
  assert.equal(deps.socialV2.paused, false);
  assert.equal(deps.socialV2.conversations.size, 0);
  assert.equal(writes.length, 0);
});

test('加载：读取期间文件被其它进程改写时跳过回写', () => {
  let statCalls = 0;
  const { deps, writes, logs } = makeDeps({
    fs: { statSync: () => (++statCalls === 1 ? { size: 10, mtimeMs: 1 } : { size: 11, mtimeMs: 2 }) },
  });
  const store = createSocialV2Store(deps);

  store.loadState();

  assert.equal(writes.length, 0, '内存态已过期，不能回写覆盖对方的更新');
  assert.ok(logs.some((line) => line.includes('被其它进程改写')));
  assert.equal(deps.socialV2.conversations.size, 3, '内存态仍按读到的文件加载');
});

test('保存路径：save 遵守合并窗口，cancel 丢弃待写，flush 立即落盘', () => {
  const { deps, writes } = makeDeps({ readJsonSafe: () => null });
  const store = createSocialV2Store(deps);
  deps.socialV2.conversations.set('group:1', {
    wakeConfig: { triggers: {} }, recentMessages: [], unread: [], lastWakeReason: '',
    lastAiReplyAt: 0, lastActionAt: 0, agentToken: 't', bootstrapSent: false,
    wakeTimes: [], sendTimes: [], stickerCollectTimes: [], lastIncomingAt: 0,
  });

  store.save();
  assert.equal(store.cancel(), true, '待写的合并任务应被取消');
  assert.equal(writes.length, 0);

  assert.equal(store.flush(), true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].obj.conversations['group:1']);
});

test('快照裁剪：长数组按上限截断，保持文件大小有界', () => {
  const { deps } = makeDeps({ readJsonSafe: () => null });
  const store = createSocialV2Store(deps);
  deps.socialV2.paused = false;
  deps.socialV2.conversations.set('group:1', {
    wakeConfig: { triggers: {} },
    recentMessages: Array.from({ length: 250 }, (_, i) => ({ i })),
    unread: Array.from({ length: 150 }, (_, i) => ({ i })),
    lastWakeReason: '', lastAiReplyAt: 0, lastActionAt: 0, agentToken: 't', bootstrapSent: false,
    wakeTimes: Array.from({ length: 300 }, (_, i) => i),
    sendTimes: Array.from({ length: 600 }, (_, i) => i),
    stickerCollectTimes: Array.from({ length: 600 }, (_, i) => i),
    activeTopics: Array.from({ length: 60 }, (_, i) => i),
    pendingThoughts: Array.from({ length: 60 }, (_, i) => i),
    fishGuardLog: Array.from({ length: 40 }, () => ({})),
  });
  deps.seenForwardIds.set('group:1', new Set(Array.from({ length: 1200 }, (_, i) => `f${i}`)));

  const snap = store.buildSnapshot();
  const conv = snap.conversations['group:1'];
  assert.equal(conv.recentMessages.length, 200);
  assert.equal(conv.unread.length, 100);
  assert.equal(conv.wakeTimes.length, 200);
  assert.equal(conv.sendTimes.length, 500);
  assert.equal(conv.stickerCollectTimes.length, 500);
  assert.equal(conv.activeTopics.length, 50);
  assert.equal(conv.pendingThoughts.length, 50);
  assert.equal(conv.fishGuardLog.length, 30);
  assert.equal(conv.seenForwardIds.length, 1000);
  assert.equal(snap.paused, false);
});

test('快照：长期无活动的会话不落盘（TTL 可配置，0 关闭）', () => {
  const now = Date.now();
  const buildWith = (ttlDays) => {
    const { deps } = makeDeps({
      readJsonSafe: () => null,
      getConfig: () => ({ socialV2: { closure: {}, context: { conversationTtlDays: ttlDays } } }),
    });
    const store = createSocialV2Store(deps);
    const stub = (lastIncomingAt) => ({
      wakeConfig: { triggers: {} }, recentMessages: [], unread: [],
      wakeTimes: [], sendTimes: [], stickerCollectTimes: [],
      activeTopics: [], pendingThoughts: [], fishGuardLog: [],
      lastIncomingAt, lastAiReplyAt: 0, lastActionAt: 0, agentToken: 't', bootstrapSent: false,
    });
    deps.socialV2.conversations.set('group:old', stub(now - 40 * 86_400_000));
    deps.socialV2.conversations.set('group:new', stub(now - 1000));
    deps.socialV2.conversations.set('group:unknown', stub(0));
    return store.buildSnapshot();
  };

  const snap = buildWith(30);
  assert.equal(snap.conversations['group:old'], undefined, '40 天无活动应被跳过');
  assert.ok(snap.conversations['group:new'], '有近期活动的会话必须保留');
  assert.ok(snap.conversations['group:unknown'], '无时间戳的旧数据要保留，避免升级误删');
  assert.ok(buildWith(0).conversations['group:old'], 'TTL=0 应关闭淘汰');
});

test('加载：文件存在但解析失败时先备份现场，避免被空状态覆盖', () => {
  const renamed = [];
  const { deps } = makeDeps({
    readJsonSafe: () => null,
    fs: {
      statSync: () => ({ size: 32, mtimeMs: 1 }),
      renameSync: (from, to) => { renamed.push([from, to]); },
    },
  });
  const store = createSocialV2Store(deps);

  assert.doesNotThrow(() => store.loadState());
  assert.equal(renamed.length, 1, '损坏文件应被改名备份');
  assert.equal(renamed[0][0], deps.SOCIAL_V2_FILE);
  assert.match(renamed[0][1], /social-v2\.json\.corrupt-\d+$/);
});
