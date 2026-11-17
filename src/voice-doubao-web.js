// 豆包网页版朗读音源（doubao-web）。
//
// 为什么接它：火山开放 API 只有 2 个音色，豆包网页版却有整套「对话音色」
//（温柔桃子 / 磁性俊宇 / 邻家女孩 …，实际下发的是 *_conversation_*_bigtts），
// 这些音色只能通过网页的朗读接口拿到。做法是「常驻一个 Edge（Playwright）打开
// doubao.com → 让豆包原样复读这段文字 → 点回复下方的朗读按钮 → 抓朗读 WebSocket
// 的音频帧 → ffmpeg 转 mp3」，输出与 edge 路由同构的 mp3，下游（SnowLuma/QQ）不用改。
//
// 代价与边界（用户已知并接受）：
//   · 每次合成长（要等模型复读 + 合成，通常 8~20 秒）；
//   · 依赖网页登录态与页面结构，豆包改版/风控会失效 → 由调用方回落到 edge；
//   · 朗读走的是「复读出来的这句话」，文字若有偏差/加料，音频就不等于原文，所以这里
//     会做一次「回复是否等于原文」的校验，不合格宁可失败（让调用方回落），也不发错话。
//
// 音色：网页的朗读音色在「设置 → 通用 → 偏好设置 → 声音选择」里，服务端再把它映射成
// TTS speaker（例如 温柔桃子（升级版）→ zh_female_taozi_conversation_v4_wvae_bigtts）。
// 默认**跟随网页**（配置项 doubaoWebVoice 留空 / auto）：在网页里换了音色，下一次朗读和试听
// 就直接用新的，不需要在这里填名称。只有填了显示名时才会主动去网页里切一次（失败不致命）。
//
// 登录：首次需要人工扫码。设置页「登录 / 换账号」按钮（或 scripts/doubao-web-login.mjs）会打开有头
// 窗口让用户登录，登录态保存在 doubaoWebProfileDir（默认 <state>/doubao-web-profile）。
// 换账号后可继续用：朗读音色跟着账号走，所以每次合成前按 localStorage 里的 uid 检测账号是否变化，
// 变了就按音色名重新选一次；新账号没有该音色时只告警，沿用网页当前音色。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pruneAudioCache, resolveFfmpeg } from './voice-core.js';
import { resolveHostModule } from './host-module.mjs';

const require = createRequire(import.meta.url);

const CHAT_URL = 'https://www.doubao.com/chat/';
// 与真实 Edge 一致：headless 的默认 UA 带 HeadlessChrome，容易被风控直接拦。
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
// 空闲这么久就关掉浏览器：常驻进程占内存，也会一直挂着一个 Edge。
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const MIN_OGG_BYTES = 1024;

let runtime = null;
// 同一时刻只允许一次「发送 → 等回复 → 点朗读」：共用一页，并发会互相抢消息与音频帧。
let queue = Promise.resolve();

function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});
  return run;
}

/** 默认 profile 目录：与 QQ 数据根同层级，卸载/清临时目录都不会丢登录态。 */
export function defaultProfileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'surfcore', 'qq', 'state', 'doubao-web-profile');
}

function loadChromium() {
  // 插件不再自带 playwright-core（dependencies 已移除——它是 DSH 宿主自带的包，
  // 插件声明一份会在安装时遮蔽宿主浏览器栈，「装上插件 DSH 整体启动失败」同机制）。
  // 改为：插件旧副本（开发机残留）→ 宿主 profile → DSH 运行时；都没有才报错。
  try {
    const mod = require('playwright-core');
    if (mod?.chromium) return mod.chromium;
  } catch { /* 新依赖策略下的常态 */ }
  const host = resolveHostModule('playwright-core') ?? resolveHostModule('playwright');
  if (!host?.chromium) {
    throw new Error('豆包网页音源缺浏览器引擎：playwright-core 没找到（插件不再自带，改用 DSH 宿主副本）。'
      + '确认 DSH 已完整安装并至少打开过一次（profiles/*/node_modules 里应有 playwright-core），然后完全重启 DSH 再试。');
  }
  return host.chromium;
}

/** 极简 protobuf 解析：只取我们需要的字段（4=事件名，8=音频块），够用且不引依赖。 */
function parseProto(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key = 0;
    let shift = 0;
    let b;
    do {
      if (i >= buf.length) return out;
      b = buf[i++];
      key |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v = 0;
      let s = 0;
      do {
        if (i >= buf.length) return out;
        b = buf[i++];
        v |= (b & 0x7f) << s;
        s += 7;
      } while (b & 0x80);
      out.push({ field, varint: v });
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      do {
        if (i >= buf.length) return out;
        b = buf[i++];
        len |= (b & 0x7f) << s;
        s += 7;
      } while (b & 0x80);
      if (i + len > buf.length) return out;
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return out;
    }
  }
  return out;
}

/**
 * 一段朗读会话：豆包把整句音频拆成多个 field8 的 Ogg 页，按到达顺序拼接即可。
 * （实测拼接后是标准 Ogg Opus / 24kHz 单声道，ffmpeg 可直接读。）
 */
function createCapture() {
  return { sessions: [] };
}

function attachCapture(page, capture) {
  page.on('websocket', (ws) => {
    if (!/voicegenie/i.test(ws.url())) return;
    const session = { frames: [], events: [], ended: false, uid: '', speaker: '' };
    capture.sessions.push(session);
    // 发出去的 StartTTS 帧里带 uid 与实际 speaker：既能在换账号时自动重设音色，
    // 也能把「网页到底用了哪个 speaker」回显到设置页（排查音色没换过来）。
    ws.on('framesent', (frame) => {
      if (typeof frame.payload === 'string') return;
      let fields;
      try { fields = parseProto(Buffer.from(frame.payload)); } catch { return; }
      for (const item of fields) {
        if (item.field !== 6 || !item.bytes) continue;
        const json = item.bytes.toString('utf8');
        const uid = json.match(/"uid":"?([0-9]+)"?/);
        if (uid) session.uid = uid[1];
        const speaker = json.match(/"speaker":"([^"]+)"/);
        if (speaker) session.speaker = speaker[1];
      }
    });
    ws.on('framereceived', (frame) => {
      if (typeof frame.payload === 'string') return;
      let fields;
      try { fields = parseProto(Buffer.from(frame.payload)); } catch { return; }
      for (const item of fields) {
        if (item.field === 4 && item.bytes) {
          const event = item.bytes.toString('utf8');
          session.events.push(event);
          if (event === 'TTSEnded' || event === 'SessionCanceled' || event === 'TaskFailed') session.ended = true;
        } else if (item.field === 8 && item.bytes && item.bytes.length) {
          session.frames.push(Buffer.from(item.bytes));
        }
      }
    });
    ws.on('close', () => { session.ended = true; });
  });
}

function touch(rt) {
  rt.lastUsedAt = Date.now();
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  rt.idleTimer = setTimeout(() => { closeRuntime(); }, IDLE_CLOSE_MS);
  try { rt.idleTimer.unref?.(); } catch {}
}

async function closeRuntime() {
  const rt = runtime;
  runtime = null;
  if (!rt) return;
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  try { await rt.ctx.close(); } catch {}
}

/** 供测试 / 进程退出时主动释放。 */
export async function closeDoubaoWeb() {
  await closeRuntime();
}

async function launch({ profileDir, headless }) {
  const chromium = loadChromium();
  const dir = path.resolve(profileDir || defaultProfileDir());
  fs.mkdirSync(dir, { recursive: true });
  const options = {
    channel: 'msedge',
    headless: headless !== false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: EDGE_UA,
    // 只做朗读抓帧，不需要下载/权限弹窗；静音避免在有头模式下真的出声。
    acceptDownloads: false,
    args: ['--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-blink-features=AutomationControlled'],
  };
  let ctx = null;
  let lastError = null;
  // 上一轮 ctx.close() 后 Edge 可能还有几秒没退干净（profile 仍被锁），
  // 这时首次启动会 exit 21。隔 1.5 秒重试一次，避免「空闲关浏览器后下一句必失败」。
  for (let attempt = 0; attempt < 2 && !ctx; attempt += 1) {
    try {
      ctx = await chromium.launchPersistentContext(dir, options);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const transient = /exitCode=21|ProcessSingleton|SingletonLock|already in use|has been closed|EBUSY|EPERM/i.test(message);
      if (!transient || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  if (!ctx) {
    const message = String(lastError?.message ?? lastError);
    throw new Error(`打不开豆包网页浏览器（${dir}）：${message.slice(0, 200)}`);
  }

  const page = ctx.pages()[0] ?? await ctx.newPage();
  const capture = createCapture();
  attachCapture(page, capture);
  const rt = { ctx, page, capture, dir, appliedVoice: '', lastUsedAt: Date.now(), idleTimer: null };
  ctx.on('close', () => { if (runtime === rt) runtime = null; });
  touch(rt);
  return rt;
}

async function getRuntime({ profileDir, headless }) {
  if (runtime) {
    touch(runtime);
    return runtime;
  }
  runtime = await launch({ profileDir, headless });
  return runtime;
}

/** 登录账号标识：网页把 uid 写在 localStorage（flow_tea_user_id），账号一换这里就变。 */
async function readUid(rt) {
  try {
    return String(await rt.page.evaluate(() => localStorage.getItem('flow_tea_user_id') || '')).trim();
  } catch {
    return '';
  }
}

async function closeSettingsIfOpen(page) {
  const modal = page.locator('[data-testid="settings_modal"]');
  if (await modal.isVisible().catch(() => false)) {
    await page.locator('[data-testid="setting-modal-close"]').click({ timeout: 5000 }).catch(() => {});
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }
}

async function ensureChatPage(rt) {
  const { page } = rt;
  if (!/doubao\.com/.test(page.url())) {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  const editor = page.locator('.ProseMirror').first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 30000 });
  } catch {
    let text = '';
    try { text = await page.evaluate(() => String(document.body.innerText || '').slice(0, 600)); } catch {}
    if (/登录|扫码|手机号|验证码|Log in|Sign in/i.test(text)) {
      throw new Error(`豆包网页未登录：请先运行 node scripts/doubao-web-login.mjs 登录（profile：${rt.dir}）`);
    }
    throw new Error(`豆包网页没加载出输入框（网络/改版/风控都可能）：${text.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

function normalizeWords(text) {
  return String(text || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：""''（）()《》【】…—~·,.!?;:'"()[\]<>-]/g, '');
}

/**
 * 打开「设置 → 通用 → 声音选择」，读出列表里的全部显示名。
 * 列表项形如「温柔桃子 / 女 / 青年 / 温柔」（第一行是名字，下面几行是标签）。
 */
async function openVoiceList(rt) {
  const { page } = rt;
  await closeSettingsIfOpen(page);
  await page.locator('[data-testid="sidebar_footer_setting_entry"]').click({ timeout: 15000 });
  const modal = page.locator('[data-testid="settings_modal"]');
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('[data-testid="settings-category-general"]').click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.getByText('声音选择', { exact: true }).last().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
  const items = modal.locator('[class*="speaker-item-"]');
  const total = await items.count();
  if (!total) throw new Error('音色列表没加载出来');
  const names = [];
  for (let i = 0; i < total; i += 1) {
    let first = '';
    try { first = String(await items.nth(i).innerText()).split('\n')[0].trim(); } catch { /* 虚拟列表可能滚掉 */ }
    names.push(first);
  }
  return { page, modal, items, names };
}

/**
 * 按显示名切换朗读音色。
 * 默认失败只告警不抛：音色不对总比整条语音发不出去好；
 * 用户在设置页手动选音色时用 strict，让失败原因能显示出来。
 */
async function applyVoice(rt, wantedName, options = {}) {
  const name = String(wantedName || '').trim();
  if (!name) return false;
  try {
    const { page, modal, items, names } = await openVoiceList(rt);
    // 名字里可能带「（升级版）」/「（经典版）」，所以先严格匹配全文，再忽略括号匹配，
    // 无括号的那一项就是升级版（豆包网页把「升级版」这个后缀省掉了）。
    const norm = (s) => String(s || '').replace(/[\s\u3000]/g, '').replace(/（.*?）|\(.*?\)/g, '');
    const strict = names.indexOf(name);
    let index = strict;
    if (index < 0) {
      const wanted = norm(name);
      const loose = names
        .map((n, i) => ({ n, i }))
        .filter((x) => norm(x.n) === wanted);
      const plain = loose.find((x) => !/[（(]/.test(x.n));
      index = (plain || loose[0] || { i: -1 }).i;
    }
    if (index < 0) throw new Error(`音色列表里没找到「${name}」（现有：${names.slice(0, 8).join('、')}）`);
    await items.nth(index).click({ timeout: 10000 });
    const confirm = page.getByText('确定', { exact: true });
    if (await confirm.count()) await confirm.last().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.locator('[data-testid="setting-modal-close"]').click({ timeout: 5000 }).catch(() => {});
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return true;
  } catch (error) {
    const reason = `切换音色「${name}」失败：${String(error?.message ?? error).slice(0, 160)}`;
    await closeSettingsIfOpen(rt.page).catch(() => {});
    if (options.strict) throw new Error(reason);
    console.warn(`[voice][doubao-web] ${reason}，沿用网页当前音色`);
    return false;
  }
}

/**
 * 列出网页「声音选择」里的全部音色显示名（设置页下拉用）。
 * 首次会启动浏览器（6~10 秒），之后复用同一个浏览器实例。
 */
export async function listDoubaoWebVoices({ profileDir = '', headless = true } = {}) {
  // 和合成共用同一个浏览器页面，必须排进串行队列，否则会和「发送→点朗读」抢页面。
  return serialize(async () => {
    const rt = await getRuntime({ profileDir, headless });
    await ensureChatPage(rt);
    const { page, names } = await openVoiceList(rt);
    await closeSettingsIfOpen(page).catch(() => {});
    const voices = [...new Set(names.filter(Boolean))];
    return { ok: true, voices, count: voices.length, uid: rt.uid || '', profileDir: rt.dir };
  });
}

/**
 * 立即切换网页音色（不重启 DSH）：空名 = 跟随网页当前音色（不主动切）。
 * 只改运行中的浏览器，不改配置文件；持久化仍由设置页「保存」完成。
 */
export async function selectDoubaoWebVoice({ name = '', profileDir = '', headless = true } = {}) {
  return serialize(async () => {
    const rt = await getRuntime({ profileDir, headless });
    await ensureChatPage(rt);
    const wanted = String(name || '').trim();
    if (!wanted) {
      rt.appliedVoice = '';
      return { ok: true, voice: '', uid: rt.uid || '' };
    }
    await applyVoice(rt, wanted, { strict: true });
    rt.appliedVoice = wanted;
    return { ok: true, voice: wanted, uid: rt.uid || '' };
  });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const recv = [...document.querySelectorAll('[data-testid="receive_message"]')];
    const last = recv[recv.length - 1];
    const textEl = last ? last.querySelector('[data-testid="message_text_content"]') : null;
    return {
      recv: recv.length,
      read: document.querySelectorAll('[data-testid="audio_play_button"]').length,
      text: textEl ? String(textEl.innerText || '') : '',
    };
  });
}

/** 回复完成判定：助手消息数增加 + 文字稳定，且朗读按钮已出现。 */
async function waitForReply(page, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  let stableMs = 0;
  let snap = null;
  while (Date.now() < deadline) {
    snap = await snapshot(page).catch(() => null);
    if (snap) {
      if (snap.text && snap.text === lastText) stableMs += 500;
      else stableMs = 0;
      lastText = snap.text;
      if (snap.recv > baseline.recv && snap.text && snap.read > baseline.read && stableMs >= 1500) return snap;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`等豆包复读超时（${Math.round(timeoutMs / 1000)}s，最后回复：${String(snap?.text || '').slice(0, 60)}）`);
}

async function waitForAudio(rt, timeoutMs) {
  const { page, capture } = rt;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let clicked = false;
  let lastCount = 0;
  let lastFrameAt = startedAt;
  // loop-allow: 收到 TTSEnded 且已有音频 / 3 秒无新帧 / 超过 deadline
  for (;;) {
    const sessions = capture.sessions;
    const frames = sessions.reduce((n, s) => n + s.frames.length, 0);
    const ended = sessions.some((s) => s.ended);
    if (frames > lastCount) { lastCount = frames; lastFrameAt = Date.now(); }
    if (ended && frames > 0) break;
    if (frames > 0 && Date.now() - lastFrameAt > 3000) break;
    if (!frames && !clicked && Date.now() - startedAt > 2000) {
      // 不是所有账号都会自动朗读：没动静就点最后一次回复的朗读按钮。
      const btn = page.locator('[data-testid="receive_message"]').last().locator('[data-testid="audio_play_button"]');
      if (await btn.count()) {
        await btn.first().click({ timeout: 8000 }).catch(() => {});
        clicked = true;
      }
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  const parts = [];
  for (const session of capture.sessions) parts.push(...session.frames);
  const audio = Buffer.concat(parts);
  if (audio.length < MIN_OGG_BYTES) {
    throw new Error(`豆包网页没返回音频（收到 ${audio.length} 字节；可能账号被限制或页面改版）`);
  }
  if (audio.subarray(0, 4).toString('ascii') !== 'OggS') {
    throw new Error('豆包网页返回的音频不是 Ogg（朗读接口可能改版了）');
  }
  return audio;
}

function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      reject(new Error(`ffmpeg 启动失败：${error?.message ?? error}`));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('ffmpeg 转 mp3 超时'));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(error?.code === 'ENOENT'
        ? '找不到 ffmpeg（请设置 FFMPEG_PATH 或在 config.json 里指定 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转 mp3 失败（退出码 ${code}）`));
    });
  });
}

function cacheKey(input) {
  return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

async function runOneTts(rt, say, timeoutMs) {
  const { page, capture } = rt;
  await closeSettingsIfOpen(page);
  capture.sessions = [];
  const baseline = await snapshot(page);

  const editor = page.locator('.ProseMirror').first();
  await editor.click({ timeout: 15000 });
  // 兜底清空：上一次若失败可能残留草稿，直接追加会把两段话一起念。
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  const prompt = `请原样朗读下面这段文字，不要做任何修改、解释或补充：\n${say}`;
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');

  const reply = await waitForReply(page, baseline, Math.min(timeoutMs, 120000));
  // 校验「复读」是否忠实：不忠实就失败，让调用方回落，别把错的话发出去。
  const want = normalizeWords(say);
  const got = normalizeWords(reply.text);
  if (want && (!got.includes(want) || got.length > want.length * 2 + 20)) {
    throw new Error(`豆包没有原样复读（回复是「${reply.text.replace(/\s+/g, ' ').slice(0, 60)}」）`);
  }

  const audio = await waitForAudio(rt, Math.max(15000, Math.min(timeoutMs, 60000)));
  // 从 WS 请求帧里补记 uid / 实际 speaker：uid 用于换账号检测，speaker 用于设置页回显。
  const speaker = capture.sessions.map((s) => s.speaker).find(Boolean) || '';
  if (speaker) rt.lastSpeaker = speaker;
  const uid = capture.sessions.map((s) => s.uid).find(Boolean) || '';
  if (uid) rt.uid = uid;
  return audio;
}

/**
 * 文字 → 缓存 mp3（与 edge 路由同契约）。
 * @returns {Promise<{path:string,durationMs:number,cached:boolean,format:string}>}
 */
export async function synthesizeDoubaoWebToFile({
  text,
  voice = '',
  timeoutMs = 120000,
  cacheVersion = null,
  outDir,
  profileDir = '',
  headless = true,
  ffmpegPath = null,
} = {}) {
  const say = String(text ?? '').trim();
  if (!say) throw new Error('要合成的内容是空的');
  if (!outDir) throw new Error('缺少 outDir（TTS 缓存目录）');
  // voice 留空 / auto = 跟随网页里当前选中的音色（不主动切换）。
  const rawVoice = String(voice || '').trim();
  const wantedVoice = /^(auto|跟随网页|跟随网页音色)$/i.test(rawVoice) ? '' : rawVoice;
  // 跟随网页时不能复用磁盘缓存：用户在网页里换了音色，缓存里还是旧音色，
  // 直接返回旧文件会让「自动同步」看起来失效。所以只有指定了音色名才走缓存。
  const cacheable = Boolean(wantedVoice);
  fs.mkdirSync(outDir, { recursive: true });

  const file = path.join(outDir, `doubao-web-${cacheKey({ say, voice: wantedVoice || 'web', cacheVersion })}.mp3`);
  if (cacheable && fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > 1024) return { path: file, durationMs: 0, cached: true, format: 'mp3' };
    } catch { /* 缓存坏了就重合成 */ }
  }

  const budget = Math.max(30000, Math.min(180000, Number(timeoutMs) || 120000));
  return serialize(async () => {
    const rt = await getRuntime({ profileDir, headless });
    try {
      await ensureChatPage(rt);
      // 换账号后「网页音色选择」是跟着账号走的：uid 变了就作废本地缓存，重新按配置选一次。
      const uid = await readUid(rt);
      if (uid) {
        if (rt.uid && rt.uid !== uid) {
          if (wantedVoice) console.warn('[voice][doubao-web] 检测到豆包账号已变化，将重新按配置选音色');
          rt.appliedVoice = '';
        }
        rt.uid = uid;
      }
      if (wantedVoice && rt.appliedVoice !== wantedVoice) {
        if (await applyVoice(rt, wantedVoice)) rt.appliedVoice = wantedVoice;
      }
      const ogg = await runOneTts(rt, say, budget);

      const tmpOgg = path.join(os.tmpdir(), `doubao-web-${process.pid}-${crypto.randomBytes(4).toString('hex')}.ogg`);
      const tmpMp3 = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmpOgg, ogg);
        await runFfmpeg(resolveFfmpeg({ ffmpegPath }), [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', tmpOgg, '-vn', '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', '-ac', '1',
          // 输出文件是 .tmp 临时名，必须显式指定封装格式，否则 ffmpeg 猜不出扩展名会直接失败。
          '-f', 'mp3', tmpMp3,
        ], 30000);
        const size = fs.statSync(tmpMp3).size;
        if (size < 512) throw new Error('ffmpeg 输出为空（豆包音频可能不完整）');
        fs.renameSync(tmpMp3, file);
      } finally {
        try { fs.unlinkSync(tmpOgg); } catch {}
        try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch {}
      }
      pruneAudioCache(outDir, { exts: ['.mp3'] });
      return { path: file, durationMs: 0, cached: false, format: 'mp3' };
    } catch (error) {
      // 页面状态可能已经脏了（卡在弹窗/正在播报）：下次重建浏览器，比在坏页面上重试可靠。
      await closeRuntime().catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (runtime === rt) touch(rt);
    }
  });
}

/**
 * 登录状态体检（设置页「检查登录状态」）：会真实打开一次豆包网页确认输入框在。
 * 首次调用要启动浏览器 + 载入页面（约 6~10 秒），之后浏览器会常驻到空闲超时。
 */
export async function doubaoWebStatus({ profileDir = '', headless = true } = {}) {
  const dir = path.resolve(profileDir || defaultProfileDir());
  try {
    const rt = await getRuntime({ profileDir, headless });
    await ensureChatPage(rt);
    const uid = await readUid(rt);
    if (uid) rt.uid = uid;
    return {
      ok: true,
      loggedIn: true,
      uid,
      voice: rt.appliedVoice || '',
      lastSpeaker: rt.lastSpeaker || '',
      profileDir: dir,
    };
  } catch (error) {
    // 停在登录页的浏览器没有复用价值，关掉，避免下一次合成先白等 30 秒。
    await closeRuntime().catch(() => {});
    return { ok: false, loggedIn: false, error: String(error?.message ?? error), profileDir: dir };
  }
}

/**
 * 打开有头浏览器让用户扫码登录（登录态写进同一个 profile）。
 * 登录成功后自动关闭；超时也关闭，由调用方提示重试。
 */
export async function openDoubaoWebLogin({ profileDir = '', timeoutMs = 5 * 60 * 1000 } = {}) {
  await closeRuntime();
  const rt = await launch({ profileDir, headless: false });
  try {
    await rt.page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await rt.page.locator('.ProseMirror').first().waitFor({ state: 'visible', timeout: timeoutMs });
    // 留 1.5 秒让页面把登录态写稳，再关窗口。
    await rt.page.waitForTimeout(1500);
    return { ok: true, uid: await readUid(rt) };
  } finally {
    await closeRuntime();
  }
}
