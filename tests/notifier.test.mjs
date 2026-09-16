import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, detectWsl, findWindowsPowerShellFromWsl, dismiss, notify, __internals } from '../lib/notifier.js';

const { b64, encodeCommand, renderTemplate } = __internals;

/**
 * 假的 spawn：捕获真正传给 PowerShell 的 `-EncodedCommand` 脚本明文，
 * 这样不用真跑 PowerShell 就能断言模板渲染结果。
 */
function fakeSpawn(captured, { stdout = 'TOAST_SHOWN\r\n', code = 0 } = {}) {
  return (cmd, args) => {
    const i = args.indexOf('-EncodedCommand');
    const encoded = i >= 0 ? args[i + 1] : '';
    captured.push({
      cmd,
      args,
      script: encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : '',
    });
    const handlers = {};
    const child = {
      stdout: { on: (_ev, fn) => (handlers.stdout = fn) },
      stderr: { on: (_ev, fn) => (handlers.stderr = fn) },
      on: (ev, fn) => (handlers[ev] = fn),
      kill: () => {},
      unref: () => {},
    };
    // 监听器是在 spawn 返回之后才挂上的，所以必须异步触发
    setImmediate(() => {
      handlers.stdout?.(stdout);
      handlers.close?.(code);
    });
    return child;
  };
}

const WSL_TARGET = { kind: 'wsl', powershell: 'powershell.exe' };
const WIN_TARGET = { kind: 'windows', powershell: 'powershell.exe' };

test('detectWsl: 通过 WSL_DISTRO_NAME 识别', () => {
  assert.equal(detectWsl('', { WSL_DISTRO_NAME: 'Ubuntu' }), true);
});

test('detectWsl: 通过 WSL_INTEROP 识别', () => {
  assert.equal(detectWsl('', { WSL_INTEROP: '/run/WSL/1_interop' }), true);
});

test('detectWsl: 通过 /proc/version 识别（大小写不敏感）', () => {
  assert.equal(detectWsl('Linux version 6.6.87.2-Microsoft-standard-WSL2', {}), true);
  assert.equal(detectWsl('Linux version 6.6.87.2-microsoft-standard-WSL2', {}), true);
});

test('detectWsl: 普通 Linux 不误判', () => {
  assert.equal(detectWsl('Linux version 6.1.0-13-amd64', {}), false);
});

test('detectPlatform: win32 -> windows', () => {
  const p = detectPlatform({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, procVersion: '' });
  assert.equal(p.kind, 'windows');
});

test('detectPlatform: WSL 且找到 powershell -> wsl', () => {
  const p = detectPlatform({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu', DSH_NOTIFY_POWERSHELL: '/custom/pwsh.exe' },
    procVersion: 'microsoft-standard-WSL2',
  });
  assert.equal(p.kind, 'wsl');
  assert.equal(p.powershell, '/custom/pwsh.exe');
});

test('detectPlatform: WSL 但找不到 powershell -> 降级 linux', () => {
  const p = detectPlatform({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu', DSH_NOTIFY_WSL_DRIVES: '' },
    procVersion: 'microsoft-standard-WSL2',
  });
  assert.equal(p.kind, 'linux');
});

test('detectPlatform: 普通 Linux -> linux', () => {
  const p = detectPlatform({ platform: 'linux', env: {}, procVersion: 'Linux version 6.1.0' });
  assert.equal(p.kind, 'linux');
  assert.equal(p.powershell, null);
});

test('detectPlatform: darwin 单独识别', () => {
  assert.equal(detectPlatform({ platform: 'darwin', env: {}, procVersion: '' }).kind, 'darwin');
});

test('detectPlatform: 未知平台不抛异常', () => {
  assert.equal(detectPlatform({ platform: 'freebsd', env: {}, procVersion: '' }).kind, 'unsupported');
});

test('findWindowsPowerShellFromWsl: 环境变量优先', () => {
  const r = findWindowsPowerShellFromWsl({ DSH_NOTIFY_POWERSHELL: 'X:/ps.exe' });
  assert.equal(r, 'X:/ps.exe');
});

test('findWindowsPowerShellFromWsl: 无候选时返回 null', () => {
  assert.equal(findWindowsPowerShellFromWsl({ DSH_NOTIFY_WSL_DRIVES: '' }), null);
});

test('b64: 中文往返正确', () => {
  const s = '任务完成 ✅ 需要你的回答';
  assert.equal(Buffer.from(b64(s), 'base64').toString('utf8'), s);
});

test('encodeCommand: 产出 UTF-16LE base64', () => {
  const script = 'Write-Output "hi"';
  const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le');
  assert.equal(decoded, script);
});

test('renderTemplate: 注入的 base64 值不含未替换占位符', () => {
  const out = renderTemplate('A=__X__;B=__Y__', { __X__: '1', __Y__: '2' });
  assert.equal(out, 'A=1;B=2');
});

test('PS 模板不含非 ASCII 字符（避免编码坑）', () => {
  // eslint-disable-next-line no-control-regex
  assert.match(__internals.PS_TEMPLATE, /^[\x00-\x7F]*$/);
  assert.match(__internals.PS_VERIFY_TEMPLATE, /^[\x00-\x7F]*$/);
});

test('PS 模板包含提示音开关与 Toast 通用模板', () => {
  assert.match(__internals.PS_TEMPLATE, /ms-winsoundevent:Notification\.Default/);
  assert.match(__internals.PS_TEMPLATE, /ToastGeneric/);
  assert.match(__internals.PS_TEMPLATE, /activationType/);
});

test('撤回模板是纯 ASCII 且走 History.Remove', () => {
  // eslint-disable-next-line no-control-regex
  assert.match(__internals.PS_DISMISS_TEMPLATE, /^[\x00-\x7F]*$/);
  assert.match(__internals.PS_DISMISS_TEMPLATE, /History\.Remove/);
  assert.match(__internals.PS_DISMISS_TEMPLATE, /History\.Clear/);
});

// ── 持久化通知 ──────────────────────────────────────────────────────────────

test('persistent=true 渲染出 reminder 场景、按钮与 tag/group', async () => {
  const captured = [];
  const res = await notify({
    title: '标题',
    body: '正文',
    launch: 'dshnotify:abc',
    appId: 'App',
    persistent: true,
    tag: 'dshan-1',
    group: 'dshan',
    target: WSL_TARGET,
    spawnImpl: fakeSpawn(captured),
  });

  assert.equal(res.ok, true);
  const s = captured[0].script;
  assert.doesNotMatch(s, /__[A-Z]+_B64__/, '占位符必须全部替换');
  assert.ok(s.includes(b64('reminder')), '应带 scenario=reminder');
  assert.ok(s.includes(b64('long')), '应带 duration=long 兜底');
  assert.match(s, /<actions>/, 'reminder 必须配按钮，否则会被系统忽略');
  assert.ok(s.includes(b64('dshan-1')), '应带上 tag 以便之后撤回');
  assert.ok(s.includes(b64('dshan')), '应带上 group');
  assert.match(s, /\$toast\.Tag/);
  assert.match(s, /\$toast\.Group/);
});

test('persistent=false 不带 reminder 场景（保持原有行为）', async () => {
  const captured = [];
  await notify({ title: 'T', body: 'B', appId: 'App', target: WSL_TARGET, spawnImpl: fakeSpawn(captured) });
  const s = captured[0].script;
  assert.ok(!s.includes(b64('reminder')), '默认不该带 reminder');
  assert.ok(!s.includes(b64('long')));
});

test('没有 launch 时持久通知用 system/dismiss 按钮', async () => {
  const captured = [];
  await notify({ title: 'T', body: 'B', appId: 'App', persistent: true, target: WIN_TARGET, spawnImpl: fakeSpawn(captured) });
  const s = captured[0].script;
  // 无 URL 时脚本内部把激活参数直接设成字面量 "dismiss"（system 激活）
  assert.match(s, /"dismiss"/, '无 URL 时应退回可关闭的按钮');
  assert.match(s, /"system"/);
});

test('有 launch 时持久通知的按钮用 protocol 激活到该 URL', async () => {
  const captured = [];
  await notify({
    title: 'T',
    body: 'B',
    launch: 'dshnotify:zzz',
    persistent: true,
    target: WIN_TARGET,
    spawnImpl: fakeSpawn(captured),
  });
  const s = captured[0].script;
  assert.ok(s.includes(b64('dshnotify:zzz')));
  assert.match(s, /"protocol"/);
});

// ── 撤回 ────────────────────────────────────────────────────────────────────

test('dismiss 按 tag+group 精确撤回（不是整表清理）', async () => {
  const captured = [];
  const res = await dismiss({
    appId: 'App',
    tag: 'dshan-1',
    group: 'dshan',
    target: WSL_TARGET,
    spawnImpl: fakeSpawn(captured, { stdout: 'DISMISSED\r\n' }),
  });
  assert.equal(res.ok, true);
  const s = captured[0].script;
  assert.ok(s.includes(b64('dshan-1')));
  assert.ok(s.includes(b64('dshan')));
  assert.match(s, /History\.Remove\(\$tag, \$group, \$appId\)/);
});

test('dismiss 成功与否看 DISMISSED 标记而不是退出码', async () => {
  const captured = [];
  const res = await dismiss({
    appId: 'App',
    tag: 't',
    group: 'g',
    target: WIN_TARGET,
    spawnImpl: fakeSpawn(captured, { stdout: '' }),
  });
  assert.equal(res.ok, false, '没有 DISMISSED 标记时不能算成功');
});

test('dismiss 在非 Windows 平台明确报告不支持', async () => {
  const res = await dismiss({ target: { kind: 'linux', powershell: null } });
  assert.equal(res.ok, false);
  assert.match(res.error, /not supported/);
});
