/**
 * 早安问候（组件化样板）。
 *
 * 从 src/bridge.js 的 main() 里整块搬出：状态文件、排程定时器、试发接口都归本组件。
 * 外部只注入运行期依赖（投递 prompt、发 QQ、在线状态、当前模式、好友列表），
 * 组件不读 main() 的闭包变量 —— 这样它坏了就是它坏了，不会牵动别的功能。
 */
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import { atomicWriteJson, readConfigObject, readJsonSafe } from '../json-io.js';
import { normalizeIdList } from '../config.js';
import {
  GREETING_RETRY_MS,
  buildMorningGreetingPrompt,
  localDateKey,
  parseGreetingTime,
  pickGreetingTheme,
  planMorningGreeting,
} from '../../greeting-schedule.js';

/**
 * @param {object} deps
 * @param {string} deps.stateDir           state 目录（greetings.json 落在这里）
 * @param {string} deps.configFile         config.json 路径（试发前从磁盘重读）
 * @param {Function} deps.log
 * @param {() => object} deps.getConfig    返回 main() 里那份活配置对象（热更新可见）
 * @param {(kind: string, id: number) => boolean} deps.allowed  白名单判定（已绑定当前配置）
 * @param {(key: string, prompt: string) => Promise<any>} deps.deliverPrompt
 * @param {(key: string, text: string) => Promise<any>} deps.sendToQQ
 * @param {() => boolean} deps.isDshReady
 * @param {() => string} deps.getMode
 * @param {(key: string) => object|null|undefined} deps.socialV2State
 * @param {() => any} deps.getBot           OneBot 客户端（好友列表查询用）
 * @param {(p: Promise, ms: number, label: string) => Promise<any>} deps.withTimeout
 */
export function createMorningGreetingComponent(deps) {
  const {
    stateDir, configFile, log, getConfig, allowed, deliverPrompt, sendToQQ,
    isDshReady, getMode, socialV2State, getBot, withTimeout,
  } = deps || {};
  for (const [name, value] of Object.entries({
    stateDir, configFile, log, getConfig, allowed, deliverPrompt, sendToQQ,
    isDshReady, getMode, socialV2State, getBot, withTimeout,
  })) {
    if (value === undefined || value === null) {
      throw new TypeError(`morning-greeting 缺少依赖：${name}`);
    }
  }
  const stateFile = path.join(stateDir, 'greetings.json');
  let timer = null;

  function readState() {
    const raw = readJsonSafe(stateFile, null);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  function writeState(patch) {
    try {
      atomicWriteJson(stateFile, { ...readState(), ...(patch ?? {}) });
    } catch (error) {
      log(`[早安] 写 state/greetings.json 失败：${error?.message ?? error}`);
    }
  }

  // 好友列表缓存：QQ 对「非好友」的私聊一律 result=16（请先添加对方为好友）。
  // 发之前先查一次，并把原因推给管理员，而不是只在日志里留一行。
  let friendListCache = { at: 0, ids: null };
  async function friendCheck(uin) {
    const now = Date.now();
    if (!friendListCache.ids || now - friendListCache.at > 10 * 60 * 1000) {
      try {
        const data = await withTimeout(getBot().raw('get_friend_list', {}), 6000, 'get_friend_list');
        const list = Array.isArray(data) ? data : (data?.data ?? []);
        friendListCache = { at: now, ids: new Set(list.map((x) => String(x?.user_id ?? ''))) };
      } catch (error) {
        // 查不到不拦（可能是老运行时没有这个接口），交给发送失败暴露。
        log(`[早安] 好友列表查询失败（按可发送继续）：${error?.message ?? error}`);
        return { checked: false, ok: true };
      }
    }
    return { checked: true, ok: friendListCache.ids.has(String(uin)) };
  }

  /**
   * 发一次早安。
   * @param {{manual?: boolean}} [options] manual=true（设置页试发）不占用「今天已发」名额
   * @returns {Promise<{ok: boolean, retry?: boolean, reason?: string}>}
   */
  async function fire({ manual = false } = {}) {
    const cfg = getConfig();
    const conf = cfg.greetings?.morning;
    if (!conf) return { ok: false, reason: '未配置' };
    const uin = String(conf.uin ?? '');
    const key = `private:${uin}`;
    if (!uin || !allowed('private', Number(uin))) {
      log(`[早安] ${uin} 不在白名单，跳过`);
      return { ok: false, reason: '不在白名单' };
    }
    const today = localDateKey();
    if (!manual && readState().lastMorningDate === today) {
      log('[早安] 今天已经发过，跳过');
      return { ok: true, reason: '已发过' };
    }
    // 「不是好友」不会因为重试而变好：当天标记为已处理，避免每 10 分钟重试刷屏；
    // 同时给管理员私聊一条原因（一天最多一次）。
    const reach = await friendCheck(uin);
    if (reach.checked && !reach.ok) {
      const reason = `目标 QQ ${uin} 不在机器人好友列表：QQ 会拒绝私聊（result=16「请先添加对方为好友」）`;
      log(`[早安] ${reason}`);
      if (!manual) {
        const st = readState();
        writeState({
          lastMorningDate: today,
          lastMorningAt: new Date().toISOString(),
          lastMorningOk: false,
          lastMorningError: reason,
        });
        if (cfg.ownerQQ && st.lastTargetWarnDate !== today) {
          writeState({ lastTargetWarnDate: today });
          try {
            await sendToQQ(`private:${cfg.ownerQQ}`,
              `⚠️ 早安问候没发出去：${reason}。\n去设置页把问候对象换成好友，或先用那个号加机器人好友。`);
          } catch (error) {
            log(`[早安] 给管理员发失败告警失败：${error?.message ?? error}`);
          }
        }
      }
      return { ok: false, reason };
    }
    if (!isDshReady()) {
      // 不把整天丢掉：交给排程重试，DSH 一恢复就能补上。
      log(`[早安] DSH 不在线，${Math.round(GREETING_RETRY_MS / 60000)} 分钟后重试`);
      return { ok: false, retry: true, reason: 'DSH 离线' };
    }
    const mode = getMode();
    const timeText = parseGreetingTime(conf.time).text;
    const catchUp = !manual && Date.now() > (() => {
      const t = new Date();
      t.setHours(parseGreetingTime(conf.time).hh, parseGreetingTime(conf.time).mm, 0, 0);
      return t.getTime();
    })();
    const theme = pickGreetingTheme();
    const who = String(conf.name ?? '').trim() || `QQ ${uin}`;
    // reserved2 的发送工具要会话令牌（wake prompt 里本来也会带），这里补上。
    const greetingToken = mode === 'reserved2' ? (socialV2State(key)?.agentToken ?? '') : '';
    const promptText = buildMorningGreetingPrompt({
      who, uin, time: timeText, theme, mode, catchUp, token: greetingToken,
    });
    try {
      await deliverPrompt(key, promptText);
      if (!manual) {
        writeState({
          lastMorningDate: today,
          lastMorningAt: new Date().toISOString(),
          lastMorningOk: true,
          lastMorningTheme: theme,
        });
      } else {
        writeState({ lastManualAt: new Date().toISOString(), lastManualOk: true });
      }
      log(`[早安] 已投递 ${key}（主题：${theme}${manual ? '，手动试发' : catchUp ? '，补发' : ''}）`);
      return { ok: true };
    } catch (error) {
      const message = String(error?.message ?? error);
      writeState({ lastMorningError: message, lastMorningAttemptAt: new Date().toISOString() });
      log(`[早安] 投递失败 ${key}：${message}（${Math.round(GREETING_RETRY_MS / 60000)} 分钟后重试）`);
      return { ok: false, retry: true, reason: message };
    }
  }

  function schedule({ retryDelayMs = 0 } = {}) {
    const cfg = getConfig();
    const conf = cfg.greetings?.morning;
    if (!conf || cfg.greetings?.enabled === false) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const { hh, mm, text: hhmm } = parseGreetingTime(conf.time);
    const plan = planMorningGreeting({
      now: Date.now(),
      hh,
      mm,
      sentToday: readState().lastMorningDate === localDateKey(),
      retryDelayMs,
    });
    timer = setTimeout(() => {
      fire()
        .catch((e) => log(`[早安] 异常：${e?.message ?? e}`))
        .then((result) => schedule({ retryDelayMs: result?.retry ? GREETING_RETRY_MS : 0 }));
    }, Math.max(0, plan.fireAt - Date.now()));
    const modeLabel = { scheduled: '准点', catchup: '补发', retry: '重试', tomorrow: '明天' }[plan.mode] ?? plan.mode;
    log(`[早安] 已排定（${modeLabel}）：每天 ${hhmm} → ${conf.uin}（下次 ${new Date(plan.fireAt).toLocaleString()}）`);
  }

  function dispose() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  // ── POST /api/greeting/test：设置页立即试发 ────────────────────────────────
  // 从磁盘重读 greetings，避免「设置页刚保存但桥接还没重启」时试发旧配置。
  async function handleTest(ctx, io) {
    const { sendJson, readBody } = io;
    try {
      // readBody() 已经返回解析好的对象（空体是 {}），不要再 JSON.parse。
      const body = await readBody();
      const cfg = getConfig();
      const file = readConfigObject(configFile);
      const m = file.greetings?.morning;
      const uin = m ? normalizeIdList([m.uin])[0] : null;
      cfg.greetings = {
        enabled: file.greetings?.enabled !== false && Boolean(m && uin),
        morning: m && uin ? { time: String(m.time ?? '08:00'), uin, name: String(m.name ?? '').trim().slice(0, 40) } : null,
      };
      // 临时换对象试发（只影响这一次调用，不写回 config.json）：
      // 目标必须在私聊白名单里，避免变成「任意号码探测」。
      if (body.uin != null && String(body.uin).trim()) {
        const override = normalizeIdList([body.uin])[0];
        if (!override || !allowed('private', Number(override))) {
          sendJson({ ok: false, error: `试发目标 ${body.uin} 不在私聊白名单` }, 400);
          return;
        }
        if (!cfg.greetings.morning) cfg.greetings.morning = { time: '08:00', uin: override, name: '' };
        cfg.greetings.morning = { ...cfg.greetings.morning, uin: override, name: String(body.name ?? cfg.greetings.morning.name ?? '').slice(0, 40) };
        cfg.greetings.enabled = true;
      }
      if (!cfg.greetings.enabled || !cfg.greetings.morning) {
        sendJson({ ok: false, error: '早安问候未启用或未填写要问候的 QQ' }, 400);
        return;
      }
      // manual=true：试发不占用「今天已发」名额，也不改下一次准点排程。
      const result = await fire({ manual: true });
      if (!result.ok) {
        sendJson({ ok: false, error: `试发失败：${result.reason ?? '未知原因'}` }, 500);
        return;
      }
      sendJson({ ok: true, greeting: cfg.greetings, message: `已投递早安问候 → ${cfg.greetings.morning.uin}` });
    } catch (error) {
      sendJson({ ok: false, error: `试发失败：${error?.message ?? error}` }, 500);
    }
  }

  return defineComponent({
    id: 'morning-greeting',
    routes: [{ method: 'POST', path: '/api/greeting/test', handle: handleTest }],
    init() {
      return { fire, schedule, dispose, friendCheck, readState, writeState };
    },
    stop(ctx, api) {
      api?.dispose?.();
    },
  });
}
