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
import { hostModuleCandidates } from '../../src/host-module.mjs';

// ⚠️ 工程坑（两段）：
//   ① 发布的 @deepseek-ai/schemastery 只有 lib/index.cjs，但 package.json 的 import
//      条件指向不存在的 lib/index.mjs；纯 ESM `import` 会直接 ERR_MODULE_NOT_FOUND。
//      旧 qq-mode-console 能跑是因为 DSH 的加载路径走了 require。
//   ② **不能把它声明进 dependencies**（2026-11-17 体检）：它是宿主（DSH profile）
//      自带的包。插件再声明一份，npm/pnpm 会把它提升进 profile 顶层 node_modules ——
//      「插件副本 vs 宿主副本谁生效」取决于安装顺序，宿主哪天升版本就是又一个
//      「装上插件 DSH 整体启动失败」（2026-11-16 的真事故就是这个机制：插件带进来的
//      旧 @deepseek-ai/dsh-* 盖掉了宿主 0.2.x）。所以 package.json 已不再声明它，
//      解析走 src/host-module.mjs（插件旧副本 → 宿主 profile → DSH 运行时）。
//   ③ **导入期绝不抛错**：这一行是 cordis.patch.yml 的 loader entry，模块评估抛错
//      会让整条加载失败。找不到 schemastery 时 Config 导出 null（命名空间缺席 =
//      模式切换退回 config.json，DSH 本体照常跑），并把原因打到 stderr 排障。
const require = createRequire(import.meta.url);

function loadSchemastery() {
  // ① 插件自己的副本：开发机 / 老 clone 的 node_modules 里可能还留着（向后兼容）。
  try { return require('@deepseek-ai/schemastery'); } catch { /* 新依赖策略下常态 */ }
  // ② 宿主候选（profiles/*/node_modules、DSH 根、.dsh-web、dsh-runtimes）。
  for (const dir of hostModuleCandidates('@deepseek-ai/schemastery')) {
    try {
      const pkgFile = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const main = String(pkg.main || '').trim();
      if (main) return require(path.join(dir, main));
      return require(dir);
    } catch { /* 下一个候选 */ }
  }
  return null;
}

const z = loadSchemastery();
if (!z) {
  console.error('[qq-mode] 找不到 @deepseek-ai/schemastery（宿主自带的 schema 库，插件不再自带）：'
    + 'qq-mode 命名空间本次不注册，模式切换退回 config.json。请确认 DSH 已完整安装并至少打开过一次'
    + '（<DSH_HOME>/profiles/*/node_modules/@deepseek-ai/schemastery 应存在），然后重启 DSH。');
}

export const name = 'surfcore/qq-mode';
export const inject = ['settings'];

export const Config = z ? z.object({
  mode: z.union([
    z.const('chat'),
    z.const('closed-agent'),
    z.const('reserved'),
    z.const('reserved2'),
    z.const('simulation'),
  ]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json').extra('volatile', true),
}) : null;

/** 0.2.x 下命名空间由 entry id + Config 推导，apply 不需要注册任何东西。 */
export function apply() {}
