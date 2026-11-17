/**
 * 最小 DSH 宿主桩（只给安装模拟 / 测试用，不参与运行时）。
 *
 * 目的：**不启动真实 DSH** 也能把 `lib/index.js` 的 `apply()` 完整走一遍，
 * 从而在「装完能不能激活」「DSH 老版本少了某个服务会不会整体失败」这两件事上
 * 拿到确定结论，而不是等用户装完才发现。
 *
 * 两种能力档位：
 *   · full   —— 当前 DSH（webServer / connection / sessionController / credentials / settings 都在）
 *   · legacy —— 老版本 DSH（没有 tapIndex / credentials / connection / sessionController）
 *
 * 约定：桩里任何回调抛出的异常都会被收集到 `errors`，不静默吞掉 —— 这些正是
 * 「插件让宿主起不来」的候选根因。
 */

const noop = () => {};

export function createStubHost({ profile = 'full', onError = () => {} } = {}) {
  const legacy = profile === 'legacy';
  const routes = [];
  const listeners = new Map();
  const disposers = [];
  const errors = [];

  const record = (fn) => {
    try {
      const result = fn();
      if (typeof result === 'function') disposers.push(result);
      return result;
    } catch (error) {
      errors.push(error);
      onError(error);
      return undefined;
    }
  };

  const webServer = {
    register(def) {
      routes.push(def);
      return noop;
    },
    tapIndex() {
      return noop;
    },
  };

  const credentials = {
    async resolve() { return null; },
    async set() { return undefined; },
    async delete() { return undefined; },
  };

  const connection = {
    requestRejection() { return undefined; },
  };

  const services = {
    webServer,
    connection,
    sessionController: {},
    credentials,
    settings: { get: () => undefined, set: () => undefined },
  };

  const ctx = {
    // 真实 cordis 的子 ctx 会把服务同时挂成属性（代码里有 `ctx.webServer.register`、
    // `ctx.credentials.resolve` 这种直接访问），桩必须保持一致。
    webServer,
    ...(legacy ? {} : { credentials, connection }),
    get(name) {
      if (legacy) return name === 'webServer' ? webServer : undefined;
      return services[name];
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return noop;
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) record(() => fn(...args));
    },
    effect(fn) {
      record(fn);
      return noop;
    },
    inject(deps, cb) {
      // 真实宿主会等依赖服务就绪；这里视为「立即就绪」，但要模拟老版本服务缺失。
      const sub = {
        ...ctx,
        get(name) {
          if (Array.isArray(deps) && deps.includes(name)) {
            return legacy ? undefined : services[name];
          }
          return ctx.get(name);
        },
      };
      return record(() => cb(sub));
    },
  };

  return { ctx, routes, listeners, errors, disposers, legacy };
}
