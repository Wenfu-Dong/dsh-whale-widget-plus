#!/usr/bin/env node
/**
 * scripts/ci-gate.mjs —— CI 门禁的**单一清单**。
 *
 * 为什么要有这个文件（真实事故复盘）：
 *   · 以前 ci.yml 与 publish.yml 各抄一份 20 多条命令，改一处漏一处；
 *     同一个 bug 会在两条 workflow 上各红一次，体感就是"CI 反反复复"。
 *   · 本地根本没有跑同一套门禁的入口：`npm test` 只跑 test/*.test.mjs，
 *     `npm run audit` 只跑 ci-audit 一条 —— 时区、工作目录、OS 这类
 *     "本机假设"永远只能等推送后由 CI 揭穿（0.7.11 的 UTC 凌晨假红就是）。
 *
 * 因此这里做三件事：
 *   1) 所有检查只登记一次；两条 workflow 都只调用本脚本，本地 `npm run gate` 同款；
 *   2) 默认 TZ=UTC（CI 就是 UTC），本地也能提前复现时区类假红；
 *   3) 便宜的纯逻辑审计排在最前面，失败立刻退出 —— 别等跑满一分钟才报。
 *
 * 用法：
 *   npm run gate
 *   node scripts/ci-gate.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 统一按 CI 的时区跑。审计里任何"本机时区/本机日界"的假设，在这里都会现形。
process.env.TZ = 'UTC'

// 只认 GitHub Actions 的专用变量：很多本地/代理环境也会设 CI=true，
// 用它判断会把"本地跑一下"误当成干净 clone。
const IS_CI = String(process.env.GITHUB_ACTIONS || '') === 'true'

// ---------------------------------------------------------------------------
// 通用执行器
// ---------------------------------------------------------------------------
function node(rel, args = []) {
  const r = spawnSync(process.execPath, [rel, ...args], { cwd: ROOT, stdio: 'inherit' })
  return r.status === 0
}
const script = (rel, args = []) => () => node(rel, args)

function gitList(...patterns) {
  const args = ['ls-files', '-z', '--', ...patterns]
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  return r.stdout.toString('utf8').split('\0').filter(Boolean)
}

// ---------------------------------------------------------------- 语法检查
// 与旧 CI 完全一致：4 个入口显式点名 + 所有被跟踪的 *.js / *.mjs 逐个 node --check。
// 这里用 8 路并发（比 xargs 串行快，Windows 上尤其明显）。
function nodeCheck(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--check', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ file, err: String(e.message || e) }))
    p.on('close', (code) => resolve(code === 0 ? null : { file, err }))
  })
}

async function syntaxCheck() {
  const entries = ['lib/index.js', 'widget/lib/index.js', 'backend/lib/index.js', 'shims/qq-mode/lib/qq-mode.js']
  const tracked = gitList('*.js', '*.mjs')
  if (!tracked) { console.error('  ✗ git ls-files 失败'); return false }
  const files = [...new Set([...entries, ...tracked])]
  const failures = []
  let cursor = 0
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= files.length) return
      const bad = await nodeCheck(files[i])
      if (bad) failures.push(bad)
    }
  })
  await Promise.all(workers)
  if (!failures.length) return true
  console.error(`  ✗ ${failures.length} 个文件语法不合法：`)
  for (const f of failures.slice(0, 10)) console.error(`    · ${f.file}\n${f.err.slice(0, 600)}`)
  return false
}

// ------------------------------------------------------- 开发机路径扫描
// 扫描器自身要写这个字面量，必须跳过自己，否则永远自命中。
const SELF_REL = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/')
function scanTestBox() {
  const dirs = ['lib', 'backend/lib', 'widget/lib', 'src', 'scripts']
  const hits = []
  const walk = (rel) => {
    if (rel === SELF_REL) return
    const abs = path.join(ROOT, rel)
    let st = null
    try { st = fs.statSync(abs) } catch { return }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(rel + '/' + name)
      return
    }
    if (!/\.(js|mjs|cjs|ts)$/.test(rel)) return
    let text = ''
    try { text = fs.readFileSync(abs, 'utf8') } catch { return }
    if (text.includes('TestBox')) hits.push(rel)
  }
  for (const d of dirs) walk(d)
  if (!hits.length) return true
  console.error('  ✗ 发现开发机路径 TestBox：' + hits.join(', '))
  return false
}

// ------------------------------------------- 人设生成物不得进版本库
function personaNotTracked() {
  const tracked = gitList()
  if (!tracked) { console.error('  ✗ git ls-files 失败'); return false }
  const bad = tracked.filter((f) => /^presets\/[^/]+\.patch\.yml$/.test(f) || f === 'dsh/agent-presets/persona.system.md')
  if (!bad.length) return true
  console.error('  ✗ 人设生成物被提交进了 git（应只在本机生成）：' + bad.join(', '))
  return false
}

// ---------------------------------------------------------------------------
// 门禁清单（便宜 → 昂贵；失败即停）
// ---------------------------------------------------------------------------
const steps = []
const add = (name, fn) => steps.push({ name, fn })

// —— 便宜、纯逻辑（几毫秒；先跑，早报错）——
add('版本一致性（README / AGENT / CHANGELOG / tag）', script('scripts/version.mjs', ['check']))
add('隐私与敏感信息扫描', script('scripts/privacy-scan.mjs', ['--strict']))
add('开发机路径扫描（TestBox）', scanTestBox)
add('人设生成物不得进版本库', personaNotTracked)
add('图层审计', script('widget/tools/z-layer-audit.mjs'))
add('泡泡配置语义审计', script('widget/tools/bubble-config-audit.mjs'))
add('并列候选审计', script('widget/tools/choice-options-audit.mjs'))
add('死设置审计', script('widget/tools/check-dead-settings.mjs'))
add('表情包冒烟', script('widget/tools/expr-smoke.mjs'))
add('配置模糊审计（毒值组合）', script('widget/tools/config-fuzz-audit.mjs'))
add('Token 守卫边界审计', script('widget/tools/token-guard-audit.mjs'))
add('人格分层审计', script('widget/tools/persona-layers-audit.mjs'))
add('出站安全审计', script('widget/tools/outbound-safety-audit.mjs'))
add('出站管道回归', script('widget/tools/outbound-pipeline-audit.mjs'))
add('跨模块口径审计', script('widget/tools/divergence-audit.mjs'))
add('功能模块审计（原子写 / 超时 / 可见性）', script('widget/tools/module-audit.mjs'))
add('核心不变量审计', script('widget/tools/ci-audit.mjs', ['--no-pack']))
add('审计脚本自检（含环境依赖扫描）', script('widget/tools/ci-audit-selftest.mjs'))
add('单元测试（test/*.test.mjs）', () => {
  // 以前 test/ 下的 225 条测试根本不在 CI 里跑（npm test 只存在于本地习惯），
  // 这里显式列文件（不依赖 shell 展开 glob，Windows / Linux 行为一致）。
  const dir = path.join(ROOT, 'test')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => 'test/' + f) } catch { files = [] }
  if (!files.length) { console.error('  ✗ test/ 下没有找到 *.test.mjs'); return false }
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' })
  return r.status === 0
})

// —— 需要干净 clone 的检查（本地生成物是预期存在，跳过并说明）——
add('发布守卫（不得含本机人设生成物）', () => {
  if (!IS_CI) {
    console.log('  · 本地跳过：该项只对干净 clone 有意义（本机 persona 生成物属预期）')
    return true
  }
  return node('scripts/publish-guard.mjs')
})

// —— 较慢：语法 / 构建产物 / 依赖加载 / 真装一遍 ——
add('语法检查（入口 + 全量 tracked js/mjs）', syntaxCheck)
add('构建产物与源一致', script('build.mjs', ['--check']))
add('模块导入冒烟', script('widget/tools/module-import-audit.mjs'))
add('安装模拟（pack → 干净安装 → import 全解析）', script('scripts/install-simulation.mjs'))

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
console.log(`CI 门禁（scripts/ci-gate.mjs）· TZ=${process.env.TZ} · ${steps.length} 步`)
const t0 = Date.now()
for (let i = 0; i < steps.length; i++) {
  const s = steps[i]
  console.log(`\n▸ [${i + 1}/${steps.length}] ${s.name}`)
  let ok = false
  try { ok = await s.fn() } catch (err) {
    console.error('  ✗ 步骤自身异常：' + String((err && err.message) || err))
  }
  if (!ok) {
    console.error(`\n✗ 门禁失败：第 ${i + 1} 步「${s.name}」`)
    process.exit(1)
  }
}
console.log(`\n✓ 门禁通过：${steps.length}/${steps.length} 步，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
