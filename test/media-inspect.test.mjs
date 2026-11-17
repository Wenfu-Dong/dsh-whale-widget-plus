/**
 * 图片 / 表情字节解析（组件化迁移 #13）的回归测试。
 * 重点钉住历史踩坑点：图片炸弹像素上限、表情 CDN 只接受十六进制 id、
 * OneBot file 字段拒绝路径/协议、媒体上限收敛到安全区间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe,
  resolveMediaLimits, isSafeLocalMediaPath, isProbablySafeImageFileRef,
  emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer,
} from '../src/media-inspect.js';

function pngBuffer(width = 1, height = 1) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifBuffer(width = 2, height = 3) {
  const buf = Buffer.alloc(24);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

test('mimeFromBuffer 识别 PNG/GIF/JPEG/WebP', () => {
  assert.equal(mimeFromBuffer(pngBuffer()), 'image/png');
  assert.equal(mimeFromBuffer(gifBuffer()), 'image/gif');
  assert.equal(mimeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(mimeFromBuffer(webp), 'image/webp');
});

test('mimeFromUrl 按后缀推断，失败回落', () => {
  assert.equal(mimeFromUrl('https://a/b/c.PNG?x=1'), 'image/png');
  assert.equal(mimeFromUrl('https://a/b/c.webp'), 'image/webp');
  assert.equal(mimeFromUrl('not a url'), 'image/jpeg');
  assert.equal(mimeFromUrl('not a url', 'image/gif'), 'image/gif');
});

test('getImageDimensions 解析 PNG/GIF 宽高', () => {
  assert.deepEqual(getImageDimensions(pngBuffer(12, 34)), { width: 12, height: 34 });
  assert.deepEqual(getImageDimensions(gifBuffer(5, 6)), { width: 5, height: 6 });
  assert.equal(getImageDimensions(Buffer.alloc(4)), null);
});

test('base64FromMaybe 支持 base64://、data URI 与纯 base64', () => {
  assert.equal(base64FromMaybe('base64:// aGVs bG8='), 'aGVsbG8=');
  assert.equal(base64FromMaybe('data:image/png;base64,QUJD'), 'QUJD');
  assert.equal(base64FromMaybe('QUJD'), 'QUJD');
  assert.equal(base64FromMaybe('https://x/y.png'), null);
  assert.equal(base64FromMaybe(null), null);
});

test('resolveMediaLimits 收敛到安全区间', () => {
  assert.deepEqual(resolveMediaLimits({}), { maxBytes: 8 * 1024 * 1024, maxCount: 5, maxPixels: 64_000_000 });
  assert.equal(resolveMediaLimits({ socialV2: { media: { maxBytes: 1 } } }).maxBytes, 256 * 1024);
  assert.equal(resolveMediaLimits({ socialV2: { media: { maxCount: 99 } } }).maxCount, 8);
  assert.equal(resolveMediaLimits({ socialV2: { media: { maxPixels: 1 } } }).maxPixels, 1_000_000);
});

test('isSafeLocalMediaPath 只允许资料目录内的真实路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-safe-'));
  const inside = path.join(dir, 'a.txt');
  fs.writeFileSync(inside, 'x');
  assert.equal(isSafeLocalMediaPath(inside, dir), true);
  assert.equal(isSafeLocalMediaPath(inside, path.join(dir, 'nope')), false);
  assert.equal(isSafeLocalMediaPath(inside, null), false);
  assert.equal(isSafeLocalMediaPath(path.join(dir, 'missing.txt'), dir), false);
});

test('isProbablySafeImageFileRef 拒绝路径/协议/穿越', () => {
  assert.equal(isProbablySafeImageFileRef('abc123.gif'), true);
  assert.equal(isProbablySafeImageFileRef('f9-0123456789abcdef0123456789abcdef.gif'), true);
  assert.equal(isProbablySafeImageFileRef('C:\\windows\\a.gif'), false);
  assert.equal(isProbablySafeImageFileRef('../../etc/passwd'), false);
  assert.equal(isProbablySafeImageFileRef('http://evil/a.gif'), false);
  assert.equal(isProbablySafeImageFileRef('base64://AAA'), false);
  assert.equal(isProbablySafeImageFileRef('a/b.gif'), false);
});

test('emojiCdnCandidates 只接受十六进制 id', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(emojiCdnCandidates(id), [
    `https://gxh.vip.qq.com/club/item/parcel/item/01/${id}/raw300.gif`,
  ]);
  assert.deepEqual(emojiCdnCandidates('../../evil'), []);
  assert.deepEqual(emojiCdnCandidates(''), []);
});

test('emojiIdFromFileName 从缓存文件名提取 32 位 id', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(emojiIdFromFileName(`f9-${id}.gif`), id);
  assert.equal(emojiIdFromFileName('plain.gif'), '');
});

test('acceptImageBuffer 拦截非图片与超像素图片', () => {
  const logs = [];
  const ok = acceptImageBuffer(pngBuffer(10, 10), '图片', { maxPixels: 1000, log: (m) => logs.push(m) });
  assert.equal(ok?.mimeType, 'image/png');
  const bomb = acceptImageBuffer(pngBuffer(100, 100), '图片', { maxPixels: 1000, log: (m) => logs.push(m) });
  assert.equal(bomb, null);
  assert.match(logs.at(-1), /像素超限/);
  const bad = acceptImageBuffer(Buffer.from('not an image at all'), '图片', { maxPixels: 1000, log: (m) => logs.push(m) });
  assert.equal(bad, null);
  assert.match(logs.at(-1), /不是有效图片/);
});
