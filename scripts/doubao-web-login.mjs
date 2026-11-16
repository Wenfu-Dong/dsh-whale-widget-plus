// 豆包网页音源（doubao-web）首次登录 / 登录态续期。
//
//   node scripts/doubao-web-login.mjs
//
// 会打开一个 Edge 窗口（用的是插件保存登录态的同一个 profile），扫码登录后窗口
// 自动关闭。插件侧不需要重启：下一次合成时会直接复用这份登录态。
// 注意：合成进行中（或插件正持有浏览器）时 profile 会被占用，先等它空闲再跑。
import { openDoubaoWebLogin, defaultProfileDir } from '../src/voice-doubao-web.js';

const profileDir = process.env.DOUBAO_WEB_PROFILE_DIR || defaultProfileDir();
console.log(`豆包网页登录：profile = ${profileDir}`);
console.log('请在弹出的 Edge 窗口里完成登录（扫码/手机号），登录成功会自动关闭。');

try {
  await openDoubaoWebLogin({ profileDir, timeoutMs: 5 * 60 * 1000 });
  console.log('✅ 登录完成，登录态已保存');
  process.exit(0);
} catch (error) {
  console.error(`❌ 登录没完成：${String(error?.message ?? error).slice(0, 300)}`);
  process.exit(1);
}
