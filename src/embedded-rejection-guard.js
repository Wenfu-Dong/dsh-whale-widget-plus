/**
 * 嵌入模式下的 unhandledRejection 隔离。
 *
 * 背景：Node 15+ 默认把未处理的 Promise 拒绝升级成致命异常。独立进程里这最多让
 * bridge 自己退出（守护脚本会拉起）；但嵌入 DSH 后，同一个进程就是宿主 ——
 * 一次泄漏的拒绝会把整个 DSH 带走，用户看到的就是「装了插件 DSH 打不开」。
 *
 * 策略：**只吞自己的**
 *   · 拒绝堆栈里出现本包路径 → 记一条日志后吞掉，宿主继续跑；
 *   · 其他任何来源 → 摘掉自己再把错误抛出去，保持宿主原有行为。
 *
 * 为什么必须按堆栈归属判断：Promise 不携带「产生它的模块」，全局监听器无法知道
 * 这次拒绝是不是本插件造成的。无差别吞掉会掩盖 DSH 自身的致命错误（比崩溃更难
 * 排查），所以宁可对外部错误维持默认语义。
 *
 * 有意不处理 uncaughtException：那是同步代码/回调里的异常，Node 文档明确说
 * 恢复运行后进程状态未定义。把宿主从「明确崩溃」改成「带病继续跑」风险更大。
 */
function normalizePath(input) {
  const value = String(input ?? '').replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * 判断一段堆栈是否来自本插件。
 * @param {string} stack - `error.stack` 或字符串化的拒绝原因
 * @param {string} rootDir - 插件包根目录
 * @returns {boolean}
 */
export function isOwnStack(stack, rootDir) {
  const text = normalizePath(stack);
  const root = normalizePath(rootDir).replace(/\/+$/, '');
  if (!text || !root) return false;
  // 必须带尾随斜杠，避免 `/pkg-other` 命中 `/pkg` 这种前缀误判。
  return text.includes(`${root}/`);
}

/**
 * @param {object} options
 * @param {string} options.rootDir - 插件包根目录（堆栈归属判据）
 * @param {(...args:any[]) => void} [options.log] - 记录被隔离的拒绝
 * @param {(reason:any) => void} [options.onForeign] - 外部拒绝的接管回调；
 *        不提供时恢复默认行为（摘掉监听后重新抛出）
 */
export function createEmbeddedRejectionGuard({ rootDir, log = () => {}, onForeign } = {}) {
  let installed = false;

  const uninstall = () => {
    if (!installed) return;
    installed = false;
    process.removeListener('unhandledRejection', handler);
  };

  const handler = (reason) => {
    const stack = String(reason?.stack ?? reason ?? '');
    if (isOwnStack(stack, rootDir)) {
      try {
        log('嵌入模式：已隔离本插件内部的未处理拒绝（DSH 继续运行）', stack.slice(0, 4000));
      } catch { /* 日志失败也不能反过来影响宿主 */ }
      return;
    }
    if (typeof onForeign === 'function') {
      onForeign(reason);
      return;
    }
    // 恢复 Node 的默认语义：没有本监听器时，未处理拒绝会变成致命异常。
    uninstall();
    throw reason;
  };

  const install = () => {
    if (installed) return;
    installed = true;
    process.on('unhandledRejection', handler);
  };

  return {
    install,
    uninstall,
    handler,
    get installed() { return installed; },
  };
}
