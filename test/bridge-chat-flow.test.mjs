/**
 * P0 真链路护栏（2/3）：一条私聊消息走完「入站 → DSH prompt → 回合事件 → QQ 出站」。
 *
 * 覆盖的正是「插件装上以后别人能不能用」：不是单元函数，而是四个真实边界
 * （OneBot WS 入站、DSH HTTP RPC、remote.mux 事件流、OneBot HTTP 出站）串起来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  startFakeDsh, startFakeSnowluma, getFreePort, waitFor,
} from './helpers/fake-hosts.mjs';
import {
  prepareBridgeEnv, writeBridgeConfig, consoleStatus, privateMessageEvent, OWNER_QQ,
} from './helpers/bridge-env.mjs';

test('私聊入站：唤醒 DSH 并把回合回复发回 QQ', async (t) => {
  const { home } = prepareBridgeEnv('dsh-dfy-chat-');
  const consolePort = await getFreePort();
  const dsh = await startFakeDsh({ replyText: '我在，怎么了？' });
  const snow = await startFakeSnowluma();
  await writeBridgeConfig(home, {
    consolePort,
    dshBaseUrl: dsh.baseUrl,
    snowlumaHttpUrl: snow.httpUrl,
    snowlumaWsUrl: snow.wsUrl,
  });

  let bridge;
  let startError = null;
  try {
    bridge = await import('../src/bridge.js');
    bridge.main({ embed: true }).catch((error) => { startError = error; });

    // 1) 等桥接与 DSH 建立好关系（第一次 settings/describe 成功后 dshReady 才会置真）。
    await waitFor(async () => {
      const r = await consoleStatus(consolePort).catch(() => null);
      if (r?.status === 200 && r.body?.dshReady === true) return r;
      if (startError) throw startError;
      return null;
    }, { label: 'dshReady' });
    // 端口探测不能把请求劫持到开发机上真实运行的 DSH。
    const status = await consoleStatus(consolePort);
    assert.equal(status.body.dshBaseUrl, dsh.baseUrl);
    await waitFor(() => snow.hasClient(), { label: 'SnowLuma WS 连接' });

    // 2) 推一条 owner 私聊消息进来。
    const injected = snow.inject(privateMessageEvent(OWNER_QQ, '在吗'));
    assert.ok(injected > 0, '应当有已连接的 OneBot 客户端接收事件');

    // 3) 桥接应当把这句送进 DSH（建会话 + prompt）。
    const prompt = await waitFor(() => dsh.prompts[0], { label: 'DSH prompt' });
    assert.ok(dsh.sessions.length >= 1, '应当创建过会话');
    assert.match(JSON.stringify(prompt.payload), /在吗/);

    // 4) 假 DSH 推回 assistant/message + turn/end；桥接应当在出站端口发两件事：
    //    先「收到，正在思考…」回执，再回合正式回复。
    const sent = await waitFor(() => {
      const list = snow.outgoing('send_private_msg');
      const textOf = (item) => JSON.stringify(item.params?.message ?? '');
      return list.some((item) => textOf(item).includes('收到')) && list.some((item) => textOf(item).includes('我在'))
        ? list
        : null;
    }, { label: 'QQ 回执与正式回复', timeoutMs: 20000 });
    const texts = sent.map((item) => JSON.stringify(item.params?.message ?? ''));
    assert.ok(texts.some((x) => x.includes('收到')), '缺少回执消息');
    assert.ok(texts.some((x) => x.includes('我在')), '缺少正式回复');
    // 私聊目标必须是 owner 本人，不能串到群/别人。
    for (const item of sent) assert.equal(Number(item.params?.user_id), OWNER_QQ);
  } finally {
    try { await bridge?.stopEmbedded(); } catch {}
    await dsh.close();
    await snow.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
