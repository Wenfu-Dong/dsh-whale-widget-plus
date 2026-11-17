/**
 * P0 真链路护栏（1/3）：内嵌桥接能起来、能干净地停下。
 *
 * 这条用例存在的理由不是「验证业务」，而是插件分发最致命的三件事：
 *   1. 装上之后能不能起来（配置缺项/宿主不可达时不许把 DSH 带崩）；
 *   2. 起来之后宿主能看到控制台（端口真的在监听、令牌校验生效）；
 *   3. 停的时候能不能把句柄收干净（否则 DSH 退出会挂住 / 热重载会双实例）。
 *
 * 依赖全部是真实边界：真实 HTTP/WS 服务器（test/helpers/fake-hosts.mjs）、
 * 真实的 config.json / DSH_HOME 目录、真实的 @snowluma/sdk 客户端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFakeDsh, startFakeSnowluma, getFreePort, waitFor } from './helpers/fake-hosts.mjs';
import { prepareBridgeEnv, writeBridgeConfig, consoleStatus } from './helpers/bridge-env.mjs';

test('内嵌桥接：能启动控制台、能收干净地停止', async (t) => {
  const { home } = prepareBridgeEnv();
  const consolePort = await getFreePort();
  const dsh = await startFakeDsh();
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
    // 动态 import：必须晚于环境变量设置（见 bridge-env.mjs 注释）。
    bridge = await import('../src/bridge.js');
    // main() 以「后台任务」方式运行（内部 await pumpMux 是长循环），不能 await。
    bridge.main({ embed: true }).catch((error) => { startError = error; });

    const ready = await waitFor(async () => {
      const r = await consoleStatus(consolePort).catch(() => null);
      if (r?.status === 200) return r;
      if (startError) throw startError;
      return null;
    }, { label: '控制台端口就绪' });
    assert.equal(ready.status, 200);
    assert.ok(ready.body && typeof ready.body === 'object', '状态接口应返回 JSON 对象');

    // 鉴权是失败关闭：错令牌不许放行。
    const denied = await consoleStatus(consolePort, 'wrong-token-0123456789');
    assert.equal(denied.status, 401);

    // DSH 侧确实被访问过（settings/describe 是启动探测）。
    await waitFor(() => dsh.rpcCalls.some((c) => c.method === 'settings/describe'), { label: 'DSH 启动探测' });
    // SnowLuma 侧的 WebSocket 客户端确实连上了。
    await waitFor(() => snow.hasClient(), { label: 'SnowLuma WS 连接' });

    const stop = await bridge.stopEmbedded();
    assert.equal(stop.ok, true);

    // 停止后端口必须释放（否则热重载/再次启动会撞 EADDRINUSE）。
    await waitFor(async () => {
      try { await consoleStatus(consolePort); return false; } catch { return true; }
    }, { label: '控制台端口释放', timeoutMs: 8000 });
    // SDK 的 close() 是异步的：给对方一个断开的时间窗口，而不是假设瞬时完成。
    // 这里同时守着「stop 之后不许再自愈重连」——主动关闭会触发 close 事件，
    // 自愈一旦成功就会把连接重新拉起来（已修复，见 healTokenIfStale 的 shuttingDown 闸门）。
    await waitFor(() => snow.hasClient() === false, { label: 'SnowLuma 连接断开', timeoutMs: 8000 });
    assert.equal(startError, null, `启动期不应有未捕获异常：${startError?.message ?? ''}`);
  } finally {
    try { await bridge?.stopEmbedded(); } catch {}
    await dsh.close();
    await snow.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
