/**
 * 宿主模块解析：优先用 DSH 宿主自带的包，插件**不再自带**（dependencies 声明）。
 *
 * 为什么（2026-11-16/17 两次真事故的同一机制）：
 *   插件 dependencies 里声明宿主也自带的包（@deepseek-ai/dsh-*、schemastery、
 *   playwright-core），安装时 npm/pnpm 会把插件那份提升进 profile 顶层 node_modules；
 *   与宿主自己的副本版本不满足同一条 semver 时就是版本冲突——谁生效取决于安装
 *   顺序，宿主核心（browser-use / settings 服务 / 浏览器栈）可能被旧副本盖掉，
 *   结果是「装上插件 DSH 整体启动失败」。所以宿主自带的包一律运行时解析：
 *     ① 插件自己的 node_modules（开发机 / 老 clone 残留，向后兼容）；
 *     ② DSH profile 的 node_modules（宿主真正在用的那份）；
 *     ③ DSH 根 node_modules 与 .dsh-web（双形态）；
 *     ④ DSH 自带运行时的 dependencies。
 *   找不到返回 null —— **调用方决定降级方式**，本模块不在模块加载期抛错。
 *
 * 危险名单由 scripts/install-simulation.mjs 强制：dependencies 不得出现宿主同款包。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 收集某个包名在宿主侧的全部候选目录（不校验存在性）。 */
export function hostModuleCandidates(name) {
  const out = [];
  const roots = [
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    path.join(os.homedir(), '.dsh-web'),
  ];
  for (const root of roots) {
    const profilesDir = path.join(root, 'profiles');
    let names = [];
    try { names = fs.readdirSync(profilesDir); } catch { names = []; }
    for (const profile of names) out.push(path.join(profilesDir, profile, 'node_modules', name));
    out.push(path.join(root, 'node_modules', name));
  }
  // DSH 自带运行时（bootstrap.ps1 引用的 dsh-primary-runtime/dependencies）。
  const runtimeRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes');
  try {
    for (const runtime of fs.readdirSync(runtimeRoot)) {
      out.push(path.join(runtimeRoot, runtime, 'dependencies', 'node_modules', name));
    }
  } catch { void 0; }
  return out;
}

/**
 * 解析并加载宿主侧的包。找不到返回 null（绝不抛错——导入期抛错会把整个插件
 * 半边带死，那是「装上插件用不了」的另一条通路）。
 * @param {string} name 包名（如 'playwright-core' / '@deepseek-ai/schemastery'）
 * @returns {unknown|null}
 */
export function resolveHostModule(name) {
  // ① 插件自己的副本（开发机 / 老 clone 残留）。
  try {
    const require = createRequire(import.meta.url);
    return require(name);
  } catch { /* 新依赖策略下的常态 */ }
  // ② 宿主候选目录逐个试。
  for (const dir of hostModuleCandidates(name)) {
    try {
      const pkgFile = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      // 以包目录为解析起点 require 包名：命中它自己的 main/exports。
      return createRequire(pkgFile)(name);
    } catch { /* 下一个候选 */ }
  }
  return null;
}
