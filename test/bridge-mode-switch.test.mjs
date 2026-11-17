/**
 * P0 真链路护栏（5/5）：从 reserved2 切到 chat 后，排队中的唤醒必须被取消。
 *
 * 线上事故形态：用户在控制台把模式从仿真切回普通聊天，但 reserved2 的合并窗口定时器
 * 还挂着 —— 几秒后一个「仿真唤醒」被投进 DSH，AI 按仿真规则调发送工具（此时接口已
 * 因模式不符返回 403），或者反过来在普通聊天里收到一串仿真提示词。这里用真实的
 * POST /api/mode 触发切换，验证切换时会把 pending 唤醒清掉，且切换本身不会把桥接带崩。
 *
 * 同时做一个反向确认（切回 reserved2 再发一条能正常唤醒）：避免「其实这条用例里
 * 唤醒本来就不会发生」导致的假绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startFakeDsh, startFakeSnowluma, getFreePort, waitFor,
} from './helpers/fake-hosts.mjs';
import {
  prepareBridgeEnv, writeBridgeConfig, consoleStatus, consolePost, socialStates,
  groupMessageEvent, OWNER_QQ,
} from './helpers/bridge-env.mjs';

const GROUP_ID = 876543210;
const MEMBER_QQ = 555555555;
const BATCH_MS = 3000; // 唤醒合并窗口：留出足够时间在同一窗口内完成模式切换

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('reserved2 → chat：排队中的唤醒被取消，不产生投递', async (t) => {
  const { home } = prepareBridgeEnv('dsh-dfy-modeswitch-');
  const consolePort = await getFreePort();
  const dsh = await startFakeDsh({ mode: 'reserved2', replyText: '我在。' });
  const snow = await startFakeSnowluma();
  await writeBridgeConfig(home, {
    consolePort,
    dshBaseUrl: dsh.baseUrl,
    snowlumaHttpUrl: snow.httpUrl,
    snowlumaWsUrl: snow.wsUrl,
    extra: {
      allow: { private: [OWNER_QQ], groups: [GROUP_ID] },
      socialV2: { wake: { batchWindowMs: BATCH_MS } },
    },
  });

  let bridge;
  let startError = null;
  const key = `group:${GROUP_ID}`;
  try {
    bridge = await import('../src/bridge.js');
    bridge.main({ embed: true }).catch((error) => { startError = error; });

    await waitFor(async () => {
      const r = await consoleStatus(consolePort).catch(() => null);
      if (r?.status === 200 && r.body?.dshReady === true && r.body?.mode === 'reserved2') return r;
      if (startError) throw startError;
      return null;
    }, { label: 'reserved2 + dshReady' });
    await waitFor(() => snow.hasClient(), { label: 'SnowLuma WS 连接' });

    // 1) 一条 @ 消息 → 入未读，并排上一个合并窗口内的唤醒。
    assert.ok(snow.inject(groupMessageEvent(GROUP_ID, MEMBER_QQ, '在吗', { atBot: true })) > 0);
    await waitFor(async () => {
      const r = await socialStates(consolePort).catch(() => null);
      const conv = r?.body?.conversations?.find((c) => c.key === key);
      return conv && conv.unreadCount >= 1 ? conv : null;
    }, { label: '消息进入 reserved2 未读' });
    assert.equal(dsh.prompts.length, 0, '合并窗口内还不应投递唤醒');

    // 2) 在窗口到期前切到 chat：切换必须成功写穿 DSH。
    const switched = await consolePost(consolePort, '/api/mode', { mode: 'chat' });
    assert.equal(switched.status, 200, `模式切换应成功：${switched.text}`);
    assert.equal(switched.body?.ok, true);
    assert.equal(switched.body?.mode, 'chat');
    assert.equal(switched.body?.dshSynced, true, '模式应写穿 DSH（避免 5s 轮询把本地值改回去）');

    // 3) 等过合并窗口：被取消的唤醒不能再投递。
    await sleep(BATCH_MS + 1500);
    assert.equal(dsh.prompts.length, 0, '离开 reserved2 后不应再产生唤醒投递');
    const alive = await consoleStatus(consolePort);
    assert.equal(alive.status, 200);
    assert.equal(alive.body.mode, 'chat');
    assert.equal(alive.body.dshReady, true);
    assert.equal(startError, null, `不应有未捕获异常：${startError?.message ?? ''}`);

    // 4) 反向确认：切回 reserved2 后同样的消息仍能唤醒（证明上面不是「本来就不会醒」）。
    const back = await consolePost(consolePort, '/api/mode', { mode: 'reserved2' });
    assert.equal(back.status, 200);
    assert.equal(back.body?.mode, 'reserved2');
    assert.ok(snow.inject(groupMessageEvent(GROUP_ID, MEMBER_QQ, '再问一次', { messageId: 2, atBot: true })) > 0);
    await waitFor(() => dsh.prompts.length >= 1, { label: '切回 reserved2 后的唤醒投递', timeoutMs: 20000 });
  } finally {
    try { await bridge?.stopEmbedded(); } catch {}
    await dsh.close();
    await snow.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
