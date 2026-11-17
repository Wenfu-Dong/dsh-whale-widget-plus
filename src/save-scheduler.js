/**
 * 合并落盘调度器：脏标记 + **固定滞后**的合并写。
 *
 * 为什么需要（src/bridge.js 的写放大）：`saveSocialV2State()` 是同步全量重写
 * `state/social-v2.json`，而它在每条入站消息、每条出站消息、每次记忆更新后都会被调。
 * 一个多会话实例单次写就有几十~几百 KB，繁忙群等于每条消息一次全文件同步写，
 * 把 DSH 事件循环（桥接与 QQ 事件同一个循环）拖出抖动。
 *
 * 语义约定（调用方必须遵守）：
 *   · `schedule()` —— **可丢的合并写**：只负责「最终会落盘」，用于高频记账/上下文缓冲。
 *   · `flush()`   —— **必须的立即写**：需要崩溃恢复、睡前/收尾、配置变更、会话重置、
 *                    写入后立刻读回、或进程退出时调用（同步完成，抛错被吞并记日志）。
 *
 * 关键取舍：这是「**首次脏标记后固定滞后**」而不是「每次调用都重置计时器」，
 * 否则持续有新消息时计时器会被无限推迟（饥饿），状态可能永远落不了盘。
 * 因此最坏情况下的陈旧窗口 = coalesceMs + 一次写盘耗时，而不是「等到没消息为止」。
 *
 * @param {object} options
 * @param {() => (boolean|void)} options.write   真正的同步落盘函数；返回 false 或抛错视为失败
 * @param {number} [options.coalesceMs]          合并窗口（默认 300ms）
 * @param {number} [options.retryDelayMs]        写失败后的重试基准间隔（默认 max(合并窗口, 1s)）
 * @param {(message:string, error?:unknown) => void} [options.log]
 * @param {Function} [options.setTimeoutImpl]    便于单测注入假定时器
 * @param {Function} [options.clearTimeoutImpl]
 */
export function createCoalescingWriter({
  write,
  coalesceMs = 300,
  retryDelayMs,
  log = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof write !== 'function') throw new Error('createCoalescingWriter: write 必须是函数');
  const delay = Number.isFinite(Number(coalesceMs)) && Number(coalesceMs) > 0 ? Math.round(Number(coalesceMs)) : 300;

  let timer = null;
  let pending = false;
  let writeCount = 0;
  let failureCount = 0;
  // 写失败后的有限重试：Windows 上杀软/搜索索引会短暂占用目标文件，rename 失败是
  // 真实会发生的瞬时故障。失败后若只是返回 false，这批改动要等下一次 schedule()
  // 才会再写 —— 停机前的那一次 flush 失败就等于永久丢数据。
  const MAX_WRITE_RETRIES = 3;
  const retryDelay = Number(retryDelayMs) > 0 ? Number(retryDelayMs) : Math.max(delay, 1000);
  let retryTimer = null;
  let retryCount = 0;

  function armRetry() {
    if (retryCount >= MAX_WRITE_RETRIES) return false;
    retryCount += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      flush();
    }, retryDelay * retryCount);
    if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
    return true;
  }

  /** 立即落盘（幂等：没有待写内容也允许调用，用于「必须确认已经落盘」的语义点）。 */
  function flush() {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    pending = false;
    writeCount += 1;
    try {
      const result = write();
      if (result === false) throw new Error('write() 返回 false');
      retryCount = 0;
      return true;
    } catch (error) {
      failureCount += 1;
      // 这次写没有生效：恢复脏标记，否则这批状态只能等下一次 schedule() 才有机会落盘。
      pending = true;
      const retried = armRetry();
      try { log(retried ? '合并落盘失败，已安排重试' : '合并落盘失败，重试次数已用尽', error); } catch {}
      return false;
    }
  }

  /** 标记为脏并安排一次合并写；已安排则不重置计时器（避免饥饿）。 */
  function schedule() {
    pending = true;
    if (timer) return false;
    timer = setTimeoutImpl(() => {
      timer = null;
      if (pending) flush();
    }, delay);
    // 未落盘的合并写不该拖住进程退出（退出路径会显式 flush）。
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  /**
   * 丢弃待写的合并任务（**不写盘**）。
   *
   * 用途：调用方即将「直写」目标文件（例如控制台把 social-v2.json 重置成空对象）。
   * 不取消的话，300ms 后合并写会把内存里的旧快照整个写回去 —— 刚做的重置当场复活。
   */
  function cancel() {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
    const had = pending;
    pending = false;
    return had;
  }

  return {
    schedule,
    flush,
    cancel,
    get pending() { return pending; },
    get scheduled() { return timer !== null || retryTimer !== null; },
    get coalesceMs() { return delay; },
    stats: () => ({
      writeCount, failureCount, retryCount, pending,
      scheduled: timer !== null || retryTimer !== null, coalesceMs: delay,
    }),
  };
}
