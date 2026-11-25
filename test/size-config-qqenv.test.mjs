// issue #11：/.dshw-size.json 的「待机信封入口」开关（qqEnvOn）
// 四件套里的宿主两侧：① PUT 载荷透传 ② 缺字段沿用旧值 ③ GET 回读带 qqEnvOn。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhaleMiscRoutes } from '../widget/lib/whale-misc-routes.mjs';

const BASE_DEPS = {
  JSON_HEADERS: { 'Content-Type': 'application/json' },
  readBodyMax: async () => '{}',
  surfcoreRequest: async () => ({ ok: true }),
  normalizeUsageMode: (v) => (v === 'token' ? 'token' : 'ledger'),
  exprPackId: (v) => String(v || ''),
  exprDefaults: () => ({ exprOn: true, blinkOn: true }),
  resetBalanceCache: () => {},
  codexInvalidate: () => {},
  BUILD_VERSION: 'test',
  VERSION_LABEL: 'test',
};

function run(sizeHandler, method, bodyText) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(body) { this.body = body; resolve({ status: this.status, body: JSON.parse(body) }) },
    };
    sizeHandler({ method }, res).catch((err) => resolve({ status: 0, error: String(err) }));
    void bodyText;
  });
}

test('size.json：qqEnvOn 可保存，缺字段时沿用旧值', async () => {
  let saved = null;
  const oldCfg = { scale: 1, qqEnvOn: true };
  const deps = {
    ...BASE_DEPS,
    readSizeConfig: () => oldCfg,
    writeSizeConfig: (...args) => { saved = args; return { ok: true } },
    readBody: async () => JSON.stringify({ scale: 1, qqEnvOn: false }),
  };
  const { sizeHandler } = createWhaleMiscRoutes(deps);
  const put = await run(sizeHandler, 'PUT');
  assert.equal(put.status, 200);
  // 最后一个位置参数就是 qqEnvOn
  assert.equal(saved[saved.length - 1], false);

  // 不带 qqEnvOn 的 PUT（旧客户端 / 其它开关）不得把它洗回默认值
  const deps2 = {
    ...BASE_DEPS,
    readSizeConfig: () => ({ scale: 1, qqEnvOn: false }),
    writeSizeConfig: (...args) => { saved = args; return { ok: true } },
    readBody: async () => JSON.stringify({ scale: 1 }),
  };
  const { sizeHandler: handler2 } = createWhaleMiscRoutes(deps2);
  await run(handler2, 'PUT');
  assert.equal(saved[saved.length - 1], false);
});

test('size.json：GET 原样回读 qqEnvOn', async () => {
  const deps = {
    ...BASE_DEPS,
    readSizeConfig: () => ({ scale: 1, qqEnvOn: false }),
    writeSizeConfig: () => ({ ok: true }),
    readBody: async () => '{}',
  };
  const { sizeHandler } = createWhaleMiscRoutes(deps);
  const got = await run(sizeHandler, 'GET');
  assert.equal(got.status, 200);
  assert.equal(got.body.qqEnvOn, false);
  assert.equal(got.body.version, 'test');
});
