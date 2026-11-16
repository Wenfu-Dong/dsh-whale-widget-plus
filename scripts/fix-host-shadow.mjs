#!/usr/bin/env node
/**
 * fix-host-shadow.mjs —— 清理 profile 里「插件带进来的旧版宿主核心包」。
 *
 * 背景（0.7.9 之前的真实事故）：
 *   插件曾把 @deepseek-ai/dsh-host-apiproxy 当普通依赖，它会拉进 20+ 个
 *   @deepseek-ai/dsh-*（^0.1.1-rc.2，prerelease 上界 <0.2.0）。装进 profile 后，
 *   这些旧核心包会盖掉 App 自带的 0.2.x，required 插件找不到 tools / agents / sessions / llm
 *   服务，整个 DSH 启动失败：
 *     DesktopHostFatalError: dsh: startup failed: 2 required plugins did not activate
 *
 *   0.7.9 已经删掉那条依赖，但**已经装坏的机器不会自己好**：npm 不会因为你删了
 *   依赖就去清理 profile 里已经解出来的旧包，而且 DSH 起不来时也点不开插件更新。
 *
 * 用法（在 profile 目录下，DSH 关着也行）：
 *   node node_modules/dsh-dfy/scripts/fix-host-shadow.mjs            # 只体检（默认）
 *   node node_modules/dsh-dfy/scripts/fix-host-shadow.mjs --apply    # 真的删除
 *
 * ⚠️ 只删「版本低于 profile 自己声明的宿主版本」的 @deepseek-ai/dsh-*，
 *    宿主正在用的新版（例如 0.2.2-rc.3）不会被碰。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SCOPE = '@deepseek-ai';

function parseVer(v) {
  return String(v ?? '').split(/[.+-]/).slice(0, 3).map((n) => Number(n) || 0);
}
/** 仅用于「旧 vs 新」判断：-1 / 0 / 1。 */
function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** profile 自己的 package.json 里声明过的 @deepseek-ai/dsh-*（宿主真正要用的版本）。 */
function declaredHostVersions(profileDir) {
  const pkg = readJson(path.join(profileDir, 'package.json')) ?? {};
  const out = new Map();
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (!/^@deepseek-ai\/dsh-/.test(name)) continue;
    const version = String(spec).replace(/^[^\d]*/, '');
    if (/^\d/.test(version)) out.set(name, version);
  }
  return out;
}

/** 某 profile 里所有存放 @deepseek-ai 的 node_modules（根 + 一层嵌套，例如 dsh-dfy/node_modules）。 */
function scopeDirs(profileDir) {
  const out = [path.join(profileDir, 'node_modules', SCOPE)];
  let entries = [];
  try { entries = fs.readdirSync(path.join(profileDir, 'node_modules'), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name === SCOPE) continue;
    const nested = path.join(profileDir, 'node_modules', entry.name, 'node_modules', SCOPE);
    if (fs.existsSync(nested)) out.push(nested);
  }
  return out;
}

const profilesRoot = path.join(DSH_HOME, 'profiles');
let profileDirs = [];
try {
  profileDirs = fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profilesRoot, e.name));
} catch { /* 下面统一报「找不到 profile」 */ }

if (!profileDirs.length) {
  console.error(`✗ 找不到 profile：${profilesRoot}（可用 DSH_HOME 指定 DSH 数据目录）`);
  process.exit(1);
}

let staleTotal = 0;
for (const profileDir of profileDirs) {
  const declared = declaredHostVersions(profileDir);
  const reference = [...declared.values()].sort((a, b) => cmpVer(a, b)).at(-1) ?? '';
  const hits = [];
  for (const dir of scopeDirs(profileDir)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue;
      const full = path.join(dir, entry.name);
      const pkg = readJson(path.join(full, 'package.json'));
      if (!pkg) continue;
      const name = String(pkg.name ?? `${SCOPE}/${entry.name}`);
      const version = String(pkg.version ?? '');
      // 没有参照版本时只做提示，不删除（避免误伤更老的合法 DSH）。
      const stale = reference ? cmpVer(version, reference) < 0 : false;
      hits.push({ name, version, full, stale });
    }
  }
  if (!hits.length) continue;
  console.log(`\n[${path.basename(profileDir)}] 参照宿主版本：${reference || '(未声明，只体检不删)'}`);
  for (const hit of hits) {
    console.log(`  ${hit.stale ? (APPLY ? '✗ 已删除' : '✗ 待删除') : '· 保留  '} ${hit.name}@${hit.version}`);
    if (hit.stale) staleTotal += 1;
    if (hit.stale && APPLY) {
      try {
        fs.rmSync(hit.full, { recursive: true, force: true });
      } catch (error) {
        console.log(`     删除失败：${error?.code ?? error}`);
      }
    }
  }
}

if (!staleTotal) {
  console.log('\n✓ 没有发现影子包（profile 里的 @deepseek-ai/dsh-* 都不低于宿主版本）');
} else if (APPLY) {
  console.log(`\n✓ 已清理 ${staleTotal} 个旧核心包。请完全退出并重启 DSH。`);
} else {
  console.log(`\n发现 ${staleTotal} 个旧核心包。确认无误后执行：node node_modules/dsh-dfy/scripts/fix-host-shadow.mjs --apply`);
}
