/**
 * 抖音 MediaAdapter —— vendor 契约的本地实现（默认关闭）。
 *
 * 为什么必须有这个文件：core.mjs 的 `douyin_media_status` 工具与 listen()、
 * chat-service 的语音转写都会动态导入 ./media/index.mjs。2026-11-17 安装模拟
 * 闸门发现这个文件**从未入库**（git 历史零记录）——任何一条懒加载路径被走到就
 * 直接 ERR_MODULE_NOT_FOUND 崩掉，把 vendor 精心设计的「未启用优雅降级」
 * （listen 的 audioAvailable:false、transcribeMessage 的「需要本人开启本地
 * Whisper」提示）全部变成裸异常。
 *
 * 本实现遵守调用方的契约（不新增能力）：
 *   · settings()  默认 enabled:false —— 所有调用方看到关闭就走各自的降级分支；
 *   · status()    报告本地 whisper 可用性（命令不存在就是不可用，不假装）；
 *   · transcribeAudio() 只在用户显式写好 settings.json（enabled:true + whisper 命令）
 *     后才真正执行；结果形状严格按 chat-service.transcribeMessage 的校验来
 *     （ok/backend/kind/text/interval，或 no-speech 变体）。
 *
 * 启用方法（本机可选，不做任何设置页入口）：把 <stateDir>/douyin-media.json 写成
 *   { "enabled": true, "backend": "local-whisper", "whisperCommand": ["whisper", "--model", "small"] }
 * whisperCommand 以文件内容为准、逐元素 spawn（不拼 shell），stderr/stdout 都不外发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveRuntimePaths } from '../runtime-paths.mjs';

const SETTINGS_FILE = 'douyin-media.json';
const AUDIO_MIME_OK = true; // 转写只吃本地文件路径；来源合法性由调用方（chat-service）核过

function settingsPath() {
  return path.join(resolveRuntimePaths().stateDir, SETTINGS_FILE);
}

function readSettings() {
  const file = settingsPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { enabled: false };
    return {
      enabled: raw.enabled === true,
      backend: raw.backend === 'local-whisper' ? 'local-whisper' : '',
      whisperCommand: Array.isArray(raw.whisperCommand)
        ? raw.whisperCommand.map(String).filter(Boolean)
        : (typeof raw.whisperCommand === 'string' && raw.whisperCommand.trim() ? [raw.whisperCommand.trim()] : []),
      language: typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : 'auto',
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // 配置写坏了就当关闭处理，但要留一句日志线索——不静默。
      console.error(`[douyin-media] ${SETTINGS_FILE} 无法读取（按未启用处理）：${error?.message ?? error}`);
    }
    return { enabled: false };
  }
}

function whisperAvailable(command) {
  if (!command.length) return false;
  return new Promise((resolve) => {
    const child = spawn(command[0], [...command.slice(1), '--help'], { windowsHide: true });
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; try { child.kill(); } catch { void 0; } resolve(ok); } };
    child.on('error', () => done(false));
    child.on('close', (code) => done(code === 0 || code === 1 || code === 2)); // 部分实现 --help 返回非 0 但仍是可用命令
    setTimeout(() => done(false), 8000).unref?.();
  });
}

function runWhisper(command, { source, language }) {
  return new Promise((resolve) => {
    const args = [...command.slice(1), source];
    if (language && language !== 'auto') args.push('--language', language);
    // whisper CLI 的输出形态多样：这里不解析花哨格式，只要最后一段非空文本；
    // --output_format txt 若被命令自带参数覆盖，也仍能从 stdout 兜底。
    const child = spawn(command[0], args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => { try { child.kill('killed'); } catch { void 0; } }, 10 * 60_000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: `whisper 启动失败：${error?.message ?? error}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `whisper 退出码 ${code}${err ? `：${err.slice(-300)}` : ''}` });
        return;
      }
      // 优先读同目录 .txt（whisper 默认输出），否则用 stdout 的尾部。
      const txtFile = `${source.replace(/\.[^.]+$/, '')}.txt`;
      let text = '';
      try { text = fs.readFileSync(txtFile, 'utf8'); } catch { text = out; }
      text = String(text ?? '').replace(/\r/g, '').split('\n').map((line) => line.replace(/^\[\d{2}:\d{2}[:.]\d{2}(?:\.\d+)?\]\s*/, '').trim()).filter(Boolean).join(' ').trim();
      resolve({ ok: true, text });
    });
  });
}

export class MediaAdapter {
  constructor() {
    // 与 vendor 其它模块一致：状态文件随 runtime-location.json 的 stateDir 走。
    this.settingsFile = settingsPath();
  }

  async settings() {
    const s = readSettings();
    return { enabled: s.enabled === true, backend: s.backend || '' };
  }

  async status() {
    const s = readSettings();
    const command = s.whisperCommand ?? [];
    const available = s.enabled && s.backend === 'local-whisper' ? await whisperAvailable(command) : false;
    return {
      enabled: s.enabled === true,
      backend: s.backend || '',
      backends: { 'local-whisper': { available, command: command.length ? command[0] : '' } },
      settingsFile: this.settingsFile,
    };
  }

  /**
   * @param {object} input - { source: 绝对路径, startSeconds, durationSeconds, backend, language }
   * @param {object} opts - { signal }
   */
  async transcribeAudio(input, { signal } = {}) {
    const s = readSettings();
    if (!s.enabled || s.backend !== 'local-whisper') {
      return { ok: false, backend: 'local-whisper', kind: 'transcription', error: '媒体适配未启用：把 stateDir/douyin-media.json 写成 enabled:true 并配置 whisperCommand' };
    }
    const source = String(input?.source ?? '');
    if (!source || !path.isAbsolute(source) || !AUDIO_MIME_OK) {
      return { ok: false, backend: 'local-whisper', kind: 'transcription', error: '转写输入必须是绝对路径的本地音频文件' };
    }
    if (!fs.existsSync(source)) {
      return { ok: false, backend: 'local-whisper', kind: 'transcription', error: `音频文件不存在：${source}` };
    }
    const seconds = Number(input?.durationSeconds);
    const startSeconds = Number(input?.startSeconds) || 0;
    const durationSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const result = await runWhisper(s.whisperCommand ?? [], { source, language: input?.language || s.language || 'auto' });
    if (signal?.aborted) return { ok: false, backend: 'local-whisper', kind: 'transcription', error: '转写已取消' };
    if (!result.ok) {
      return { ok: false, backend: 'local-whisper', kind: 'transcription', error: String(result.error ?? 'whisper 转写失败').slice(0, 300) };
    }
    const text = String(result.text ?? '').trim();
    if (!text) {
      // no-speech 变体的形状按 chat-service.transcribeMessage 的校验逐字段给。
      return {
        ok: false, status: 'no-speech', backend: 'local-whisper', kind: 'transcription',
        text: '', segments: [],
        interval: { startSeconds: 0, durationSeconds: durationSeconds || Math.max(1, seconds || 1) },
      };
    }
    return {
      ok: true, backend: 'local-whisper', kind: 'transcription',
      text: text.slice(0, 16_000), segments: [],
      interval: { startSeconds: 0, durationSeconds: durationSeconds || Math.max(1, seconds || 1) },
    };
  }
}
