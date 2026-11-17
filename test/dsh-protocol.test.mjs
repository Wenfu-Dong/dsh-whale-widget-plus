import test from 'node:test';
import assert from 'node:assert/strict';
import { isDshProtocolMismatch, annotateDshError, protocolHint } from '../src/dsh-protocol.js';

test('严格模式识别方法/端点缺失', () => {
  assert.equal(isDshProtocolMismatch('unknown method: session/prompt'), true);
  assert.equal(isDshProtocolMismatch('method not found'), true);
  assert.equal(isDshProtocolMismatch('invalid server-response for session/prompt'), true);
  assert.equal(isDshProtocolMismatch('unexpected remote stream frame'), true);
});

test('严格模式不把普通业务错误当成协议问题', () => {
  assert.equal(isDshProtocolMismatch('friend not found'), false);
  assert.equal(isDshProtocolMismatch('session/control timeout'), false);
  assert.equal(isDshProtocolMismatch(''), false);
});

test('HTTP 404/405/501 判定为协议不兼容，500 不算', () => {
  assert.equal(isDshProtocolMismatch({ message: 'transport failure', dshStatus: 404 }), true);
  assert.equal(isDshProtocolMismatch({ message: 'transport failure', dshStatus: 405 }), true);
  assert.equal(isDshProtocolMismatch({ message: 'transport failure', dshStatus: 501 }), true);
  assert.equal(isDshProtocolMismatch({ message: 'transport failure', dshStatus: 500 }), false);
});

test('宽松模式接受 not found / unknown / unsupported（供端点回落使用）', () => {
  assert.equal(isDshProtocolMismatch('session/modelCatalog not found', { loose: true }), true);
  assert.equal(isDshProtocolMismatch('unknown endpoint', { loose: true }), true);
  assert.equal(isDshProtocolMismatch('unsupported feature', { loose: true }), true);
});

test('annotateDshError 附加方法与状态，并给出可读提示', () => {
  const error = annotateDshError(new Error('transport failure for /api/session/prompt: HTTP 404'), {
    method: 'session/prompt',
    path: '/api/session/prompt',
    httpStatus: 404,
  });
  assert.equal(error.dshMethod, 'session/prompt');
  assert.equal(error.dshStatus, 404);
  assert.equal(error.dshProtocolMismatch, true);
  assert.match(error.message, /DSH 协议可能不兼容/);
  assert.match(error.message, /session\/prompt/);
});

test('annotateDshError 幂等：重复调用不会叠加提示', () => {
  const error = annotateDshError(new Error('invalid server-response for session/prompt'), { method: 'session/prompt' });
  const first = error.message;
  annotateDshError(error, { method: 'session/prompt' });
  assert.equal(error.message, first);
});

test('annotateDshError 不污染普通错误', () => {
  const error = annotateDshError(new Error('friend not found'), { method: 'session/prompt' });
  assert.equal(error.dshProtocolMismatch, undefined);
  assert.equal(error.message, 'friend not found');
});

test('protocolHint 未给方法时也能给出可读文案', () => {
  assert.match(protocolHint(''), /当前调用/);
  assert.match(protocolHint('session/prompt'), /session\/prompt/);
});
