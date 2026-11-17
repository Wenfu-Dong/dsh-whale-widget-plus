/**
 * 静态素材 / 外观（泡泡）路由（组件化迁移收尾）。
 *
 * 从 widget/lib/index.js 原样搬出以下 handler：
 *   · /dsh-whale/image.png            · /dsh-whale/rua.gif
 *   · /dsh-whale/expr-packs.json      · /dsh-whale/expr.png
 *   · /dsh-whale/pet-video.webm       · /dsh-whale/pet-animations.json
 *   · /dsh-whale/bubble.json          · /dsh-whale/bubble-imgs.json
 *   · /dsh-whale/bubble-img-upload.json · /dsh-whale/bubble-img.png
 *   · /dsh-whale/widget.js            · /dsh-whale/console.html
 *
 * 只搬「路由私有」的实现：图片/GIF 字节缓存、表情包扫描与 ETag、桌宠动画清单、
 * 泡泡图库读写、泡泡框净化、挂件/控制台文件读取。目录候选、配置读写与状态 getter
 * 由 index.js 注入（loadBubbleConfig/writeBubbleConfig 仍被 index 的其它逻辑复用）。
 * 路径、状态码、响应头、缓存 TTL 与只读降级文案保持原样。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEP_ID = 'whale-assets-routes'

function requireDeps(deps) {
  for (const [name, value] of Object.entries(deps)) {
    if (value === undefined || value === null) throw new TypeError(`${DEP_ID} 缺少依赖：${name}`)
  }
}

export function createWhaleAssetsRoutes(deps) {
  const {
    imageCandidates,
    ruaGifCandidates,
    exprDirCandidates,
    exprPackFile,
    exprPackIdRe,
    exprFileNameRe,
    exprCuteMax,
    exprCuteScanMax,
    exprPacksTtlMs,
    petVideoDir,
    bubbleImgDirCandidates,
    bubbleImgIndexName,
    defaultBubbleImgs,
    bubbleImgFileCandidates,
    widgetFileCandidates,
    consoleFileCandidates,
    loadBubbleConfig,
    writeBubbleConfig,
    getBubbleConfigIgnored,
    readBodyMax,
    JSON_HEADERS,
  } = deps || {}
  requireDeps({
    imageCandidates,
    ruaGifCandidates,
    exprDirCandidates,
    exprPackFile,
    exprPackIdRe,
    exprFileNameRe,
    exprCuteMax,
    exprCuteScanMax,
    exprPacksTtlMs,
    petVideoDir,
    bubbleImgDirCandidates,
    bubbleImgIndexName,
    defaultBubbleImgs,
    bubbleImgFileCandidates,
    widgetFileCandidates,
    consoleFileCandidates,
    loadBubbleConfig,
    writeBubbleConfig,
    getBubbleConfigIgnored,
    readBodyMax,
    JSON_HEADERS,
  })

  // —— 鲸鱼图 / rua 动图：进程内字节缓存，找不到时由 handler 转 404 ——
  let imageBytes = null
  let gifBytes = null

  function loadGif() {
    if (gifBytes) return gifBytes
    for (const p of ruaGifCandidates) {
      try {
        const bytes = fs.readFileSync(p)
        if (bytes && bytes.length > 0) {
          gifBytes = bytes
          return bytes
        }
      } catch (err) {}
    }
    throw new Error('rua gif not found')
  }

  function loadImage() {
    if (imageBytes) return imageBytes
    for (const p of imageCandidates) {
      try {
        const bytes = fs.readFileSync(p)
        if (bytes && bytes.length > 0) {
          imageBytes = bytes
          return bytes
        }
      } catch (err) {}
    }
    throw new Error('whale image not found')
  }

  // ===== 表情素材层：自描述素材包（每个包一个 <packId>/ 目录，内含 pack.json + 图片）=====
  // 清单里只保留**真实存在**的文件；字节不常驻内存；清单 5s 低频缓存；图片走 ETag 协商缓存。
  let exprPacksCache = null
  let exprPacksCacheAt = 0
  const exprEtags = new Map() // path -> { key, etag }；key = mtimeMs + ':' + size
  function exprEtagsPut(p, key, etag) {
    if (exprEtags.size > 512) exprEtags.clear() // 防无界增长（条目数天然有界：素材包里的图总数）
    exprEtags.set(p, { key: key, etag: etag })
  }
  function exprFileOk(dir, name) {
    // 用 lstat（**不是** stat）：符号链接的 isFile() 为 false ⇒ 指向包外的链接会被自动排除在清单之外。
    try { return fs.lstatSync(path.join(dir, name)).isFile() } catch (err) { return false }
  }
  function readExprPack(dir, id) {
    let raw = null
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, exprPackFile), 'utf8')) } catch (err) { return null }
    if (!raw || typeof raw !== 'object') return null
    const pickFile = (v) => (typeof v === 'string' && exprFileNameRe.test(v) && v !== '.' && v !== '..' ? v : '')
    const declared = new Set()
    const pack = { id: id, label: id, main: '', blink: {}, moods: {}, cute: [], labels: {}, images: [] }
    if (typeof raw.label === 'string' && raw.label) pack.label = String(raw.label).slice(0, 24)
    const main = pickFile(raw.main)
    if (main) declared.add(main)
    if (raw.blink && typeof raw.blink === 'object') {
      for (const k of ['half', 'closed']) {
        const f = pickFile(raw.blink[k])
        if (f) { pack.blink[k] = f; declared.add(f) }
      }
    }
    if (raw.moods && typeof raw.moods === 'object') {
      for (const k of ['angry', 'shy', 'disappointed', 'exhausted']) {
        const f = pickFile(raw.moods[k])
        if (f) { pack.moods[k] = f; declared.add(f) }
      }
    }
    if (Array.isArray(raw.cute)) {
      for (const v of raw.cute.slice(0, exprCuteScanMax)) {
        const f = pickFile(v)
        if (f) declared.add(f)
        if (declared.size >= exprCuteMax + 8) break
      }
    }
    // 只保留盘上真实存在的：declared 里声明过但文件不在的一律剔除 ⇒ 清单不可能给出破图
    const present = new Set()
    for (const f of declared) if (exprFileOk(dir, f)) present.add(f)
    pack.main = main && present.has(main) ? main : ''
    for (const k of Object.keys(pack.blink)) if (!present.has(pack.blink[k])) delete pack.blink[k]
    for (const k of Object.keys(pack.moods)) if (!present.has(pack.moods[k])) delete pack.moods[k]
    if (Array.isArray(raw.cute)) {
      const seen = new Set()
      for (const v of raw.cute.slice(0, exprCuteScanMax)) {
        const f = pickFile(v)
        if (!f || seen.has(f) || !present.has(f)) continue
        seen.add(f)
        pack.cute.push(f)
        if (pack.cute.length >= exprCuteMax) break
      }
    }
    // labels 两种写法都认：键为**文件名**，或键为**语义槽位**；输出统一按文件名作键。
    if (raw.labels && typeof raw.labels === 'object') {
      const slotFile = {
        main: pack.main,
        half: pack.blink.half,
        closed: pack.blink.closed,
        angry: pack.moods.angry,
        shy: pack.moods.shy,
        disappointed: pack.moods.disappointed,
        exhausted: pack.moods.exhausted,
      }
      for (const k of Object.keys(raw.labels)) {
        if (typeof raw.labels[k] !== 'string') continue
        const target = present.has(k) ? k : (slotFile[k] && present.has(slotFile[k]) ? slotFile[k] : '')
        if (target) pack.labels[target] = String(raw.labels[k]).slice(0, 24)
      }
    }
    pack.images = Array.from(present)
    const usable = pack.main || pack.cute.length || Object.keys(pack.moods).length || Object.keys(pack.blink).length
    return usable ? pack : null
  }
  function scanExprPacks() {
    const out = []
    const seenIds = new Set()
    for (const base of exprDirCandidates) {
      let entries = []
      try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch (err) { continue }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const id = ent.name
        if (!exprPackIdRe.test(id) || seenIds.has(id)) continue
        const pack = readExprPack(path.join(base, id), id)
        if (pack) { seenIds.add(id); out.push(pack) }
      }
    }
    return out
  }
  function listExprPacks() {
    const now = Date.now()
    if (exprPacksCache && now - exprPacksCacheAt < exprPacksTtlMs) return exprPacksCache
    exprPacksCache = scanExprPacks()
    exprPacksCacheAt = now
    return exprPacksCache
  }
  // 素材路径解析：pack 必须是扫描到的包，name 必须是该包清单里的文件（双白名单 ⇒ 无路径穿越）
  function exprImagePath(packId, name) {
    if (!exprPackIdRe.test(packId) || !exprFileNameRe.test(name)) return ''
    const pack = listExprPacks().find((p) => p.id === packId)
    if (!pack || pack.images.indexOf(name) === -1) return ''
    for (const base of exprDirCandidates) {
      const p = path.join(base, packId, name)
      // 同 exprFileOk：用 lstat 排除符号链接（清单里本就不会出现链接名，这里是第二道口）
      try { if (fs.lstatSync(p).isFile()) return p } catch (err) {}
    }
    return ''
  }

  const exprPacksHandler = (req, res) => {
    const packs = listExprPacks()
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify({ ok: true, packs: packs }))
  }

  const exprImageHandler = (req, res) => {
    try {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams
      const p = exprImagePath(String(q.get('pack') || ''), String(q.get('name') || ''))
      if (!p) throw new Error('expression image not found')
      let st = null
      try { st = fs.statSync(p) } catch (err) { throw new Error('expression image unreadable') }
      // 缓存键 = mtimeMs:size（不做内容哈希：否则每次请求都要把整张图读进内存做 sha256）
      const key = st.mtimeMs + ':' + st.size
      let etag = ''
      let bytes = null
      const cached = exprEtags.get(p)
      if (cached && cached.key === key) {
        etag = cached.etag
      } else {
        bytes = fs.readFileSync(p)
        etag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '"'
        exprEtagsPut(p, key, etag)
      }
      // 命中即 304 无 body（也不必读整张图）
      const inm = String(req.headers['if-none-match'] || '')
      const inmHit = inm.split(',').some((t) => {
        const v = t.trim().replace(/^W\//, '')
        return v === '*' || v === etag
      })
      if (inmHit) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
        res.end()
        return
      }
      if (!bytes) bytes = fs.readFileSync(p)
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-cache',
        'ETag': etag,
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('expression image unavailable')
    }
  }

  // ===== 桌宠动画素材（内置角色形态「桌宠」的 webm 动画池）=====
  // 动画名允许中文 ⇒ 不能走 exprFileNameRe（仅 ASCII），改为「盘上清单」白名单。
  let petVideoFiles = null // name -> filename 缓存（5 分钟 TTL，与表情清单同节奏）
  let petVideoFilesAt = 0
  // 素材是否缺失（目录不存在 / 为空）。缺的原因缓存下来，由 pet-animations.json 如实上报。
  let petVideoMissingReason = ''
  function petVideoList() {
    const now = Date.now()
    if (petVideoFiles && now - petVideoFilesAt < exprPacksTtlMs) return petVideoFiles
    const map = {}
    let reason = ''
    try {
      for (const ent of fs.readdirSync(petVideoDir)) {
        if (/\.webm$/i.test(ent)) map[ent.replace(/\.webm$/i, '')] = ent
      }
      if (!Object.keys(map).length) reason = 'empty'
    } catch (err) {
      reason = (err && err.code) === 'ENOENT' ? 'dir-missing' : 'unreadable'
    }
    petVideoMissingReason = reason
    petVideoFiles = map
    petVideoFilesAt = now
    return map
  }
  // 素材缺失时给用户的可执行指引（前端 toast / 控制台直接展示这一段）
  function petVideoMissingHint() {
    const why = petVideoMissingReason === 'dir-missing' ? '目录不存在' : (petVideoMissingReason === 'empty' ? '目录为空' : '目录不可读')
    return '桌宠动画素材未安装（assets/pet-video/ ' + why + '）：请重装最新版 dsh-Dfy（github:louke6572/surfcore，不要锁旧 commit），' +
      '或手动把 106 段 .webm 放进 ' + petVideoDir + ' 后刷新页面。'
  }

  const petVideoHandler = (req, res) => {
    try {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams
      const name = String(q.get('name') || '')
      // 清单是普通对象，`list[name]` 对 __proto__/constructor 会命中原型链拿到非字符串 ⇒ 用自有键判断。
      const list = petVideoList()
      const file = Object.prototype.hasOwnProperty.call(list, name) ? list[name] : ''
      if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('pet animation not found'); return }
      const p = path.join(petVideoDir, file)
      let st = null
      try { st = fs.lstatSync(p) } catch (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('pet animation unreadable'); return }
      if (!st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('pet animation unreadable'); return }
      const key = st.mtimeMs + ':' + st.size
      const cached = exprEtags.get(p)
      const etag = cached && cached.key === key ? cached.etag : '"size-' + st.size + '-' + Math.round(st.mtimeMs) + '"'
      exprEtagsPut(p, key, etag)
      const inm = String(req.headers['if-none-match'] || '')
      if (inm.split(',').some((t) => { const v = t.trim().replace(/^W\//, ''); return v === '*' || v === etag })) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
        res.end()
        return
      }
      // <video> 播放常带 Range 请求（分块加载）；不支持 Range 会让部分浏览器直接放弃播放
      const total = st.size
      const range = String(req.headers.range || '')
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (m && (m[1] || m[2])) {
        let start = 0
        let end = total - 1
        if (!m[1] && m[2]) {
          // 后缀区间 bytes=-N：要**最后** N 字节。
          const n = parseInt(m[2], 10)
          if (!isFinite(n) || n <= 0) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total })
            res.end()
            return
          }
          start = Math.max(0, total - n)
        } else {
          start = m[1] ? parseInt(m[1], 10) : 0
          end = m[2] ? parseInt(m[2], 10) : total - 1
          if (end >= total) end = total - 1
        }
        if (!isFinite(start) || !isFinite(end) || start > end || end >= total) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total })
          res.end()
          return
        }
        const fd = fs.openSync(p, 'r')
        try {
          const buf = Buffer.alloc(end - start + 1)
          fs.readSync(fd, buf, 0, buf.length, start)
          res.writeHead(206, {
            'Content-Type': 'video/webm',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(buf.length),
            'Cache-Control': 'no-cache',
            'ETag': etag,
          })
          res.end(buf)
        } finally { fs.closeSync(fd) }
        return
      }
      const bytes = fs.readFileSync(p)
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-cache',
        'ETag': etag,
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('pet animation unavailable')
    }
  }

  // 桌宠动画清单（前端拉取 + 校验素材在位；分类/权重内置在前端，与 dsh-pet 同源）
  const petAnimationsHandler = (req, res) => {
    try {
      const files = Object.keys(petVideoList())
      res.writeHead(200, JSON_HEADERS)
      if (!files.length) {
        // 素材未安装：不能再回 ok:true + 空数组（前端会静默回退，用户一脸懵）。
        // 保留 200 让前端能解析，用 ok:false + reason/hint 明确告诉它和用户怎么回事。
        res.end(JSON.stringify({
          ok: false,
          error: 'pet-assets-missing',
          reason: petVideoMissingReason || 'empty',
          animations: [],
          dir: petVideoDir,
          hint: petVideoMissingHint(),
        }))
        return
      }
      res.end(JSON.stringify({ ok: true, animations: files }))
    } catch (err) {
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 160) }))
    }
  }

  // —— 泡泡图库(独立于角色图库)：图片文件目录 + 索引 ——
  function pickBubbleImgDir() {
    for (const p of bubbleImgDirCandidates) {
      try {
        fs.mkdirSync(p, { recursive: true })
        fs.accessSync(p, fs.constants.W_OK)
        return p
      } catch (err) {}
    }
    return bubbleImgDirCandidates[0]
  }
  function defaultBubbleImgIndex() {
    return { version: 1, images: [] }
  }
  function readBubbleImgIndex() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(pickBubbleImgDir(), bubbleImgIndexName), 'utf8'))
      if (parsed && Array.isArray(parsed.images)) return parsed
    } catch (err) {}
    return defaultBubbleImgIndex()
  }
  function writeBubbleImgIndex(index) {
    try {
      fs.writeFileSync(path.join(pickBubbleImgDir(), bubbleImgIndexName), JSON.stringify(index, null, 2), 'utf8')
      return true
    } catch (err) {
      return false
    }
  }
  function bubbleImgPayload() {
    const index = readBubbleImgIndex()
    // 内置默认图常驻(先列出,不占 createdAt 排序;用户图库含同 id 时不重复)
    const seen = {}
    index.images.forEach((im) => { seen[im.id] = 1 })
    const builtins = defaultBubbleImgs.filter((d) => !seen[d.id]).map((d) => ({
      id: d.id,
      name: String(d.name || d.id),
      format: d.format === 'gif' ? 'gif' : 'png',
      url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(d.id),
      createdAt: null,
      builtin: true,
    }))
    return {
      ok: true,
      images: builtins.concat(index.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((im) => ({
        id: im.id,
        name: String(im.name || im.id),
        format: im.format === 'gif' ? 'gif' : 'png',
        url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(im.id),
        createdAt: im.createdAt || null,
      }))),
    }
  }
  function bubbleImgIdFromUrl(url) {
    try {
      const q = String(url || '').split('?')[1] || ''
      const m = /(?:^|&)id=([^&]+)/.exec(q)
      return m ? decodeURIComponent(m[1]) : ''
    } catch (err) { return '' }
  }
  // 泡泡图 id 只有两种合法来源（上传时生成 / 内置清单），但索引文件是用户可编辑的 ⇒ 字符校验防穿越。
  const BUBBLE_IMG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
  function bubbleImgFilePath(id, format) {
    if (typeof id !== 'string' || !BUBBLE_IMG_ID_RE.test(id)) return null
    return path.join(pickBubbleImgDir(), id + '.' + (format === 'gif' ? 'gif' : 'png'))
  }
  function loadBuiltinBubbleImgBytes(def) {
    if (!def || !def.file) return null
    for (const p of bubbleImgFileCandidates(def.file)) {
      try {
        const bytes = fs.readFileSync(p)
        if (bytes && bytes.length > 0) return bytes
      } catch (err) {}
    }
    return null
  }

  // ===== v815：自定义泡泡框 —— 宿主侧净化 =====
  // 用户可以在"泡泡框"里写 SVG 代码 ⇒ 这些片段最终会进 innerHTML ⇒ **必须白名单化**：
  //   · 只放行无脚本、无外链的几何标签；
  //   · 标签属性只放行几何/描边类；
  //   · 直接删掉 <script>/<foreignObject>/on* 事件/href(javascript:)/style 里的 url()、expression。
  const FRAME_SVG_TAGS = ['path', 'ellipse', 'circle', 'rect', 'polygon', 'polyline', 'g']
  // v828：补 `r`（`<circle>` 的半径）—— 标签在白名单里却漏了属性，用户写 `<circle r="30"/>` 会被剥成画不出来
  const FRAME_SVG_ATTRS = ['d', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'fill', 'stroke',
    'stroke-width', 'stroke-dasharray', 'stroke-linejoin', 'stroke-linecap', 'transform', 'opacity', 'fill-opacity', 'stroke-opacity']
  function frameColorOk(v, def) {
    const s = String(v == null ? '' : v).trim()
    if (/^#[0-9a-fA-F]{3}$/.test(s) || /^#[0-9a-fA-F]{6}$/.test(s)) return s
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(s)) return s
    if (s === 'transparent' || s === 'none') return s
    return def
  }
  function frameNumIn(v, def, min, max) {
    const n = Number(v)
    let x = isFinite(n) ? n : def
    if (typeof min === 'number' && x < min) x = min
    if (typeof max === 'number' && x > max) x = max
    return Math.round(x * 1000) / 1000
  }
  function frameSvgSanitize(code) {
    let s = String(code == null ? '' : code).slice(0, 8000)
    if (!s) return ''
    // 整块危险元素直接删（含内容）
    s = s.replace(/<\s*(script|foreignObject|style|iframe|image|use|animate|set)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    s = s.replace(/<\s*(script|foreignObject|style|iframe|image|use|animate|set)\b[^>]*\/?>/gi, '')
    // 只保留白名单标签；其它标签（含自闭合）整体删除
    s = s.replace(/<\s*\/?\s*([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g, (m0, tag, attrs) => {
      const t = String(tag)
      if (FRAME_SVG_TAGS.indexOf(t) < 0) return ''
      const closing = /^<\s*\//.test(m0)
      // v823（P2）：**保住自闭合的斜杠**。P0 首版一律重拼成 `<tag …>`，而内联 SVG 里 `<path>` 不是空元素
      //   ⇒ HTML 解析器会把后面的兄弟塞进它里面（`<path a/><path b/>` → path a > path b，子节点不渲染）。
      const selfClose = /\/\s*>$/.test(m0)
      let out = '<' + (closing ? '/' : '') + t
      if (!closing) {
        const re = /([A-Za-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
        let m
        let kept = 0
        while ((m = re.exec(attrs))) {
          // 零长度匹配会让 lastIndex 原地不动 → 死循环。
          if (m[0].length === 0) break
          const name = String(m[1]).toLowerCase()
          const val = String(m[3] !== undefined ? m[3] : m[4])
          if (FRAME_SVG_ATTRS.indexOf(name) < 0) continue
          // 值里也不许出现 javascript:/url(/expression
          if (/javascript:|url\s*\(|expression\s*\(/i.test(val)) continue
          if (/[<>]/.test(val)) continue
          out += ' ' + name + '="' + val.replace(/"/g, '&quot;') + '"'
          kept++
        }
        void kept
      }
      return out + ((selfClose && !closing) ? '/>' : '>')
    })
    // v818（自检发现）：再**清掉标签之外的所有裸文本**。
    s = s.replace(/[^<>]+(?=<|$)/g, '')
    return s
  }
  function frameSanitizeOne(raw, idx) {
    const s = raw && typeof raw === 'object' ? raw : {}
    let id = String(s.id == null ? '' : s.id).trim().slice(0, 64)
    if (!id) id = 'frame_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
    const slotsIn = s.slots && typeof s.slots === 'object' ? s.slots : {}
    function slot(kind) {
      const d = slotsIn[kind] && typeof slotsIn[kind] === 'object' ? slotsIn[kind] : {}
      const paint = d.paint && typeof d.paint === 'object' ? d.paint : {}
      const out = {
        dx: frameNumIn(d.dx, 0, -1026, 1026),
        dy: frameNumIn(d.dy, 0, -700, 700),
        scale: frameNumIn(d.scale, 1, 0.2, 4),
        kind: d.kind === 'image' ? 'image' : 'svg',
        svgPreset: ['classic', 'roundrect', 'zigzag', 'custom'].indexOf(String(d.svgPreset)) >= 0 ? String(d.svgPreset) : 'classic',
        svgCode: frameSvgSanitize(d.svgCode),
        imgId: String(d.imgId == null ? '' : d.imgId).slice(0, 64),
        imgScale: frameNumIn(d.imgScale, 1, 0.1, 6),
        imgOpacity: frameNumIn(d.imgOpacity, 1, 0, 1),
        paint: {
          bgOn: paint.bgOn === undefined ? true : paint.bgOn !== false,
          bg: frameColorOk(paint.bg, '#FFFFFF'),
          bgAlpha: frameNumIn(paint.bgAlpha, 1, 0, 1),
          lineOn: paint.lineOn === undefined ? true : paint.lineOn !== false,
          line: frameColorOk(paint.line, '#203170'),
          lineW: frameNumIn(paint.lineW, 18, 0, 120),
          lineAlpha: frameNumIn(paint.lineAlpha, 1, 0, 1),
          dashOn: paint.dashOn === true,
          dash: /^[0-9][0-9.,\s]*$/.test(String(paint.dash == null ? '' : paint.dash).trim()) ? String(paint.dash).trim().slice(0, 40) : '0',
          cap: ['butt', 'square', 'round'].indexOf(String(paint.cap)) >= 0 ? String(paint.cap) : 'round',
          join: ['miter', 'bevel', 'round'].indexOf(String(paint.join)) >= 0 ? String(paint.join) : 'round',
        },
      }
      if (kind === 'small1' || kind === 'small2') out.on = d.on === undefined ? true : d.on !== false
      return out
    }
    const safe = s.safe && typeof s.safe === 'object' ? s.safe : {}
    const w = frameNumIn(safe.w, 646, 40, 1026)
    const h = frameNumIn(safe.h, 400, 40, 700)
    return {
      id: id,
      name: String(s.name == null ? '' : s.name).trim().slice(0, 24) || ('泡泡框' + (idx + 1)),
      builtin: s.builtin === true,
      pinned: Math.round(frameNumIn(s.pinned, 0, 0, 9999)),
      createdAt: Math.round(frameNumIn(s.createdAt, Date.now(), 0, 1e15)),
      textColor: frameColorOk(s.textColor, ''),
      safe: { x: frameNumIn(safe.x, 190, 0, 1026 - w), y: frameNumIn(safe.y, 90, 0, 700 - h), w: w, h: h },
      slots: { big: slot('big'), small1: slot('small1'), small2: slot('small2') },
    }
  }
  // 整份框库净化：内置框强制只读（内容还原由前端做；宿主这里只保证"不许被改成非内置"）
  function framesSanitize(list, defId) {
    const arr = Array.isArray(list) ? list.slice(0, 50) : []
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const f = frameSanitizeOne(arr[i], i)
      if (f.id === 'frame_classic') { f.builtin = true; f.name = '经典（内置）'; continue } // 内置框不进库（前端会补）
      out.push(f)
    }
    let def = String(defId == null ? '' : defId).slice(0, 64)
    if (!out.some((x) => x.id === def)) def = 'frame_classic'
    return { frames: out, defaultFrameId: def }
  }
  // items 里的"框引用 / 外观覆盖"：只保留已知形状的字段（逐字段白名单）
  function itemsSanitizeFrames(items) {
    const list = Array.isArray(items) ? items : []
    const cleanOne = (obj) => {
      if (!obj || typeof obj !== 'object') return obj
      const out = obj
      if (typeof out.frameId === 'string') out.frameId = out.frameId.slice(0, 64)
      else delete out.frameId
      const ov = out.frameOverride
      if (ov && typeof ov === 'object') {
        const keep = {}
        for (const slot of ['big', 'small1', 'small2']) {
          const raw = ov[slot]
          if (!raw || typeof raw !== 'object') continue
          const p = {}
          for (const k of ['bgOn', 'bg', 'bgAlpha', 'lineOn', 'line', 'lineW', 'lineAlpha', 'dashOn', 'dash', 'cap', 'join']) {
            if (Object.prototype.hasOwnProperty.call(raw, k)) p[k] = raw[k]
          }
          // 颜色/数值仍然过一遍校验，避免脏值写进配置
          const norm = frameSanitizeOne({ slots: { [slot]: { paint: p } } }, 0).slots[slot].paint
          const only = {}
          for (const k of Object.keys(p)) if (Object.prototype.hasOwnProperty.call(norm, k)) only[k] = norm[k]
          keep[slot] = only
        }
        if (Object.keys(keep).length) out.frameOverride = keep
        else delete out.frameOverride
      } else delete out.frameOverride
      return out
    }
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      cleanOne(it)
      if (it.kind === 'choice' && Array.isArray(it.options)) for (const o of it.options) { if (o) { cleanOne(o); if (o.item) cleanOne(o.item) } }
    }
    return list
  }

  const bubbleHandler = async (req, res) => {
    try {
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBodyMax(req, 512 * 1024)
        const parsed = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid bubble config' }))
          return
        }
        // v727：tapAdvance =「点按角色推进泡泡队列」（只存布尔值，不放行其它字段）
        // v815：泡泡框（frames/defaultFrameId）与 items 上的框引用/外观覆盖走净化后落盘。
        //   没带 frames 的老客户端 ⇒ 不写这两个键（老配置零 churn）。
        const itemsClean = itemsSanitizeFrames(parsed.items)
        const cfg = { v: 1, items: itemsClean, lib: parsed.lib, tapAdvance: parsed.tapAdvance === true }
        if (Array.isArray(parsed.frames)) {
          const fr = framesSanitize(parsed.frames, parsed.defaultFrameId)
          cfg.frames = fr.frames
          cfg.defaultFrameId = fr.defaultFrameId
        }
        writeBubbleConfig(cfg)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, config: cfg, ignored: getBubbleConfigIgnored() }))
        return
      }
      const cfg = loadBubbleConfig()
      res.writeHead(200, JSON_HEADERS)
      res.end(JSON.stringify({ ok: true, config: cfg }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }

  const bubbleImgsHandler = (req, res) => {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(bubbleImgPayload()))
  }

  const bubbleImgUploadHandler = async (req, res) => {
    try {
      // v882：写接口补方法校验（前端固定 POST；非写方法一律 405，与其它写接口一致）
      if (req.method !== 'POST' && req.method !== 'PUT') {
        res.writeHead(405, { ...JSON_HEADERS, Allow: 'POST, PUT' })
        res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
        return
      }
      const body = await readBodyMax(req, 10 * 1024 * 1024)
      const parsed = JSON.parse(body)
      const action = parsed && parsed.action
      const index = readBubbleImgIndex()
      if (action === 'upload') {
        const name = String(parsed.name || '').trim().slice(0, 40) || ''
        const data = String(parsed.data || '')
        const m = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data)
        if (!m) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
          return
        }
        const format = m[1] === 'gif' ? 'gif' : 'png'
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length < 64 || buf.length > 8 * 1024 * 1024) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image too large' }))
          return
        }
        const id = 'bimg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
        fs.writeFileSync(path.join(pickBubbleImgDir(), id + '.' + format), buf)
        index.images.push({ id, name, format, createdAt: Date.now() })
        writeBubbleImgIndex(index)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
        return
      }
      if (action === 'delete') {
        const id = String(parsed.id || '')
        const img = index.images.find((x) => x.id === id)
        if (!img) {
          res.writeHead(404, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'image not found' }))
          return
        }
        index.images = index.images.filter((x) => x.id !== id)
        writeBubbleImgIndex(index)
        const p = bubbleImgFilePath(id, img.format)
        if (p) { try { fs.unlinkSync(p) } catch (err) {} }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
        return
      }
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
    } catch (err) {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
    }
  }

  const bubbleImgHandler = (req, res) => {
    try {
      const id = bubbleImgIdFromUrl(req.url)
      // 1) 用户图库优先
      const index = readBubbleImgIndex()
      const img = index.images.find((x) => x.id === id)
      if (img) {
        const p = bubbleImgFilePath(id, img.format)
        if (!p) throw new Error('bad image id')
        const bytes = fs.readFileSync(p)
        res.writeHead(200, {
          'Content-Type': img.format === 'gif' ? 'image/gif' : 'image/png',
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
        return
      }
      // 2) 内置默认图回退(全新安装无用户图库时,泡泡序列引用的语义 id 也能出图)
      const def = defaultBubbleImgs.find((x) => x.id === id)
      if (def) {
        const bytes = loadBuiltinBubbleImgBytes(def)
        if (bytes) {
          res.writeHead(200, {
            'Content-Type': def.format === 'gif' ? 'image/gif' : 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
          return
        }
      }
      throw new Error('bad image id')
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bubble image unavailable')
    }
  }

  // 浏览器端挂件代码已拆分为独立文件 whale-widget.js，按 mtime 判断是否需要重读。
  let widgetJsCache = null // { text, mtimeMs }
  function loadWidgetJs() {
    for (const p of widgetFileCandidates) {
      try {
        const st = fs.statSync(p)
        if (widgetJsCache && widgetJsCache.mtimeMs === st.mtimeMs) return widgetJsCache.text
        const text = fs.readFileSync(p, 'utf8')
        widgetJsCache = { text, mtimeMs: st.mtimeMs }
        return text
      } catch (err) {}
    }
    return widgetJsCache ? widgetJsCache.text : ''
  }
  // v881：桌面控制台页面（设计稿原样 + 预编译 Tailwind），由挂件内的 iframe 加载。
  let consoleHtmlCache = null // { text, mtimeMs }
  function loadConsoleHtml() {
    for (const p of consoleFileCandidates) {
      try {
        const st = fs.statSync(p)
        if (consoleHtmlCache && consoleHtmlCache.mtimeMs === st.mtimeMs) return consoleHtmlCache.text
        const text = fs.readFileSync(p, 'utf8')
        consoleHtmlCache = { text, mtimeMs: st.mtimeMs }
        return text
      } catch (err) {}
    }
    return consoleHtmlCache ? consoleHtmlCache.text : ''
  }

  const imageHandler = (req, res) => {
    try {
      const bytes = loadImage()
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('whale image unavailable: ' + String((err && err.message) || err))
    }
  }

  const ruaGifHandler = (req, res) => {
    try {
      const bytes = loadGif()
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('rua gif unavailable: ' + String((err && err.message) || err))
    }
  }

  const widgetJsHandler = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(loadWidgetJs())
  }

  const consoleHtmlHandler = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(loadConsoleHtml())
  }

  return {
    imageHandler,
    ruaGifHandler,
    exprPacksHandler,
    exprImageHandler,
    petVideoHandler,
    petAnimationsHandler,
    bubbleHandler,
    bubbleImgsHandler,
    bubbleImgUploadHandler,
    bubbleImgHandler,
    widgetJsHandler,
    consoleHtmlHandler,
  }
}
