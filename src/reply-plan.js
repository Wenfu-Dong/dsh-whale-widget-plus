/**
 * 回复分条 / 分句规划（组件化迁移 #12）。
 *
 * 从 src/bridge.js 的 main() 闭格里搬出来的纯函数：只做文本处理，不碰网络、
 * 不读配置对象以外的状态，方便单测，也避免这些规则再和发送链路混在一层。
 *
 * 规则来源：
 *   · 空格是分条信号（真人不会主动用中文空格）；
 *   · 超长段落按标点/字符硬拆，URL 与代理对（emoji）不可切开；
 *   · 单字碎片并回相邻段，避免「牛」「逼」各自成一条；
 *   · 二代仿真只做「软提醒」（中文空格、把一句话拆到两条），不拦截不改写。
 */
import { takeMarkdownImages } from './outbound-reply.mjs';

/** 合并单行文本里的换行与多余空白。 */
export function singleLineForQQ(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
// URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
export function splitLongSegment(segment, max) {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
  if (s.length <= safeMax) return [s];

  const urlRe = /https?:\/\/[^\s，。；、]+/g;
  const urls = [];
  const masked = s.replace(urlRe, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  const raw = masked.split(/([，、；：,;:])/);
  const tokens = [];
  for (let i = 0; i < raw.length; i += 2) {
    tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
  }
  const out = [];
  let cur = '';
  // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
  // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
  // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
  // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
  // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
  const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
  /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
  const splitByPlaceholder = (tok) => {
    const parts = [];
    let last = 0;
    let m;
    PLACEHOLDER_ALL.lastIndex = 0;
    while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
      // 零长度匹配会让 lastIndex 原地不动 → 死循环。占位符正则不应命中空串，
      // 但模型/第三方改正则时必须有这层兜底。
      if (m[0].length === 0) break;
      if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
      parts.push({ text: m[0], isPlaceholder: true });
      last = m.index + m[0].length;
    }
    if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
    return parts;
  };
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.length > safeMax) {
      if (cur) { out.push(cur); cur = ''; }
      for (const piece of splitByPlaceholder(tok)) {
        // 占位符整块输出；普通文本仍按 safeMax 切
        if (piece.isPlaceholder) { out.push(piece.text); continue; }
        for (let i = 0; i < piece.text.length;) {
          let end = Math.min(i + safeMax, piece.text.length);
          // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
          // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
          // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
          // 宁可硬切也要保证循环一定前进。
          if (end < piece.text.length && end - i > 1) {
            const lastCode = piece.text.charCodeAt(end - 1);
            if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
          }
          out.push(piece.text.slice(i, end));
          i += end > i ? end - i : safeMax;
        }
      }
    } else if (cur.length + tok.length <= safeMax) {
      cur += tok;
    } else {
      out.push(cur);
      cur = tok;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
    .filter(Boolean);
}

// 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
// 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
export function isCjkChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF)
  );
}

// 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
// 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
// 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
// 单字分条保护：空格分条本来是给「她想分两条说」用的，但弱模型会随手敲空格，
// 于是「牛逼 谁啊」变成两条、甚至把「牛逼」拆成「牛」「逼」——群里就是莫名其妙冒出一个单字。
// 这里把孤立的单个汉字并回相邻段；真正的单字反应（？ 草 6 行 嗯）放行。
const STANDALONE_REACTIONS = new Set(['？', '?', '！', '!', '…', '草', '6', '行', '嗯', '哦', '啊', '哈', '呵', '靠', '淦', '啧', '牛']);

export function mergeShortFragments(groups) {
  if (groups.length <= 1) return groups;
  const lone = (g) => {
    const chars = [...g];
    return chars.length === 1 && /[\u4e00-\u9fa5]/.test(chars[0]) && !STANDALONE_REACTIONS.has(chars[0]);
  };
  const out = [];
  for (const g of groups) {
    if (lone(g) && out.length) {
      out[out.length - 1] += g;
      continue;
    }
    out.push(g);
  }
  if (out.length > 1 && lone(out[0])) {
    out[1] = out[0] + out[1];
    out.shift();
  }
  return out;
}

export function splitByCjkSpaces(src) {
  const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return tokens;
  const groups = [];
  let cur = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const prevLast = [...cur].pop() || '';
    const currFirst = [...tokens[i]][0] || '';
    // 空格两侧只要有一侧是汉字，就视为分条信号。
    if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
      groups.push(cur);
      cur = tokens[i];
    } else {
      cur = cur + ' ' + tokens[i];
    }
  }
  if (cur) groups.push(cur);
  return mergeShortFragments(groups);
}

// 新分句逻辑：分句权交给 AI。
// AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
// 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
export function planSocialTimeline(text, socialCfg) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return { main: [], followUp: null };
  // 先把表情包等 Markdown 图片整段剥离，图片不参与分条：路径里即使带空格/换行，
  // 也不会被 splitByCjkSpaces 拆碎 —— 拆碎后就认不出是图片，只能把 markdown 原样发出去
  // （群里出现「![名字](C:\...\xxx.gif)」的根因）。图片作为独立条目追加，交由发送端转图片段。
  const split = takeMarkdownImages(raw);
  const src = split.text;
  const imageParts = split.images.map((url) => `![](${url})`);
  const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
  const enabled = socialCfg?.burstEnabled !== false;
  if (!src) return { main: imageParts, followUp: null };

  const planned = [];
  if (!enabled) {
    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    planned.push(...splitLongSegment(src, maxChars).map(singleLineForQQ));
  } else {
    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      planned.push(...splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ));
    } else {
      for (const part of parts) planned.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
  }
  return { main: [...planned, ...imageParts].filter(Boolean), followUp: null };
}

// 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
// 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
// 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
export function isCjkLikeChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0x3000 && code <= 0x303F)
  );
}

// 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
// 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
// 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
export function convertExampleSpacesToComma(line) {
  const chars = Array.from(String(line ?? ''));
  const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && isCjkLikeChar(prev);
      const nextCjk = !!next && isCjkLikeChar(next);
      const prevBlocked = !!prev && NO_REPLACE.has(prev);
      const nextBlocked = !!next && NO_REPLACE.has(next);
      if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
// 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
export function findCjkSpaceWarning(messages) {
  const bad = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const chars = Array.from(String(messages[i] ?? ''));
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (ch !== ' ' && ch !== '\t') continue;
      const prev = chars[j - 1];
      const next = chars[j + 1];
      if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
        bad.push(i + 1);
        break;
      }
    }
  }
  if (!bad.length) return null;
  const list = [...new Set(bad)];
  const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
  return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
}

// 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
// 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
// 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
export function findSplitBoundaryWarning(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return null;
  const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
  // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
  const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
  const bad = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const prev = String(messages[i] ?? '').trim();
    const next = String(messages[i + 1] ?? '').trim();
    if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
    const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
    const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
    const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
    if (nonTerminalPunct || incompleteTail) {
      bad.push(`${i + 1}、${i + 2}`);
    }
  }
  if (!bad.length) return null;
  return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
}

const randInt = (min, max) => {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
};

export function clampGapV2(ms, sendCfg) {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

export function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
    } else {
      const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampGapV2(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && Math.random() < longProb;
      const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
      const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
      delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
    }
  }
  return delays;
}
