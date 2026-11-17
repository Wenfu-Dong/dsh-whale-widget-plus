/**
 * 组件注册表的可执行回归：依赖顺序、启动/停止、路由分发、错误收敛。
 *
 * 这些约定是「以后新增功能不用再改 main()」的前提，破坏它们不会报错，
 * 只会表现为某个功能悄悄不工作 —— 所以必须用测试钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry, defineComponent } from '../src/qq/core/registry.js';
import { createCoreContext } from '../src/qq/core/context.js';

function ctx() {
  return createCoreContext({ log: () => {}, config: {}, paths: {} });
}

test('依赖组件先初始化，注册顺序不决定启动顺序', async () => {
  const order = [];
  const registry = createRegistry();
  registry.register(defineComponent({
    id: 'consumer',
    deps: ['base'],
    init() { order.push('consumer'); return {}; },
  }));
  registry.register(defineComponent({
    id: 'base',
    init() { order.push('base'); return { answer: 42 }; },
  }));
  await registry.startAll(ctx());
  assert.deepEqual(order, ['base', 'consumer']);
  assert.equal(registry.get('base').answer, 42);
  assert.deepEqual(registry.list().map((c) => c.id), ['consumer', 'base']);
});

test('依赖缺失在启动时报错，而不是运行时 undefined', async () => {
  const registry = createRegistry();
  registry.register(defineComponent({ id: 'needs-ghost', deps: ['ghost'] }));
  await assert.rejects(() => registry.startAll(ctx()), /组件依赖缺失：ghost/);
});

test('依赖成环时明确报错并给出链路', async () => {
  const registry = createRegistry();
  registry.register(defineComponent({ id: 'a', deps: ['b'] }));
  registry.register(defineComponent({ id: 'b', deps: ['a'] }));
  await assert.rejects(() => registry.startAll(ctx()), /组件依赖成环：a → b → a/);
});

test('重复 id 与非法声明在注册时就拒绝', () => {
  const registry = createRegistry();
  registry.register(defineComponent({ id: 'dup' }));
  assert.throws(() => registry.register(defineComponent({ id: 'dup' })), /组件重复注册/);
  assert.throws(() => defineComponent({ id: 'Bad_Id' }), /组件 id 非法/);
  assert.throws(() => defineComponent({ id: 'x', routes: [{ method: 'get', path: '/x', handle() {} }] }), /route.method/);
  assert.throws(() => defineComponent({ id: 'x', routes: [{ method: 'GET', path: '/x' }] }), /route.handle/);
});

test('两个组件声明同一路由时启动失败，避免静默覆盖', async () => {
  const registry = createRegistry();
  registry.register(defineComponent({ id: 'a', routes: [{ method: 'GET', path: '/api/x', handle() {} }] }));
  registry.register(defineComponent({ id: 'b', routes: [{ method: 'GET', path: '/api/x', handle() {} }] }));
  await assert.rejects(() => registry.startAll(ctx()), /路由冲突/);
});

test('路由按 method+path 命中，未命中返回 false 交回旧分发链', async () => {
  const registry = createRegistry();
  let seen = null;
  registry.register(defineComponent({
    id: 'demo',
    routes: [{
      method: 'POST',
      path: '/api/demo',
      async handle(context, io) {
        seen = { body: await io.readBody(), url: io.url.pathname };
        io.sendJson({ ok: true });
      },
    }],
  }));
  await registry.startAll(ctx());

  const sent = [];
  const io = {
    readBody: async () => ({ hello: 'world' }),
    sendJson: (obj, status) => sent.push({ obj, status }),
  };
  const hit = await registry.dispatchHttp(
    { method: 'POST' }, null, new URL('http://127.0.0.1:3100/api/demo'), io,
  );
  assert.equal(hit, true);
  assert.deepEqual(seen, { body: { hello: 'world' }, url: '/api/demo' });
  assert.deepEqual(sent, [{ obj: { ok: true }, status: undefined }]);

  const miss = await registry.dispatchHttp(
    { method: 'GET' }, null, new URL('http://127.0.0.1:3100/api/demo'), io,
  );
  assert.equal(miss, false);
});

test('handler 抛错收敛成 JSON 500，异常不穿透到 http server', async () => {
  const registry = createRegistry();
  registry.register(defineComponent({
    id: 'boom',
    routes: [{
      method: 'GET',
      path: '/api/boom',
      handle() { const e = new Error('坏了'); e.statusCode = 503; throw e; },
    }],
  }));
  await registry.startAll(ctx());
  const sent = [];
  const hit = await registry.dispatchHttp(
    { method: 'GET' }, null, new URL('http://127.0.0.1:3100/api/boom'),
    { sendJson: (obj, status) => sent.push({ obj, status }) },
  );
  assert.equal(hit, true);
  assert.deepEqual(sent, [{ obj: { ok: false, error: '坏了' }, status: 503 }]);
});

test('stopAll 逆序停止，全部收干净后可以启动新注册表', async () => {
  const stopped = [];
  const registry = createRegistry();
  registry.register(defineComponent({
    id: 'outer',
    deps: ['inner'],
    stop() { stopped.push('outer'); },
  }));
  registry.register(defineComponent({
    id: 'inner',
    stop() { stopped.push('inner'); },
  }));
  await registry.startAll(ctx());
  const result = await registry.stopAll();
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.deepEqual(stopped, ['outer', 'inner']);
  assert.deepEqual(registry.list().map((c) => c.started), [false, false]);
});
