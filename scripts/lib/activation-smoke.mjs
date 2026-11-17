#!/usr/bin/env node
/**
 * 插件激活冒烟（独立子进程）。
 *
 * 用法：node scripts/lib/activation-smoke.mjs <包根> [full|legacy]
 *
 * 为什么必须独立子进程：
 *   · 激活会启动定时器、写 $DSH_HOME、注册大量路由；放进测试进程会污染其它用例；
 *   · 「插件把宿主搞崩」的形态通常是进程级副作用（unhandledRejection / 强杀进程），
 *     只有在独立进程里才能安全复现并隔离。
 *
 * 退出码 0 = 激活过程没有异常；1 = 有异常（stderr 里给出摘要）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStubHost } from './dsh-host-stub.mjs';

const target = path.resolve(process.argv[2] ?? '');
const profile = process.argv[3] === 'legacy' ? 'legacy' : 'full';

if (!fs.existsSync(path.join(target, 'lib', 'index.js'))) {
  console.error(`[activation-smoke] 找不到 ${path.join(target, 'lib', 'index.js')}`);
  process.exit(1);
}

// 激活写盘一律落到临时 DSH_HOME，绝不碰用户真实配置。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdfy-activation-'));
process.env.DSH_HOME = tmpHome;
process.env.SURFCORE_EMBEDDED = '1';
// 避免激活后真的去拉起 SnowLuma / 桥接（安装模拟环境里没有它们）。
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.DSH_VERSION = process.env.DSH_VERSION || '0.0.0-smoke';

const problems = [];
const FATAL = /apply failed|启动失败|激活失败|TypeError|ReferenceError|SyntaxError|is not a function|Cannot read/;
const originalError = console.error;
console.error = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  if (FATAL.test(line)) problems.push(line.slice(0, 400));
  originalError(...args);
};

process.on('unhandledRejection', (reason) => {
  problems.push(`unhandledRejection: ${reason?.stack ?? reason}`);
});

try {
  const mod = await import(pathToFileURL(path.join(target, 'lib', 'index.js')).href);
  if (typeof mod.apply !== 'function') throw new Error('lib/index.js 没有导出 apply');
  const host = createStubHost({
    profile,
    onError: (error) => problems.push(`宿主桩回调异常: ${error?.stack ?? error}`),
  });
  await mod.apply(host.ctx, {});
  // 给启动后的异步任务（定时器 / 自愈巡检）一点时间暴露异常。
  await new Promise((resolve) => setTimeout(resolve, 800));
} catch (error) {
  problems.push(`apply 抛异常: ${error?.stack ?? error}`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}

if (problems.length) {
  console.log(`[activation-smoke:${profile}] ✗ ${problems.length} 个问题`);
  for (const problem of problems.slice(0, 12)) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log(`[activation-smoke:${profile}] ✓ 激活通过（${target}）`);
process.exit(0);
