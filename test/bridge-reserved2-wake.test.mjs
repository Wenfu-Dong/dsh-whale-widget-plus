/**
 * P0 真链路护栏（4/4）：reserved2 群消息 → 入未读 → 唤醒 DSH → agent 调发送工具 → send_group_msg。
 *
 * 为什么单独测这条：reserved2 与 chat 的行为**相反** —— 它的文本输出不会自动转发到 QQ，
 * 回话必须由 agent 自己调 qq_send_message。于是「群消息能不能把 AI 叫起来、叫起来以后
 * 发不发得出去」是两段独立的链路，任一段断了，用户看到的现象都是「机器人在群里装死」。
 *
 * 这里用假 SnowLuma 注入一条 @ 机器人的群消息，等桥接把唤醒 prompt 投给假 DSH，
 * 再用提示词里的会话令牌模拟 agent 调用发送工具，最后断言 OneBot 收到了 send_group_msg。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startFakeDsh, startFakeSnowluma, getFreePort, waitFor,
} from './helpers/fake-hosts.mjs';
import {
  prepareBridgeEnv, writeBridgeConfig, consoleStatus, socialStates,
  groupMessageEvent, CONSOLE_TOKEN, OWNER_QQ,
} from './helpers/bridge-env.mjs';

const GROUP_ID = 987654321;
const MEMBER_QQ = 555555555;

test('reserved2 群唤醒：@ 消息 → DSH 唤醒回合 → 发送工具 → send_group_msg', async (t) => {
  const { home } = prepareBridgeEnv('dsh-dfy-wake-');
  const consolePort = await getFreePort();
  // reserved2 是群聊仿真模式：必须走这个模式启动；唤醒合并窗口调到 1s，避免用例等 8s。
  const dsh = await startFakeDsh({ mode: 'reserved2', replyText: '我在。' });
  const snow = await startFakeSnowluma();
  await writeBridgeConfig(home, {
    consolePort,
    dshBaseUrl: dsh.baseUrl,
    snowlumaHttpUrl: snow.httpUrl,
    snowlumaWsUrl: snow.wsUrl,
    extra: {
      allow: { private: [OWNER_QQ], groups: [GROUP_ID] },
      socialV2: { wake: { batchWindowMs: 1000 } },
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

    // 1) 一条 @ 机器人的群消息：入未读并按 @ 触发一次唤醒。
    assert.ok(snow.inject(groupMessageEvent(GROUP_ID, MEMBER_QQ, '在吗', { atBot: true })) > 0);
    const states = await waitFor(async () => {
      const r = await socialStates(consolePort).catch(() => null);
      const conv = r?.body?.conversations?.find((c) => c.key === key);
      return conv && conv.unreadCount >= 1 ? conv : null;
    }, { label: '消息进入 reserved2 未读' });
    assert.ok(states.unreadCount >= 1);

    // 2) 唤醒必须真的投给 DSH，且 prompt 里带着这个群的会话 key 与会话令牌。
    const prompt = await waitFor(() => dsh.prompts[0], { label: 'reserved2 唤醒 prompt', timeoutMs: 20000 });
    const promptText = JSON.stringify(prompt.payload);
    assert.ok(promptText.includes(key), `唤醒 prompt 应包含会话 key ${key}`);
    const tokenMatch = /【会话令牌】([A-Za-z0-9_-]+)/.exec(promptText);
    assert.ok(tokenMatch, '唤醒 prompt 应下发会话令牌供发送工具使用');

    // 3) 假 DSH 已经推完回合事件；模拟 agent 调 qq_send_message（真实链路是 MCP → 本机 HTTP）。
    const sendRes = await fetch(`http://127.0.0.1:${consolePort}/api/socialV2/send-message?token=${encodeURIComponent(CONSOLE_TOKEN)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-token': tokenMatch[1],
        'x-agent-call': '1',
        connection: 'close',
      },
      body: JSON.stringify({ key, messages: ['我在。'] }),
    });
    const sendBody = await sendRes.json().catch(() => ({}));
    assert.equal(sendRes.status, 200, `发送工具应成功：${JSON.stringify(sendBody)}`);
    assert.equal(sendBody.ok, true);

    // 4) 出站落在群上（不是私聊、不是别的群）。
    const out = await waitFor(() => {
      const list = snow.outgoing('send_group_msg');
      return list.length ? list : null;
    }, { label: 'send_group_msg 出站', timeoutMs: 10000 });
    const target = out[out.length - 1];
    assert.equal(Number(target.params?.group_id), GROUP_ID);
    assert.match(JSON.stringify(target.params?.message ?? ''), /我在/);
    assert.equal(startError, null, `不应有未捕获异常：${startError?.message ?? ''}`);
  } finally {
    try { await bridge?.stopEmbedded(); } catch {}
    await dsh.close();
    await snow.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
