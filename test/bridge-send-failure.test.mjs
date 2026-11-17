/**
 * P0 真链路护栏（3/3）：发送失败必须被记账，连续失败要能自动刹车，且不许把桥接带崩。
 *
 * 线上最贵的故障不是「发失败」，而是「发失败被当成成功」—— agent 每轮照常生成、
 * token 照常烧掉，QQ 里却一条消息都没有（用户视角：机器人还活着但完全失联）。
 * 桥接的做法是记 sendFailureStreak，连续 3 次就暂停自动唤醒 30 分钟。
 * 这条用例用假 OneBot 的注入失败把这条链路跑通。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startFakeDsh, startFakeSnowluma, getFreePort, waitFor,
} from './helpers/fake-hosts.mjs';
import {
  prepareBridgeEnv, writeBridgeConfig, consoleStatus, privateMessageEvent, OWNER_QQ,
} from './helpers/bridge-env.mjs';

function readV2State(home, key) {
  const file = path.join(home, 'surfcore', 'qq', 'state', 'social-v2.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc?.conversations?.[key] ?? null;
  } catch {
    return null;
  }
}

test('发送失败：记账并连续失败后暂停自动唤醒，桥接不崩', async (t) => {
  const { home } = prepareBridgeEnv('dsh-dfy-sendfail-');
  const consolePort = await getFreePort();
  const dsh = await startFakeDsh({ replyText: '收到你的消息了。' });
  const snow = await startFakeSnowluma();
  await writeBridgeConfig(home, {
    consolePort,
    dshBaseUrl: dsh.baseUrl,
    snowlumaHttpUrl: snow.httpUrl,
    snowlumaWsUrl: snow.wsUrl,
  });

  const key = `private:${OWNER_QQ}`;
  let bridge;
  let startError = null;
  try {
    bridge = await import('../src/bridge.js');
    bridge.main({ embed: true }).catch((error) => { startError = error; });
    await waitFor(async () => {
      const r = await consoleStatus(consolePort).catch(() => null);
      if (r?.status === 200 && r.body?.dshReady === true) return r;
      if (startError) throw startError;
      return null;
    }, { label: 'dshReady' });
    await waitFor(() => snow.hasClient(), { label: 'SnowLuma WS 连接' });

    // 让后续所有 WS 发送都失败（ack + 正式回复 + 下一轮 ack …）。
    snow.state.failNextWsSends = 50;
    snow.inject(privateMessageEvent(OWNER_QQ, '第一条'));
    await waitFor(() => dsh.prompts.length >= 1, { label: '第一条 prompt' });
    // 第一次失败就该落盘（sendFailureStreak >= 1），而不是静默吞掉。
    await waitFor(() => (readV2State(home, key)?.sendFailureStreak ?? 0) >= 1, { label: '发送失败记账' });

    // 再推一条：累计到 3 次后应当进入「暂停自动唤醒」状态。
    snow.inject(privateMessageEvent(OWNER_QQ, '第二条', 2));
    await waitFor(() => dsh.prompts.length >= 2, { label: '第二条 prompt' });
    const suspended = await waitFor(() => {
      const st = readV2State(home, key);
      return Number(st?.wakeSuspendedUntil) > Date.now() ? st : null;
    }, { label: '连续失败后暂停唤醒', timeoutMs: 15000 });
    assert.ok(Number(suspended.sendFailureStreak) >= 3, '暂停应发生在连续 3 次失败之后');
    assert.ok(snow.sent.some((item) => item.transport === 'ws' && item.failed), '应当记录到失败的发送');

    // 失败期间桥接必须保持在线：控制台还能正常应答，且没有启动期未捕获异常。
    const alive = await consoleStatus(consolePort);
    assert.equal(alive.status, 200);
    assert.equal(alive.body.dshReady, true);
    assert.equal(startError, null, `不应有未捕获异常：${startError?.message ?? ''}`);
  } finally {
    try { await bridge?.stopEmbedded(); } catch {}
    await dsh.close();
    await snow.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
