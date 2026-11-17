/**
 * qq-mode —— 只保留 QQ 桥接模式命名空间的 Config。
 *
 * 为什么合体后还要这一条 loader entry：
 *   QQ 桥接（<仓库路径>\src\bridge.js）通过 DSH settings 读写 `qq-mode`
 *   命名空间来切换 chat / closed-agent / reserved / reserved2。DSH 0.2.x 的命名空间
 *   由「loader entry id + 该 entry 的 Config」推导：
 *     ① entry id 必须精确等于 `qq-mode`   —— 见 cordis.patch.yml 的 `- id: qq-mode`
 *     ② 插件模块必须导出 `Config`          —— 本文件
 *     ③ Config 至少有一个带 volatile 的字段 —— mode / ownerQQ
 *
 * 所以它不是第二个用户插件，只是把旧 qq-mode-console 的 host 半并进来。
 * 设置窗口本身在 surfcore 的 client 半；这里不注册任何 UI。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// ⚠️ 工程坑（两段）：
//   ① 发布的 @deepseek-ai/schemastery 只有 lib/index.cjs，但 package.json 的 import
//      条件指向不存在的 lib/index.mjs；纯 ESM `import` 会直接 ERR_MODULE_NOT_FOUND。
//      旧 qq-mode-console 能跑是因为 DSH 的加载路径走了 require。
//   ② **不能把它声明进 dependencies**（2026-11-17 体检）：它是宿主（DSH profile）
//      自带的包。插件再声明一份，npm/pnpm 会把它提升进 profile 顶层 node_modules ——
//      「插件副本 vs 宿主副本谁生效」取决于安装顺序，宿主哪天升版本就是又一个
//      「装上插件 DSH 整体启动失败」（2026-11-16 的真事故就是这个机制：插件带进来的
//      旧 @deepseek-ai/dsh-* 盖掉了宿主 0.2.x）。所以 package.json 已不再声明它，
//      这里按「宿主 profile 优先、插件旧副本兜底」解析；两边都没有才报错。
const require = createRequire(import.meta.url);

function loadSchemasteryFrom(dir) {
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const main = String(pkg.main || '').trim();
  if (main) return require(path.join(dir, main));
  return require(dir);
}

function loadSchemastery() {
  const candidates = [];
  // ① 插件自己的副本：开发机/老 clone 的 node_modules 里可能还留着（向后兼容）。
  try { candidates.push(require.resolve('@deepseek-ai/schemastery')); } catch { /* 新依赖策略下常态 */ }
  // ② 宿主 profile：DSH 跑起来必然带着 schemastery（它是宿主设置服务的 schema 库）。
  //    web 与 desktop 两种 profile 都扫；DSH_HOME 允许自定义。
  for (const root of [process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.dsh-web')]) {
    const profilesDir = path.join(root, 'profiles');
    let names = [];
    try { names = fs.readdirSync(profilesDir); } catch { continue; }
    for (const name of names) {
      candidates.push(path.join(profilesDir, name, 'node_modules', '@deepseek-ai', 'schemastery'));
    }
    candidates.push(path.join(root, 'node_modules', '@deepseek-ai', 'schemastery'));
  }
  for (const candidate of candidates) {
    try {
      if (candidate.endsWith('.js') || candidate.endsWith('.cjs')) return require(candidate);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return loadSchemasteryFrom(candidate);
    } catch { /* 下一个候选 */ }
  }
  throw new Error(
    '找不到 @deepseek-ai/schemastery（宿主自带的 schema 库，插件按 2026-11 依赖策略不再自带）：'
    + '请确认 DSH 已安装并至少完整打开过一次（<DSH_HOME>/profiles/*/node_modules/@deepseek-ai/schemastery 应存在），'
    + '然后重启 DSH。',
  );
}

const z = loadSchemastery();

export const name = 'surfcore/qq-mode';
export const inject = ['settings'];

export const Config = z.object({
  mode: z.union([
    z.const('chat'),
    z.const('closed-agent'),
    z.const('reserved'),
    z.const('reserved2'),
    z.const('simulation'),
  ]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json').extra('volatile', true),
});

/** 0.2.x 下命名空间由 entry id + Config 推导，apply 不需要注册任何东西。 */
export function apply() {}
