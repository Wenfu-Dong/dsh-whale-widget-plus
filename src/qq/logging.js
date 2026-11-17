/**
 * 日志 / 活动流水 / 主人审计 / 身份对齐块。
 *
 * 从 src/bridge.js 拆出。此前这些写盘逻辑和业务代码混在一起，且日志路径、
 * 截断长度、脱敏入口各自硬编码；现在统一由工厂注入，路径与脱敏策略只有一份。
 */
import fs from 'node:fs';
import { createOwnerAudit } from '../owner-audit.js';

export function createLogging({
  stateDir,
  bridgeLogFile,
  activityLogFile,
  publicFeedFile,
  alignmentBriefFile,
  embedded = false,
  redact = (value) => value,
}) {
  // 下面这段是从 bridge.js 原样搬出的实现，用局部别名保持零改动。
  const STATE_DIR = stateDir;
  const BRIDGE_LOG = bridgeLogFile;
  const ACTIVITY_LOG = activityLogFile;
  const PUBLIC_FEED = publicFeedFile;
  const ALIGNMENT_BRIEF = alignmentBriefFile;
  const EMBEDDED_MODE = embedded;
  const redactSensitiveText = redact;
/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  // 嵌入 DSH 时只写 state/bridge.log，不往 DSH 的终端刷屏（SnowLuma 未启动时会反复重连）。
  try { if (!EMBEDDED_MODE) console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}

// 主人特权操作审计（单写者：桥接；插件只读）。写入失败不阻塞业务，health 由 /api/status 暴露。
const ownerAudit = createOwnerAudit({ dir: STATE_DIR, log: (...args) => log(...args) });
const auditOnceAt = new Map();
function auditOnce(scope, key, ms = 60_000) {
  const id = `${scope}|${key}`;
  const last = auditOnceAt.get(id) ?? 0;
  if (Date.now() - last < ms) return false;
  auditOnceAt.set(id, Date.now());
  return true;
}
function auditOwner(event, { actor, rule = '', decision = '', ok = true, errorCode = '', ref = null } = {}) {
  ownerAudit.append(event, {
    actor: actor ? { platform: 'qq', ...actor } : null,
    auth: { rule, decision },
    result: { ok: ok !== false, ...(errorCode ? { errorCode } : {}) },
    ref,
  });
}
function auditActor(userId, isOwner) {
  return { id: String(userId ?? ''), isOwner: isOwner === true };
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// ── 合体插件：公开群消息单向日志（QQ → B站 记忆的唯一来源）────────────────────
// 只记录「已经通过白名单/模式闸门、且不是私信」的群消息。合体插件的隐私闸门再从这里
// 做二次过滤（密钥/手机号/地址/私信话题/QQ号一律剔除）。桥接本身不做语义判断，只守住
// “绝不写私信”这条结构性边界。
const appendPublicFeedLog = createCappedLogger(PUBLIC_FEED, 5000);
function appendPublicFeed(entry) {
  try {
    const text = String(entry?.text ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1200);
    if (!text) return;
    appendPublicFeedLog(`${JSON.stringify({
      at: new Date().toISOString(),
      groupId: String(entry.groupId ?? ''),
      senderId: String(entry.senderId ?? ''),
      senderName: String(entry.senderName ?? '').slice(0, 60),
      isOwner: entry.isOwner === true,
      text,
    })}\n`);
  } catch {}
}

// 身份对齐提示块：文件由合体插件写，桥接只读。缓存按 mtime 失效，每轮不重复读盘。
let alignmentBriefCache = { mtime: -1, text: '' };
function alignmentBriefBlock() {
  try {
    const stat = fs.statSync(ALIGNMENT_BRIEF);
    if (stat.mtimeMs === alignmentBriefCache.mtime) return alignmentBriefCache.text;
    const text = fs.readFileSync(ALIGNMENT_BRIEF, 'utf8').trim();
    const capped = text.length > 8000 ? `${text.slice(0, 8000)}\n（后略：对齐表过长）` : text;
    alignmentBriefCache = { mtime: stat.mtimeMs, text: capped };
    return capped;
  } catch {
    return '';
  }
}
  function readActivityTail(n) {
    try {
      const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-n).join('\n');
    } catch {
      return '';
    }
  }

  return {
    createCappedLogger, localClock, log, auditOnce, auditOwner, auditActor, ownerAudit,
    appendActivity, appendPublicFeed, alignmentBriefBlock, readActivityTail,
  };
}

