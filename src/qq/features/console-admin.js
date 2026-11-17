/**
 * 控制台管理端点（组件化迁移 #13）：会话/挂起查看、白名单编辑、DSH 模型与
 * 思考强度、安全设置。
 *
 * 这些端点只改配置与读取运行时视图，不参与消息链路；`/api/mode` 仍留在 bridge
 * （要联动定时器、排队投递与会话策略），本轮不动。全局鉴权与只读降级由 bridge
 * 在分发前完成，本模块只做参数校验、写盘与内存热更新。
 *
 * handler 统一签名：`handle(req, res, url, sendJson, readBody)`，已处理返回 true。
 */

export function createConsoleAdminRoutes(deps) {
  const {
    log, getConfig, state, pending,
    CONFIG_FILE, readConfigObject, atomicWriteJson,
    normalizeOwnerQQ, normalizeAllowlist, getSelfUserId, reconcileSessionPolicies,
    fetchModelCatalog, withTimeout, unwrap,
    REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT,
    normalizeReasoningEffort, bumpModelSelectionEpoch,
    STATE_DIR, getStateDirHardened, rehardenStateDir, manualDirCommand,
  } = deps || {};
  for (const [name, value] of Object.entries({
    log, getConfig, state, pending,
    CONFIG_FILE, readConfigObject, atomicWriteJson,
    normalizeOwnerQQ, normalizeAllowlist, getSelfUserId, reconcileSessionPolicies,
    fetchModelCatalog, withTimeout, unwrap,
    REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT,
    normalizeReasoningEffort, bumpModelSelectionEpoch,
    STATE_DIR, getStateDirHardened, rehardenStateDir, manualDirCommand,
  })) {
    if (value === undefined || value === null) throw new TypeError(`console-admin 缺少依赖：${name}`);
  }

  // 模型目录在途请求去重：withTimeout 只做 Promise.race，不会取消底层 RPC，
  // 因此并发刷新会各自留下一个不可取消的请求。同一时刻只发一个。
  let modelCatalogInFlight = null;
  // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
  const modelCatalogErrorLogged = new Set();

  // ── 会话查看 ──────────────────────────────────────────────────────────────
  async function handleSessions(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/sessions')) return false;
    const cfg = getConfig();
    const list = [];
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
    }
    sendJson({ sessions: list });
    return true;
  }

  // ── 挂起审批 / 提问 ───────────────────────────────────────────────────────
  async function handlePending(req, res, url, sendJson) {
    if (!(req.method === 'GET' && url.pathname === '/api/pending')) return false;
    const list = [];
    for (const [key, p] of pending.entries()) {
      list.push({
        key,
        kind: p.kind,
        sessionId: p.sessionId,
        ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
        ...(p.kind === 'question' ? { questions: p.questions } : {})
      });
    }
    sendJson({ pending: list });
    return true;
  }

  // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────────
  async function handleWhitelist(req, res, url, sendJson, readBody) {
    const cfg = getConfig();
    if (req.method === 'GET' && url.pathname === '/api/whitelist') {
      sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { users: [], private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
      return true;
    }
    if (!(req.method === 'POST' && url.pathname === '/api/whitelist')) return false;
    const body = await readBody();
    const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
    // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
    const file = readConfigObject(CONFIG_FILE);
    const allow = {
      private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
      groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
    };
    const deny = {
      // 人的黑名单也要能在这个接口里保存；请求里没带 users 时**保留原值**而不是清空——
      // 旧控制台（public/console.html 的白名单表单）只提交 private/groups，
      // 直接覆盖会让「在设置页拉黑的人」被一次旧页面保存悄悄抹掉。
      users: toNum(body.deny?.users) ?? (file.deny?.users ?? []),
      private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
      groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
    };
    // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
    let ownerQQ = cfg.ownerQQ ?? null;
    if (body.ownerQQ !== undefined) {
      try {
        ownerQQ = normalizeOwnerQQ(body.ownerQQ);
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
        return true;
      }
    }
    // 归一化：去掉机器人自己、确保主人在私聊白名单里、去重（与启动自愈同一套规则）
    const normalized = normalizeAllowlist({ allow, ownerQQ, selfUserId: getSelfUserId() });
    allow.private = normalized.allow.private;
    allow.groups = normalized.allow.groups;
    file.allow = allow;
    file.deny = deny;
    file.ownerQQ = ownerQQ;
    atomicWriteJson(CONFIG_FILE, file);
    cfg.allow = { private: allow.private, groups: allow.groups };
    cfg.deny = { users: deny.users, private: deny.private, groups: deny.groups };
    cfg.ownerQQ = ownerQQ;
    reconcileSessionPolicies();
    log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，黑名单人: ${deny.users.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
    sendJson({ ok: true, allow, deny, ownerQQ, warnings: normalized.warnings });
    return true;
  }

  // ── DSH 模型与思考强度 ───────────────────────────────────────────────────
  async function handleDshModel(req, res, url, sendJson, readBody) {
    const cfg = getConfig();
    if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
      const provider = String(cfg.dsh?.provider || 'deepseek-official');
      const model = String(cfg.dsh?.model || 'deepseek-flash');
      // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
      let options = REASONING_EFFORT_OPTIONS.slice();
      let labels = {};
      let providerDefault = null;
      let catalogSource = 'fallback';
      try {
        if (!modelCatalogInFlight) {
          modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
            .finally(() => { modelCatalogInFlight = null; });
        }
        const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
        const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
        const entry = (group?.models ?? []).find((m) => m?.id === model);
        const efforts = entry?.reasoning?.efforts ?? [];
        const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
        if (advertised.length) {
          options = advertised;
          labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
          providerDefault = entry.reasoning.defaultEffort ?? null;
          catalogSource = 'dsh';
        }
      } catch (error) {
        const reason = String(error?.message ?? error);
        if (!modelCatalogErrorLogged.has(reason)) {
          modelCatalogErrorLogged.add(reason);
          log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
        }
      }
      sendJson({
        provider,
        model,
        reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
        options,
        labels,
        default: REASONING_EFFORT_DEFAULT,
        providerDefault,
        catalogSource,
        // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
        // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
        globalSideEffect: true,
      });
      return true;
    }
    if (!(req.method === 'POST' && url.pathname === '/api/dsh/effort')) return false;
    const body = await readBody();
    let effort;
    try { effort = normalizeReasoningEffort(body.reasoningEffort); }
    catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return true; }
    // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
    const file = readConfigObject(CONFIG_FILE);
    file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
    atomicWriteJson(CONFIG_FILE, file);
    cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
    // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
    bumpModelSelectionEpoch();
    log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
    sendJson({ ok: true, reasoningEffort: effort });
    return true;
  }

  // ── 安全拦截通知设置 ─────────────────────────────────────────────────────
  async function handleSecurity(req, res, url, sendJson, readBody) {
    const cfg = getConfig();
    if (req.method === 'GET' && url.pathname === '/api/security') {
      sendJson({
        security: cfg.security ?? { interceptNotify: true },
        // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
        // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
        // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
        // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
        stateDir: {
          hardened: getStateDirHardened(),
          path: STATE_DIR,
          manualCommand: process.platform === 'win32'
            ? manualDirCommand(STATE_DIR)
            : `chmod 700 "${STATE_DIR}"`
        }
      });
      return true;
    }
    if (!(req.method === 'POST' && url.pathname === '/api/security')) return false;
    const body = await readBody();
    // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
    if (body.rehardenStateDir === true) {
      const hardened = rehardenStateDir();
      sendJson({ ok: hardened === true, hardened, path: STATE_DIR });
      return true;
    }
    const file = readConfigObject(CONFIG_FILE);
    const next = { ...(file.security ?? {}), ...body };
    if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
    else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
    file.security = next;
    atomicWriteJson(CONFIG_FILE, file);
    cfg.security = { ...(cfg.security ?? {}), ...next };
    log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
    sendJson({ ok: true, security: cfg.security });
    return true;
  }

  async function dispatch(req, res, url, sendJson, readBody) {
    if (await handleSessions(req, res, url, sendJson, readBody)) return true;
    if (await handlePending(req, res, url, sendJson, readBody)) return true;
    if (await handleWhitelist(req, res, url, sendJson, readBody)) return true;
    if (await handleDshModel(req, res, url, sendJson, readBody)) return true;
    if (await handleSecurity(req, res, url, sendJson, readBody)) return true;
    return false;
  }

  return {
    handleSessions,
    handlePending,
    handleWhitelist,
    handleDshModel,
    handleSecurity,
    dispatch,
  };
}
