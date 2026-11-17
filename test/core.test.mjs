/**
 * 刚拆出的纯模块的可执行回归：配置默认值/覆盖/夹取、文件原子读写、模式与名单判定。
 *
 * 这些用例存在的原因：项目此前只有静态审计，没有一条真正执行代码的测试，
 * 所以每次拆分/修复都只能靠手工点一遍，问题只能被用户撞见。
 * 以后改动 src/qq/ 下的模块，先跑 `npm test`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/qq/config.js';
import { atomicWriteJson, atomicWriteText, readJsonSafe, readConfigObject } from '../src/qq/json-io.js';
import {
  normalizeModeInput, canonicalV2Key, allowed, senderBlocked, isSilentMarker, VALID_MODES,
} from '../src/qq/policy.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-test-'));
}

test('配置缺失时明确抛错（fail-fast），错误信息带文件路径', () => {
  const dir = tempDir();
  assert.throws(
    () => loadConfig({ configFile: path.join(dir, 'missing.json') }),
    /配置文件读取\/解析失败.*missing\.json/,
  );
});

test('配置覆盖生效，且未覆盖的默认值不丢', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ dsh: { provider: 'p-test', model: 'm-test' } }));
  const cfg = loadConfig({ configFile: file });
  assert.equal(cfg.dsh.provider, 'p-test');
  assert.equal(cfg.dsh.model, 'm-test');
  assert.equal(typeof cfg.role.maxInjectChars, 'number');
});

test('人格注入上限越界时，运行时变量被夹取（配置原值保留）', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ role: { maxInjectChars: 999999 } }));
  let written = null;
  const cfg = loadConfig({
    configFile: file,
    applyRoleInjectLimit: (v) => Math.min(20000, Math.max(1000, Math.round(Number(v)))),
    setRoleInjectMaxChars: (v) => { written = v; },
  });
  assert.equal(cfg.role.maxInjectChars, 999999);
  assert.equal(written, 20000);
});

test('配置 JSON 损坏时明确抛错，而不是带着半份配置继续跑', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ 坏掉的 json');
  assert.throws(() => loadConfig({ configFile: file }), /配置文件读取\/解析失败/);
});

test('原子写 JSON 后可原样读回，且不残留临时文件', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteJson(file, { a: 1, b: ['x'] });
  assert.deepEqual(readJsonSafe(file, null), { a: 1, b: ['x'] });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('原子写文本后可直接读回', () => {
  const dir = tempDir();
  const file = path.join(dir, 'note.txt');
  atomicWriteText(file, '你好');
  assert.equal(fs.readFileSync(file, 'utf8'), '你好');
});

test('readConfigObject 拒绝顶层非对象，避免整份配置被覆盖', () => {
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, 'null');
  assert.throws(() => readConfigObject(file), /顶层不是对象/);
  fs.writeFileSync(file, '[]');
  assert.throws(() => readConfigObject(file), /顶层不是对象/);
});

test('模式别名收敛为同一内部值，无法识别时返回 null', () => {
  assert.equal(normalizeModeInput('simulation'), 'reserved2');
  assert.equal(normalizeModeInput(' reserved2 '), 'reserved2');
  assert.equal(normalizeModeInput('closed-agent'), 'closed-agent');
  assert.equal(normalizeModeInput('乱写'), null);
  assert.ok(VALID_MODES.includes('reserved2'));
});

test('二代会话 key 规范化去掉前导零并拒绝非法值', () => {
  assert.equal(canonicalV2Key('group:007'), 'group:7');
  assert.equal(canonicalV2Key('private:123'), 'private:123');
  assert.equal(canonicalV2Key('group:0'), null);
  assert.equal(canonicalV2Key('room:1'), null);
  assert.equal(canonicalV2Key(undefined), null);
});

test('白名单优先于 allowAllWhenEmpty，黑名单优先于白名单', () => {
  const cfg = {
    allow: { group: ['1'], groups: ['1'] },
    deny: { group: ['2'], groups: ['2'] },
    allowAllWhenEmpty: true,
  };
  assert.equal(allowed('group', 1, cfg), true);
  assert.equal(allowed('group', 9, cfg), false);
  assert.equal(allowed('group', 2, cfg), false);
  assert.equal(allowed('private', 9, cfg), true);
});

test('发送者黑名单按字符串比较，容忍数字与空格', () => {
  assert.equal(senderBlocked(12345, [' 12345 ']), true);
  assert.equal(senderBlocked('12345', [12345]), true);
  assert.equal(senderBlocked('', ['12345']), false);
  assert.equal(senderBlocked('1', null), false);
});

test('静默标记只匹配整条消息', () => {
  assert.equal(isSilentMarker('[SILENT]'), true);
  assert.equal(isSilentMarker('  [silent]  '), true);
  assert.equal(isSilentMarker('我说 [SILENT] 了'), false);
});
