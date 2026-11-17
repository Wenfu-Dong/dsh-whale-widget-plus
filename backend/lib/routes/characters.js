/**
 * 角色人格路由（组件化迁移 #11）。
 *
 * GET  /characters      → 角色总览 / 单个角色详情
 * POST /characters      → create / load / update / snapshot / auto-snapshot /
 *                         restore / migrate / delete
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出。回档会短暂停掉
 * 桥接与生物钟，宿主通过回调注入这三个生命周期动作，模块不直接改宿主状态。
 */
export function createCharacterRoutes(deps) {
  const {
    characterDetail, characterOverview, getCharacterMigration,
    readCurrentCharacter, createCharacterFromPayload, switchCharacterEverywhere,
    updateCharacterFromPayload, manualSnapshot, autoSnapshot, restoreCharacterSnapshot,
    writeCharacterRolePointer, archiveBridgeRuntimeState, ensureCharacterSystem, deleteCharacter,
    bridgeStatus, memoryCardIdle, stopAllBridgeSessions, stopBridge, startBridge, currentDshUrl,
    runMemoryCardMaintenance,
    prepareSchedulerForRestore, resetSchedulerIdleForRestore, getSchedulerStatus, startSchedulerNow,
    readJsonBody, json, pluginLog,
  } = deps || {};

  const required = {
    characterDetail, characterOverview, getCharacterMigration,
    readCurrentCharacter, createCharacterFromPayload, switchCharacterEverywhere,
    updateCharacterFromPayload, manualSnapshot, autoSnapshot, restoreCharacterSnapshot,
    writeCharacterRolePointer, archiveBridgeRuntimeState, ensureCharacterSystem, deleteCharacter,
    bridgeStatus, memoryCardIdle, stopAllBridgeSessions, stopBridge, startBridge, currentDshUrl,
    runMemoryCardMaintenance,
    prepareSchedulerForRestore, resetSchedulerIdleForRestore, getSchedulerStatus, startSchedulerNow,
    readJsonBody, json, pluginLog,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`character-routes 缺少依赖：${name}`);
  }

  async function handleCharacters(req, res, url) {
    if (req.method === 'GET') {
      const id = String(url.searchParams.get('id') ?? '').trim();
      try {
        json(res, 200, id ? characterDetail(id) : { ...characterOverview(), migration: getCharacterMigration() });
      } catch (error) {
        json(res, 404, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    let body = {};
    try { body = await readJsonBody(req, 16 * 1024 * 1024); } catch { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
    const action = String(body.action ?? '');
    const id = String(body.id ?? readCurrentCharacter()?.id ?? '').trim();
    try {
      if (action === 'create') {
        const created = createCharacterFromPayload(body);
        if (body.load === true) {
          const switched = await switchCharacterEverywhere(created.character.id);
          json(res, 200, { ok: true, created, switched });
        } else {
          json(res, 200, created);
        }
        return;
      }
      if (action === 'load') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, await switchCharacterEverywhere(id));
        return;
      }
      if (action === 'update') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, updateCharacterFromPayload(id, body));
        return;
      }
      if (action === 'snapshot') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, manualSnapshot(id, { label: String(body.label ?? '') }));
        return;
      }
      if (action === 'auto-snapshot') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, autoSnapshot(id, { force: body.force === true }));
        return;
      }
      if (action === 'restore') {
        if (!id) throw new Error('缺少角色 id');
        const current = readCurrentCharacter();
        if (!current || current.id !== id) throw new Error('只能回档当前角色；先加载这个角色再回档');
        const skipPlatform = process.env.SURFCORE_DISABLE_PLATFORM_RESTART === '1';
        const wasRunning = skipPlatform ? false : (await bridgeStatus()).running;
        await memoryCardIdle();
        await prepareSchedulerForRestore(skipPlatform);
        resetSchedulerIdleForRestore();
        if (wasRunning) {
          await stopAllBridgeSessions();
          const stopped = await stopBridge();
          if (!stopped.ok) {
            if (!skipPlatform) startSchedulerNow();
            throw new Error(`回档失败：QQ 桥接没停下来（${stopped.error || stopped.message || '未知原因'}）`);
          }
        }
        const restored = restoreCharacterSnapshot(id, String(body.slot ?? ''));
        writeCharacterRolePointer();
        archiveBridgeRuntimeState();
        await runMemoryCardMaintenance({}).catch((error) => pluginLog('回档后整理记忆卡失败：', error?.message ?? error));
        if (wasRunning) await startBridge({ dshWebUrl: currentDshUrl() });
        if (!skipPlatform) startSchedulerNow();
        json(res, 200, { ...restored, bridgeRestarted: wasRunning, scheduler: getSchedulerStatus() });
        return;
      }
      if (action === 'migrate') {
        json(res, 200, ensureCharacterSystem());
        return;
      }
      if (action === 'delete') {
        if (!id) throw new Error('缺少角色 id');
        json(res, 200, deleteCharacter(id));
        return;
      }
      json(res, 400, { ok: false, error: `未知 action：${action}` });
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  }

  return { handleCharacters };
}
