import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// 独立软件直接使用 playwright-core；原插件的 CLI/MCP 安装保留兼容入口。
//
// ⚠️ 2026-11-17 依赖策略：插件**不再自带** playwright-core（dependencies 已移除）。
// 它是 DSH 宿主自带的包（desktop 1.63-alpha / web 1.64-alpha，与插件钉的 ^1.65
// 互不满足），插件再声明一份会在安装时提升进 profile 顶层 node_modules 遮蔽宿主
// 浏览器栈——「装上插件 DSH 整体启动失败」事故的同机制。这里改为：
// 插件旧副本 → 宿主 profile → DSH 运行时 → @playwright/mcp 兜底；全都没有时
// **导出 null 且模块照常加载**——抖音浏览器功能在使用点给出可执行指引，
// 绝不在模块加载期抛错（否则 douyin.js → backend/lib/index.js 整条静态 import
// 链断掉，「插件装上直接用不了」）。
const require = createRequire(import.meta.url);

function hostCandidates(name) {
  const out = [];
  for (const root of [process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.dsh-web')]) {
    const profilesDir = path.join(root, 'profiles');
    let names = [];
    try { names = fs.readdirSync(profilesDir); } catch { names = []; }
    for (const profile of names) out.push(path.join(profilesDir, profile, 'node_modules', name));
    out.push(path.join(root, 'node_modules', name));
  }
  const runtimeRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes');
  try {
    for (const runtime of fs.readdirSync(runtimeRoot)) {
      out.push(path.join(runtimeRoot, runtime, 'dependencies', 'node_modules', name));
    }
  } catch { void 0; }
  return out;
}

function loadFromHost(name) {
  for (const dir of hostCandidates(name)) {
    try {
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
      return createRequire(path.join(dir, 'package.json'))(name);
    } catch { /* 下一个候选 */ }
  }
  return null;
}

let playwright = null;
try { playwright = require('playwright-core'); } catch { void 0; } // 开发机 / 老 clone 残留副本
if (!playwright?.chromium) playwright = loadFromHost('playwright-core');
if (!playwright?.chromium) playwright = loadFromHost('playwright'); // 宿主完整包同样暴露 chromium
if (!playwright?.chromium) {
  try { playwright = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright-core'); }
  catch { playwright = null; }
}

export const chromium = playwright?.chromium ?? null;

export function chromiumUnavailableReason() {
  return '浏览器引擎（playwright-core）没有找到：插件已不再自带（避免版本遮蔽 DSH 宿主导致整体启动失败），'
    + '会自动改用 DSH 宿主的副本。请确认 DSH 已完整安装并至少打开过一次（profiles/*/node_modules 里应有 playwright-core），'
    + '然后完全重启 DSH 再试。';
}
