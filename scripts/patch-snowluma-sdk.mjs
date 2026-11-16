// 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名，
// 纯 Node ESM 无法解析（bundler 可以）。postinstall 时对每个包 dist 下所有 .js
// 文件做机械修补：仅当目标文件存在时才补扩展名，否则保持原样。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const requireFromHere = createRequire(import.meta.url);

const TARGETS = ['@snowluma/sdk', '@snowluma/mcp'];

/**
 * 找到包的 dist 目录。
 *
 * 不能只看 `<插件根>/node_modules/...`：插件通常是 profile 的一个依赖，npm 会把
 * @snowluma/* **提升**到 profile 根的 node_modules，插件目录下根本没有它
 * （旧实现在这种安装方式下会打印「dist 不存在，跳过」，于是扩展名 bug 没修，
 * 桥接启动时直接 ERR_MODULE_NOT_FOUND —— 这是「别人装了跑不起来」的真实来源之一）。
 * 所以优先按 Node 自己的解析规则找，找不到再退回本地 node_modules。
 */
function locateDist(pkg) {
  const candidates = [];
  try {
    candidates.push(path.join(path.dirname(requireFromHere.resolve(`${pkg}/package.json`)), 'dist'));
  } catch { /* 没有导出 package.json 的子路径 */ }
  try {
    const entry = requireFromHere.resolve(pkg);
    const dir = path.dirname(entry);
    candidates.push(path.basename(dir) === 'dist' ? dir : path.join(dir, 'dist'));
  } catch { /* 解析不了就只看下面两个 */ }
  candidates.push(path.join(ROOT, 'node_modules', pkg, 'dist'));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let total = 0;
let failed = 0;
/**
 * 这是 postinstall 的**尽力修补**：单个文件读不了/写不了（权限、被占用、node_modules
 * 是别的包管理器接过来的软链）不应该让整次 `npm install` 失败 —— 那会让用户连
 * 「装依赖」都过不去，却看不出真正原因。所以逐文件 try/catch，最后用一句明确的警告收尾。
 */
for (const pkg of TARGETS) {
  const distRoot = locateDist(pkg);
  if (!distRoot) {
    console.log(`[patch-snowluma] ${pkg}: 找不到 dist（未安装或结构不同），跳过`);
    continue;
  }
  let patched = 0;
  let files;
  try {
    files = walk(distRoot);
  } catch (error) {
    console.log(`[patch-snowluma] ${pkg}: 列目录失败（${error?.code ?? error}），跳过`);
    continue;
  }
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (error) {
      failed += 1;
      console.log(`[patch-snowluma] ${pkg}: 读不了 ${path.relative(distRoot, file)}（${error?.code ?? error}），跳过`);
      continue;
    }
    const next = src.replace(/from\s+'(\.[^']+)'/g, (m, spec) => {
      if (spec.endsWith('.js') || spec.endsWith('.json')) return m;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target + '.js')) return m.replace(spec, spec + '.js');
      if (fs.existsSync(target + '.json')) return m.replace(spec, spec + '.json');
      return m;
    });
    if (next !== src) {
      try {
        fs.writeFileSync(file, next);
        patched += 1;
      } catch (error) {
        failed += 1;
        console.log(`[patch-snowluma] ${pkg}: 写不了 ${path.relative(distRoot, file)}（${error?.code ?? error}），跳过`);
      }
    }
  }
  console.log(`[patch-snowluma] ${pkg}: 修补了 ${patched} 个文件`);
  total += patched;
}
console.log(`[patch-snowluma] 合计 ${total} 个文件`);
if (failed) {
  // 不 exit 1：postinstall 失败会让 npm install 直接红掉，但这里的修补是"尽力而为"，
  // 而且真报错时用户也不知道该改什么。只把风险说清楚。
  console.log(`[patch-snowluma] ⚠️ ${failed} 个文件未能处理（上面有逐条原因）。`);
  console.log('[patch-snowluma] 若运行时出现 ERR_MODULE_NOT_FOUND（@snowluma/*），请手动重跑：node scripts/patch-snowluma-sdk.mjs');
}
