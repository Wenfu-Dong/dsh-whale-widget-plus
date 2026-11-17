/**
 * 用量设置 / API 模型路由的边界回归（组件化迁移 #11）。
 * 重点验证搬出后的动作分发、凭据名白名单与错误码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createUsageSettingsRoute, createApiModelsRoute } from '../widget/lib/usage-api-routes.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

function makeRes() {
  const out = { status: 0, body: null };
  return {
    out,
    res: {
      writeHead(status) { out.status = status; },
      end(text) { out.body = JSON.parse(text); },
    },
  };
}

function makeReq(method, body) {
  return { method, url: '/dsh-whale/x.json', __body: body };
}

function readBodyMax(req) {
  return Promise.resolve(JSON.stringify(req.__body ?? {}));
}

test('两个路由工厂缺少依赖时构造即失败', () => {
  assert.throws(() => createUsageSettingsRoute({}), /usage-settings-route 缺少依赖/);
  assert.throws(() => createApiModelsRoute({}), /api-models-route 缺少依赖/);
});

test('用量设置：GET 读、POST 写并按结果给状态码', async () => {
  let written = null;
  const handler = createUsageSettingsRoute({
    readBodyMax,
    readUsageSettings: () => ({ alerts: true }),
    writeUsageSettings: (patch) => { written = patch; return { ok: true, settings: patch }; },
    JSON_HEADERS,
  });

  const get = makeRes();
  await handler(makeReq('GET'), get.res);
  assert.equal(get.out.status, 200);
  assert.deepEqual(get.out.body, { ok: true, settings: { alerts: true } });

  const post = makeRes();
  await handler(makeReq('POST', { alerts: false }), post.res);
  assert.deepEqual(written, { alerts: false });
  assert.equal(post.out.status, 200);
});

test('API 模型：动作分发、保存合并 keyValue、删除返回最新列表', async () => {
  const saved = [];
  const deleted = [];
  let modelSettings = null;
  const deps = {
    readBodyMax,
    JSON_HEADERS,
    apiModelsPayload: async () => ({ models: [{ id: 'a' }, { id: 'b' }] }),
    apiModelById: (id) => ({ id }),
    apiProbeModel: async (model) => ({ ok: true, probed: model.id }),
    apiDeleteModel: (id) => { deleted.push(id); return { ok: true }; },
    apiSaveModel: async (model) => { saved.push(model); return { ok: true }; },
    writeUsageSettings: (patch) => { modelSettings = patch; return { ok: true }; },
    getCtx: () => ({
      credentials: {
        set: async () => {},
        unset: async () => {},
      },
    }),
  };
  const handler = createApiModelsRoute(deps);

  const get = makeRes();
  await handler(makeReq('GET'), get.res);
  assert.equal(get.out.body.models.length, 2);

  const save = makeRes();
  await handler(makeReq('POST', { model: { id: 'c' }, keyValue: 'sk-1' }), save.res);
  assert.deepEqual(saved[0], { id: 'c', keyValue: 'sk-1' });
  assert.equal(save.out.body.models.length, 2);

  const del = makeRes();
  await handler(makeReq('POST', { action: 'delete', id: 'a' }), del.res);
  assert.deepEqual(deleted, ['a']);
  assert.equal(del.out.status, 200);

  const probe = makeRes();
  await handler(makeReq('POST', { action: 'probe', id: 'b' }), probe.res);
  assert.equal(probe.out.body.probed, 'b');

  const settings = makeRes();
  await handler(makeReq('POST', { action: 'model-settings', id: 'b', alert: 1, budget: 2, quota: 3 }), settings.res);
  assert.deepEqual(modelSettings, { modelSettings: { id: 'b', alert: 1, budget: 2, quota: 3 } });
});

test('API 模型：凭据名白名单拒绝非法 ref，非法请求体返回 400', async () => {
  let setCalls = 0;
  const handler = createApiModelsRoute({
    readBodyMax,
    JSON_HEADERS,
    apiModelsPayload: async () => ({ models: [] }),
    apiModelById: () => ({}),
    apiProbeModel: async () => ({ ok: true }),
    apiDeleteModel: () => ({ ok: true }),
    apiSaveModel: async () => ({ ok: true }),
    writeUsageSettings: () => ({ ok: true }),
    getCtx: () => ({ credentials: { set: async () => { setCalls += 1; } } }),
  });

  const bad = makeRes();
  await handler(makeReq('POST', { action: 'set-key', keyRef: '../evil', keyValue: 'x' }), bad.res);
  assert.equal(bad.out.status, 400);
  assert.match(bad.out.body.error, /凭据名只能包含/);
  assert.equal(setCalls, 0);

  const ok = makeRes();
  await handler(makeReq('POST', { action: 'set-key', keyRef: 'openai_key', keyValue: 'sk-x' }), ok.res);
  assert.equal(ok.out.status, 200);
  assert.equal(setCalls, 1);
});
