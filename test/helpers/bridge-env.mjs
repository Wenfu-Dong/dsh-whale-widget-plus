/**
 * 真链路测试的公共环境：隔离的 DSH_HOME + 最小 config.json + 控制台探活。
 *
 * 关键约束：这些函数必须在 `import('../src/bridge.js')` **之前**调用 ——
 * 桥接模块顶层就会读 DSH_HOME 定位数据根，并做一次旧布局迁移。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONSOLE_TOKEN = 'test-console-token-0123456789';
export const OWNER_QQ = 123456789;

/**
 * 建一个完全隔离的 DSH_HOME 并设好环境变量。
 *
 * 仓库根本身有真实的 config.json / state/（开发机的实际数据），而迁移逻辑会把
 * 「旧布局（仓库根）」缺失的文件复制到数据根。这里放一个诱饵目录当 SURFCORE_ROOT，
 * 让迁移只看到一个空壳，绝不把开发机的聊天状态带进测试。
 */
export function prepareBridgeEnv(prefix = 'dsh-dfy-e2e-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const legacy = path.join(home, 'legacy');
  fs.mkdirSync(path.join(legacy, 'src'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'src', 'bridge.js'), '// decoy\n');
  process.env.DSH_HOME = home;
  process.env.SURFCORE_EMBEDDED = '1';
  process.env.SURFCORE_ROOT = legacy;
  process.env.SURFCORE_SKIP_AUTOSTART = '1';
  return { home, legacy };
}

/** 写数据根的 config.json（QQ_DATA_ROOT = $DSH_HOME/surfcore/qq）。 */
export function writeBridgeConfig(home, { consolePort, dshBaseUrl, snowlumaHttpUrl, snowlumaWsUrl }) {
  const dir = path.join(home, 'surfcore', 'qq');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    consolePort,
    consoleToken: CONSOLE_TOKEN,
    ownerQQ: OWNER_QQ,
    allow: { private: [OWNER_QQ], groups: [] },
    dsh: {
      baseUrl: dshBaseUrl,
      authToken: 'test-launch-token-0123456789',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
    snowluma: { wsUrl: snowlumaWsUrl, httpUrl: snowlumaHttpUrl, accessToken: '' },
    // 测试关注稳定性，不测「活人感」的随机停顿。
    humanize: { gather: false, groupGate: false },
    // 这两项会在回复后/启动时访问外网（表情包 CDN、B 站）。测试机可能离线，
    // 打开它们只会让用例挂在 TCP 连接上，与「稳定性」结论无关。
    stickers: { enabled: false },
    biliBridge: { enabled: false },
  }, null, 2));
}

/** 控制台状态接口（用 connection: close 避免 keep-alive 干扰端口释放断言）。 */
export async function consoleStatus(port, token = CONSOLE_TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}/api/status?token=${encodeURIComponent(token)}`, {
    headers: { connection: 'close' },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}

/** 一条 OneBot v11 私聊消息事件。 */
export function privateMessageEvent(userId, message, messageId = 1) {
  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: 10000,
    user_id: userId,
    time: Math.floor(Date.now() / 1000),
    message_id: messageId,
    message: [{ type: 'text', data: { text: message } }],
    raw_message: message,
    sender: { user_id: userId, nickname: '主人' },
  };
}
