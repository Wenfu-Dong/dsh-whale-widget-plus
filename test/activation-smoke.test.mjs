// 插件激活冒烟回归：装完之后 apply() 能不能真的跑完。
//
// 2026-11-17 实测抓到的真实事故：把路由拆成工厂函数后，`createConfigRoutes({...})`
// 的注入参数里读了后面才用 const 声明的 `startSyncTimer`，触发 TDZ
// （Cannot access 'startSyncTimer' before initialization）。整个 surfcore apply 被
// lib/index.js 的 try/catch 吞掉 —— 表现就是「插件装好了、设置页也在，但 QQ 完全不工作」。
// 纯函数单测永远碰不到这种顺序问题，必须真跑一次激活。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts', 'lib', 'activation-smoke.mjs');

// full = 当前 DSH 服务齐全；legacy = 老版本缺 credentials/connection/tapIndex 等。
for (const profile of ['full', 'legacy']) {
  test(`插件激活冒烟（${profile}）`, () => {
    const result = spawnSync(process.execPath, [RUNNER, ROOT, profile], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
