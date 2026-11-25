/**
 * 抖音发送兜底：SDK 被官方签名校验拦截（check=10509）时，改走专用浏览器的抖音网页版。
 *
 * 只做一件事：按「会话显示名 + 群/私聊」在网页版会话列表里精确找到唯一会话，
 * 把剩下的文本逐条发出去。复用 vendor 的 ChatBrowser：
 *   · 列表必须唯一匹配，同名/类型不明一律拒发；
 *   · 发送前后由 ChatBrowser 自己核对会话身份、输入框和发送按钮；
 *   · 只补发 SDK 没发成功的剩余条，避免重复。
 */
import { setTimeout as delay } from 'node:timers/promises';

const SEND_TIMEOUT_MS = 120_000;
const BETWEEN_BUBBLE_MS = 600;

let browserPromise = null;

/** 默认复用 vendor 的专用浏览器（和「打开抖音窗口」是同一个 Edge 资料目录）。 */
function defaultBrowser() {
  if (!browserPromise) {
    browserPromise = import('../vendor/douyin/chat-browser.mjs')
      .then(({ ChatBrowser }) => new ChatBrowser({ source: 'api-chat' }))
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

export function normalizeDouyinName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 群名后面常跟未读数/人数，如「大肥鱼交流群 (3)」；只对群聊去掉这个尾巴。 */
function stripGroupSuffix(name) {
  return name.replace(/\s*\(\d{1,6}\+?\)$/, '').trim();
}

export function matchDouyinContacts(contacts, { displayName, isGroup } = {}) {
  const target = normalizeDouyinName(displayName);
  if (!target) return [];
  const wantedGroup = isGroup === true;
  return (Array.isArray(contacts) ? contacts : []).filter((item) => {
    if (!item || item.isGroup !== wantedGroup) return false;
    const name = normalizeDouyinName(item.displayName ?? item.name);
    if (!name) return false;
    if (name === target) return true;
    return wantedGroup && stripGroupSuffix(name) === stripGroupSuffix(target);
  });
}

function describeError(error) {
  return String(error?.message ?? error ?? '').slice(0, 200) || '未知错误';
}

/**
 * 把 texts 逐条发到指定会话。
 * @returns {Promise<{ok: boolean, sent: number, reason?: string, contact?: object}>}
 */
export async function sendDouyinWebMessages({ displayName, isGroup, texts, signal, browser, log = () => {} } = {}) {
  const bubbles = (Array.isArray(texts) ? texts : []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (!bubbles.length) return { ok: false, sent: 0, reason: '没有要补发的内容' };
  stop(signal);

  const timeout = signal ? null : AbortSignal.timeout(SEND_TIMEOUT_MS);
  const activeSignal = signal ?? timeout;
  let sent = 0;
  let instance;
  try {
    instance = browser ?? await defaultBrowser();
    stop(activeSignal);
    const list = await instance.listContacts({ signal: activeSignal, verifyFollowing: false });
    if (list?.blocked || list?.loginRequired || list?.verificationRequired) {
      return { ok: false, sent: 0, reason: '专用浏览器的抖音网页版未登录，需在「打开抖音窗口」用同一个抖音账号扫码登录' };
    }
    const matches = matchDouyinContacts(list?.contacts, { displayName, isGroup });
    if (matches.length !== 1) {
      const name = String(displayName || '').trim() || '（空）';
      return {
        ok: false,
        sent: 0,
        reason: matches.length
          ? `网页版里有 ${matches.length} 个同名${isGroup === true ? '群聊' : '会话'}「${name}」，无法确定发给谁`
          : `网页版会话列表里没有找到${isGroup === true ? '群聊' : '私聊'}「${name}」`,
      };
    }
    const contact = matches[0];
    for (let index = 0; index < bubbles.length; index += 1) {
      stop(activeSignal);
      const result = await instance.sendMessage(contact.id, bubbles[index], { allowed: true, signal: activeSignal, weak: true });
      if (result?.blocked) return { ok: false, sent, reason: '发送时网页版要求重新登录或验证' };
      if (result?.confirmed !== true) {
        return { ok: false, sent, reason: String(result?.reason || '网页版没有确认消息已发出') };
      }
      sent += 1;
      log(`[网页兜底] 已发送 ${sent}/${bubbles.length} 条 → ${contact.displayName || displayName}`);
      if (index < bubbles.length - 1) await delay(Math.min(2500, BETWEEN_BUBBLE_MS + bubbles[index].length * 60), undefined, { signal: activeSignal });
    }
    return {
      ok: true,
      sent,
      contact: { id: contact.id, displayName: contact.displayName || displayName, isGroup: contact.isGroup === true },
    };
  } catch (error) {
    return { ok: false, sent, reason: describeError(error) };
  }
}

function stop(signal) {
  signal?.throwIfAborted();
}
