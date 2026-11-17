// 真机 DSH 兼容性只读探测。
//
// 目的：DSH 升级后「插件还能不能用」最大的不确定性在于协议细节 —— 鉴权换票方式、
// settings / agentPresets / modelCatalog 这几个桥接启动即调的 RPC 是否还在。
// 把它们在**不改任何数据**的前提下打一遍，能在升级后第一时间区分：
//   · DSH 没起来（退出码 2，跳过，不是失败）
//   · DSH 起来了但插件鉴权不上（退出码 1，需要处理）
//   · 协议兼容（退出码 0）
//
// 只读承诺：只调用 settings.describe / agentPresets.list / session/modelCatalog，
// 不发 prompt、不建会话、不改设置、不动文件。SnowLuma 侧的只读检查用
// `node scripts/check-onebot-status.mjs`（它会连一次 WS 并读登录信息）。
//
// 目标选择：环境变量 → 数据根 config.json 的 dsh.baseUrl → 127.0.0.1:3100 → 端口发现。
// 候选逐个尝试鉴权，取**第一个真能拿到 settings.describe 结果**的（本机可能同时开着
// 模型网关/插件控制台，它们也会对 / 回 401，只看 401 会认错对象）。
//
// 用法：
//   node scripts/verify-real-dsh.mjs
//   DSH_BASE_URL=http://127.0.0.1:64271 node scripts/verify-real-dsh.mjs
//   DSH_LAUNCH_TOKEN=xxx node scripts/verify-real-dsh.mjs
import {
  NodeApiClient, unwrap, discoverDshLaunchToken,
} from '../src/dsh-client.js';
import { discoverDshBaseUrl, listDshCandidatePorts, probeDshBaseUrl } from '../src/dsh-port.js';
import { effectiveQqConfigFile } from '../src/config-locate.js';
import { readConfigObject } from '../src/qq/json-io.js';

function configuredBaseUrl() {
  try {
    const cfg = readConfigObject(effectiveQqConfigFile());
    const raw = String(cfg?.dsh?.baseUrl ?? '').trim();
    return raw ? raw.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

const normalize = (value) => String(value ?? '').trim().replace(/\/+$/, '');
const configBase = configuredBaseUrl();
const candidates = [];
const addCandidate = (value) => {
  const url = normalize(value);
  if (url && !candidates.includes(url)) candidates.push(url);
};
addCandidate(process.env.DSH_BASE_URL);
addCandidate(configBase);
addCandidate('http://127.0.0.1:3100');
for (const port of listDshCandidatePorts()) addCandidate(`http://127.0.0.1:${port}`);
addCandidate(await discoverDshBaseUrl());

const viable = [];
for (const url of candidates) {
  // eslint-disable-next-line no-await-in-loop
  if (await probeDshBaseUrl(url)) viable.push(url);
}
if (!viable.length) {
  console.error(`⏭  未发现正在运行的 DSH（已探测：${candidates.join(', ') || '无候选'}）。`);
  console.error('   这不是失败：请先启动 DSH，或用 DSH_BASE_URL=... 指定地址。');
  process.exitCode = 2;
} else {
  await main(viable);
}

async function main(targets) {
  const launchToken = normalize(process.env.DSH_LAUNCH_TOKEN) || discoverDshLaunchToken() || '';
  console.log(`🔎 候选 DSH：${targets.join(', ')}`);
  console.log(`   启动令牌：${launchToken ? '已发现' : '未发现（将使用持久化签名密钥铸造 Cookie）'}`);

  // 逐个候选鉴权：只有真正返回 settings 描述的才是 DSH 的 API 端口。
  let api = null;
  let target = '';
  let settings = null;
  const failures = [];
  for (const baseUrl of targets) {
    const client = new NodeApiClient(baseUrl, 8000, {
      token: launchToken,
      tokenExplicit: Boolean(process.env.DSH_LAUNCH_TOKEN),
      // 本机回环，允许把 launch token 放进查询串换 Cookie。
      allowRemote: false,
    });
    if (!client.hasAuth()) {
      failures.push(`${baseUrl}：无可用鉴权手段（找不到签名密钥/启动令牌）`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      settings = unwrap(await client.settings.describe({}), 'settings.describe');
      api = client;
      target = baseUrl;
      break;
    } catch (error) {
      failures.push(`${baseUrl}：${error?.message ?? error}`);
    }
  }

  if (!api) {
    console.error('❌ 没有一个候选能通过 DSH 鉴权：');
    for (const line of failures) console.error(`   · ${line}`);
    console.error('   鉴权失败：确认 DSH 正在以当前用户运行，且 ~/.dsh/.credentials.yaml 可读。');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 目标 DSH：${target}（settings/describe 通过）`);
  if (configBase && configBase !== target) {
    console.log(`   ℹ️  config.json 的 dsh.baseUrl=${configBase} 不是 DSH API 端口，已自动改用可用端口`);
  }

  let failuresCount = 0;
  async function readOnly(label, fn) {
    try {
      const value = await fn();
      console.log(`✅ ${label}`);
      return value;
    } catch (error) {
      failuresCount += 1;
      console.error(`❌ ${label}：${error?.message ?? error}`);
      return null;
    }
  }

  // 1) 设置命名空间：桥接靠它读模式（qq-mode）与默认 preset（agent-presets）。
  const namespaces = Array.isArray(settings.namespaces) ? settings.namespaces : [];
  const ids = namespaces.map((ns) => ns?.ns).filter(Boolean);
  console.log(`   命名空间 ${namespaces.length} 个：${ids.join(', ') || '（空）'}`);
  for (const want of ['agent-presets', 'qq-mode']) {
    if (ids.includes(want)) continue;
    // agent-presets 缺失不算致命：桥接会回退到 agentPresets/list 里的 isDefault。
    const fatal = want === 'qq-mode';
    console.error(`   ${fatal ? '⚠️' : 'ℹ️'}  缺少命名空间 ${want}：${fatal
      ? '桥接读完设置后无法确定当前模式'
      : '将回退到 preset 列表的默认项'}`);
  }

  // 2) agent preset 清单：群聊/仿真会话按它 fail-closed（清单缺失会拒绝建会话）。
  const presets = await readOnly('agentPresets/list', async () => unwrap(
    await api.agentPresets.list({}), 'agentPresets.list',
  ));
  if (presets) {
    const list = Array.isArray(presets.presets) ? presets.presets : [];
    console.log(`   preset ${list.length} 个：${list.map((p) => p?.id).filter(Boolean).join(', ') || '（空）'}`);
    if (!list.length) console.error('   ⚠️  preset 清单为空：群聊/仿真会话会因缺少安全 preset 而拒绝建会话');
  }

  // 3) 模型目录：桥接按它校验 provider/model 与思考强度档位。
  const catalog = await readOnly('session/modelCatalog', async () => unwrap(
    await api.callUnary('session/modelCatalog', {}), 'session/modelCatalog',
  ));
  if (catalog) {
    const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
    const models = groups.flatMap((g) => (Array.isArray(g?.models) ? g.models : []));
    console.log(`   模型 ${models.length} 个：${models.map((m) => m?.id).filter(Boolean).slice(0, 8).join(', ') || '（空）'}`);
    if (!models.length) console.error('   ⚠️  模型清单为空：聊天会因选不到模型而失败');
  }

  if (failuresCount > 0) {
    console.error(`\n❌ 兼容性检查失败：${failuresCount} 项。DSH 可能已升级并改了协议，请对照修复。`);
    // 用 exitCode 而不是 process.exit()：undici 连接池还在收尾时强退，Windows 上
    // 会撞上 libuv 的 handle 关闭断言（uv async !CLOSING），把结论刷成一段崩溃栈。
    process.exitCode = 1;
  } else {
    console.log('\n✅ 只读兼容性检查全部通过（未发送任何消息、未修改任何数据）。');
  }
}
