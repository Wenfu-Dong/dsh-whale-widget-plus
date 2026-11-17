/**
 * 合并写调度器回归：固定滞后合并、写失败保留脏标记并有限重试、cancel 全清。
 *
 * 背景：写失败（Windows 上杀软/索引占用导致 rename 失败）过去只记日志并清掉
 * 脏标记，这批状态要等下一次 schedule() 才会再写 —— 停机前那一次 flush 失败
 * 等于永久丢数据。这里把「保留 pending + 有限重试」的语义钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCoalescingWriter } from '../src/save-scheduler.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('合并窗口内多次 schedule 只落盘一次', async () => {
  let writes = 0;
  const writer = createCoalescingWriter({
    write: () => { writes += 1; return true; },
    coalesceMs: 20,
    retryDelayMs: 5,
  });
  writer.schedule();
  writer.schedule();
  writer.schedule();
  await tick(60);
  assert.equal(writes, 1);
  assert.equal(writer.pending, false);
  assert.equal(writer.scheduled, false);
});

test('flush 写失败时保留脏标记，并按间隔重试直到成功', async () => {
  let attempts = 0;
  const logs = [];
  const writer = createCoalescingWriter({
    write: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('EBUSY');
      return true;
    },
    coalesceMs: 10,
    retryDelayMs: 5,
    log: (message) => logs.push(String(message)),
  });

  assert.equal(writer.flush(), false, '首次写失败应返回 false');
  assert.equal(writer.pending, true, '失败后必须保留脏标记');
  assert.ok(logs.some((line) => line.includes('重试')), '应记录重试计划');

  await tick(80);
  assert.equal(attempts, 3, '两次失败后第三次应成功');
  assert.equal(writer.pending, false);
  assert.equal(writer.stats().failureCount, 2);
});

test('重试次数用尽后仍保留脏标记，交给下一次 flush 落盘', async () => {
  let fail = true;
  let attempts = 0;
  const writer = createCoalescingWriter({
    write: () => {
      attempts += 1;
      if (fail) throw new Error('EPERM');
      return true;
    },
    coalesceMs: 10,
    retryDelayMs: 5,
  });

  assert.equal(writer.flush(), false);
  await tick(120);
  assert.equal(attempts, 4, '首次 + 3 次重试');
  assert.equal(writer.pending, true, '重试用尽后脏标记不能丢');

  fail = false;
  assert.equal(writer.flush(), true, '故障恢复后必须能落盘');
  assert.equal(writer.pending, false);
});

test('cancel 同时丢弃合并任务与重试定时器', async () => {
  let attempts = 0;
  const writer = createCoalescingWriter({
    write: () => { attempts += 1; throw new Error('EBUSY'); },
    coalesceMs: 10,
    retryDelayMs: 5,
  });

  writer.flush();
  assert.equal(writer.cancel(), true, '失败后 pending=true，cancel 应报告丢弃了脏数据');
  const before = attempts;
  await tick(80);
  assert.equal(attempts, before, 'cancel 后不能再有重试写入');
  assert.equal(writer.pending, false);
  assert.equal(writer.scheduled, false);
});
