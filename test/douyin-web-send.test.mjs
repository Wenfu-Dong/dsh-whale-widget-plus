import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDouyinContacts, sendDouyinWebMessages, normalizeDouyinName } from '../backend/lib/douyin-web-send.js';

function fakeBrowser(contacts, { blocked = false, responses = [] } = {}) {
  const calls = [];
  return {
    calls,
    async listContacts() {
      return blocked ? { blocked: true, loginRequired: true, contacts: [] } : { contacts };
    },
    async sendMessage(id, text, options) {
      calls.push({ id, text, options });
      return responses.shift() ?? { confirmed: true, messageId: `m-${calls.length}` };
    },
  };
}

const group = { id: 'conv:group', displayName: '大肥鱼交流群', name: '大肥鱼交流群', isGroup: true };
const friend = { id: 'conv:friend', displayName: '大肥鱼交流群', name: '大肥鱼交流群', isGroup: false };

test('群聊：唯一同名会话按顺序补发全部剩余条', async () => {
  const browser = fakeBrowser([group]);
  const result = await sendDouyinWebMessages({
    displayName: '大肥鱼交流群', isGroup: true, texts: ['第一句', '第二句'], browser,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.equal(browser.calls.length, 2);
  assert.deepEqual(browser.calls.map((item) => item.text), ['第一句', '第二句']);
  assert.equal(browser.calls[0].options.allowed, true);
  assert.equal(browser.calls[0].options.weak, true);
});

test('群名带人数尾巴也能唯一匹配（全角/半角括号）', () => {
  const contacts = [
    { ...group, displayName: '大肥鱼交流群（128）' },
    { ...friend, displayName: '大肥鱼交流群' },
  ];
  const matches = matchDouyinContacts(contacts, { displayName: '大肥鱼交流群', isGroup: true });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].isGroup, true);
  assert.equal(matchDouyinContacts(contacts, { displayName: '大肥鱼交流群', isGroup: false }).length, 1);
});

test('同名多个群聊：拒发并说明歧义', async () => {
  const browser = fakeBrowser([group, { ...group, id: 'conv:group2' }]);
  const result = await sendDouyinWebMessages({
    displayName: '大肥鱼交流群', isGroup: true, texts: ['在吗'], browser,
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.match(result.reason, /2 个同名群聊/);
  assert.equal(browser.calls.length, 0);
});

test('找不到同名会话：拒发', async () => {
  const browser = fakeBrowser([group]);
  const result = await sendDouyinWebMessages({
    displayName: '另一个群', isGroup: true, texts: ['在吗'], browser,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有找到群聊/);
  assert.equal(browser.calls.length, 0);
});

test('部分成功后中断：只补发已确认的条数，不自动重试', async () => {
  const browser = fakeBrowser([group], {
    responses: [{ confirmed: true, messageId: 'm1' }, { confirmed: false, reason: '未取得发送确认' }],
  });
  const result = await sendDouyinWebMessages({
    displayName: '大肥鱼交流群', isGroup: true, texts: ['一', '二', '三'], browser,
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 1);
  assert.match(result.reason, /未取得发送确认/);
  assert.equal(browser.calls.length, 2);
});

test('网页版未登录：不发送并提示先登录', async () => {
  const browser = fakeBrowser([], { blocked: true });
  const result = await sendDouyinWebMessages({
    displayName: '大肥鱼交流群', isGroup: true, texts: ['在吗'], browser,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /未登录/);
  assert.equal(browser.calls.length, 0);
});

test('空内容直接拒绝', async () => {
  const browser = fakeBrowser([group]);
  const result = await sendDouyinWebMessages({ displayName: '大肥鱼交流群', isGroup: true, texts: ['  '], browser });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(browser.calls.length, 0);
});

test('显示名归一化去掉零宽字符与多余空白', () => {
  assert.equal(normalizeDouyinName('  大肥鱼\u200b 交流群  '), '大肥鱼 交流群');
});
