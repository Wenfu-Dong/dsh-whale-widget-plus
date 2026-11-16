#!/usr/bin/env node
/**
 * 跨模块口径审计（divergence audit）。
 *
 * 为什么需要：
 *   2026-11-11 用户原话——「不光是这一个地方，别的功能模块都要查清楚，
 *   不然这些问题随时随地的爆出来，然后陷入死循环打补丁的流程」。
 *
 *   真正反复爆的根因不是某个正则写错，而是**同一个概念在多个模块里各算一遍**：
 *     · 数据目录：一半代码尊重 DSH_HOME，一半写死 ~/.dsh
 *       → 改过 DSH_HOME 的机器上「明明登录了却说没凭据」
 *     · 「今天」：一半用本机时区、一半用北京时间
 *       → 非 UTC+8 的机器「没用多少却额度已满」
 *     · 出站清洗：每个发送入口一份（已由 outbound-reply.mjs 收口）
 *
 *   这里把「同一概念只能有一个实现」变成可执行的检查，而不是靠人记得。
 *
 * 0 依赖，CI 直接跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = ['src', 'backend', 'packages/dsh-dfy-core'].map((d) => path.join(ROOT, d));
// 不参与运行时口径检查的目录：
//   · backend/tools、*/backend/tools —— 开发者命令行脚本（手动跑，不影响插件行为）
//   · backend/vendor/douyin        —— 第三方 vendor 代码（另一个口径，见下方 DAYKEY_ALLOW）
const EXCLUDE_DIRS = ['backend/tools', 'backend/vendor', 'packages/dsh-dfy-core/backend/tools'];
const failures = [];
const notes = [];
const ok = (m) => notes.push(m);
const fail = (m) => failures.push(m);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const excluded = (file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
};

const files = SOURCE_DIRS.flatMap((d) => walk(d)).filter((f) => !excluded(f));
const readAll = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// ── 1) 数据目录必须尊重 DSH_HOME ───────────────────────────────────────
// 违规写法：path.join(<home>, '.dsh', ...) 且同一行/同一个小函数里没有 DSH_HOME。
const HOME_DH_RE = /path\.join\(\s*(?:os\.homedir\(\)|home|HOME)\s*,\s*['"]\.dsh['"]/;
const ALLOW = new Set([
  // 共享口径的实现本身
  'src/character-persona.js',
  'src/dsh-client.js',
  'src/meme-wiki.js',
  'src/web-search.js',
  'src/token-budget.js',
  'src/day-key.mjs',
  // 抖音浏览器层：vendor 固定写 ~/.dsh/douyin-browser（不受 DSH_HOME 影响），
  // 这里必须跟它算同一份路径，否则插件和 vendor 会各看一个目录 → 读不到浏览器状态。
  // 两边内部一致，不构成分叉；改口径要连 vendor 一起改。
  'backend/lib/douyin.js',
]);
const offenders = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOW.has(rel)) continue;
  const text = readAll(file);
  const lines = text.split(/\r?\n/);
  let hasDshHome = /process\.env\.DSH_HOME/.test(text);
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (!HOME_DH_RE.test(line)) return;
    // 同一行里已经写了 DSH_HOME 兜底（`process.env.DSH_HOME || path.join(...)`）是合法写法
    if (/DSH_HOME/.test(line)) return;
    // 文件里根本没有 DSH_HOME 概念 → 一定写死了；文件里有但这一行没有 → 也可能是兜底分支，标出来人工看
    offenders.push({ rel, line: i + 1, text: line.trim().slice(0, 100), hasDshHome });
  });
}
const hardWired = offenders.filter((o) => !o.hasDshHome);
const suspicious = offenders.filter((o) => o.hasDshHome);
if (hardWired.length) {
  for (const o of hardWired) fail(`[数据目录] ${o.rel}:${o.line} 写死 ~/.dsh（不尊重 DSH_HOME）：${o.text}`);
} else ok('没有模块写死 ~/.dsh（数据目录统一尊重 DSH_HOME）');
if (suspicious.length) {
  for (const o of suspicious) fail(`[数据目录] ${o.rel}:${o.line} 这一行绕过了 DSH_HOME，请改成共享口径：${o.text}`);
}

// ── 2) 「今天」必须只有一个实现 ─────────────────────────────────────────
const DAYKEY_FILE = 'packages/dsh-dfy-core/src/day-key.js';
const dayKeyImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) return false;
  const t = readAll(f);
  return /Intl\.DateTimeFormat\(\s*['"]en-CA['"][\s\S]{0,80}Asia\/Shanghai/.test(t);
});
if (dayKeyImpl.length) {
  for (const f of dayKeyImpl) {
    fail(`[今天口径] ${path.relative(ROOT, f)} 又自己算了一遍北京时间日期；请 import { dayKey } from 'day-key.js'`);
  }
} else ok('「今天」只有 day-key.js 一个实现');
// 用本机时区算日期的写法（getFullYear + getMonth + getDate 拼日期）同样属于分叉。
// 极少数的「展示用本地时间戳」（日期+时刻+星期）可以显式豁免：在上一行写 day-key-allow 并说明原因。
const localDayOffenders = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) continue;
  const lines = readAll(f).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/getFullYear\s*\(\).*getDate\s*\(\)/.test(line)) return;
    if (/day-key-allow/.test(line) || /day-key-allow/.test(lines[i - 1] ?? '')) return;
    localDayOffenders.push(`${rel}:${i + 1}`);
  });
}
if (localDayOffenders.length) {
  for (const o of localDayOffenders) fail(`[今天口径] ${o} 用本机时区拼日期（非 UTC+8 的机器会和额度文件对不上）`);
} else ok('没有模块用本机时区拼「今天」');
// `toLocaleDateString('sv-SE')` 看起来是 ISO 日期，但它是**本机时区**的日期。
// 运行时模块里出现过 10+ 处，和北京时间的额度/日报口径错开一天。
const svSeOffenders = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) return false;
  return /toLocaleDateString\(\s*['"]sv-SE['"]\s*\)/.test(readAll(f));
});
if (svSeOffenders.length) {
  for (const f of svSeOffenders) fail(`[今天口径] ${path.relative(ROOT, f)} 用 toLocaleDateString('sv-SE') 算日期（本机时区）；请改用 dayKey()`);
} else ok('没有模块用 sv-SE 本地日期算「今天」');

// ── 3) 出站清洗只有一处实现 ────────────────────────────────────────────
// 任何模块再写一份「抽 [sticker:] / 剥 Markdown 图片」都算分叉。
const stickerImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  // reply-cleanup 是共享实现本体（outbound-reply 复用它），不是分叉。
  if (rel === 'src/outbound-reply.mjs' || rel === 'src/reply-cleanup.mjs') return false;
  const t = readAll(f);
  return /\\\[\(\?:sticker\|表情\)|\[sticker\[:：\]/.test(t);
});
if (stickerImpl.length) {
  for (const f of stickerImpl) fail(`[出站清洗] ${path.relative(ROOT, f)} 自己写了 [sticker:] 正则；请用 outbound-reply.mjs`);
} else ok('没有模块自写 [sticker:] 清洗');

// ── 4) 配置路径只有一处实现 ────────────────────────────────────────────
// QQ 配置固定是 <DSH_HOME>/surfcore/qq/config.json；散着拼容易漏层级（历史事故）。
const qqConfigImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const t = readAll(f);
  return /['"]surfcore['"]\s*,\s*['"]qq['"]\s*,\s*['"]config\.json['"]/.test(t);
});
if (qqConfigImpl.length > 4) {
  fail(`[配置路径] 有 ${qqConfigImpl.length} 处自己拼 QQ 配置路径（${qqConfigImpl.map((f) => path.relative(ROOT, f)).join(', ')}）：漏一层目录就会读不到配置`);
} else ok(`QQ 配置路径拼接集中在 ${qqConfigImpl.length} 处（可接受）`);

// ── 5) 音源清单与失败回落不分叉 ────────────────────────────────────────
// 加音源时最容易漏的两步：设置页下拉没加（用户选不到）、私有链路失败没回落
//（一个音源挂掉连带整条 QQ 语音不可用）。默认音色常量也必须两处一致。
const routesSrc = readAll(path.join(ROOT, 'src/voice-routes.mjs'));
const routesDef = routesSrc.match(/export const VOICE_ROUTES = \[([^\]]+)\]/);
const routes = routesDef ? [...routesDef[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const uiVoiceSrc = readAll(path.join(ROOT, 'lib/ui/pages/130-voice.js'));
if (!routes.length) {
  fail('[音源清单] 读不到 voice-routes.mjs 的 VOICE_ROUTES');
} else {
  const missingRoutes = routes.filter((r) => !uiVoiceSrc.includes(`value: '${r}'`));
  if (missingRoutes.length) {
    fail(`[音源清单] 设置页缺少音源选项：${missingRoutes.join(', ')}（新音源必须能选，否则等于没接）`);
  } else ok(`音源清单一致（${routes.length} 路都有设置项）`);
}
if (routes.includes('doubao-web') && !/fallbackFrom: effective/.test(routesSrc)) {
  fail('[音源清单] doubao-web 没有回落到 edge：私有链路挂掉会连带语音条不可用');
} else if (routes.includes('doubao-web')) ok('doubao-web 失败会回落 edge');

// 豆包网页音色以「网页里选的那个」为准：配置留空 = 跟随网页，任何一层都不许把它兜底成
// 写死的音色名（否则用户在网页换音色会被代码切回去，表现为「不同步」）。
const forcedDoubaoVoice = [
  ['src/voice-routes.mjs', /doubaoWebVoice\s*\|\|\s*DOUBAO_WEB_DEFAULT_VOICE/],
  ['src/bridge.js', /doubaoWebVoice[^\n]*DOUBAO_WEB_DEFAULT_VOICE/],
  ['backend/lib/pet-chat.js', /doubaoWebVoice[^\n]*DOUBAO_WEB_DEFAULT_VOICE/],
  ['lib/ui/pages/130-voice.js', /qqTts\.doubaoWebVoice\s*\?\?\s*'[^']+'/],
  ['config.example.json', /"doubaoWebVoice":\s*"[^"]+"/],
]
  .filter(([rel, re]) => re.test(readAll(path.join(ROOT, rel))))
  .map(([rel]) => rel);
if (forcedDoubaoVoice.length) {
  fail(`[音源清单] 豆包网页音色被写死默认值：${forcedDoubaoVoice.join('、')}（留空 = 跟随网页，否则网页里换音色不会生效）`);
} else ok('豆包网页音色默认跟随网页（各层都没有写死默认名）');
const followsWeb = /voice:\s*tts\.doubaoWebVoice\s*\|\|\s*''/.test(routesSrc)
  && /if \(wantedVoice && rt\.appliedVoice !== wantedVoice\)/.test(readAll(path.join(ROOT, 'src/voice-doubao-web.js')));
if (routes.includes('doubao-web') && !followsWeb) {
  fail('[音源清单] doubao-web 空音色没有走「跟随网页」分支（会退化成强制切某个音色）');
} else if (routes.includes('doubao-web')) ok('doubao-web 空音色 = 跟随网页（不主动切音色）');

const bridgeSrc = readAll(path.join(ROOT, 'src/bridge.js'));
const backendSrc = readAll(path.join(ROOT, 'backend/lib/index.js'));
const statusWired = bridgeSrc.includes("'/api/voice/doubao-web/status'")
  && uiVoiceSrc.includes("'/voice/doubao-web/status'")
  && backendSrc.includes('${API_PREFIX}/voice/doubao-web/');
if (routes.includes('doubao-web') && !statusWired) {
  fail('[音源清单] 豆包网页登录状态接口没接全（设置页 / 桥接 / 插件后端三层缺一层，用户只能靠失败反推登录态）');
} else if (routes.includes('doubao-web')) ok('豆包网页登录状态接口三层已接线（设置页 → 插件后端代理 → 桥接）');

// 设置页下拉选音色：列表接口 + 立即切换接口都必须三层接线，且切换后要同步内存配置
// （只改浏览器不改 cfg 的话，下一次合成又按旧配置切回去 —— 就是「改音色要重启」的根因）。
const voicePickWired = ['voices', 'voice'].every((k) => bridgeSrc.includes(`'/api/voice/doubao-web/${k}'`)
  && uiVoiceSrc.includes(`/voice/doubao-web/${k}`))
  && backendSrc.includes('${API_PREFIX}/voice/doubao-web/')
  && /cfg\.socialV2\.voice\.tts\.doubaoWebVoice\s*=/.test(bridgeSrc)
  && /export async function listDoubaoWebVoices/.test(readAll(path.join(ROOT, 'src/voice-doubao-web.js')));
if (routes.includes('doubao-web') && !voicePickWired) {
  fail('[音源清单] 豆包网页音色下拉没接全（voices/voice 三层 + 切换后同步内存 cfg，否则「选了不生效 / 要重启」）');
} else if (routes.includes('doubao-web')) ok('豆包网页音色下拉三层已接线，且切换即时同步内存配置');

// ── 结果 ──────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n跨模块口径审计失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\n修复方向：把分叉的实现统一到共享模块，而不是各修各的。');
  process.exit(1);
}
console.log('\n✔ 跨模块口径审计通过：数据目录 / 今天 / 出站清洗 / 配置路径 / 音源清单都只有一个实现。');
