import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  PROTOCOL,
  buildProtocolUri,
  parseProtocolUri,
  buildProtocolCommand,
  deriveWscriptPath,
  renderRegisterScript,
  renderUnregisterScript,
  toWindowsPath,
  registerProtocol,
} from '../lib/protocol.js';

const VBS = 'F:\\p\\run-hidden.vbs';
const PS1 = 'F:\\p\\focus-or-open.ps1';
const PS_WSL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const PS_WIN = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** 假的子进程：立刻回一段 stdout 然后 close。 */
function fakeChild(stdoutText) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  setImmediate(() => {
    child.stdout.emit('data', stdoutText);
    child.emit('close', 0);
  });
  return child;
}

const decodeEncodedCommand = (args) => Buffer.from(String(args.at(-1)), 'base64').toString('utf16le');

// ── URI 编解码 ──────────────────────────────────────────────────────────────

test('buildProtocolUri / parseProtocolUri 往返一致（含 token 与 & 等特殊字符）', () => {
  const url = 'http://127.0.0.1:3081/?token=Ab-C_d.123~&dshAwayNotifyFocus=session-abc';
  const uri = buildProtocolUri(url);
  assert.ok(uri.startsWith(`${PROTOCOL}:`));
  assert.equal(parseProtocolUri(uri), url);
});

test('协议 URI 只含 URI 安全字符（不含 & " % 空格）', () => {
  const uri = buildProtocolUri('http://127.0.0.1:3081/?a=1&b="x"&c=%20');
  assert.match(uri.slice(PROTOCOL.length + 1), /^[A-Za-z0-9_-]+$/);
});

test('parseProtocolUri 兼容 dshnotify:// 前缀与带 padding 的 base64', () => {
  const url = 'http://127.0.0.1:3081/';
  const plain = Buffer.from(url, 'utf8').toString('base64');
  assert.equal(parseProtocolUri(`${PROTOCOL}://${plain}`), url);
  assert.equal(parseProtocolUri(`${PROTOCOL}:${plain}`), url);
});

test('中文 URL 往返正确', () => {
  const url = 'http://127.0.0.1:3081/?t=会话完成';
  assert.equal(parseProtocolUri(buildProtocolUri(url)), url);
});

// ── 路径转换 ────────────────────────────────────────────────────────────────

test('toWindowsPath 在 wslpath 可用时采用其输出', () => {
  assert.equal(
    toWindowsPath('/mnt/f/project/x.ps1', { spawnSyncImpl: () => ({ status: 0, stdout: 'F:\\project\\x.ps1\n' }) }),
    'F:\\project\\x.ps1',
  );
});

test('toWindowsPath 在 wslpath 不可用时原样返回（原生 Windows）', () => {
  const boom = () => {
    throw new Error('ENOENT');
  };
  assert.equal(toWindowsPath('C:\\plugins\\x.ps1', { spawnSyncImpl: boom }), 'C:\\plugins\\x.ps1');
});

test('deriveWscriptPath 从 WSL 形式与 Windows 形式的 powershell 推出 wscript', () => {
  assert.equal(deriveWscriptPath(PS_WSL), '/mnt/c/Windows/System32/wscript.exe');
  assert.equal(deriveWscriptPath(PS_WIN), 'C:\\Windows\\System32\\wscript.exe');
});

test('deriveWscriptPath 对意外的 powershell 路径返回 null', () => {
  assert.equal(deriveWscriptPath('powershell.exe'), null);
  assert.equal(deriveWscriptPath(''), null);
  assert.equal(deriveWscriptPath(undefined), null);
});

// ── 注册命令 ────────────────────────────────────────────────────────────────

const ENQUEUE = 'F:\\p\\enqueue-focus.vbs';
const SPOOL = 'F:\\p\\.focus-spool';

test('enqueue 模式：注册表直接指向 VBS，点击路径上没有 PowerShell', () => {
  const cmd = buildProtocolCommand({
    powershell: PS_WIN,
    enqueueVbs: ENQUEUE,
    spoolDir: SPOOL,
  });
  assert.ok(cmd.startsWith('"C:\\Windows\\System32\\wscript.exe"'), `应由 wscript 启动：${cmd}`);
  assert.match(cmd, /"F:\\p\\enqueue-focus\.vbs"/);
  assert.match(cmd, /"%1"/);
  assert.match(cmd, /"F:\\p\\\.focus-spool"$/);
  assert.doesNotMatch(cmd, /powershell/i, '快路径不该出现 powershell');
  assert.doesNotMatch(cmd, /focus-or-open/, '快路径不该直接调冷脚本');
});

test('enqueue 模式参数不全时退回 direct（不至于注册出坏命令）', () => {
  const cmd = buildProtocolCommand({ mode: 'enqueue', powershell: PS_WIN, scriptPath: PS1, vbsPath: VBS });
  assert.match(cmd, /"F:\\p\\focus-or-open\.ps1"/);
});

test('direct 模式走 wscript + run-hidden.vbs，避免 PowerShell 控制台闪烁', () => {
  const cmd = buildProtocolCommand({ mode: 'direct', powershell: PS_WIN, scriptPath: PS1, vbsPath: VBS });
  assert.ok(cmd.startsWith('"C:\\Windows\\System32\\wscript.exe"'), `应由 wscript 启动：${cmd}`);
  assert.match(cmd, /"F:\\p\\run-hidden\.vbs"/);
  assert.match(cmd, /"F:\\p\\focus-or-open\.ps1"/);
  assert.match(cmd, /-Uri "%1"/);
  assert.doesNotMatch(cmd, /-WindowStyle/, '不该再直接调 powershell');
});

test('direct 命令带上 marker 与 tagMode 作为命名参数', () => {
  const cmd = buildProtocolCommand({
    mode: 'direct',
    powershell: PS_WIN,
    scriptPath: PS1,
    vbsPath: VBS,
    marker: 'DeepSeek Harness',
  });
  assert.match(cmd, /-Marker "DeepSeek Harness" -TagMode "port"$/, `默认应要求端口 tag：${cmd}`);
});

test('tagMode=off 时也如实传下去（退回旧行为）', () => {
  const cmd = buildProtocolCommand({
    mode: 'direct',
    powershell: PS_WIN,
    scriptPath: PS1,
    vbsPath: VBS,
    marker: 'DeepSeek Harness',
    tagMode: 'off',
  });
  assert.match(cmd, /-TagMode "off"$/);
});

test('推不出 wscript 时退回直接调用 powershell（会闪，但不至于不可用）', () => {
  const cmd = buildProtocolCommand({ mode: 'direct', powershell: 'powershell.exe', scriptPath: PS1 });
  assert.match(cmd, /^"powershell\.exe" -NoProfile/);
  assert.match(cmd, /-WindowStyle Hidden/);
});

test('路径里的双引号被剔除，不会破坏命令行', () => {
  const cmd = buildProtocolCommand({ mode: 'direct', powershell: PS_WIN, scriptPath: 'F:\\p"x.ps1', vbsPath: VBS });
  assert.doesNotMatch(cmd, /p"x\.ps1/);
});

// ── 注册脚本 ────────────────────────────────────────────────────────────────

test('注册脚本写入 HKCU 且标记 URL Protocol（无需管理员）', () => {
  const script = renderRegisterScript({
    powershell: PS_WIN,
    scriptPath: PS1,
    vbsPath: VBS,
    marker: 'DeepSeek Harness',
  });
  assert.match(script, /HKCU:\\Software\\Classes\\dshnotify/);
  assert.match(script, /"URL Protocol"/);
  assert.match(script, /New-Item -Path \$key -Force/);
  assert.match(script, /wscript\.exe/);
});

test('注册脚本里的单引号被正确转义（路径含撇号也不会破坏语法）', () => {
  const script = renderRegisterScript({ powershell: "C:\\it's\\ps.exe", scriptPath: PS1, vbsPath: VBS });
  assert.match(script, /it''s/);
});

test('注册与注销脚本都是纯 ASCII（PowerShell 5.1 无 BOM 读取的前提）', () => {
  for (const script of [
    renderRegisterScript({ powershell: PS_WIN, scriptPath: PS1, vbsPath: VBS, marker: 'DeepSeek Harness' }),
    renderUnregisterScript(),
  ]) {
    // eslint-disable-next-line no-control-regex
    assert.match(script, /^[\x00-\x7F]*$/);
  }
});

test('注销脚本删除 HKCU 下的协议键', () => {
  assert.match(renderUnregisterScript(), /Remove-Item -Path "HKCU:\\Software\\Classes\\dshnotify" -Recurse -Force/);
});

// ── 随包脚本 ────────────────────────────────────────────────────────────────

/** 读 scripts/ 下的脚本源码。 */
const readScript = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
const ASCII_ONLY = /^[\x00-\x7F]*$/;

test('所有随包脚本都是纯 ASCII（PS 5.1 无 BOM 读取的前提）', () => {
  for (const name of [
    'focus-lib.ps1',
    'focus-or-open.ps1',
    'focus-helper.ps1',
    'enqueue-focus.vbs',
    'run-hidden.vbs',
  ]) {
    // eslint-disable-next-line no-control-regex
    assert.match(readScript(name), ASCII_ONLY, `${name} 不得包含非 ASCII 字符`);
  }
});

test('focus-lib.ps1 包含真正的聚焦与兜底打开逻辑', () => {
  const src = readScript('focus-lib.ps1');
  assert.match(src, /dshnotify:/);
  assert.match(src, /SetForegroundWindow/);
  assert.match(src, /AttachThreadInput/, '前台锁要靠 AttachThreadInput 绕开');
  assert.match(src, /IsIconic/);
  assert.match(src, /Start-Process \$url/);
});

test('focus-lib.ps1 用字面包含而非 -like（否则[]会被当成字符集，tag 过滤失效）', () => {
  const src = readScript('focus-lib.ps1');
  // 真机踩到过：-like "*[dsh:3080]*" 只要求标题含 d/s/h/:/3/0/8 其中一个字符，
  // 于是任何 dsh 窗口都能匹配上，实例区分完全失效。
  assert.match(
    src,
    /IndexOf\(\$Needle, \[System\.StringComparison\]::OrdinalIgnoreCase\)/,
    'marker 与 tag 都必须走字面匹配',
  );
  assert.doesNotMatch(src, /-like\s+"\*\$(tag|Marker)\*"/, '标题匹配不得再用 -like 包住变量');
});

test('focus-lib.ps1 用一次 EnumWindows 找窗口，不再逐个进程全量枚举', () => {
  const src = readScript('focus-lib.ps1');
  // 真机实测：GetProcessesByName 单次就要枚举整台机器的进程（400 进程时 148-213ms），
  // 而旧实现每次点击调它三次（msedge/chrome/firefox），成了点击延迟的大头。
  assert.match(src, /EnumWindows/, '应按顶层窗口枚举');
  assert.match(src, /ListWindowTitles/, '应走一次枚举拿到所有标题');
  assert.doesNotMatch(
    src,
    /\[System\.Diagnostics\.Process\]::GetProcessesByName/,
    '不该再用全量扫进程的 GetProcessesByName（注释里提到它不算）',
  );
});

test('focus-lib.ps1 记住上次命中的窗口：标签不在前台时不新开标签页', () => {
  const src = readScript('focus-lib.ps1');
  // 窗口标题只反映浏览器当前标签：用户切到别的标签后 marker/tag 就消失，旧实现会
  // 因此新开一个重复标签页。多实例并存时本实例的标签必然经常不在前台，更需要兜底。
  assert.match(src, /DshWindowCache/, '应缓存上次命中的窗口');
  assert.match(src, /IsWindow\(\$cached\)/, '缓存命中前要用 IsWindow 确认窗口还在');
  assert.match(src, /FromCache/, '应把「来自缓存」透出来，便于诊断');
});

test('focus-or-open.ps1 与 focus-helper.ps1 共用同一份逻辑，不各写一遍', () => {
  for (const name of ['focus-or-open.ps1', 'focus-helper.ps1']) {
    const src = readScript(name);
    assert.match(src, /focus-lib\.ps1/, `${name} 应 dot-source 共享库`);
    assert.match(src, /Invoke-DshFocus/, `${name} 应调用共享入口`);
    assert.doesNotMatch(src, /SetForegroundWindow/, `${name} 不该再自带一份 P/Invoke`);
  }
});

test('focus-helper.ps1 是常驻的：事件驱动 + 单实例 + 心跳 + 可停止', () => {
  const src = readScript('focus-helper.ps1');
  assert.match(src, /FileSystemWatcher/, '用事件唤醒而不是忙轮询，否则常驻会白烧 CPU');
  assert.match(src, /WaitForChanged/);
  assert.match(src, /Mutex/, '单实例，避免重载时两个助手抢同一批请求');
  assert.match(src, /heartbeat/, '心跳让 enqueue 脚本能判断助手是否活着');
  assert.match(src, /stop/, '插件卸载时助手要能退出');
});

test('enqueue-focus.vbs 不起 PowerShell，且具备兜底与自愈', () => {
  const src = readScript('enqueue-focus.vbs');
  assert.match(src, /CreateTextFile/, '点击只写一个请求文件');
  assert.match(src, /MoveFile/, '先写临时名再改名，避免助手读到半个文件');
  assert.match(src, /heartbeat/, '要检查助手是否还活着');
  assert.doesNotMatch(src, /-EncodedCommand/, '不该有 PowerShell 负载');
  assert.match(src, /focus-or-open/, '助手不在时要能退回冷路径');
});

test('run-hidden.vbs 是纯 ASCII 且以隐藏窗口方式启动 PowerShell', () => {
  const src = readScript('run-hidden.vbs');
  assert.match(src, /WScript\.Shell/);
  assert.match(src, /shell\.Run cmd, 0, False/, '0 = 隐藏窗口，False = 不等待');
  assert.match(src, /powershell\.exe/);
  assert.match(src, /args\.Count - 1/, '参数要透传，助手启动也复用它');
});

// ── registerProtocol ────────────────────────────────────────────────────────

test('回归：注册命令里所有路径都必须是 Windows 形式，且走 wscript', async () => {
  // 真机踩到过两件事：命令里写成 /mnt/c/... 时 ShellExecute 直接失败；
  // 直接调 powershell 会闪控制台。
  let captured = '';
  const res = await registerProtocol({
    powershell: PS_WSL,
    scriptPath: '/mnt/f/p/focus-or-open.ps1',
    vbsPath: '/mnt/f/p/run-hidden.vbs',
    spawnSyncImpl: (cmd, args) => {
      const p = String(args[1]);
      const map = {
        [PS_WSL]: PS_WIN,
        '/mnt/f/p/focus-or-open.ps1': PS1,
        '/mnt/f/p/run-hidden.vbs': VBS,
        '/mnt/c/Windows/System32/wscript.exe': 'C:\\Windows\\System32\\wscript.exe',
      };
      return { status: 0, stdout: map[p] ?? p };
    },
    spawnImpl: (cmd, args) => {
      captured = decodeEncodedCommand(args);
      return fakeChild('REGISTERED\n');
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.doesNotMatch(captured, /\/mnt\//, '注册表命令里不能出现 WSL 路径');
  assert.match(captured, /C:\\Windows\\System32\\wscript\.exe/);
  assert.match(captured, /F:\\p\\focus-or-open\.ps1/);
  assert.ok(res.command.startsWith('"C:\\Windows\\System32\\wscript.exe"'), res.command);
});

test('注册失败时返回 ok=false 且带可读原因（不是空字符串）', async () => {
  const res = await registerProtocol({
    powershell: '/mnt/c/ps.exe',
    scriptPath: '/mnt/f/x.ps1',
    vbsPath: '/mnt/f/x.vbs',
    spawnSyncImpl: () => ({ status: 0, stdout: 'C:\\ps.exe' }),
    spawnImpl: () => fakeChild('SOMETHING_ELSE\n'),
  });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0, '失败原因不能为空');
});

test('缺少 powershell 时直接失败，不发起进程', async () => {
  const res = await registerProtocol({ powershell: '', scriptPath: '/x.ps1' });
  assert.equal(res.ok, false);
  assert.match(res.error, /powershell/);
});
