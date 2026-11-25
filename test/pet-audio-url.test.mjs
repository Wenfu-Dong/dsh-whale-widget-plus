// 回归：豆包网页等音源的缓存 key 带前缀（doubao-web-xxxx）。
// 以前 /tts 返回的音频地址会把非 hex 字符删掉 → 前端拉到 404 → 只能退回浏览器 speechSynthesis。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPetApiService } from '../backend/lib/pet-api.js';

const KEY = 'doubao-web-2d23618d25ff6234846d18c2059f164d';
const TOKEN = 'a'.repeat(48);
const HOST = '127.0.0.1:58415';

function makeRes() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; },
    end(body) { out.body = body; },
    setHeader() {},
  };
}

test('带前缀的缓存 key：/tts 返回的音频地址可以直接取到文件（不再 404）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-api-audio-'));
  const bytes = Buffer.concat([Buffer.alloc(44), Buffer.from('fake-mp3')]);
  const chat = {
    token: () => TOKEN,
    synthesize: async () => ({ ok: true, key: KEY, durationMs: 0, text: '你好' }),
    voiceSettings: () => ({ speakVolume: 80 }),
    // 只认原始 key：和真实实现一致（audioFiles 表按带前缀的 key 存）
    readAudio: (key) => (key === KEY ? { file: path.join(root, `${KEY}.mp3`), bytes } : null),
  };
  const api = createPetApiService({
    chat,
    purpose: {},
    petService: {},
    stateDir: root,
    petRoot: root,
    currentDshUrl: () => `http://${HOST}`,
  });

  const ttsRes = makeRes();
  await api.handle(
    { method: 'GET', headers: { host: HOST, 'x-pet-token': TOKEN } },
    ttsRes,
    new URL(`http://${HOST}/dsh-surfcore/pet-api/tts?text=hi`),
  );
  assert.equal(ttsRes.out.status, 200);
  const body = JSON.parse(ttsRes.out.body);
  assert.equal(body.key, KEY);
  const audioUrl = new URL(body.url, `http://${HOST}`);
  // key 必须原样出现在路径里（旧实现会变成 dbaeb2...，与缓存文件对不上）
  assert.equal(audioUrl.pathname, `/dsh-surfcore/pet-api/audio/${KEY}.wav`);

  const audioRes = makeRes();
  await api.handle({ method: 'GET', headers: { host: HOST } }, audioRes, audioUrl);
  assert.equal(audioRes.out.status, 200);
  assert.equal(audioRes.out.headers['Content-Type'], 'audio/mpeg');
});
