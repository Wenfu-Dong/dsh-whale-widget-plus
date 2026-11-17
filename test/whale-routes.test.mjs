/**
 * 组件化迁移收尾：四族路由工厂的边界回归。
 * 覆盖：缺依赖即抛错、泡泡配置读写、音频/角色 GET 形状、wait 与 update-check 降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWhaleAssetsRoutes } from '../widget/lib/whale-assets-routes.mjs';
import { createWhaleAccountingRoutes } from '../widget/lib/whale-accounting-routes.mjs';
import { createWhaleRolesAudioRoutes } from '../widget/lib/whale-roles-audio-routes.mjs';
import { createWhaleMiscRoutes } from '../widget/lib/whale-misc-routes.mjs';
import { createRoleAudioStore } from '../widget/lib/role-audio-store.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

function makeRes() {
  const out = { status: 0, headers: null, body: null };
  return {
    out,
    res: {
      writeHead(status, headers) { out.status = status; out.headers = headers || null; },
      end(text) { out.body = text === undefined ? null : JSON.parse(text); },
    },
  };
}

function makeReq(method, url, body) {
  return { method, url: url || '/dsh-whale/x.json', __body: body };
}

function readBody(req) {
  return Promise.resolve(JSON.stringify(req.__body ?? {}));
}

function readBodyMax(req) {
  return Promise.resolve(JSON.stringify(req.__body ?? {}));
}

function makeAssetsDeps(overrides) {
  return {
    imageCandidates: [],
    ruaGifCandidates: [],
    exprDirCandidates: [],
    exprPackFile: 'pack.json',
    exprPackIdRe: /^[A-Za-z0-9_-]{1,64}$/,
    exprFileNameRe: /^[A-Za-z0-9_.-]{1,128}$/,
    exprCuteMax: 12,
    exprCuteScanMax: 120,
    exprPacksTtlMs: 5000,
    petVideoDir: path.join(os.tmpdir(), 'whale-test-pet-video'),
    bubbleImgDirCandidates: [path.join(os.tmpdir(), 'whale-test-bubble-imgs')],
    bubbleImgIndexName: 'bubble-imgs.json',
    defaultBubbleImgs: [],
    bubbleImgFileCandidates: () => [],
    widgetFileCandidates: [],
    consoleFileCandidates: [],
    loadBubbleConfig: () => ({ v: 1, items: [], lib: [] }),
    writeBubbleConfig: () => true,
    getBubbleConfigIgnored: () => '',
    readBodyMax,
    JSON_HEADERS,
    ...overrides,
  };
}

function makeAccountingDeps(overrides) {
  return {
    JSON_HEADERS,
    readBody,
    readBodyMax,
    fetchPlatformUsage: async () => null,
    getPlatformUsageSource: () => '',
    getPlatformUsageCode: () => '',
    setPlatformToken: async () => {},
    getBalance: async () => ({ ok: false, code: 'NO_TOKEN' }),
    getBalanceLast: () => null,
    setBalanceLast: () => {},
    BUILD_VERSION: '0.0.0-test',
    BUILD_CHANNEL: 'test',
    VERSION_LABEL: 'v0.0.0-test',
    getLastTurn: () => null,
    getLastTurnSeq: () => 0,
    getLastStep: () => null,
    getWaitState: () => ({ pending: null, sessionName: '' }),
    getAboutPayload: () => () => ({ ok: true }),
    usageRecordsPayload: () => ({ ok: true, days: [] }),
    API_BUILTIN_ID: 'deepseek',
    canAdjustBuiltinBalance: () => true,
    apiModelById: () => ({}),
    todayKey: () => '2026-01-01',
    readUsageLedger: () => ({}),
    writeUsageLedger: () => true,
    reconcileBalance: () => ({ ok: true }),
    accountingDays: () => [],
    balanceSummary: () => null,
    resetBalanceCache: () => {},
    httpsGetJson: async () => { throw new Error('offline'); },
    npmCliVersion: async () => { throw new Error('offline'); },
    ...overrides,
  };
}

function makeRoleAudioDeps(tmpRoot) {
  const store = createRoleAudioStore({
    roleDirCandidates: [path.join(tmpRoot, 'roles')],
    audioDirCandidates: [path.join(tmpRoot, 'audio')],
    roleDefaultId: 'role_builtin',
    roleIndexName: 'roles.json',
    audioIndexName: 'audio.json',
    presetGroups: {
      duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2' },
    },
    presetFragments: {},
    builtinFragmentFiles: {},
    soundSets: { duck: { press: [], release: [] } },
    loadSound: () => null,
  });
  return {
    JSON_HEADERS,
    readBody,
    readBodyMax,
    roleDefaultId: 'role_builtin',
    presetGroups: { duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2' } },
    presetFragments: {},
    soundSets: { duck: { press: [], release: [] } },
    packageRoot: tmpRoot,
    loadSound: () => null,
    petAiFileCandidates: [path.join(tmpRoot, 'pet-ai.json')],
    surfcoreRequest: async () => ({ ok: false }),
    readSurfcoreHost: () => null,
    getCtx: () => ({ get: () => null }),
    ...store,
  };
}

test('四族路由工厂缺少依赖时构造即失败', () => {
  assert.throws(() => createWhaleAssetsRoutes({}), /whale-assets-routes 缺少依赖/);
  assert.throws(() => createWhaleAccountingRoutes({}), /whale-accounting-routes 缺少依赖/);
  assert.throws(() => createWhaleRolesAudioRoutes({}), /whale-roles-audio-routes 缺少依赖/);
  assert.throws(() => createWhaleMiscRoutes({}), /whale-misc-routes 缺少依赖/);
});

test('bubble.json：GET 读配置，POST 净化后落盘并回显 ignored', async () => {
  let written = null;
  const routes = createWhaleAssetsRoutes(makeAssetsDeps({
    loadBubbleConfig: () => ({ v: 1, items: [{ kind: 'text' }], lib: [] }),
    writeBubbleConfig: (cfg) => { written = cfg; return true; },
    getBubbleConfigIgnored: () => 'bad-file',
  }));

  const get = makeRes();
  await routes.bubbleHandler(makeReq('GET', '/dsh-whale/bubble.json'), get.res);
  assert.equal(get.out.status, 200);
  assert.deepEqual(get.out.body, { ok: true, config: { v: 1, items: [{ kind: 'text' }], lib: [] } });

  const post = makeRes();
  await routes.bubbleHandler(makeReq('POST', '/dsh-whale/bubble.json', {
    items: [{ kind: 'text' }, { kind: 'choice', options: [] }],
    lib: [{ id: 'a' }],
    tapAdvance: true,
    extra: 'drop-me',
  }), post.res);
  assert.equal(post.out.status, 200);
  assert.deepEqual(written, { v: 1, items: [{ kind: 'text' }, { kind: 'choice', options: [] }], lib: [{ id: 'a' }], tapAdvance: true });
  assert.deepEqual(post.out.body, { ok: true, config: written, ignored: 'bad-file' });
});

test('audio.json：GET 返回 ok / groups / fragments 形状', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-audio-'));
  try {
    const routes = createWhaleRolesAudioRoutes(makeRoleAudioDeps(tmpRoot));
    const out = makeRes();
    await routes.audioHandler(makeReq('GET', '/dsh-whale/audio.json'), out.res);
    assert.equal(out.out.status, 200);
    assert.equal(out.out.body.ok, true);
    assert.ok(Array.isArray(out.out.body.groups));
    assert.ok(Array.isArray(out.out.body.fragments));
    assert.equal(out.out.body.groups[0].id, 'duck');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('roles.json：GET 返回 ok 与内置默认角色', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-roles-'));
  try {
    const routes = createWhaleRolesAudioRoutes(makeRoleAudioDeps(tmpRoot));
    const out = makeRes();
    await routes.rolesHandler(makeReq('GET', '/dsh-whale/roles.json'), out.res);
    assert.equal(out.out.status, 200);
    assert.equal(out.out.body.ok, true);
    assert.ok(Array.isArray(out.out.body.roles));
    assert.equal(out.out.body.roles[0].id, 'role_builtin');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('wait.json：没有挂起交互时降级为空 pending', async () => {
  const routes = createWhaleAccountingRoutes(makeAccountingDeps());
  const out = makeRes();
  routes.waitHandler(makeReq('GET', '/dsh-whale/wait.json'), out.res);
  assert.equal(out.out.status, 200);
  assert.deepEqual(out.out.body, { ok: true, pending: null, sessionName: '' });
});

test('update-check.json：所有源失败时逐个列出原因并带 tried', async () => {
  const routes = createWhaleAccountingRoutes(makeAccountingDeps({
    httpsGetJson: async () => { throw new Error('超时'); },
    npmCliVersion: async () => { throw new Error('npm 退出异常'); },
  }));
  const out = makeRes();
  await routes.updateCheckHandler(makeReq('GET', '/dsh-whale/update-check.json'), out.res);
  assert.equal(out.out.status, 200);
  assert.equal(out.out.body.ok, false);
  assert.equal(out.out.body.current, '0.0.0-test');
  assert.match(out.out.body.error, /npmmirror：超时/);
  assert.match(out.out.body.error, /npm-cli：npm 退出异常/);
  assert.equal(out.out.body.tried.length, 5);
});
