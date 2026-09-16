/**
 * selftest-notify.mjs — 真机自检：实际弹一条通知，并回读通知中心确认落地。
 * 用法: node scripts/selftest-notify.mjs [title] [body]
 */
import { detectPlatform, notify } from '../lib/notifier.js';

const title = process.argv[2] ?? 'dsh-away-notify 自检';
const body = process.argv[3] ?? '如果你看到这条通知，说明通知通路可用。';

const target = detectPlatform();
console.log('== 平台探测 ==');
console.log(JSON.stringify(target, null, 2));

console.log('\n== 发送通知（含通知中心回读校验）==');
const res = await notify({
  title,
  body,
  launch: 'http://127.0.0.1:3080/',
  sound: true,
  verify: true,
  target,
});
console.log(JSON.stringify(res, null, 2));

if (!res.ok) {
  console.error('\n❌ 通知发送失败:', res.error);
  process.exit(1);
}
if (res.stdout && !/HISTORY_COUNT=[1-9]/.test(res.stdout)) {
  console.error('\n⚠️ Toast 已发出，但通知中心未回读到记录（可能被系统通知设置拦截）。');
  process.exit(2);
}
console.log('\n✅ 通知通路正常，且已确认进入通知中心。');
