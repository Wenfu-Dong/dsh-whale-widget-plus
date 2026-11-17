/**
 * 图片 / 表情字节解析（组件化迁移 #13）。
 *
 * 从 src/bridge.js 的 main() 闭格里搬出来的纯解析工具：识别格式、读取宽高、
 * 解析 base64、限制媒体上限、判断本地路径与表情 CDN。这里不发起网络请求，
 * 也不直接写日志/读配置，所有副作用由调用方注入，方便单测与复用。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 按文件头识别图片 MIME。 */
export function mimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

/** 按 URL 后缀推断图片 MIME。 */
export function mimeFromUrl(url, fallback = 'image/jpeg') {
  try {
    const pathname = new URL(String(url)).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  } catch {}
  return fallback;
}

// 解析常见图片宽高（PNG/JPEG/GIF/WebP），用于限制“图片炸弹”的解码像素量。
export function getImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) return null;
        // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
    }
  } catch {}
  return null;
}

/** 解析 base64://、data:image/... 或纯 base64 字符串。 */
export function base64FromMaybe(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
  if (s.startsWith('data:image/')) {
    const idx = s.indexOf(',');
    if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
  }
  // 纯 base64（允许少量空白）
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
  return null;
}

// 媒体上限（config.json 可调，但必须收敛到安全区间）：
//   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
//                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
//   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
//   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
export function resolveMediaLimits(cfg) {
  const media = cfg?.socialV2?.media || {};
  const bytes = Number(media.maxBytes);
  const count = Number(media.maxCount);
  const pixels = Number(media.maxPixels);
  const maxBytes = Number.isFinite(bytes) && bytes > 0
    ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(bytes)))
    : 8 * 1024 * 1024;
  const maxCount = Number.isFinite(count) && count > 0
    ? Math.min(8, Math.max(1, Math.round(count)))
    : 5;
  const maxPixels = Number.isFinite(pixels) && pixels > 0
    ? Math.min(64_000_000, Math.max(1_000_000, Math.round(pixels)))
    : 64_000_000;
  return { maxBytes, maxCount, maxPixels };
}

/** 本地媒体路径必须位于 SnowLuma 资料目录内（防任意文件读取）。 */
export function isSafeLocalMediaPath(filePath, homeDir) {
  try {
    const real = fs.realpathSync(String(filePath));
    if (!homeDir) return false;
    const realHome = fs.realpathSync(String(homeDir));
    return real === realHome || real.startsWith(realHome + path.sep);
  } catch {
    return false;
  }
}

// OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
// 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
export function isProbablySafeImageFileRef(file) {
  const s = String(file ?? '').trim();
  if (!s || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[\\/]/.test(s)) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;
  if (/^(file|https?|base64|data):/i.test(s)) return false;
  if (s.includes('..')) return false;
  return /^[\w.+=@-]+$/.test(s);
}

// QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
// https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
// 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
// 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
export function emojiCdnCandidates(emojiId) {
  const id = String(emojiId ?? '').trim();
  if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
  return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
}

/** 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。 */
export function emojiIdFromFileName(file) {
  const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
  return match ? match[1] : '';
}

/** 校验一张图片字节：格式、像素上限；不通过返回 null。大小由调用方先限。 */
export function acceptImageBuffer(buf, label = '图片', { maxPixels, log = () => {} } = {}) {
  if (!buf || !buf.length) return null;
  const head = buf.toString('ascii', 0, 6);
  const isImage = (buf.length >= 12 && (
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    head === 'GIF87a' || head === 'GIF89a' ||
    (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
  ));
  if (!isImage) {
    log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
    return null;
  }
  const dims = getImageDimensions(buf);
  if (dims && Number.isFinite(maxPixels) && maxPixels > 0 && dims.width * dims.height > maxPixels) {
    log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
    return null;
  }
  return { buffer: buf, mimeType: mimeFromBuffer(buf) };
}
