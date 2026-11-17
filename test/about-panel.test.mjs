/**
 * 「关于 / 自检」面板数据组装的边界回归（组件化迁移 #11）。
 * 只验证字段白名单、客户端判定与脱敏口径；文件探测用注入的假实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAboutPanel } from '../widget/lib/about-panel.mjs';

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-about-'));
  const hostFile = path.join(dir, 'index.js');
  const widgetFile = path.join(dir, 'whale-widget.js');
  fs.writeFileSync(hostFile, "const dev = 'C:/dev/x';\n");
  fs.writeFileSync(widgetFile, '// widget');
  return {
    BUILD_VERSION: '0.7.8',
    BUILD_CHANNEL: 'release',
    VERSION_LABEL: '0.7.8',
    PACKAGE_ROOT: dir,
    DSH_HOME: path.join(dir, '.dsh'),
    hostFile,
    WIDGET_FILE_CANDIDATES: [widgetFile],
    USAGE_FILE_CANDIDATES: [path.join(dir, 'usage.json')],
    API_FILE_CANDIDATES: [path.join(dir, 'api.json')],
    BUBBLE_FILE_CANDIDATES: [path.join(dir, 'bubble.json')],
    SIZE_FILE_CANDIDATES: [path.join(dir, 'size.json')],
    TURN_FILE_CANDIDATES: [path.join(dir, 'turn.json')],
    firstExisting: (list) => (list || []).find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '',
    fileFacts: (file) => {
      try { const st = fs.statSync(file); return { bytes: st.size, mtime: st.mtimeMs }; } catch { return null; }
    },
    maskPath: (input) => String(input ?? '').split(dir).join('$DSH_HOME'),
    readUsageLedger: () => ({ history: { '2026-11-17': {} } }),
    todayKey: () => '2026-11-17',
    daySummary: () => ({ source: 'observed', lastObservedAt: 1, needsReview: false }),
    accountingDays: () => ['2026-11-17'],
    codexStatsOn: () => true,
    codexDisabledReason: () => '',
    getCodexSnap: () => ({ ok: true, sessions: 2, skipped: 0 }),
    getCodexSnapAt: () => 123,
    getBubbleConfigIgnored: () => null,
    getBalanceLast: () => ({ ok: true, ms: 12 }),
    ...overrides,
  };
}

test('about panel 缺少依赖时构造即失败', () => {
  assert.throws(() => createAboutPanel({}), /about-panel 缺少依赖/);
});

test('payload 覆盖版本、构建、运行时与客户端判定，且路径脱敏', async () => {
  const deps = makeDeps();
  const { aboutPayload } = createAboutPanel(deps);
  const payload = aboutPayload({ headers: { 'user-agent': 'Mozilla/5.0 Electron/30.0' } });

  assert.equal(payload.ok, true);
  assert.equal(payload.plugin.version, '0.7.8');
  assert.equal(payload.plugin.label, '0.7.8');
  assert.equal(payload.client.kind, 'desktop');
  assert.equal(payload.build.host.found, true);
  assert.equal(payload.build.host.path, '$DSH_HOME' + path.sep + 'index.js');
  assert.equal(payload.build.hostHasDevPaths, true);
  assert.equal(payload.runtime.dataHome, '$DSH_HOME' + path.sep + '.dsh');
  assert.equal(typeof payload.runtime.dsh, 'string');
  assert.equal(payload.ledger.days, 1);
  assert.equal(payload.ledger.lastObservedAt, 1);
  assert.deepEqual(payload.balance, { ok: true, ms: 12 });
  assert.equal(payload.codex.ok, true);
  assert.equal(payload.codex.files, 2);
  assert.equal(payload.data.find((row) => row.label === '泡泡配置').found, false);
});

test('被忽略的泡泡配置会在自检数据里点名原因', async () => {
  const deps = makeDeps({ getBubbleConfigIgnored: () => ({ path: '/x/bubble.json', reason: 'kind 不认识' }) });
  const { aboutPayload } = createAboutPanel(deps);
  const payload = aboutPayload({ headers: {} });
  const row = payload.data.find((item) => item.label === '泡泡配置');
  assert.match(row.note, /被忽略：kind 不认识/);
  assert.equal(payload.client.kind, 'web');
});
