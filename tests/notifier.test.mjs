import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, detectWsl, findWindowsPowerShellFromWsl, __internals } from '../lib/notifier.js';

const { b64, encodeCommand, renderTemplate } = __internals;

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
