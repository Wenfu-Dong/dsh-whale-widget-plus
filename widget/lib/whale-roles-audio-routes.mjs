/**
 * 角色 / 音频 / 桌宠对话路由（组件化迁移收尾）。
 *
 * 从 widget/lib/index.js 原样搬出以下 handler：
 *   · /dsh-whale/roles.json          · /dsh-whale/role-pin.json
 *   · /dsh-whale/role-delete.json    · /dsh-whale/role-image.png
 *   · /dsh-whale/audio.json          · /dsh-whale/audio-fragment(.wav)
 *   · /dsh-whale/sound/press.mp3     · /dsh-whale/sound/release.mp3
 *   · /dsh-whale/sound/voice.mp3     · /dsh-whale/tts.json
 *   · /dsh-whale/pet-ai.json
 *
 * 角色/音频的索引读写仍由 role-audio-store.mjs 提供（依赖注入）；loadSound 也留在 index.js
 * （role-audio-store 的内置片段回退同样用它），这里只注入复用。
 * 路径、状态码、响应头与错误文案保持原样。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEP_ID = 'whale-roles-audio-routes'

function requireDeps(deps) {
  for (const [name, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`${DEP_ID} 缺少依赖：${name}`)
  }
}

// 音效组 URL 参数（?set=<组 id>）
function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}

export function createWhaleRolesAudioRoutes(deps) {
  const {
    JSON_HEADERS,
    readBody,
    readBodyMax,
    roleDefaultId,
    presetGroups,
    presetFragments,
    soundSets,
    packageRoot,
    pickRoleDir,
    readRolesIndex,
    writeRolesIndex,
    rolesPayload,
    roleFileExt,
    roleFilePath,
    roleImagePath,
    roleIdFromUrl,
    roleIndexFind,
    readAudioIndex,
    writeAudioIndex,
    audioFragmentPath,
    audioIdFromUrl,
    audioFragmentsPayload,
    audioGroupsPayload,
    audioPayload,
    loadAudioFragmentBytes,
    groupFragmentId,
    pickAudioDir,
    loadSound,
    petAiFileCandidates,
    surfcoreRequest,
    readSurfcoreHost,
    getCtx,
  } = deps || {}
  requireDeps({
    JSON_HEADERS,
    readBody,
    readBodyMax,
    roleDefaultId,
    presetGroups,
    presetFragments,
    soundSets,
    packageRoot,
    pickRoleDir,
    readRolesIndex,
    writeRolesIndex,
    rolesPayload,
    roleFileExt,
    roleFilePath,
    roleImagePath,
    roleIdFromUrl,
    roleIndexFind,
    readAudioIndex,
    writeAudioIndex,
    audioFragmentPath,
    audioIdFromUrl,
    audioFragmentsPayload,
    audioGroupsPayload,
    audioPayload,
    loadAudioFragmentBytes,
    groupFragmentId,
    pickAudioDir,
    loadSound,
    petAiFileCandidates,
    surfcoreRequest,
    readSurfcoreHost,
    getCtx,
  })

  // —— 角色 ——
  const rolesHandler = async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        // 放宽到 30MB：支持最大 20MB 的 GIF（base64 膨胀约 1.33 倍）
        const body = await readBodyMax(req, 30 * 1024 * 1024)
        const parsed = JSON.parse(body)
        const name = String(parsed.name || '').trim().slice(0, 20) || '新角色'
        const image = String(parsed.image || '')
        const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image)
        if (!m) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
          return
        }
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length < 8 || buf.length > 20 * 1024 * 1024) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image too large' }))
          return
        }
        // format：客户端显式告知 gif/apng（APNG 的 dataURL 是 image/png，需客户端区分）；
        // 未显式给时按 dataURL 的 MIME 推断（gif→gif，其余 png）
        const declared = parsed.format === 'gif' ? 'gif' : (parsed.format === 'apng' ? 'apng' : null)
        const fmt = declared || (m[1] === 'gif' ? 'gif' : 'png')
        const id = 'role_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
        const dir = pickRoleDir()
        fs.writeFileSync(path.join(dir, id + '.' + roleFileExt(fmt)), buf)
        const index = readRolesIndex()
        index.roles.push({ id, name, format: fmt, pinnedAt: null, createdAt: Date.now() })
        writeRolesIndex(index)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(rolesPayload()))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(rolesPayload()))
  }

  const rolePinHandler = async (req, res) => {
    try {
      // v882（审查发现）：这两个写接口原来**不看方法**——只要带 JSON body 就落盘（GET/DELETE 也行）。
      //   前端固定用 POST；补上方法校验后，非写方法一律 405，语义与其它写接口一致。
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
        res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
        return
      }
      const body = await readBodyMax(req, 8192)
      const parsed = JSON.parse(body)
      const id = String(parsed.id || '')
      const { index, role } = roleIndexFind(id)
      if (!role) {
        res.writeHead(404, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'role not found' }))
        return
      }
      role.pinnedAt = parsed.pinned === true ? Date.now() : null
      writeRolesIndex(index)
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(rolesPayload()))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }

  const roleDeleteHandler = async (req, res) => {
    try {
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
        res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
        return
      }
      const body = await readBodyMax(req, 8192)
      const parsed = JSON.parse(body)
      const id = String(parsed.id || '')
      if (id === roleDefaultId) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'cannot delete default role' }))
        return
      }
      const { index, role } = roleIndexFind(id)
      if (!role) {
        res.writeHead(404, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'role not found' }))
        return
      }
      // 先按角色 format 确定文件路径（必须在从索引移除之前，否则查不到 format 默认成 png，删不掉 .gif）
      const fmt = role.format === 'gif' || role.format === 'apng' ? role.format : 'png'
      const p = roleFilePath(id, fmt)
      index.roles = index.roles.filter((r) => r.id !== id)
      writeRolesIndex(index)
      if (p) { try { fs.unlinkSync(p) } catch (err) {} }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify(rolesPayload()))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }

  const roleImageHandler = (req, res) => {
    try {
      const id = roleIdFromUrl(req.url)
      const p = roleImagePath(id)
      if (!p) throw new Error('bad role id')
      const bytes = fs.readFileSync(p)
      // 按角色格式返回对应 MIME：gif 动图 → image/gif；png/apng 都是 PNG 容器 → image/png
      const { role } = roleIndexFind(id)
      const mime = role && role.format === 'gif' ? 'image/gif' : 'image/png'
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('role image unavailable')
    }
  }

  // —— 音频 ——
  const audioHandler = async (req, res) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        const body = await readBodyMax(req, 8 * 1024 * 1024)
        const parsed = JSON.parse(body)
        const action = parsed.action
        const index = readAudioIndex()
        if (action === 'upload-fragment') {
          const name = String(parsed.name || '').trim().slice(0, 40) || '未命名音频'
          const audio = String(parsed.audio || '')
          const m = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/.exec(audio)
          if (!m) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'invalid wav data' }))
            return
          }
          const buf = Buffer.from(m[1], 'base64')
          if (buf.length < 44 || buf.length > 8 * 1024 * 1024) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'audio too large' }))
            return
          }
          const id = 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
          fs.writeFileSync(path.join(pickAudioDir(), id + '.wav'), buf)
          index.fragments.push({ id, name, createdAt: Date.now() })
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, id, fragments: audioFragmentsPayload() }))
          return
        }
        if (action === 'save-group') {
          const id = String(parsed.id || '')
          const name = String(parsed.name || '').trim().slice(0, 20) || '未命名音效组'
          const press = String(parsed.press ?? '')
          const release = String(parsed.release ?? '')
          // 校验引用片段存在（预设或自定义）；空字符串=该槽留空(该事件静音)，允许保存
          const frags = audioFragmentsPayload().map((f) => f.id)
          const validPress = press === '' ? '' : (frags.includes(press) ? press : presetGroups.duck.press)
          const validRelease = release === '' ? '' : (frags.includes(release) ? release : presetGroups.duck.release)
          if (id && index.groups.some((g) => g.id === id)) {
            const g = index.groups.find((x) => x.id === id)
            g.name = name
            g.press = validPress
            g.release = validRelease
          } else {
            const gid = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            index.groups.push({ id: gid, name, press: validPress, release: validRelease, pinnedAt: null, createdAt: Date.now() })
          }
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        if (action === 'delete-group') {
          const id = String(parsed.id || '')
          if (presetGroups[id]) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete preset group' }))
            return
          }
          index.groups = index.groups.filter((g) => g.id !== id)
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        if (action === 'delete-fragment') {
          const id = String(parsed.id || '')
          if (presetFragments[id]) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete preset fragment' }))
            return
          }
          index.fragments = index.fragments.filter((f) => f.id !== id)
          writeAudioIndex(index)
          const p = audioFragmentPath(id)
          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, fragments: audioFragmentsPayload(), groups: audioGroupsPayload() }))
          return
        }
        if (action === 'pin-group') {
          const id = String(parsed.id || '')
          const g = index.groups.find((x) => x.id === id)
          if (!g) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'group not found' }))
            return
          }
          g.pinnedAt = parsed.pinned === true ? Date.now() : null
          writeAudioIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
          return
        }
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
      return
    }
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(audioPayload()))
  }

  // 片段字节对应的 MIME：内置/预设片段按声明，自定义片段一律 wav
  function fragmentMime(fragId) {
    const f = presetFragments[fragId]
    return (f && f.mime) || 'audio/wav'
  }

  // v860（issue #226）：路由**不再以 .wav 结尾** —— 带后缀的 URL 会被部分环境（下载器/扩展/反代）
  //   当成"下载文件"劫持，导致试听与任务结束音无声。Content-Type 由 fragmentMime() 决定。
  const audioFragmentHandler = (req, res) => {
    try {
      const id = audioIdFromUrl(req.url)
      const bytes = loadAudioFragmentBytes(id)
      if (!bytes) throw new Error('bad fragment id')
      // 预设/内置片段可能是 mp3 也可能是 wav —— Content-Type 必须与字节匹配
      const mime = fragmentMime(id)
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('audio fragment unavailable')
    }
  }

  function serveSound(req, res, candidates) {
    const bytes = loadSound(candidates)
    if (!bytes) {
      // v752：404 也带 no-store。原来只有 200 分支有缓存头，失败的响应可能被浏览器/中间层
      // 缓存住，一旦缓存就会变成"永久没声音、刷新也没用"。
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('sound unavailable')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'Content-Length': String(bytes.length),
    })
    res.end(bytes)
  }

  const pressSoundHandler = (req, res) => {
    // v882：只认 soundSets **自有**键 —— 直接用 `soundSets[setName]` 会让 __proto__/constructor
    //   命中原型链，被当成"已知预设组"，既不回退默认音效也不去查用户自定义组。
    const setName = soundSetFromUrl(req.url)
    const isPresetSet = Object.prototype.hasOwnProperty.call(soundSets, setName)
    const set = isPresetSet ? soundSets[setName] : soundSets.duck
    // 自定义音效组：set 为组 id 时按组内 press 片段取音频
    if (setName && !isPresetSet) {
      const fragId = groupFragmentId(setName, 'press')
      if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
      const bytes = loadAudioFragmentBytes(fragId)
      if (bytes) {
        res.writeHead(200, {
          'Content-Type': fragmentMime(fragId),
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
        return
      }
    }
    serveSound(req, res, set.press)
  }

  const releaseSoundHandler = (req, res) => {
    const setName = soundSetFromUrl(req.url)
    const isPresetSet = Object.prototype.hasOwnProperty.call(soundSets, setName)
    const set = isPresetSet ? soundSets[setName] : soundSets.duck
    if (setName && !isPresetSet) {
      const fragId = groupFragmentId(setName, 'release')
      if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
      const bytes = loadAudioFragmentBytes(fragId)
      if (bytes) {
        res.writeHead(200, {
          'Content-Type': fragmentMime(fragId),
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
        return
      }
    }
    serveSound(req, res, set.release)
  }

  // 桌宠语音：点击回应 / 拖拽甩出 / 硬落地 / Q 弹落地，四条固定语音，按 name 取盘
  const PET_VOICE_FILES = {
    bing: 'voice-bing.mp3',
    heng: 'voice-heng.mp3',
    weiqu: 'voice-weiqu.mp3',
    qtan: 'voice-qtan.mp3',
  }
  const voiceSoundHandler = (req, res) => {
    let name = ''
    try { name = new URL(req.url, 'http://local').searchParams.get('name') || '' } catch (err) {}
    // v882（审查发现）：`PET_VOICE_FILES[name]` 对 __proto__/constructor 会命中原型链，
    //   拿到的不是字符串，path.join() 直接 TypeError（旧版是未处理拒绝）⇒ 用自有键判断。
    const file = Object.prototype.hasOwnProperty.call(PET_VOICE_FILES, name) ? PET_VOICE_FILES[name] : ''
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('voice unavailable')
      return
    }
    serveSound(req, res, [path.join(packageRoot, 'assets', file)])
  }

  // 朗读合成：卡片/气泡「念出来」用 Edge TTS（与 QQ 语音条同一音色）。
  const ttsHandler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const text = String(url.searchParams.get('text') || '').trim()
      if (!text) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: '缺少 text' }))
        return
      }
      // 合成要等 Edge 端点，给足超时（默认合成总时限 60s）
      const data = await surfcoreRequest(`/tts?text=${encodeURIComponent(text.slice(0, 300))}`, { timeout: 70000 })
      if (!data || !data.ok) {
        res.writeHead(502, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: (data && data.error) || '语音合成不可用' }))
        return
      }
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, url: data.url, durationMs: data.durationMs, text: data.text, volume: data.volume }))
    } catch (err) {
      try {
        res.writeHead(Number(err && err.status) || 500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      } catch (e) {}
    }
  }

  // —— 桌宠碎碎念 / 对话（SurfCore 优先，失败回退挂件自己的模型）——
  const PET_AI_DEFAULT_PERSONA = '你是一只住在电脑桌面上的小鲸鱼桌宠，性格活泼可爱、好奇心强，说话口语化、简短自然。'
  const PET_AI_CALL_IDENTITY = 'dsh-whale-widget'
  const PET_AI_WHISPER_TEXT = '随便说一句日常碎碎念，一句就好，20 字以内。'
  const PET_AI_MAX_HISTORY = 40 // 磁盘上最多保留 40 条（≈20 轮）

  async function surfcoreChat(text) {
    const host = readSurfcoreHost()
    if (!host) return null
    const url = String(host.baseUrl).replace(/\/+$/, '') + String(host.api) + '/chat'
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pet-token': String(host.token) },
        body: JSON.stringify({ text, modality: 'text' }),
        // 服务端桌宠对话的超时是 90s（pet-chat CHAT_LLM_TIMEOUT_MS）：
        // 这里必须比它长，否则「正常但稍慢」的回复会被前端提前放弃。
        signal: AbortSignal.timeout(150000),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok || !body || !body.ok || !body.reply || typeof body.reply.text !== 'string') {
        // 保留失败原因，便于诊断为什么降级（原来直接 return null，现场无迹可查）。
        console.warn('[pet-ai] SurfCore 对话失败，回退挂件模型:', (body && (body.error || body.message)) || `HTTP ${r.status}`)
        return null
      }
      return { text: body.reply.text, audioKey: (body.reply.audio && body.reply.audio.key) || '' }
    } catch (err) {
      console.warn('[pet-ai] SurfCore 对话异常，回退挂件模型:', (err && err.message) || err)
      return null
    }
  }

  function normalizePetAi(raw) {
    const r = raw && typeof raw === 'object' ? raw : {}
    const every = Number(r.whisperEveryMin)
    const hist = Array.isArray(r.history) ? r.history : []
    return {
      persona: typeof r.persona === 'string' ? r.persona.slice(0, 2000) : '',
      whisperOn: r.whisperOn !== false,
      whisperEveryMin: (isFinite(every) && every >= 1) ? Math.min(240, Math.round(every)) : 30,
      // 默认接 SurfCore；没有 host.json 时 surfcoreChat() 返回 null，自动回退到挂件自己的模型。
      linkSurfcore: r.linkSurfcore !== false,
      history: hist
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000), ts: Number(m.ts) || 0 }))
        .slice(-PET_AI_MAX_HISTORY),
    }
  }
  function readPetAi() {
    for (const p of petAiFileCandidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object') return normalizePetAi(parsed)
      } catch (err) {}
    }
    return normalizePetAi(null)
  }
  function writePetAi(cfg) {
    const body = JSON.stringify(cfg, null, 2)
    for (const p of petAiFileCandidates) {
      try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
    }
    return false
  }
  function petAiSettings(cfg) {
    return { persona: cfg.persona || PET_AI_DEFAULT_PERSONA, whisperOn: !!cfg.whisperOn, whisperEveryMin: cfg.whisperEveryMin, linkSurfcore: cfg.linkSurfcore !== false }
  }
  // 时间背景：每次生成现算（人设 + 名字 + 此刻时间，与 dsh-pet 的 composeSystemPrompt 同构）
  function petAiTimeContext(now) {
    try {
      const d = now instanceof Date ? now : new Date()
      if (!isFinite(d.getTime())) return ''
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
      const hh = d.getHours()
      let slot = '深夜'
      if (hh >= 5 && hh < 9) slot = '清晨'
      else if (hh >= 9 && hh < 12) slot = '上午'
      else if (hh >= 12 && hh < 14) slot = '中午'
      else if (hh >= 14 && hh < 18) slot = '下午'
      else if (hh >= 18 && hh < 23) slot = '晚上'
      const pad = (n) => String(n).padStart(2, '0')
      return '现在是 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week + ' ' + slot +
        '（' + pad(hh) + ':' + pad(d.getMinutes()) + '）。'
    } catch (err) { return '' }
  }
  function petAiSystem(cfg) {
    const lines = [cfg.persona && cfg.persona.trim() ? cfg.persona.trim() : PET_AI_DEFAULT_PERSONA, '你的名字是“小鲸鱼”。']
    const t = petAiTimeContext(new Date())
    if (t) lines.push(t)
    return lines.join('\n')
  }
  // 当前对话的模型（agentDefaultModel 是宿主服务；用 ctx.get 可选读取，拿不到就报“未配置模型”）
  function petAiModelRef() {
    try {
      const ctx = getCtx()
      const adm = ctx.get('agentDefaultModel', false)
      const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
      if (sel && sel.provider && sel.model) return { provider: String(sel.provider), model: String(sel.model) }
    } catch (err) {}
    return null
  }
  function petAiMessages(history, userText, sel) {
    const out = []
    const mkId = () => 'pet-ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    for (const m of history || []) {
      out.push({
        id: mkId(),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: String(m.content || '') }],
        source: m.role === 'assistant'
          ? { kind: 'model', provider: sel.provider, model: sel.model }
          : { kind: 'user' },
      })
    }
    out.push({ id: mkId(), role: 'user', content: [{ type: 'text', text: String(userText || '') }], source: { kind: 'user' } })
    return out
  }
  function petAiNoTextReason(finish) {
    const kind = finish && finish.kind
    const failure = finish && finish.failure
    if (kind === 'aborted') return '生成已取消'
    if (kind === 'max-tokens') return '输出达到上限，未产出正文'
    if (kind !== 'error') return '模型未返回文本'
    if (failure && typeof failure.message === 'string' && failure.message.trim()) return failure.message
    if (failure && typeof failure.code === 'string' && failure.code.trim()) return failure.code
    return '未提供失败原因'
  }
  /**
   * 跑一次生成：kind = 'whisper' | 'chat'。
   * 用 ctx.llm.stream（适配器路由/模型解析/凭据都由宿主接管），流式收集 text 块；
   * 不显式传 reasoningEffort（无 reasoning 元数据的模型传 off 会被折成空流）。
   */
  async function petAiGenerate(kind, cfg, history, userText) {
    const sel = petAiModelRef()
    if (!sel) return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' }
    let llm = null
    try { llm = getCtx().get('llm', false) } catch (err) { llm = null }
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' }
    const timeoutMs = kind === 'chat' ? 60000 : 30000
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { ac.abort() } catch (err) {} }, timeoutMs)
    let finish = null
    let text = ''
    try {
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        sessionId: PET_AI_CALL_IDENTITY,
        messages: petAiMessages(history, userText, sel),
        system: petAiSystem(cfg),
        temperature: 1,
        signal: ac.signal,
      })
      // 迷你 BlockAssembler：按 index 归并 delta / block-end，只取 text 块
      const partials = new Map()
      const order = []
      const ensure = (index, blockType) => {
        let p = partials.get(index)
        if (!p) {
          p = { blockType: blockType || 'text', text: '', block: null }
          partials.set(index, p)
          order.push(index)
        }
        return p
      }
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'block-start') ensure(chunk.index, chunk.blockType)
        else if (chunk.type === 'text-delta') {
          const p = ensure(chunk.index, 'text')
          if (!p.block) p.text += String(chunk.text || '')
        } else if (chunk.type === 'reasoning-delta') ensure(chunk.index, 'reasoning')
        else if (chunk.type === 'block-end') {
          const p = ensure(chunk.index, (chunk.block && chunk.block.type) || 'text')
          if (!p.block) p.block = chunk.block || null
        } else if (chunk.type === 'finish') finish = chunk.reason
      }
      text = order
        .map((i) => {
          const p = partials.get(i)
          return p.block ? p.block : { type: p.blockType, text: p.text }
        })
        .filter((b) => b && b.type === 'text')
        .map((b) => String(b.text || ''))
        .join('')
        .trim()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (timedOut || (msg && msg.indexOf('abort') >= 0)) return { ok: false, reason: 'generate-error', message: '生成超时（' + Math.round(timeoutMs / 1000) + 's）' }
      return { ok: false, reason: 'generate-error', message: msg }
    } finally {
      clearTimeout(timer)
    }
    if (!text) return { ok: false, reason: 'generate-error', message: petAiNoTextReason(finish) }
    return { ok: true, text }
  }

  const petAiHandler = async (req, res) => {
    try {
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}')
        const action = String((parsed && parsed.action) || '')
        const cfg = readPetAi()
        if (action === 'settings') {
          if (typeof parsed.persona === 'string') cfg.persona = parsed.persona.slice(0, 2000)
          if (typeof parsed.whisperOn === 'boolean') cfg.whisperOn = parsed.whisperOn
          const n = Number(parsed.whisperEveryMin)
          if (isFinite(n) && n >= 1) cfg.whisperEveryMin = Math.min(240, Math.round(n))
          if (typeof parsed.linkSurfcore === 'boolean') cfg.linkSurfcore = parsed.linkSurfcore
          const ok = writePetAi(cfg)
          res.writeHead(ok ? 200 : 500, JSON_HEADERS)
          res.end(JSON.stringify(ok ? { ok: true, settings: petAiSettings(cfg) } : { ok: false, error: 'write failed' }))
          return
        }
        if (action === 'clear') {
          cfg.history = []
          const ok = writePetAi(cfg)
          res.writeHead(ok ? 200 : 500, JSON_HEADERS)
          res.end(JSON.stringify(ok ? { ok: true, settings: petAiSettings(cfg), history: [] } : { ok: false, error: 'write failed' }))
          return
        }
        if (action === 'whisper') {
          const r = await petAiGenerate('whisper', cfg, [], PET_AI_WHISPER_TEXT)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(r.ok ? { ok: true, text: r.text } : { ok: false, reason: r.reason, message: r.message }))
          return
        }
        if (action === 'chat') {
          const text = String(parsed.text || '').trim().slice(0, 500)
          if (!text) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, message: '说点什么吧' }))
            return
          }
          // 优先交给 SurfCore：同一个人格卡/记忆卡，桌面和 QQ 里是同一只小鲸鱼。
          // 桥接没起、令牌过期或超时时回退到挂件自己的模型，不影响使用。
          const linked = cfg.linkSurfcore !== false ? await surfcoreChat(text) : null
          if (linked) {
            const linkedAt = Date.now()
            cfg.history.push({ role: 'user', content: text, ts: linkedAt })
            cfg.history.push({ role: 'assistant', content: linked.text, ts: linkedAt })
            cfg.history = cfg.history.slice(-PET_AI_MAX_HISTORY)
            writePetAi(cfg)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, text: linked.text, audioKey: linked.audioKey, source: 'surfcore', settings: petAiSettings(cfg), history: cfg.history }))
            return
          }
          const r = await petAiGenerate('chat', cfg, cfg.history.slice(-12), text)
          if (!r.ok) {
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, reason: r.reason, message: r.message }))
            return
          }
          const now = Date.now()
          cfg.history.push({ role: 'user', content: text, ts: now })
          cfg.history.push({ role: 'assistant', content: r.text, ts: now })
          cfg.history = cfg.history.slice(-PET_AI_MAX_HISTORY)
          writePetAi(cfg)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, text: r.text, settings: petAiSettings(cfg), history: cfg.history }))
          return
        }
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        return
      }
      const cfg = readPetAi()
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, settings: petAiSettings(cfg), history: cfg.history }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }

  return {
    rolesHandler,
    rolePinHandler,
    roleDeleteHandler,
    roleImageHandler,
    audioHandler,
    audioFragmentHandler,
    pressSoundHandler,
    releaseSoundHandler,
    voiceSoundHandler,
    ttsHandler,
    petAiHandler,
  }
}
