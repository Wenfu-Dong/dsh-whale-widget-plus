/**
 * 回复分条 / 分句规划（组件化迁移 #12）的回归测试。
 *
 * 这些规则以前埋在 bridge.js 的 main() 闭包里，只能靠真实群聊观察。
 * 搬出来之后用最小用例钉住：URL/emoji 不能被拆坏、单字不能各自成条、
 * 图片不能参与分条、二代软提醒只在应触发时触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  singleLineForQQ, splitLongSegment, splitByCjkSpaces,
  planSocialTimeline, convertExampleSpacesToComma,
  findCjkSpaceWarning, findSplitBoundaryWarning,
  clampGapV2, computeGapsV2,
} from '../src/reply-plan.js';

test('singleLineForQQ 合并换行与多余空白', () => {
  assert.equal(singleLineForQQ('  a\n\n b\t\t c  '), 'a b c');
  assert.equal(singleLineForQQ(null), '');
});

test('splitLongSegment：短文本原样返回，空串返回空数组', () => {
  assert.deepEqual(splitLongSegment('你好', 10), ['你好']);
  assert.deepEqual(splitLongSegment('   ', 10), []);
});

test('splitLongSegment：URL 是不可切开的最小单位', () => {
  const url = 'https://example.com/a/very/long/path?x=1&y=2';
  const out = splitLongSegment(`看看这个 ${url} 吧`, 12);
  assert.ok(out.some((s) => s.includes(url)), `URL 被拆坏：${JSON.stringify(out)}`);
  assert.ok(out.every((s) => !s.includes('\u0000')), '残留占位符');
});

test('splitLongSegment：不在 emoji 代理对中间下刀', () => {
  const text = 'a'.repeat(9) + '😀' + 'b'.repeat(9);
  const out = splitLongSegment(text, 10);
  assert.ok(out.every((s) => !/[\uD800-\uDBFF]$/.test(s)), `出现半个代理对：${JSON.stringify(out)}`);
  assert.equal(out.join(''), text);
});

test('splitByCjkSpaces：中文空格分条，单字碎片并回相邻段', () => {
  assert.deepEqual(splitByCjkSpaces('好 的呀'), ['好的呀']);
  assert.deepEqual(splitByCjkSpaces('牛逼 谁啊'), ['牛逼', '谁啊']);
  assert.deepEqual(splitByCjkSpaces('草 这也行'), ['草', '这也行']);
  assert.deepEqual(splitByCjkSpaces('DeepSeek V4 真快'), ['DeepSeek V4', '真快']);
});

test('planSocialTimeline：Markdown 图片剥离后单独追加，不参与分条', () => {
  const plan = planSocialTimeline('先说一句 ![猫](C:\\a b\\cat.gif) 再说', { maxReplyChars: 500 });
  assert.deepEqual(plan.main, ['先说一句', '再说', '![](C:\\a b\\cat.gif)']);
  assert.equal(plan.followUp, null);
});

test('planSocialTimeline：关闭分条时整条发送并按上限硬拆', () => {
  const plan = planSocialTimeline('一二三四五六', { burstEnabled: false, maxReplyChars: 3 });
  assert.deepEqual(plan.main, ['一二三', '四五六']);
});

test('convertExampleSpacesToComma：中文空格转逗号，英文/路径空格不动', () => {
  assert.equal(convertExampleSpacesToComma('你好 世界'), '你好，世界');
  assert.equal(convertExampleSpacesToComma('C:\\Program Files'), 'C:\\Program Files');
  assert.equal(convertExampleSpacesToComma('DeepSeek V4'), 'DeepSeek V4');
});

test('findCjkSpaceWarning：只提醒两侧都是中文的空格', () => {
  assert.match(findCjkSpaceWarning(['你好 世界']) || '', /第 1 条/);
  assert.equal(findCjkSpaceWarning(['DeepSeek V4']), null);
  assert.equal(findCjkSpaceWarning(['正常句子']), null);
});

test('findSplitBoundaryWarning：非终止标点/半句话断点才提醒', () => {
  assert.match(findSplitBoundaryWarning(['我想说，', '你听我讲']) || '', /1、2/);
  assert.equal(findSplitBoundaryWarning(['好的', '走吧']), null);
  assert.equal(findSplitBoundaryWarning(['一句话结束了。', '下一句']), null);
});

test('clampGapV2 与 computeGapsV2：fixed 模式按配置夹取', () => {
  const sendCfg = { burstIntervalMinMs: 300, maxGapMs: 5000 };
  assert.equal(clampGapV2(10, sendCfg), 300);
  assert.equal(clampGapV2(9000, sendCfg), 5000);
  assert.deepEqual(computeGapsV2(['a', 'b', 'c'], 'fixed', 1000, [], sendCfg), [1000, 1000]);
});

test('computeGapsV2：byLength 模式按时长递增', () => {
  const sendCfg = { burstIntervalMinMs: 100, maxGapMs: 10000, gapBaseMs: 800, gapPerCharMs: 20 };
  assert.deepEqual(computeGapsV2(['12345', '1'], 'byLength', 0, [], sendCfg), [900]);
  assert.deepEqual(computeGapsV2(['x'], 'auto', 0, [], sendCfg), []);
});
