// 长稳 / 浸泡测试（默认 15 秒，可用 SOAK_MS 拉长到数小时）。
//
// 目的：把「跑一会儿就出问题」的稳定性缺陷在开发机上复现出来，而不是等用户装上以后。
// 它不是功能测试，断言的是四类不变量：
//   1. 内存 / 句柄不随消息量单调增长（V8 堆、RSS、活跃句柄数在末段不持续爬升）；
//   2. 偶发发送失败不会把桥接带崩，也不会让 SnowLuma 连接掉线后不再重连；
//   3. 连续发送失败会把该会话的自动唤醒暂停（wakeSuspendedUntil），并真的不再投递；
//   4. 全程一轮不崩：控制台 200、dshReady 保持为真，最后能干净收尾（进程自然退出）。
//
// 覆盖两条链路：
//   · chat：私聊消息 → DSH 回合 → 自动回发（高频，压吞吐与句柄）；
//   · reserved2：群 @ 消息 → 唤醒 → agent 调发送工具连续失败 → 暂停唤醒（压故障路径）。
//
// 用法：
//   node test/tools/soak.mjs                        # 默认 15s
//   SOAK_MS=1800000 node test/tools/soak.mjs        # 30 分钟
//   SOAK_MS=3600000 SOAK_INTERVAL_MS=500 node test/tools/soak.mjs
//   SOAK_RESERVED2=0 node test/tools/soak.mjs       # 只跑 chat 高频段
//
// 放在 test/ 而不是 scripts/：它复用了 test/helpers 的假宿主，而 test 目录不进 npm 包；
// 放进 scripts/ 会让发布出去的脚本 import 不到依赖。
import fs from 'node:fs';
import path from 'node:path';
import {
  startFakeDsh, startFakeSnowluma, getFreePort, waitFor,
} from '../helpers/fake-hosts.mjs';
import {
  prepareBridgeEnv, writeBridgeConfig, consoleStatus, consolePost, socialStates,
  groupMessageEvent, privateMessageEvent, CONSOLE_TOKEN, OWNER_QQ,
} from '../helpers/bridge-env.mjs';

const SOAK_MS = Math.max(2000, Number(process.env.SOAK_MS) || 15_000);
const INTERVAL_MS = Math.max(20, Number(process.env.SOAK_INTERVAL_MS) || 250);
const FAIL_EVERY = Math.max(0, Number(process.env.SOAK_FAIL_EVERY ?? 9)); // 每 N 条注入一次发送失败，0=关闭
const WITH_RESERVED2 = process.env.SOAK_RESERVED2 !== '0';
const GROUP_ID = 765432109;
const MEMBER_QQ = 555555555;
const BATCH_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heapMB = (bytes) => Math.round(bytes / 1024 / 1024 * 10) / 10;

/** 读 social-v2.json（桥接用原子写，读到的要么旧要么新，不会半截）。 */
function readSocialV2(home) {
  const file = path.join(home, 'surfcore', 'qq', 'state', 'social-v2.json');
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { file, bytes: Buffer.byteLength(text), doc: JSON.parse(text) };
  } catch {
    return { file, bytes: 0, doc: null };
  }
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

async function main() {
  const { home } = prepareBridgeEnv('dsh-dfy-soak-');
  const consolePort = await getFreePort();
  const dsh = await startFakeDsh({ mode: 'chat', replyText: '收到。' });
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
  let bridgeError = null;
  const samples = [];
  let sampler = null;

  const sample = () => {
    const mem = process.memoryUsage();
    samples.push({
      at: Date.now(),
      heap: mem.heapUsed,
      rss: mem.rss,
      resources: process.getActiveResourcesInfo().length,
    });
  };

  try {
    bridge = await import('../../src/bridge.js');
    bridge.main({ embed: true }).catch((error) => { bridgeError = error; });
    await waitFor(async () => {
      const r = await consoleStatus(consolePort).catch(() => null);
      if (r?.status === 200 && r.body?.dshReady === true) return r;
      if (bridgeError) throw bridgeError;
      return null;
    }, { label: '桥接就绪', timeoutMs: 30000 });
    await waitFor(() => snow.hasClient(), { label: 'SnowLuma 连接' });

    sampler = setInterval(sample, 1000);
    sampler.unref?.();
    sample();

    // ── 阶段 A：chat 高频私聊 ──────────────────────────────────────────
    const startedAt = Date.now();
    let messages = 0;
    let injectedFailures = 0;
    const deadline = startedAt + (WITH_RESERVED2 ? Math.floor(SOAK_MS * 0.6) : SOAK_MS);
    while (Date.now() < deadline) {
      messages += 1;
      if (FAIL_EVERY > 0 && messages % FAIL_EVERY === 0) {
        // 让下一次（或下几次）发送失败：模拟 QQ/SnowLuma 抖动。
        snow.state.failNextWsSends += 2;
        snow.state.failNextSends += 2;
        injectedFailures += 1;
      }
      snow.inject(privateMessageEvent(OWNER_QQ, `压测消息 ${messages}`, messages));
      // eslint-disable-next-line no-await-in-loop
      await sleep(INTERVAL_MS);
      if (messages % 20 === 0) {
        // eslint-disable-next-line no-await-in-loop
        const r = await consoleStatus(consolePort).catch(() => null);
        check(r?.status === 200, `阶段 A 第 ${messages} 条后控制台不可用`);
        check(r?.body?.dshReady === true, `阶段 A 第 ${messages} 条后 dshReady 变为假`);
      }
    }
    // 等最后几轮回合收尾
    await sleep(600);

    const chatPrompts = dsh.prompts.length;
    const chatSent = snow.outgoing('send_private_msg');
    const chatOk = chatSent.filter((x) => !x.failed).length;
    console.log(`阶段 A（chat）：注入 ${messages} 条私聊，DSH 收到 ${chatPrompts} 次 prompt，`
      + `出站 ${chatSent.length} 次（成功 ${chatOk}），人为注入失败 ${injectedFailures} 次`);
    check(chatPrompts >= Math.floor(messages * 0.5), `阶段 A DSH 收到的 prompt 过少（${chatPrompts}/${messages}）`);
    check(chatOk >= Math.floor(messages * 0.4), `阶段 A 成功出站过少（${chatOk}/${messages}）`);
    check(snow.hasClient(), '阶段 A 结束后 SnowLuma 连接已断开');
    check(!bridgeError, `阶段 A 出现未捕获异常：${bridgeError?.message ?? ''}`);

    // ── 阶段 B：reserved2 连续发送失败 → 暂停唤醒 ──────────────────────
    if (WITH_RESERVED2) {
      // 先让发送通道恢复健康：qqSendChannelStatus 在「最近 2 分钟有失败」时会拦下唤醒，
      // 阶段 A 刚注入过失败，不恢复的话阶段 B 会被这道闸门挡住（那是正确行为，不是缺陷）。
      snow.state.failNextSends = 0;
      snow.state.failNextWsSends = 0;
      const okBefore = snow.outgoing().filter((x) => !x.failed).length;
      snow.inject(privateMessageEvent(OWNER_QQ, '通道恢复探测', messages + 1));
      await waitFor(() => snow.outgoing().filter((x) => !x.failed).length > okBefore, {
        label: '发送通道恢复', timeoutMs: 15000,
      });

      const switched = await consolePost(consolePort, '/api/mode', { mode: 'reserved2' });
      check(switched.status === 200 && switched.body?.ok === true, `切到 reserved2 失败：${switched.text}`);
      const wake = (dsh.prompts.length);

      // 让群消息真正进未读并触发一次唤醒。
      snow.inject(groupMessageEvent(GROUP_ID, MEMBER_QQ, '在吗', { messageId: 9001, atBot: true }));
      const prompt = await waitFor(() => dsh.prompts[wake], { label: 'reserved2 唤醒', timeoutMs: 20000 });
      const promptText = JSON.stringify(prompt.payload);
      const tokenMatch = /【会话令牌】([A-Za-z0-9_-]+)/.exec(promptText);
      check(Boolean(tokenMatch), '唤醒 prompt 未下发会话令牌');
      const key = `group:${GROUP_ID}`;

      // 通道全挂：后续发送工具调用必须全部失败（而不是被吞成成功）。
      snow.state.failNextSends = 200;
      snow.state.failNextWsSends = 200;
      if (tokenMatch) {
        for (let i = 0; i < 3; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await fetch(`http://127.0.0.1:${consolePort}/api/socialV2/send-message?token=${encodeURIComponent(CONSOLE_TOKEN)}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-agent-token': tokenMatch[1],
              'x-agent-call': '1',
              connection: 'close',
            },
            body: JSON.stringify({ key, messages: [`压测失败 ${i + 1}`] }),
          }).catch(() => null);
          // eslint-disable-next-line no-await-in-loop
          await sleep(120);
        }
      }

      const suspended = await waitFor(() => {
        const { doc } = readSocialV2(home);
        const st = doc?.conversations?.[key];
        return st && Number(st.sendFailureStreak) >= 3 && Number(st.wakeSuspendedUntil) > Date.now() ? st : null;
      }, { label: '连续失败后暂停唤醒', timeoutMs: 15000 });
      const { bytes: stateBytes } = readSocialV2(home);
      console.log(`阶段 B（reserved2）：sendFailureStreak=${suspended.sendFailureStreak}，`
        + `唤醒暂停 ${Math.ceil((suspended.wakeSuspendedUntil - Date.now()) / 1000)}s，social-v2.json ${stateBytes} B`);
      check(Number(suspended.wakeSuspendedUntil) > Date.now(), '连续失败后未设置 wakeSuspendedUntil');
      check(stateBytes < 5 * 1024 * 1024, `social-v2.json 异常膨胀（${stateBytes} B）`);

      // 暂停期间再来消息：可以有入站处理，但**不能**再投递唤醒。
      const beforeSuspended = dsh.prompts.length;
      snow.inject(groupMessageEvent(GROUP_ID, MEMBER_QQ, '还在吗', { messageId: 9002, atBot: true }));
      const unread = await waitFor(async () => {
        const r = await socialStates(consolePort).catch(() => null);
        const conv = r?.body?.conversations?.find((c) => c.key === key);
        return conv && conv.unreadCount >= 2 ? conv : null;
      }, { label: '暂停期消息入未读', timeoutMs: 8000 });
      check(unread.unreadCount >= 2, '暂停期的消息没有进入未读');
      await sleep(BATCH_MS + 1200);
      check(dsh.prompts.length === beforeSuspended, '唤醒暂停期间仍然产生了投递');
    }

    // ── 不变量：内存 / 句柄 ────────────────────────────────────────────
    const alive = await consoleStatus(consolePort);
    check(alive.status === 200, '最终控制台不可用');
    check(alive.body?.dshReady === true, '最终 dshReady 为假');
    check(snow.hasClient(), '最终 SnowLuma 连接已断开');
    check(!bridgeError, `出现未捕获异常：${bridgeError?.message ?? ''}`);

    const first = samples[0];
    const last = samples[samples.length - 1];
    const heapGrowth = last.heap - first.heap;
    const resGrowth = last.resources - first.resources;
    console.log(`采样 ${samples.length} 次：堆 ${heapMB(first.heap)}→${heapMB(last.heap)} MB（Δ${heapMB(heapGrowth)}），`
      + `活跃句柄 ${first.resources}→${last.resources}（Δ${resGrowth}）`);
    check(heapGrowth < 96 * 1024 * 1024, `堆增长过大（${heapMB(heapGrowth)} MB）`);
    check(resGrowth <= 15, `活跃句柄增长过大（${resGrowth}）`);

    // 末段爬升检查：最后 5 个采样里堆与句柄都不应持续上升。
    if (samples.length >= 5) {
      const tail = samples.slice(-5);
      const heapRising = tail.every((s, i) => i === 0 || s.heap > tail[i - 1].heap);
      const resRising = tail.every((s, i) => i === 0 || s.resources > tail[i - 1].resources);
      check(!heapRising, '末段堆内存持续单调上升（疑似泄漏）');
      check(!resRising, '末段活跃句柄持续单调上升（疑似泄漏）');
    }
  } finally {
    if (sampler) clearInterval(sampler);
    try { await bridge?.stopEmbedded(); } catch (error) { failures.push(`停止桥接失败：${error?.message ?? error}`); }
    await dsh.close().catch(() => {});
    await snow.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n❌ 长稳检查失败 ${failures.length} 项：`);
    for (const line of failures) console.error(`   · ${line}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 长稳检查通过：无崩溃、无句柄/内存单调增长、故障路径按预期暂停唤醒。');
  }
}

await main();
