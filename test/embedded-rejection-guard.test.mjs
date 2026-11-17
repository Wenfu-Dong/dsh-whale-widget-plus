import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOwnStack, createEmbeddedRejectionGuard } from '../src/embedded-rejection-guard.js';

const ROOT = process.platform === 'win32' ? 'C:\\Users\\tester\\dsh-Dfy' : '/home/tester/dsh-Dfy';
const SLASH_ROOT = process.platform === 'win32' ? 'C:/Users/tester/dsh-Dfy' : '/home/tester/dsh-Dfy';

test('isOwnStack 识别本包堆栈（反斜杠路径）', () => {
  const stack = `Error: boom\n    at run (${ROOT}\\src\\bridge.js:12:3)`;
  assert.equal(isOwnStack(stack, ROOT), true);
});

test('isOwnStack 识别本包堆栈（file URL，Windows 盘符大小写不同）', () => {
  const stack = 'Error: boom\n    at run (file:///' + SLASH_ROOT.toLowerCase() + '/backend/lib/index.js:9:1)';
  assert.equal(isOwnStack(stack, ROOT), true);
});

test('isOwnStack 不把同前缀的兄弟目录算成自己', () => {
  const stack = 'Error: boom\n    at run (' + SLASH_ROOT + '-other/src/x.js:1:1)';
  assert.equal(isOwnStack(stack, ROOT), false);
});

test('isOwnStack 对空值/外部堆栈返回 false', () => {
  assert.equal(isOwnStack('', ROOT), false);
  assert.equal(isOwnStack(undefined, ROOT), false);
  assert.equal(isOwnStack('Error: boom\n    at run (/opt/dsh/server.js:1:1)', ROOT), false);
});

test('本插件的拒绝：只记日志，不抛出', () => {
  const logs = [];
  const guard = createEmbeddedRejectionGuard({ rootDir: ROOT, log: (...args) => logs.push(args) });
  const error = new Error('leak');
  error.stack = `Error: leak\n    at run (${ROOT}\\src\\bridge.js:1:1)`;
  assert.doesNotThrow(() => guard.handler(error));
  assert.equal(logs.length, 1);
});

test('外部拒绝：默认摘掉监听并重新抛出（保持宿主原策略）', () => {
  const guard = createEmbeddedRejectionGuard({ rootDir: ROOT });
  guard.install();
  assert.equal(guard.installed, true);
  const foreign = new Error('host failure');
  foreign.stack = 'Error: host failure\n    at run (/opt/dsh/server.js:1:1)';
  assert.throws(() => guard.handler(foreign), /host failure/);
  assert.equal(guard.installed, false);
});

test('外部拒绝：提供 onForeign 时交给回调，不自行抛出', () => {
  const seen = [];
  const guard = createEmbeddedRejectionGuard({ rootDir: ROOT, onForeign: (reason) => seen.push(reason) });
  const foreign = new Error('host failure');
  foreign.stack = 'Error: host failure\n    at run (/opt/dsh/server.js:1:1)';
  assert.doesNotThrow(() => guard.handler(foreign));
  assert.equal(seen.length, 1);
});

test('重复 install 只注册一次，uninstall 可重复调用', () => {
  const guard = createEmbeddedRejectionGuard({ rootDir: ROOT });
  const before = process.listenerCount('unhandledRejection');
  guard.install();
  guard.install();
  assert.equal(process.listenerCount('unhandledRejection'), before + 1);
  guard.uninstall();
  guard.uninstall();
  assert.equal(process.listenerCount('unhandledRejection'), before);
});

test('进程级验证：装上隔离器后，本插件泄漏的拒绝不会终止进程', () => {
  const guardUrl = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'embedded-rejection-guard.js'),
  ).href;
  const script = `
    import { createEmbeddedRejectionGuard } from ${JSON.stringify(guardUrl)};
    createEmbeddedRejectionGuard({ rootDir: process.cwd(), log: () => {} }).install();
    const error = new Error('leak');
    error.stack = 'Error: leak\\n    at run (' + process.cwd() + '/src/bridge.js:1:1)';
    Promise.reject(error);
    await new Promise((resolve) => setTimeout(resolve, 150));
    console.log('ALIVE');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ALIVE/);
});
