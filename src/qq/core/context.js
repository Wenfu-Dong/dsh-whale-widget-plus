/**
 * 组件运行时上下文。
 *
 * 一个组件能拿到的东西只有这些：日志、配置（活对象，热重载后同一个引用）、
 * 路径，以及别的组件 init() 返回的 API。不提供「随便读 main() 闭包变量」的口子 ——
 * 那正是现在 problem 的源头：功能之间靠改别人的变量通信。
 */
export function createCoreContext({ log = () => {}, config = {}, paths = {}, services = {} } = {}) {
  const shared = new Map(Object.entries(services ?? {}));
  return {
    log,
    config,
    paths,
    /** 注册/覆盖一个共享服务（组件 init 返回值由 registry 自动 provide）。 */
    provide(id, api) {
      if (typeof id !== 'string' || !id) throw new TypeError('provide 需要非空 id');
      shared.set(id, api);
      return api;
    },
    /** 取共享服务；缺失时明确报错，避免 undefined 一路传下去。 */
    get(id) {
      if (!shared.has(id)) {
        throw new Error(`共享服务未提供：${id}（检查组件 deps 与启动顺序）`);
      }
      return shared.get(id);
    },
    has(id) {
      return shared.has(id);
    },
    loaded() {
      return [...shared.keys()];
    },
  };
}
