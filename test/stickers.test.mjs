/**
 * 表情库组件的可执行回归：损坏库只读降级、同步合并/删除、认知标注、备注、推荐、路由。
 *
 * 这组用例钉住的是迁移前踩过的坑：
 *  - 库文件坏了绝不能回写成空库（AI 学到的标注会被永久清零）；
 *  - 返回 data 不是数组时不能拿空数组清空本地库；
 *  - 编号（#01）是发送引用，必须持久化且不复用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickerComponent } from '../src/qq/features/stickers.js';

const STORE_ENTRY = { emoji_id: 'e1', url: 'https://example.com/a.png', md5: 'AA11', desc: '开心' };

function setup({ store, config, bot } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-stickers-'));
  const stateFile = path.join(dir, 'stickers.json');
  if (store !== undefined) fs.writeFileSync(stateFile, typeof store === 'string' ? store : JSON.stringify(store));
  const cfg = config ?? {
    socialV2: {
      sticker: { enabled: true, syncTtlMs: 0, maxListCount: 100, includeInPrompt: true, match: { topK: 2, minScore: 0 } },
    },
  };
  const calls = [];
  const fakeBot = bot ?? {
    request: async (action, params) => {
      calls.push({ action, params });
      if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [STORE_ENTRY] };
      return { status: 'ok', retcode: 0 };
    },
  };
  const deps = { stateFile, log: () => {}, getConfig: () => cfg, getBot: () => fakeBot };
  const component = createStickerComponent(deps);
  return { dir, stateFile, cfg, calls, deps, component };
}

async function start(component) {
  return component.init({});
}

test('启动时为老库补编号并落盘，编号从 1 开始', async () => {
  const { stateFile, component } = setup({ store: [STORE_ENTRY] });
  const api = await start(component);
  const entries = api.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].no, 1);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved[0].no, 1);
});

test('库文件损坏时降级为只读，后续标注不会覆盖原文件', async () => {
  const broken = '{ 这不是 json';
  const { stateFile, component } = setup({ store: broken });
  const api = await start(component);
  assert.equal(api.writable(), false);
  assert.deepEqual(api.entries(), []);

  const result = api.note('e1', { note: '不该写进去' });
  assert.equal(result, null);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), broken);
});

test('同步合并新表情并清理 QQ 端已删除的收藏（complete=true）', async () => {
  const store = [
    { ...STORE_ENTRY, no: 1, localNote: '这是 AI 写的认知' },
    { emoji_id: 'gone', url: 'https://example.com/g.png', no: 2 },
  ];
  const { component, stateFile } = setup({ store });
  const api = await start(component);
  await api.sync(true);

  const ids = api.entries().map((e) => e.id);
  assert.deepEqual(ids, ['e1']);
  const kept = api.entries()[0];
  assert.equal(kept.localNote, '这是 AI 写的认知'); // 同步不能冲掉本地认知
  assert.equal(kept.no, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).map((e) => e.id), ['e1']);
});

test('上游返回非数组时拒绝同步，本地库保持原样', async () => {
  const { component } = setup({
    store: [STORE_ENTRY],
    bot: { request: async () => ({ status: 'ok', retcode: 0, data: null }) },
  });
  const api = await start(component);
  assert.equal(await api.sync(true), null);
  assert.equal(api.entries().length, 1);
});

test('note 写入本地认知并持久化；find 支持编号引用', async () => {
  const { component, stateFile } = setup({ store: [STORE_ENTRY] });
  const api = await start(component);
  const updated = api.note('#01', { note: '群友笑的时候用', tags: ['笑'], emotion: 'happy', content: '笑脸' });
  assert.equal(updated.localNote, '群友笑的时候用');
  assert.deepEqual(updated.tags, ['笑']);
  assert.equal(api.find('#01').id, 'e1');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved[0].localNote, '群友笑的时候用');
});

test('remark 调用 OneBot 修改收藏备注，并同步本地 desc', async () => {
  const { component, calls } = setup({ store: [STORE_ENTRY] });
  const api = await start(component);
  const entry = await api.remark('#01', '  开心到飞起  ');
  assert.equal(entry.desc, '开心到飞起');
  const modify = calls.find((c) => c.action === 'modify_custom_face');
  assert.deepEqual(modify.params, { emoji_id: 'e1', desc: '开心到飞起' });
});

test('markUsed 累加使用次数并持久化', async () => {
  const { component } = setup({ store: [STORE_ENTRY] });
  const api = await start(component);
  const used = api.markUsed('e1');
  assert.equal(used.useCount, 1);
  assert.equal(api.entries()[0].useCount, 1);
});

test('suggest 按语境给出推荐；关闭后不再推荐', async () => {
  const { component, cfg } = setup({
    store: [{ ...STORE_ENTRY, content: '开心大笑', keywords: ['开心', '笑'] }],
  });
  const api = await start(component);
  const result = api.suggest([{ text: '今天太开心了我要笑死', isSelf: false }]);
  assert.ok(result, '应给出推荐');
  assert.equal(typeof result.hint, 'string');
  assert.ok(result.matches.length >= 1);
  assert.ok(result.matches[0].ref.startsWith('#'));

  cfg.socialV2.sticker.enabled = false;
  assert.equal(api.suggest([{ text: '今天太开心了我要笑死' }]), null);
});

test('GET /api/stickers 与控制台路由走组件分发', async () => {
  const { component } = setup({ store: [STORE_ENTRY] });
  const api = await start(component);
  const route = (method, p) => component.routes.find((r) => r.method === method && r.path === p);

  const sent = [];
  await route('GET', '/api/stickers').handle({}, {
    url: new URL('http://127.0.0.1:3100/api/stickers?count=10'),
    readBody: async () => ({}),
    sendJson: (obj, status) => sent.push({ obj, status }),
  });
  assert.equal(sent[0].obj.ok, true);
  assert.equal(sent[0].obj.total, 1);
  assert.equal(sent[0].obj.writable, true);

  await route('POST', '/api/stickers/sync').handle({}, {
    url: new URL('http://127.0.0.1:3100/api/stickers/sync'),
    readBody: async () => ({}),
    sendJson: (obj, status) => sent.push({ obj, status }),
  });
  assert.equal(sent[1].obj.ok, true);
  assert.equal(sent[1].obj.total, 1);
});
