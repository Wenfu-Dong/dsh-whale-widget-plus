/**
 * 人格 / 预设管理（组件化迁移 #8）。
 *
 * 从 src/bridge.js 的 main() 搬出控制台接口：
 *   - /api/role、/api/role-mode：当前人格与静默模式；
 *   - /api/roles*：列表、正文、注入上限、创建、更新、重命名、删除（移入回收站）；
 *   - /api/presets：DSH 预设清单（具体列举由 bridge 注入）；
 *   - /api/preset/sim-prompt*：仿真提示词的读取、保存、备份与还原。
 *
 * 文件读写与校验规则都在 src/qq/roles.js，这里只负责 HTTP 形状与控制台语义。
 * 模式切换（/api/mode）仍留在 bridge：它要联动定时器、排队投递与会话策略。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineComponent } from '../core/registry.js';
import { atomicWriteJson, atomicWriteText, readConfigObject } from '../json-io.js';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from '../../preset-prompt.js';
import { roleCharStats, roleSectionReport } from '../../role-card.js';

export function createRoleConsoleComponent(deps) {
  const {
    roles, log, configFile, getConfig, stateDir,
    getRoleInjectMaxChars, setRoleInjectMaxChars, listPresets,
  } = deps || {};
  for (const [name, value] of Object.entries({
    roles, log, configFile, getConfig, stateDir,
    getRoleInjectMaxChars, setRoleInjectMaxChars, listPresets,
  })) {
    if (value === undefined || value === null) throw new TypeError(`role-console 缺少依赖：${name}`);
  }
  const {
    roleFilePath, readRoleContent, writeRoleContent, validateRoleName, validateRoleContent,
    applyRoleInjectLimit, roleSummaries, roleWarnings, readRoleState, writeRoleState, sanitizeRoleName,
    ROLE_NAME_MAX, ROLE_CONTENT_MAX_BYTES,
    knownPresetName, readPresetPromptText, presetStatus, PRESET_NAMES,
    backupPresetFile, listPresetBackups, presetSourceYaml, installedPresetYaml, PRESET_BACKUP_DIR,
  } = roles;

  const routes = [
    {
      method: 'GET',
      path: '/api/presets',
      async handle(ctx, { sendJson }) {
        let presets = [];
        try { presets = await listPresets(); } catch {}
        sendJson({ presets });
      },
    },
    {
      method: 'POST',
      path: '/api/role',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const rs = readRoleState();
        if (body.role && typeof body.role === 'string') {
          const name = sanitizeRoleName(body.role);
          if (!fs.existsSync(roleFilePath(name))) {
            sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
            return;
          }
          writeRoleState(name, rs.mode);
          log(`控制台：角色已设置为 ${name}`);
          sendJson({ ok: true, role: name });
        } else {
          writeRoleState(null, rs.mode);
          log('控制台：角色已清除');
          sendJson({ ok: true, role: null });
        }
      },
    },
    {
      method: 'POST',
      path: '/api/role-mode',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const rs = readRoleState();
        const mode = body.mode === 'silent' ? 'silent' : 'active';
        writeRoleState(rs.role, mode);
        log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
        sendJson({ ok: true, roleMode: mode });
      },
    },
    {
      method: 'GET',
      path: '/api/roles',
      handle(ctx, { sendJson }) {
        const rs = readRoleState();
        const summaries = roleSummaries();
        sendJson({
          // roles 保持「人格名字符串数组」的既有契约（脚本调用方依赖它）。
          roles: summaries.map((role) => role.name),
          summaries,
          current: rs.role ?? null,
          limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: getRoleInjectMaxChars() },
        });
      },
    },
    {
      method: 'GET',
      path: '/api/roles/content',
      handle(ctx, { url, sendJson }) {
        let name;
        try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        const content = readRoleContent(name);
        sendJson({
          ok: true,
          name,
          content,
          chars: content.length,
          bytes: Buffer.byteLength(content, 'utf8'),
          warnings: roleWarnings(content),
          limits: { injectMaxChars: getRoleInjectMaxChars() },
          stats: roleCharStats(content),
          // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
          sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
        });
      },
    },
    {
      method: 'POST',
      path: '/api/roles/limit',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const next = applyRoleInjectLimit(body.maxInjectChars);
        const file = readConfigObject(configFile);
        file.role = { ...(file.role ?? {}), maxInjectChars: next };
        atomicWriteJson(configFile, file);
        const cfg = getConfig();
        cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
        setRoleInjectMaxChars(next);
        log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
        sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
      },
    },
    {
      method: 'POST',
      path: '/api/roles/create',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        let name; let content;
        try { name = validateRoleName(body.name); content = validateRoleContent(body.content); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
        writeRoleContent(name, content);
        log(`控制台：创建人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
      },
    },
    {
      method: 'POST',
      path: '/api/roles/update',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        let name; let content;
        try { name = validateRoleName(body.name); content = validateRoleContent(body.content); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        writeRoleContent(name, content);
        log(`控制台：更新人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
      },
    },
    {
      method: 'POST',
      path: '/api/roles/rename',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        let from; let to;
        try { from = validateRoleName(body.from); to = validateRoleName(body.to); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
        if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
        if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
        fs.renameSync(roleFilePath(from), roleFilePath(to));
        const rs = readRoleState();
        const switched = rs.role === from;
        if (switched) writeRoleState(to, rs.mode);
        log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
        sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      },
    },
    {
      method: 'POST',
      path: '/api/roles/delete',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        let name;
        try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        // 删改必隔离：人格卡是用户手写的唯一副本，直接 rm 不可逆。
        // 移进 state/role-trash/ 而不是删除；控制台/文件管理器都能找回。
        const trashDir = path.join(stateDir, 'role-trash');
        fs.mkdirSync(trashDir, { recursive: true });
        const trash = path.join(trashDir, `${name}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
        fs.renameSync(roleFilePath(name), trash);
        const rs = readRoleState();
        const cleared = rs.role === name;
        if (cleared) writeRoleState(null, rs.mode);
        log(`控制台：删除人格「${name}」（已移到回收站 ${trash}）${cleared ? '，已同时清除当前人格' : ''}`);
        sendJson({ ok: true, deleted: name, clearedCurrent: cleared, trash });
      },
    },
    {
      method: 'GET',
      path: '/api/preset/sim-prompt',
      handle(ctx, { url, sendJson }) {
        const preset = knownPresetName(url.searchParams.get('preset'));
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          const { prefix } = readPresetPromptText(preset);
          sendJson({
            ok: true,
            content: prefix,
            chars: prefix.length,
            bytes: Buffer.byteLength(prefix, 'utf8'),
            warnings: presetPromptWarnings(prefix),
            status: presetStatus(preset),
            presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
          });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/preset/sim-prompt',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const preset = knownPresetName(body.preset);
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        let nextText;
        try {
          const { text, prefix } = readPresetPromptText(preset);
          // 内容没变就不要写：写回会把折叠块规整成字面量块，失去可复审性。
          const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
          if (normalized === prefix) {
            sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
            return;
          }
          nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
          return;
        }
        const warnings = presetPromptWarnings(body.content);
        let sourceBackup = null;
        try {
          sourceBackup = backupPresetFile(preset);
          atomicWriteText(presetSourceYaml(preset), nextText);
          // 安装副本不做仓库内备份（内容与刚写好的源文件一致）。
          const installed = installedPresetYaml(preset);
          if (fs.existsSync(installed)) {
            fs.copyFileSync(presetSourceYaml(preset), installed);
          }
        } catch (error) {
          if (sourceBackup && fs.existsSync(sourceBackup)) {
            try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
          }
          sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
          return;
        }
        log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
        sendJson({
          ok: true,
          chars: String(body.content ?? '').length,
          warnings,
          synced: fs.existsSync(installedPresetYaml(preset)),
          requiresRestart: true,
          status: presetStatus(preset),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/preset/sim-prompt/backups',
      handle(ctx, { url, sendJson }) {
        const preset = knownPresetName(url.searchParams.get('preset'));
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          sendJson({ ok: true, backups: listPresetBackups(preset) });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/preset/sim-prompt/restore',
      async handle(ctx, { readBody, sendJson }) {
        const body = await readBody();
        const preset = knownPresetName(body.preset);
        if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
        try {
          const requested = String(body.file ?? '').trim();
          const candidates = listPresetBackups(preset).map((b) => b.file);
          const target = requested || candidates[0];
          // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
          if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
          const backupPath = path.join(PRESET_BACKUP_DIR, target);
          const restored = fs.readFileSync(backupPath, 'utf8');
          const restoredPrefix = extractPresetPrefix(restored);
          if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
          // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前。
          const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.v1 ? 'v1' : 'v2');
          if (blockers.length) {
            sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
            return;
          }
          backupPresetFile(preset);
          atomicWriteText(presetSourceYaml(preset), restored);
          const installed = installedPresetYaml(preset);
          if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
          log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
          sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
        }
      },
    },
  ];

  return defineComponent({ id: 'role-console', routes });
}
