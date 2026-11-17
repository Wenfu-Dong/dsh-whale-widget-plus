/**
 * DSH 协议不兼容的识别与提示。
 *
 * 为什么需要单独一层：DSH 每次升级都可能改 RPC 方法名 / 参数包装 / 事件帧形状。
 * 现在这些差异散落在各处靠 `message.includes('not found')` 之类的临时正则兜底，
 * 一旦漏判，用户看到的是 `transport failure for /api/session/prompt: HTTP 404`
 * 这种既不像网络故障、也不像配置问题的报错，只能来问「插件是不是坏了」。
 *
 * 这里把判据收成一处：
 *   · 严格模式（默认）—— 只认「方法/端点不存在」这类明确信号 + HTTP 404/405/501，
 *     用于给错误附加可读提示，避免把「好友不存在」之类的业务 404 误标成协议问题；
 *   · 宽松模式（loose）—— 额外接受 not found / unknown / unsupported 等泛化措辞，
 *     给「旧端点不存在就换新端点」的回落逻辑用（原来那几处正则的语义）。
 */

/** 明确的协议级信号：方法/端点不存在，或信封形状变了。 */
const STRICT_RE = /unknown method|method\s*not\s*found|unknown endpoint|unsupported method|invalid server-response|unexpected remote stream frame|invalid session\/control baseline|invalid session inbox/i;
/** 宽松模式追加的泛化措辞。 */
const LOOSE_RE = /not.?found|unknown|unsupported|404/i;

function messageOf(input) {
  if (typeof input === 'string') return input;
  return String(input?.message ?? input ?? '');
}

/**
 * 是否属于「DSH 协议不兼容」。
 * @param {unknown} input - Error 或错误信息
 * @param {{ loose?: boolean }} [options]
 */
export function isDshProtocolMismatch(input, { loose = false } = {}) {
  const message = messageOf(input);
  if (STRICT_RE.test(message)) return true;
  if (loose && LOOSE_RE.test(message)) return true;
  const status = typeof input === 'object' && input !== null ? input.dshStatus : undefined;
  return status === 404 || status === 405 || status === 501;
}

/** 给用户/日志看的可读提示。 */
export function protocolHint(method) {
  const target = method ? `「${method}」` : '当前调用';
  return `DSH 协议可能不兼容：${target} 不可用。插件按 DSH 0.1.x / 0.2.x 协议适配，请确认 DSH 版本是否已变化，或升级插件`;
}

/**
 * 给错误补上归属信息与可读提示（幂等）。
 * @param {any} error
 * @param {{ method?: string, path?: string, httpStatus?: number }} [context]
 * @returns {any} 同一个 error（方便 `throw annotateDshError(e, ...)`）
 */
export function annotateDshError(error, { method, path, httpStatus } = {}) {
  if (!error || typeof error !== 'object') return error;
  if (method && !error.dshMethod) error.dshMethod = method;
  if (path && !error.dshPath) error.dshPath = path;
  if (Number.isFinite(httpStatus) && error.dshStatus === undefined) error.dshStatus = httpStatus;
  if (!error.dshProtocolMismatch && isDshProtocolMismatch(error)) {
    error.dshProtocolMismatch = true;
    const hint = protocolHint(method ?? error.dshMethod);
    if (!String(error.message ?? '').includes('DSH 协议可能不兼容')) {
      error.message = `${error.message ?? error}（${hint}）`;
    }
  }
  return error;
}
