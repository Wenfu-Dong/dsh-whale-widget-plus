/**
 * token 用量账本（组件化迁移 #7）。
 *
 * 从 src/bridge.js 的 main() 搬出只读/重置类接口：汇总、每日额度、时间序列、
 * 单会话回合、最近条目、重置。账本实例与价格表仍由 bridge 创建并注入，
 * 组件只负责读取与呈现。
 *
 * 安全：这些是管理信息（跨群花费），AI 通道一律拒绝，只有控制台令牌可用。
 */
import { defineComponent } from '../core/registry.js';
import { evaluateBudget } from '../../token-budget.js';
import { localDayStart } from '../../token-guard.js';

export function createTokenComponent(deps) {
  const { log, getLedger, dailyUsage, budgetLimits, priceSymbol } = deps || {};
  for (const [name, value] of Object.entries({ log, getLedger, dailyUsage, budgetLimits, priceSymbol })) {
    if (value === undefined || value === null) throw new TypeError(`tokens 缺少依赖：${name}`);
  }

  const routes = [
    {
      method: 'GET',
      path: '/api/tokens/summary',
      handle(ctx, { url, sendJson }) {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const ledger = getLedger();
        sendJson({ ...ledger.summary({ limit }), ledger: ledger.stats() });
      },
    },
    {
      method: 'GET',
      path: '/api/tokens/daily',
      handle(ctx, { sendJson }) {
        const usage = dailyUsage();
        const limits = budgetLimits();
        const qqGate = evaluateBudget(usage, limits, { scopes: ['qq', 'total'] });
        sendJson({ ok: true, usage, limits, gate: { blocked: qqGate.blocked, hits: qqGate.hits }, cutoff: localDayStart() });
      },
    },
    {
      method: 'GET',
      path: '/api/tokens/series',
      handle(ctx, { url, sendJson }) {
        const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
        const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
        sendJson(getLedger().series({ hours, maxBuckets }));
      },
    },
    {
      method: 'GET',
      path: '/api/tokens/turns',
      handle(ctx, { url, sendJson }) {
        const key = String(url.searchParams.get('key') ?? '').trim();
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const detail = getLedger().conversation(key, { turnLimit: limit });
        if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
        sendJson(detail);
      },
    },
    {
      method: 'GET',
      path: '/api/tokens/recent',
      handle(ctx, { url, sendJson }) {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        sendJson({ ok: true, symbol: priceSymbol(), entries: getLedger().recent(limit) });
      },
    },
    {
      method: 'POST',
      path: '/api/tokens/reset',
      handle(ctx, { sendJson }) {
        getLedger().reset();
        log('控制台：token 用量账本已重置');
        sendJson({ ok: true });
      },
    },
  ];

  return defineComponent({
    id: 'tokens',
    routes,
    init() {
      return { summary: (limit) => getLedger().summary({ limit }) };
    },
  });
}
