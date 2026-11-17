/**
 * 功能组件注册表。
 *
 * 背景：src/bridge.js 的 main() 是一个 1.6 万行的闭包，所有功能（表情库、黑话、
 * 早安、目的、B站……）的状态、定时器、HTTP 路由都塞在同一层。任何一处改动都可能
 * 碰到别人的变量，于是只能靠「打补丁」维持；出了问题也难说是谁的。
 *
 * 这里给出的契约很小：
 *   { id, deps?, init?, start?, stop?, routes? }
 *
 *  - id     ：稳定标识，别的组件用 deps 引用它；
 *  - deps   ：启动顺序依赖（只影响 init/start 的先后，不做服务发现）；
 *  - init   ：返回该组件对外暴露的 API，注册表存起来，ctx.get(id) 可取；
 *  - start  ：启动副作用（定时器、订阅）；stop 必须能把它收干净；
 *  - routes ：自带 HTTP 路由表，注册即生效，不再往 main() 的 if 链里加分支。
 *
 * 设计原则（与前端 React 组件一致）：
 *  1. 组件只通过注入的依赖与外界交互，不读别人的闭包变量；
 *  2. 路由、状态、定时器都属于组件自己，删除组件不会留下悬挂定时器；
 *  3. 依赖缺失 / 路由冲突在**启动时**报错，而不是运行时才 undefined。
 */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function assertRoute(componentId, route) {
  if (!route || typeof route !== 'object') {
    throw new TypeError(`[component:${componentId}] route 必须是对象`);
  }
  if (route.method !== '*' && !HTTP_METHODS.has(route.method)) {
    throw new TypeError(`[component:${componentId}] route.method 非法：${String(route.method)}`);
  }
  if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
    if (!(route.pattern instanceof RegExp)) {
      throw new TypeError(`[component:${componentId}] route 需要 path（以 / 开头）或 pattern（RegExp）`);
    }
  }
  if (typeof route.handle !== 'function') {
    throw new TypeError(`[component:${componentId}] route.handle 必须是函数`);
  }
}

/** 校验并冻结一个组件声明；非法声明在注册前就抛错。 */
export function defineComponent(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('组件必须是对象');
  const id = String(spec.id ?? '').trim();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new TypeError(`组件 id 非法（小写字母开头，只含小写字母/数字/连字符）：${id || '(空)'}`);
  }
  const deps = spec.deps ?? [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !d.trim())) {
    throw new TypeError(`[component:${id}] deps 必须是非空字符串数组`);
  }
  if (deps.includes(id)) throw new TypeError(`[component:${id}] 不能依赖自己`);
  if (spec.init !== undefined && typeof spec.init !== 'function') {
    throw new TypeError(`[component:${id}] init 必须是函数`);
  }
  if (spec.start !== undefined && typeof spec.start !== 'function') {
    throw new TypeError(`[component:${id}] start 必须是函数`);
  }
  if (spec.stop !== undefined && typeof spec.stop !== 'function') {
    throw new TypeError(`[component:${id}] stop 必须是函数`);
  }
  const routes = spec.routes ?? [];
  if (!Array.isArray(routes)) throw new TypeError(`[component:${id}] routes 必须是数组`);
  for (const route of routes) assertRoute(id, route);
  return Object.freeze({
    id,
    deps: Object.freeze([...deps]),
    init: spec.init,
    start: spec.start,
    stop: spec.stop,
    routes: Object.freeze([...routes]),
  });
}

function routeKey(route) {
  return `${route.method} ${typeof route.path === 'string' ? route.path : route.pattern}`;
}

export function createRegistry({ log = () => {} } = {}) {
  /** @type {Map<string, ReturnType<typeof defineComponent>>} */
  const components = new Map();
  /** @type {Map<string, unknown>} init 返回的对外 API */
  const apis = new Map();
  /** 已成功启动的组件 id（按启动顺序，用于逆序停止） */
  const started = [];
  let ctxRef = null;

  function register(spec) {
    const component = spec && Object.isFrozen(spec) && Array.isArray(spec.deps)
      ? spec
      : defineComponent(spec);
    if (components.has(component.id)) {
      throw new Error(`组件重复注册：${component.id}`);
    }
    components.set(component.id, component);
    return component;
  }

  /** 依赖解析：缺依赖或成环都直接报错，顺序按注册顺序稳定输出。 */
  function resolveOrder() {
    const order = [];
    const visiting = new Set();
    const done = new Set();
    const visit = (id, chain) => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`组件依赖成环：${[...chain, id].join(' → ')}`);
      }
      const component = components.get(id);
      if (!component) throw new Error(`组件依赖缺失：${id}（被 ${chain.at(-1) ?? '?'} 引用）`);
      visiting.add(id);
      for (const dep of component.deps) visit(dep, [...chain, id]);
      visiting.delete(id);
      done.add(id);
      order.push(id);
    };
    for (const id of components.keys()) visit(id, []);
    return order;
  }

  function assertNoRouteConflicts() {
    const seen = new Map();
    for (const component of components.values()) {
      for (const route of component.routes) {
        const key = routeKey(route);
        const owner = seen.get(key);
        if (owner && owner !== component.id) {
          throw new Error(`路由冲突：${key} 同时被 ${owner} 与 ${component.id} 声明`);
        }
        seen.set(key, component.id);
      }
    }
  }

  async function startAll(ctx) {
    if (started.length) throw new Error('组件注册表已经启动');
    const order = resolveOrder();
    assertNoRouteConflicts();
    ctxRef = ctx;
    for (const id of order) {
      const component = components.get(id);
      // 依赖必须在启动前就已提供，避免组件拿到 undefined 继续跑。
      for (const dep of component.deps) {
        if (!apis.has(dep)) throw new Error(`[component:${id}] 依赖 ${dep} 未成功初始化`);
      }
      const api = (await component.init?.(ctx)) ?? {};
      apis.set(id, api);
      if (typeof ctx.provide === 'function') ctx.provide(id, api);
      if (component.start) await component.start(ctx, api);
      started.push(id);
      log(`[组件] 已启动 ${id}${component.routes.length ? `（路由 ${component.routes.length} 条）` : ''}`);
    }
    return order;
  }

  async function stopAll() {
    const errors = [];
    for (const id of [...started].reverse()) {
      const component = components.get(id);
      try {
        await component.stop?.(ctxRef, apis.get(id));
      } catch (error) {
        errors.push({ id, error: String(error?.message ?? error) });
        log(`[组件] 停止失败 ${id}：${error?.message ?? error}`);
      }
    }
    started.length = 0;
    return { ok: errors.length === 0, errors };
  }

  function get(id) {
    return apis.get(id);
  }

  function list() {
    return [...components.values()].map((c) => ({
      id: c.id,
      deps: [...c.deps],
      routes: c.routes.map(routeKey),
      started: started.includes(c.id),
    }));
  }

  function matchRoute(route, method, pathname) {
    if (route.method !== '*' && route.method !== method) return null;
    if (typeof route.path === 'string') {
      return route.path === pathname ? { params: [] } : null;
    }
    const m = pathname.match(route.pattern);
    return m ? { params: m.slice(1) } : null;
  }

  /**
   * 组件路由分发。命中返回 true（调用方立即 return），未命中返回 false。
   * handler 签名：(ctx, io)，io = { req, res, url, params, readBody, sendJson }。
   * handler 抛错统一转成 JSON 500，不让异常穿透到 http server 的全局兜底。
   */
  async function dispatchHttp(req, res, url, io = {}) {
    for (const component of components.values()) {
      for (const route of component.routes) {
        const matched = matchRoute(route, req.method, url.pathname);
        if (!matched) continue;
        try {
          await route.handle(ctxRef, { ...io, req, res, url, params: matched.params });
        } catch (error) {
          const status = Number(error?.statusCode) || 500;
          log(`[组件:${component.id}] ${req.method} ${url.pathname} 失败：${error?.message ?? error}`);
          try {
            io.sendJson?.({ ok: false, error: `${error?.message ?? error}` }, status);
          } catch {}
        }
        return true;
      }
    }
    return false;
  }

  return { register, startAll, stopAll, get, list, dispatchHttp };
}
