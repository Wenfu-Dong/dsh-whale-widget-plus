/**
 * 桌宠 / 目的路由（组件化迁移 #11）。
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出：
 *   · /pet/*        桌宠载体状态、专注模式、测一句话、演示气泡
 *   · /purpose/*    「目的」机制：按当前载体路由到 QQ 桥接或桌宠
 *
 * 依赖全部显式注入；路由分发仍留在 index.js。
 */
export function createPetPurposeRoutes(deps) {
  const {
    API_PREFIX, readQqConfig, readJsonBody, json,
    petService, petChat, petPurpose, bridgeStatus, callBridge,
  } = deps || {};

  const required = {
    API_PREFIX, readQqConfig, readJsonBody, json,
    petService, petChat, petPurpose, bridgeStatus, callBridge,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`pet-purpose-routes 缺少依赖：${name}`);
  }

  // 设置页「测一句话」：同样要弹到桌宠气泡（docs/PET.md）；/pet/chat-test 和 /purpose/pet-chat 共用。
  async function petChatTest(body = {}) {
    const result = await petChat.chat({ text: body.text || '在吗', modality: body.modality === 'voice' ? 'voice' : 'text' });
    if (result.ok && result.reply) {
      petChat.emit({
        type: 'reply',
        text: String(result.reply.text ?? ''),
        modality: result.reply.modality === 'voice' ? 'voice' : 'text',
        speak: result.reply.modality === 'voice',
        audioKey: result.reply.audioKey || '',
        messageId: result.reply.id || '',
      });
    }
    return result;
  }

  // 桌宠载体状态：只读（小鲸鱼插件是否已装/在用）。Electron 安装、启动、卸载接口已下线
  // （pet.js 只剩 status）；但「专注模式」「测试一句话」仍是设置页在用接口，照 docs/PET.md 保留。
  async function handlePet(req, res, url) {
    const suffix = url.pathname.slice(`${API_PREFIX}/pet`.length) || '/status';
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' && suffix === '/status') { json(res, 200, petService.status()); return; }
    if (method === 'POST' && suffix === '/focus') {
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      json(res, 200, { ok: true, ...petChat.setFocus(body.enabled === true, 'settings') });
      return;
    }
    if (method === 'POST' && suffix === '/chat-test') {
      let body = {};
      try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      json(res, 200, await petChatTest(body));
      return;
    }
    // 演示气泡：不生成模型回复，只推一条假事件，用来验证「插件 → 挂件 → 气泡」这条路。
    // 会顺带告诉前端挂件此刻是否在轮询（widgetOnline），排查时不用靠猜。
    if (method === 'POST' && suffix === '/bubble-demo') {
      const modality = String(readQqConfig().config?.purpose?.petModality ?? 'text') === 'voice' ? 'voice' : 'text';
      const text = '演示：气泡链路正常，能弹出这条就说明 QQ 回复也会这样弹出来。';
      const eventId = petChat.emit({
        type: 'reply',
        text,
        modality,
        speak: modality === 'voice',
        demo: true,
        messageId: 'demo',
      });
      const presence = petChat.status().presence ?? {};
      json(res, 200, {
        ok: true,
        eventId,
        widgetOnline: presence.online === true,
        speak: modality === 'voice',
        message: presence.online === true
          ? `已推送到气泡（${modality === 'voice' ? "会朗读" : "纯文字"}）`
          : '已推送，但挂件没在轮询：桌面气泡收不到（检查小鲸鱼挂件页面是否开着）',
        hint: presence.online === true ? '' : '挂件没在线时不会弹气泡；重开 DSH 并确保小鲸鱼挂件页面开着',
      });
      return;
    }
    json(res, 404, { ok: false, error: `桌宠安装/启动接口已下线：${suffix}` });
  }

  // ── 目的机制（设置页「目的」）：按当前载体路由到 Bridge 或桌宠 ─────────────
  async function purposeAvailability() {
    const petStatus = petService.status();
    const online = petChat.online();
    const external = petStatus.external ?? {};
    let bridge = null;
    try { bridge = await bridgeStatus(); } catch (error) { bridge = { ok: false, running: false, error: String(error?.message ?? error) }; }
    return {
      pet: {
        // 用户实际装的是 dsh-Dfy 挂件时，它就算「已装/在用」，
        // 不能因为没装 Electron 桌宠就一直显示「未安装」。
        installed: Boolean(petStatus.installed || external.installed),
        running: Boolean(petStatus.running || external.active),
        online: Boolean(online.online || external.active),
        external: {
          kind: String(external.kind || ''),
          name: String(external.name || ''),
          version: String(external.version || ''),
          active: external.active === true,
        },
        lastPollAt: online.lastSeenAt || 0,
        roleName: petChat.roleInfo().name,
      },
      qq: {
        running: Boolean(bridge?.running),
        mode: bridge?.mode || bridge?.status?.mode || null,
        ok: bridge?.ok !== false,
        error: bridge?.error || '',
      },
    };
  }

  async function handlePurpose(req, res, url) {
    const suffix = url.pathname.slice(`${API_PREFIX}/purpose`.length) || '/status';
    const method = String(req.method || 'GET').toUpperCase();
    const carrier = readQqConfig().config?.purpose?.carrier === 'pet' ? 'pet' : 'qq';
    const availability = await purposeAvailability();
    try {
      if (suffix === '/status' && method === 'GET') {
        if (carrier === 'pet') {
          const st = petPurpose.status();
          json(res, 200, {
            ok: true,
            source: 'pet',
            carrier: 'pet',
            availability,
            enabled: st.enabled,
            modality: st.modality,
            fallbackToQQ: st.fallbackToQQ,
            ownerUin: st.ownerUin,
            ownerName: st.ownerName,
            focus: st.focus,
            config: st.config,
            state: st.state,
            online: st.online,
            lastTickAt: st.lastTickAt,
            lastError: st.lastError,
            lastFallback: st.lastFallback,
          });
          return;
        }
        if (!availability.qq.running) {
          json(res, 200, {
            ok: false,
            source: 'qq',
            carrier: 'qq',
            availability,
            focus: petChat.focusEnabled(),
            error: 'QQ 桥接没在运行：先在「QQ」页启动，或者把载体切到桌宠',
            config: readQqConfig().config?.purpose ?? {},
            state: null,
          });
          return;
        }
        const remote = await callBridge('/api/purpose/status', { timeoutMs: 8000 });
        const data = remote?.data ?? {};
        json(res, remote?.status || 200, {
          ...data,
          source: 'qq',
          carrier: 'qq',
          availability,
          focus: petChat.focusEnabled(),
          ok: data.ok !== false,
          error: data.ok === false ? (data.error || '读取目的状态失败') : '',
        });
        return;
      }
      if (suffix === '/preview' && method === 'POST') {
        if (carrier === 'pet') {
          const result = await petPurpose.preview();
          json(res, result.ok ? 200 : 400, { ...result, source: 'pet', carrier: 'pet', availability });
          return;
        }
        if (!availability.qq.running) {
          json(res, 409, { ok: false, error: 'QQ 桥接没在运行，无法预览 QQ 载体的目的回合', availability });
          return;
        }
        const remote = await callBridge('/api/purpose/preview', { method: 'POST', body: {}, timeoutMs: 20000 });
        json(res, remote?.status || 200, { ...(remote?.data ?? {}), source: 'qq', carrier: 'qq', availability });
        return;
      }
      if (suffix === '/run' && method === 'POST') {
        const body = await readJsonBody(req);
        if (carrier === 'pet') {
          const result = await petPurpose.run({ force: body.force !== false });
          json(res, result.ok ? 200 : 409, { ...result, source: 'pet', carrier: 'pet', availability });
          return;
        }
        if (!availability.qq.running) {
          json(res, 409, { ok: false, error: 'QQ 桥接没在运行，无法让 QQ 载体出发', availability });
          return;
        }
        const remote = await callBridge('/api/purpose/run', { method: 'POST', body: { force: body.force !== false }, timeoutMs: 30000 });
        json(res, remote?.status || 200, { ...(remote?.data ?? {}), source: 'qq', carrier: 'qq', availability });
        return;
      }
      if (suffix === '/pet-chat' && method === 'POST') {
        // 设置页测一句话（不占主动搭话额度），回复同时弹到桌宠气泡。
        const body = await readJsonBody(req);
        const result = await petChatTest(body);
        json(res, result.ok ? 200 : 400, result);
        return;
      }
      json(res, 404, { ok: false, error: `未知目的接口：${suffix}` });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  return { handlePet, handlePurpose, petChatTest };
}
