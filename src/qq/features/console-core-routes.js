/**
 * 控制台核心端点（组件化迁移 #14）：运行状态 / 模式切换 / 访问令牌 / 审计读取。
 *
 * 这四个端点原先写在 src/bridge.js 的 startConsoleServer 里，是控制台最基础的一层：
 *   · GET  /api/owner-audit   —— 管理员操作审计尾部 + 健康度
 *   · GET  /api/status        —— 运行状态（智能体调用只给受限字段）
 *   · POST /api/mode          —— 模式切换（本地落盘 + 写穿 DSH 设置 + 定时器重建）
 *   · POST /api/console/token —— 手动修改/随机生成控制台访问令牌
 *
 * 全局鉴权（控制台令牌 / Host 校验 / agent token 分层 / CSRF）仍由 bridge 在调用本
 * 模块**之前**完成；这里只接收已经过闸门的请求，做参数校验与业务动作。
 *
 * 会变化的运行时变量（currentMode / closedAgentPreset / consoleToken）通过 getter/setter
 * 注入，模块内不持有副本；缺少任何依赖直接抛 TypeError。
 *
 * handler 统一签名：`handle(req, res, url, sendJson, readBody)`，已处理返回 true。
 */

export function createConsoleCoreRoutes(deps) {
  const {
    log, getConfig, getMode, setMode, getClosedAgentPreset, setClosedAgentPreset,
    getConsoleToken, setConsoleToken,
    VALID_MODES, normalizeModeInput, readJsonSafe, atomicWriteJson, atomicWriteText,
    CONFIG_FILE, STATE_DIR, MODE_FILE, CONSOLE_TOKEN_FILE, readConfigObject, crypto,
    readRoleState, getDshReady, ROOT, ownerAudit, purpose,
    closureConfigV2, assessClosureV2, getSocialV2State, closureStatus,
    snowlumaHealthSnapshot, readActivityTail, socialV2,
    api, unwrap, cleanupSocialForModeChange, clearAllSocialV2Timers,
    drainAllPromptQueues, reconcileSessionPolicies, setupSleepTimerV2, scheduleProactiveCheckV2,
  } = deps || {};
  for (const [name, value] of Object.entries({
    log, getConfig, getMode, setMode, getClosedAgentPreset, setClosedAgentPreset,
    getConsoleToken, setConsoleToken,
    VALID_MODES, normalizeModeInput, readJsonSafe, atomicWriteJson, atomicWriteText,
    CONFIG_FILE, STATE_DIR, MODE_FILE, CONSOLE_TOKEN_FILE, readConfigObject, crypto,
    readRoleState, getDshReady, ROOT, ownerAudit, purpose,
    closureConfigV2, assessClosureV2, getSocialV2State, closureStatus,
    snowlumaHealthSnapshot, readActivityTail, socialV2,
    api, unwrap, cleanupSocialForModeChange, clearAllSocialV2Timers,
    drainAllPromptQueues, reconcileSessionPolicies, setupSleepTimerV2, scheduleProactiveCheckV2,
  })) {
    if (value === undefined || value === null) throw new TypeError(`console-core-routes 缺少依赖：${name}`);
  }

  // ── 管理员操作审计尾部 ──────────────────────────────────────────────────
  function handleOwnerAudit(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/owner-audit')) return false;
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    sendJson({ ok: true, entries: ownerAudit.readTail(limit), health: ownerAudit.health, path: ownerAudit.path });
    return true;
  }

  // ── 运行状态 ────────────────────────────────────────────────────────────
  function handleStatus(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/status')) return false;
    const cfg = getConfig();
    const rs = readRoleState();
    // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
    // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
    // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
    // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
    // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
    // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
    // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
    if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
      sendJson({
        mode: getMode(),
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: getDshReady(),
        socialV2Paused: socialV2.paused,
      });
      return true;
    }
    sendJson({
      mode: getMode(),
      root: ROOT,
      dshBaseUrl: cfg.dsh.baseUrl,
      closedAgentPreset: getClosedAgentPreset(),
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: getDshReady(),
      ownerQQ: cfg.ownerQQ ?? null,
      ownerAudit: ownerAudit.health,
      allowGroups: cfg.allow?.groups ?? [],
      allowPrivate: cfg.allow?.private ?? [],
      socialV2Paused: socialV2.paused,
      purpose: {
        enabled: cfg.purpose?.enabled !== false,
        ...purpose.summarize(),
      },
      // 对话收尾：给设置页卡片看「最近一次收在哪 / 下次怎么接 / 当前判断」。
      // 只放管理端状态（含会话 key），不进 agent 的受限视图。
      closure: (() => {
        const config = closureConfigV2();
        let latest = null;
        for (const [key, st] of socialV2.conversations) {
          if (!st?.closure?.at) continue;
          if (!latest || Number(st.closure.at) > Number(latest.record.at)) {
            latest = { key, record: st.closure };
          }
        }
        const assessment = latest ? assessClosureV2(latest.key, getSocialV2State(latest.key)) : null;
        return {
          enabled: config.enabled,
          config,
          active: latest ? {
            key: latest.key,
            ...closureStatus(latest.record, Date.now()),
            verdict: assessment?.verdict ?? null,
            score: assessment?.score ?? null,
            reasons: assessment?.reasons ?? [],
          } : null,
          recentlyClosed: [...socialV2.conversations.entries()]
            .filter(([, st]) => st?.closure?.at)
            .sort((a, b) => Number(b[1].closure.at) - Number(a[1].closure.at))
            .slice(0, 3)
            .map(([key, st]) => ({ key, ...closureStatus(st.closure, Date.now()) })),
        };
      })(),
      // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
      // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
      snowluma: snowlumaHealthSnapshot(),
      activity: readActivityTail(100)
    });
    return true;
  }

  // ── 模式切换 ────────────────────────────────────────────────────────────
  async function handleMode(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/mode')) return false;
    const body = await readBody();
    // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
    const requestedMode = normalizeModeInput(body.mode);
    if (!requestedMode) {
      sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
      return true;
    }
    const existing = readJsonSafe(MODE_FILE, {});
    const next = {
      mode: requestedMode,
      // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
      ...(body.closedAgentPreset !== undefined
        ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
        : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
    };
    atomicWriteJson(MODE_FILE, next);
    // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
    setClosedAgentPreset(next.closedAgentPreset);
    // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
    // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
    // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
    // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
    const prevMode = getMode();
    let dshSynced = false;
    try {
      // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
      // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
      unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
      dshSynced = true;
    } catch (error) {
      log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
    }
    // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
    // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
    if (prevMode === 'reserved' && requestedMode !== 'reserved') {
      cleanupSocialForModeChange();
      log('控制台：模式离开一代仿真模式，清理社交状态');
    }
    if (prevMode === 'reserved2' && requestedMode !== 'reserved2') {
      clearAllSocialV2Timers();
      drainAllPromptQueues('模式切换，已取消排队中的投递');
      log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
    }
    setMode(requestedMode);
    reconcileSessionPolicies();
    if (requestedMode === 'reserved2') {
      for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2(key);
        scheduleProactiveCheckV2(key);
      }
      log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
    }
    log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
    sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
    return true;
  }

  // ── 控制台访问令牌（可手动修改/生成随机） ────────────────────────────────
  async function handleConsoleToken(req, res, url, sendJson, readBody) {
    if (!(req.method === 'POST' && url.pathname === '/api/console/token')) return false;
    const body = await readBody();
    let newToken = String(body.token ?? '').trim();
    const generated = !newToken;
    if (generated) {
      newToken = crypto.randomBytes(24).toString('hex');
    }
    if (newToken.length < 16) {
      sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
      return true;
    }
    if (newToken.length > 128) {
      sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
      return true;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
      sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
      return true;
    }
    const file = readConfigObject(CONFIG_FILE);
    // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
    file.consoleToken = generated ? '' : newToken;
    atomicWriteJson(CONFIG_FILE, file);
    getConfig().consoleToken = generated ? '' : newToken;
    atomicWriteText(CONSOLE_TOKEN_FILE, newToken);
    setConsoleToken(newToken);
    log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
    sendJson({ ok: true, token: newToken, generated });
    return true;
  }

  async function dispatch(req, res, url, sendJson, readBody) {
    if (handleOwnerAudit(req, res, url, sendJson)) return true;
    if (handleStatus(req, res, url, sendJson)) return true;
    if (await handleMode(req, res, url, sendJson, readBody)) return true;
    if (await handleConsoleToken(req, res, url, sendJson, readBody)) return true;
    return false;
  }

  return { handleOwnerAudit, handleStatus, handleMode, handleConsoleToken, dispatch };
}
