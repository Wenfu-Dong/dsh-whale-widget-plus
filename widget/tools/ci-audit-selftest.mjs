// tools/ci-audit-selftest.mjs —— ci-audit 的自检（0 依赖，node 直接跑）
//
// 为什么需要它：ci-audit 是门禁，而门禁有两种坏法 ——
//   ① 误判：把合法代码判死 → 维护者嫌烦，最后把整条检查删掉；
//   ② 漏判：看着是绿的其实什么都没拦 → 比没有更糟，因为它给人虚假的安全感。
// 这个自检就钉这两种坏法：先证明「干净样本全绿」，再**逐项**证明「写坏必红」。
// 每个用例都造一个独立样本仓库，用 --only=<编号> 只跑被测的那一项，互不干扰。
//
// 另外扫一遍审计脚本自身的「环境依赖」：断言里直接读本机时钟/工作目录，
// 会变成"本机 UTC+8 绿、CI UTC 红"的时区假红（0.7.11 token-guard-audit 的事故）。
//
// 用法：node tools/ci-audit-selftest.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT = path.join(HERE, 'ci-audit.mjs')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-audit-selftest-'))

const WF = [
  'name: Workflow',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    branches: [main]',
  'jobs:',
  '  audit:',
  '    steps:',
  '      - run: node scripts/ci-gate.mjs',
  '',
].join('\n')

// 统一门禁样本：被 ④ 检查的关键项都在这里登记（真实仓库对应 scripts/ci-gate.mjs）
const GATE = [
  '// 统一门禁（样本）',
  "const CHECKS = [",
  "  ['widget/tools/z-layer-audit.mjs'],",
  "  ['--check', 'lib/index.js'],",
  "  ['grep', '-rn', 'TestBox', 'lib'],",
  "  ['scripts/privacy-scan.mjs', '--strict'],",
  "  ['widget/tools/ci-audit.mjs', '--no-pack'],",
  "  ['--test', 'test/example.test.mjs'],",
  "  ['scripts/install-simulation.mjs'],",
  ']',
  '',
].join('\n')

const HOST = [
  'const WIDGET_FILE_CANDIDATES = [',
  "  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),",
  "  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),",
  ']',
  'function registerRoute(route) {',
  '  return ctx.webServer.register(route)',
  '}',
  "registerRoute({ kind: 'exact', path: '/dsh-whale/balance.json', handler: (q, s) => s.end() })",
  "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
  '',
].join('\n')

const FRONT = [
  "var BALANCE_URL = '/dsh-whale/balance.json'",
  "el.innerHTML = ''",
  "el.innerHTML = '<div>static</div>'",
  'toast.innerHTML = msg',
  '',
].join('\n')

const BASE = {
  'package.json': JSON.stringify({
    name: 'dsh-whale-widget',
    version: '0.0.0',
    type: 'module',
    main: 'lib/index.js',
    files: ['lib', 'assets', 'cordis.patch.yml', 'README.md'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2),
  'cordis.patch.yml': '- insert:\n    - id: dsh-whale-widget\n      name: dsh-whale-widget\n',
  'README.md': '全部 **2 个** `/dsh-whale/*` 路由都已接入信任栅栏。\n',
  'widget/lib/accounting.mjs': 'export const ok = true\n',
  'widget/lib/index.js': HOST,
  'widget/assets/whale-widget.js': FRONT,
  '.github/workflows/ci.yml': WF,
  '.github/workflows/publish.yml': WF,
  'scripts/ci-gate.mjs': GATE,
  'widget/tools/ci-audit.allowlist.json': JSON.stringify({
    allow: [{ key: 'widget/assets/whale-widget.js :: toast.innerHTML = msg', why: '样本用：已知动态入口' }],
  }, null, 2),
}

function writeFixture(name, overrides = {}) {
  const dir = path.join(tmpRoot, name)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, body] of Object.entries({ ...BASE, ...overrides })) {
    if (body === null) continue // null = 故意不写这个文件
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
  }
  return dir
}

function runAudit(dir, only) {
  const args = [AUDIT, `--root=${dir}`, '--no-pack']
  if (only) args.push(`--only=${only}`)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const results = []
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }) } catch (err) {
    results.push({ name, ok: false, why: String((err && err.message) || err) })
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
const green = (dir, only, label) => {
  const r = runAudit(dir, only)
  assert(r.code === 0, (label || '干净样本') + ' 应该全绿，实际退出码 ' + r.code + '\n' + r.out)
}
const red = (dir, only, label) => {
  const r = runAudit(dir, only)
  assert(r.code !== 0, (label || '写坏的样本') + ' 应该报错，实际却全绿（门禁失效）\n' + r.out)
  assert(r.out.includes('[' + only + ']'), '输出里没看到第 ' + only + ' 项的结果\n' + r.out)
}

// --- 基线 --------------------------------------------------------------------
check('基线：干净样本必须全绿（五项一起跑，标题即 ci-audit 的五项检查名）', () => {
  green(writeFixture('clean'), null)
})

// --- ① 栅栏不变量 ------------------------------------------------------------
check('① 多出一处绕过 registerRoute 的裸注册 → 必红', () => {
  const dir = writeFixture('c1-bare', {
    'widget/lib/index.js': HOST.replace(
      "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
      "ctx.webServer.register({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
    ),
  })
  red(dir, '1', '绕过栅栏的裸注册')
})

check('① README 声明的路由条数与实际不符 → 必红', () => {
  const dir = writeFixture('c1-count', { 'README.md': '全部 **9 个** `/dsh-whale/*` 路由都已接入信任栅栏。\n' })
  red(dir, '1', 'README 条数漂移')
})

// --- ② 路由对等 --------------------------------------------------------------
check('② 前端引用了宿主未注册的路径 → 必红', () => {
  const dir = writeFixture('c2-parity', {
    'widget/assets/whale-widget.js': FRONT + "var TYPO_URL = '/dsh-whale/balanc.json'\n",
  })
  red(dir, '2', '前端引用不存在的路由')
})

check('② 只有注释提到不存在的路径 → 必须绿（注释不算引用）', () => {
  const dir = writeFixture('c2-comment', {
    'widget/assets/whale-widget.js': '// 历史注释：老路由 /dsh-whale/legacy.json 已废弃\n' + FRONT,
  })
  green(dir, '2', '注释里提到不存在的路由')
})

check('② 动态前缀拼接（能落在已注册路径下）→ 必须绿', () => {
  const dir = writeFixture('c2-prefix', {
    'widget/lib/index.js': HOST.replace(
      "registerRoute({ kind: 'exact', path: '/dsh-whale/widget.js', handler: (q, s) => s.end() })",
      "registerRoute({ kind: 'exact', path: '/dsh-whale/sound/press.mp3', handler: (q, s) => s.end() })",
    ),
    'widget/assets/whale-widget.js': FRONT + "var legacy = '/dsh-whale/sound/' + slot + '.mp3'\n",
  })
  green(dir, '2', '前缀拼接的动态路径')
})

// --- ⑤ 注入面 ---------------------------------------------------------------
check('⑤ innerHTML 接上变量 → 必红', () => {
  const dir = writeFixture('c5-inject', {
    'widget/assets/whale-widget.js': FRONT + 'panel.innerHTML = serverMsg\n',
  })
  red(dir, '5', '未登记的动态写入')
})

check('⑤ 模板串带 ${} 插值 → 必红', () => {
  const dir = writeFixture('c5-template', {
    'widget/assets/whale-widget.js': FRONT + 'box.innerHTML = `<b>${name}</b>`\n',
  })
  red(dir, '5', '模板串插值')
})

check('⑤ 登记过、但写法改了（换成别的变量）→ 必红', () => {
  const dir = writeFixture('c5-rekey', {
    'widget/assets/whale-widget.js': FRONT.replace('toast.innerHTML = msg', 'toast.innerHTML = other'),
  })
  red(dir, '5', '允许清单只认精确写法')
})

check('⑤ 允许清单里有已不存在的条目 → 必红（防清单腐烂）', () => {
  const dir = writeFixture('c5-stale', { 'widget/assets/whale-widget.js': FRONT.replace('toast.innerHTML = msg\n', '') })
  red(dir, '5', '清单过期条目')
})

check('⑤ 跨行拼接的静态 SVG → 必须绿（真实写法，不能误判）', () => {
  const dir = writeFixture('c5-multiline', {
    'widget/assets/whale-widget.js': FRONT + "box.innerHTML = '<svg viewBox=\"0 0 10 10\">' +\n  '<path d=\"M0 0\"/>' +\n  '</svg>'\n",
  })
  green(dir, '5', '跨行静态字面量')
})

check('⑤ 字面量后面还有尾随代码 → 必须绿（.catch(function(){…}) 的真实写法）', () => {
  const dir = writeFixture('c5-tail', {
    'widget/assets/whale-widget.js': FRONT + "p.then(function () { card.innerHTML = '<div>ok</div>' })\n",
  })
  green(dir, '5', '字面量 + 尾随代码')
})

// --- ④ 门禁一致性 ------------------------------------------------------------
check('④ publish.yml 不再调用统一门禁 → 必红', () => {
  const dir = writeFixture('c4-gate', {
    '.github/workflows/publish.yml': WF.replace('      - run: node scripts/ci-gate.mjs\n', ''),
  })
  red(dir, '4', '发布前门禁漏挂统一清单')
})

check('④ 统一门禁里语法检查被摘掉 → 必红', () => {
  const dir = writeFixture('c4-syntax', {
    'scripts/ci-gate.mjs': GATE.replace("  ['--check', 'lib/index.js'],\n", ''),
  })
  red(dir, '4', '门禁清单少一项')
})

check('④ 两份 workflow 覆盖一致 → 必须绿', () => {
  green(writeFixture('c4-ok'), '4', '两份 workflow 一致')
})

// --- 环境依赖扫描（审计脚本不得裸用本机时钟 / 工作目录） ----------------------
// 为什么：CI 跑在 UTC、目录是干净 clone；本机是 UTC+8、还可能带生成物。
// 断言里直接用 Date.now() / new Date() / process.cwd()，就会"本机绿、CI 红"。
const ENV_PATTERNS = [
  { name: 'Date.now()', re: /\bDate\.now\s*\(/g },
  { name: 'new Date()', re: /\bnew\s+Date\s*\(/g },
  { name: 'process.cwd()', re: /\bprocess\.cwd\s*\(/g },
]
// 允许清单：必须写明"为什么可以"，不要只写文件名。
const ENV_ALLOW = new Map([
  ['token-guard-audit.mjs', '用 localDayStart(Date.now()) + 12h 固定到本地日内 12:00，结果不随时钟漂移'],
])

/** 把注释与字符串内容替换成空格（保留换行，行号不变）：注释/文案里提到不算依赖。 */
function maskNonCode(src) {
  const out = src.split('')
  let q = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '\\') { out[i] = ' '; if (i + 1 < src.length) out[i + 1] = ' '; i++; continue }
      if (c === q) { out[i] = ' '; q = null; continue }
      if (c !== '\n') out[i] = ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') { out[i] = ' '; q = c; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      i--
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i++ }
    }
  }
  return out.join('')
}

function scanEnvDeps(src) {
  const code = maskNonCode(src)
  const hits = []
  for (const p of ENV_PATTERNS) {
    p.re.lastIndex = 0
    let m
    while ((m = p.re.exec(code)) !== null) {
      hits.push({ name: p.name, line: code.slice(0, m.index).split('\n').length })
    }
  }
  return hits
}

check('环境依赖：审计脚本不得裸用 Date.now()/new Date()/process.cwd()（时区/目录假红）', () => {
  const files = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs')).sort()
  const bad = []
  for (const f of files) {
    if (ENV_ALLOW.has(f)) continue
    for (const h of scanEnvDeps(fs.readFileSync(path.join(HERE, f), 'utf8'))) {
      bad.push(f + ':' + h.line + ' ' + h.name)
    }
  }
  assert(bad.length === 0, '这些审计脚本依赖本机环境（CI 会红）：' + bad.join('；')
    + '。请把时间/目录改成注入式固定输入；确有必要就登记到 ENV_ALLOW 并写明理由')
  assert([...files].some((f) => ENV_ALLOW.has(f)), 'ENV_ALLOW 里的文件已不存在（清单腐烂）')
})

check('环境依赖扫描自证：写坏必红 / 注释与字符串不算 / 允许清单放行', () => {
  assert(scanEnvDeps('const t = Date.now()\n').length === 1, 'Date.now() 没被扫出来')
  assert(scanEnvDeps('const d = new Date()\n').length === 1, 'new Date() 没被扫出来')
  assert(scanEnvDeps('const p = process.cwd()\n').length === 1, 'process.cwd() 没被扫出来')
  assert(scanEnvDeps('// 这里提到 Date.now() 只是注释\nconst ok = 1\n').length === 0, '注释里的字样不应命中')
  assert(scanEnvDeps('console.log("用 Date.now() 会漂")\n').length === 0, '字符串里的字样不应命中')
  assert(ENV_ALLOW.has('token-guard-audit.mjs'), '允许清单丢了 token-guard-audit.mjs')
})

// --- 汇总 -------------------------------------------------------------------
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('ci-audit 自检（tools/ci-audit-selftest.mjs）')
for (const r of results) console.log((r.ok ? '  √ ' : '  × ') + r.name + (r.ok ? '' : '\n      ' + r.why))
const bad = results.filter((r) => !r.ok).length
console.log('')
console.log(bad
  ? '结果：' + bad + '/' + results.length + ' 个用例失败'
  : '结果：' + results.length + '/' + results.length + ' 个用例通过')
process.exit(bad ? 1 : 0)
