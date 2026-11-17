/**
 * 自定义角色 / 音频片段的存储层（从 widget/lib/index.js 拆出）。
 *
 * 只做目录定位 + 索引读写 + 列表整形 + 片段字节读取，不碰 HTTP。
 * 目录候选与内置素材表由调用方注入，避免这里再依赖 widget 入口的闭包状态。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROLE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * @param {object} deps
 * @param {string[]} deps.roleDirCandidates 角色目录候选（按优先级）
 * @param {string[]} deps.audioDirCandidates 音频目录候选（按优先级）
 * @param {string} deps.roleDefaultId 内置默认角色 id
 * @param {string} deps.roleIndexName 角色索引文件名
 * @param {string} deps.audioIndexName 音频索引文件名
 * @param {object} deps.presetGroups 内置音效组表
 * @param {object} deps.presetFragments 内置片段表
 * @param {object} deps.builtinFragmentFiles 随包片段文件候选（id -> 路径数组）
 * @param {object} deps.soundSets SOUND_SETS 映射（组名 -> 文件地址）
 * @param {(url: string) => Buffer|null} deps.loadSound 读取内置音效字节
 */
export function createRoleAudioStore(deps) {
  const {
    roleDirCandidates, audioDirCandidates, roleDefaultId, roleIndexName, audioIndexName,
    presetGroups, presetFragments, builtinFragmentFiles, soundSets, loadSound,
  } = deps || {}
  for (const [name, value] of Object.entries({
    roleDirCandidates, audioDirCandidates, roleDefaultId, roleIndexName, audioIndexName,
    presetGroups, presetFragments, builtinFragmentFiles, soundSets, loadSound,
  })) {
    if (value === undefined || value === null) throw new TypeError(`role-audio-store 缺少依赖：${name}`)
  }

  function pickRoleDir() {
    for (const p of roleDirCandidates) {
      try {
        fs.mkdirSync(p, { recursive: true })
        fs.accessSync(p, fs.constants.W_OK)
        return p
      } catch (err) {}
    }
    return roleDirCandidates[0]
  }

  function defaultRolesIndex() {
    return {
      version: 1,
      roles: [
        // 默认小鲸鱼初始置顶；pinnedAt=1 作为基线，任何新置顶（Date.now()）都会排在它上面
        { id: roleDefaultId, name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
      ],
    }
  }

  function readRolesIndex() {
    const dir = pickRoleDir()
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, roleIndexName), 'utf8'))
      if (parsed && Array.isArray(parsed.roles)) {
        if (!parsed.roles.some((r) => r && r.id === roleDefaultId)) {
          parsed.roles.unshift(defaultRolesIndex().roles[0])
        }
        return parsed
      }
    } catch (err) {}
    return defaultRolesIndex()
  }

  function writeRolesIndex(index) {
    const dir = pickRoleDir()
    try {
      fs.writeFileSync(path.join(dir, roleIndexName), JSON.stringify(index, null, 2), 'utf8')
      return true
    } catch (err) {
      return false
    }
  }

  // 排序：置顶的在前（pinnedAt 大者先，即最新置顶在最上面），未置顶按创建时间倒序
  function sortRoles(roles) {
    return roles.slice().sort((a, b) => {
      const ap = a.pinnedAt && a.pinnedAt > 0 ? a.pinnedAt : 0
      const bp = b.pinnedAt && b.pinnedAt > 0 ? b.pinnedAt : 0
      if (ap && bp) return bp - ap
      if (ap) return -1
      if (bp) return 1
      return (b.createdAt || 0) - (a.createdAt || 0)
    })
  }

  function rolesPayload() {
    const index = readRolesIndex()
    return {
      ok: true,
      roles: sortRoles(index.roles).map((r) => ({
        id: r.id,
        name: String(r.name || r.id),
        url: r.id === roleDefaultId ? '/dsh-whale/image.png' : '/dsh-whale/role-image.png?id=' + encodeURIComponent(r.id),
        pinned: !!(r.pinnedAt && r.pinnedAt > 0),
        pinnedAt: r.pinnedAt || null,
        createdAt: r.createdAt || null,
        // format: 'png' | 'gif' | 'apng'（旧角色无 format 字段 → png）
        format: r.format === 'gif' || r.format === 'apng' ? r.format : 'png',
      })),
    }
  }

  // 角色文件按格式映射扩展名：gif→.gif，apng/png→.png（APNG 文件仍是 PNG 容器）
  function roleFileExt(format) {
    return format === 'gif' ? 'gif' : 'png'
  }

  function roleFilePath(id, format) {
    if (typeof id !== 'string' || !ROLE_ID_RE.test(id) || id === roleDefaultId) return null
    return path.join(pickRoleDir(), id + '.' + roleFileExt(format))
  }

  function roleImagePath(id) {
    // 查找角色元数据确定扩展名；找不到默认 png
    const { role } = roleIndexFind(id)
    const format = role && (role.format === 'gif' || role.format === 'apng') ? role.format : 'png'
    const p = roleFilePath(id, format)
    return p
  }

  function roleIdFromUrl(url) {
    try {
      const q = String(url || '').split('?')[1] || ''
      const m = /(?:^|&)id=([^&]+)/.exec(q)
      return m ? decodeURIComponent(m[1]) : ''
    } catch (err) { return '' }
  }

  function roleIndexFind(id) {
    const index = readRolesIndex()
    const role = index.roles.find((r) => r && r.id === id)
    return { index, role }
  }

  // —— 自定义音频：whale-audio/ 目录，片段 <id>.wav + audio.json 索引 ——
  function pickAudioDir() {
    for (const p of audioDirCandidates) {
      try {
        fs.mkdirSync(p, { recursive: true })
        fs.accessSync(p, fs.constants.W_OK)
        return p
      } catch (err) {}
    }
    return audioDirCandidates[0]
  }

  function defaultAudioIndex() {
    return { version: 1, groups: [], fragments: [] }
  }

  function readAudioIndex() {
    const dir = pickAudioDir()
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, audioIndexName), 'utf8'))
      if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) {
        return parsed
      }
    } catch (err) {}
    return defaultAudioIndex()
  }

  function writeAudioIndex(index) {
    const dir = pickAudioDir()
    try {
      fs.writeFileSync(path.join(dir, audioIndexName), JSON.stringify(index, null, 2), 'utf8')
      return true
    } catch (err) {
      return false
    }
  }

  // 自定义片段 id -> 文件路径；预设片段无文件
  function audioFragmentPath(id) {
    if (typeof id !== 'string' || !ROLE_ID_RE.test(id)) return null
    if (presetFragments[id]) return null
    return path.join(pickAudioDir(), id + '.wav')
  }

  function audioIdFromUrl(url) {
    try {
      const q = String(url || '').split('?')[1] || ''
      const m = /(?:^|&)id=([^&]+)/.exec(q)
      return m ? decodeURIComponent(m[1]) : ''
    } catch (err) { return '' }
  }

  // 片段列表：预设片段 + 用户自定义片段
  function audioFragmentsPayload() {
    const index = readAudioIndex()
    const presets = Object.keys(presetFragments).map((k) => ({
      id: k,
      name: presetFragments[k].name,
      preset: true,
    }))
    const custom = index.fragments.map((f) => ({
      id: f.id,
      name: String(f.name || f.id),
      preset: false,
      createdAt: f.createdAt || null,
    }))
    return presets.concat(custom)
  }

  // 音效组列表：预设组 + 用户自定义组（置顶优先，组内按创建时间倒序）
  function audioGroupsPayload() {
    const index = readAudioIndex()
    // 排序：置顶的自定义组最前，其次预设组，最后未置顶的自定义组（按创建时间倒序）
    const customs = index.groups.slice().map((g) => ({
      id: g.id,
      name: String(g.name || g.id),
      press: typeof g.press === 'string' ? g.press : null,
      release: typeof g.release === 'string' ? g.release : null,
      preset: false,
      pinned: !!(g.pinnedAt && g.pinnedAt > 0),
      pinnedAt: g.pinnedAt || null,
      createdAt: g.createdAt || 0,
    }))
    const pinned = customs.filter((g) => g.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
    const unpinned = customs.filter((g) => !g.pinned).sort((a, b) => b.createdAt - a.createdAt)
    const presets = Object.keys(presetGroups).map((k) => {
      const g = presetGroups[k]
      return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
    })
    return pinned.concat(presets, unpinned)
  }

  function audioPayload() {
    return {
      ok: true,
      groups: audioGroupsPayload(),
      fragments: audioFragmentsPayload(),
    }
  }

  // 取片段音频字节：内置随包片段 → 预设(SOUND_SETS) → 自定义 whale-audio/<id>.wav
  function loadAudioFragmentBytes(fragId) {
    if (builtinFragmentFiles[fragId]) {
      return loadSound(builtinFragmentFiles[fragId])
    }
    if (presetFragments[fragId]) {
      // 预设片段映射到对应音效文件：ya1->duck.press, ya2->duck.release, d1->fx1.press, d2->fx1.release
      const map = { ya1: ['duck', 'press'], ya2: ['duck', 'release'], d1: ['fx1', 'press'], d2: ['fx1', 'release'], ya3: ['duck2', 'press'], vb: ['voice_bing', 'press'], vh: ['voice_heng', 'press'], vq: ['voice_qtan', 'press'], vw: ['voice_weiqu', 'press'] }
      const [setName, slot] = map[fragId]
      const set = soundSets[setName]
      if (!set) return null
      return loadSound(set[slot])
    }
    const p = audioFragmentPath(fragId)
    if (!p) return null
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
    return null
  }

  // 组内实际使用的片段：若自定义组引用的片段被删，回退到预设
  // 返回 '' 表示该槽显式留空（该事件静音），调用方应据此不发音频
  function groupFragmentId(groupId, slot) {
    const custom = readAudioIndex().groups.find((g) => g && g.id === groupId)
    if (custom) {
      const fid = custom[slot]
      if (fid === '') return ''
      if (fid) {
        if (presetFragments[fid]) return fid
        if (customFragExists(fid)) return fid
      }
      // 无字段/引用失效 → 回退预设：新组无引用时用 duck
      return slot === 'press' ? presetGroups.duck.press : presetGroups.duck.release
    }
    const preset = presetGroups[groupId]
    if (preset) return preset[slot]
    return slot === 'press' ? presetGroups.duck.press : presetGroups.duck.release
  }

  function customFragExists(id) {
    try {
      const p = audioFragmentPath(id)
      if (!p) return false
      const st = fs.statSync(p)
      return st.isFile()
    } catch (err) { return false }
  }

  return {
    pickRoleDir, defaultRolesIndex, readRolesIndex, writeRolesIndex, sortRoles, rolesPayload,
    roleFileExt, roleFilePath, roleImagePath, roleIdFromUrl, roleIndexFind,
    pickAudioDir, defaultAudioIndex, readAudioIndex, writeAudioIndex,
    audioFragmentPath, audioIdFromUrl, audioFragmentsPayload, audioGroupsPayload, audioPayload,
    loadAudioFragmentBytes, groupFragmentId, customFragExists,
  }
}
