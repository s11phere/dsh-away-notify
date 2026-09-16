/**
 * protocol.js — `dshnotify:` 自定义协议
 *
 * 为什么需要它：Toast 的点击由 Windows 交给默认浏览器处理，插件无法控制浏览器是
 * 复用已有窗口还是新开标签页。注册自定义协议后，点击会调起我们自己的 PowerShell
 * 脚本，由脚本先把已有的 dsh 浏览器窗口提到前台，找不到才打开新标签页。
 *
 * 注册写在 `HKCU\Software\Classes\dshnotify`（**不需要管理员权限**）。
 *
 * URI 形态：`dshnotify:<base64url(目标URL)>`。用 base64 而不是明文，是为了避开
 * URL 里的 `&`、引号、`%` 在「命令行 → 注册表 → ShellExecute」链路上的转义问题。
 */

import { spawnSync } from 'node:child_process';

export const PROTOCOL = 'dshnotify';

/** 目标 URL -> 协议 URI。 */
export function buildProtocolUri(url) {
  const b64 = Buffer.from(String(url ?? ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${PROTOCOL}:${b64}`;
}

/** 从协议 URI 还原目标 URL（自检与单测用）。 */
export function parseProtocolUri(uri) {
  let payload = String(uri ?? '');
  if (payload.startsWith(`${PROTOCOL}:`)) payload = payload.slice(PROTOCOL.length + 1);
  payload = payload.replace(/^\/+/, '');
  let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 2) b64 += '==';
  else if (b64.length % 4 === 3) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * 把路径转成 Windows 能读的形式。
 * WSL 下 `wslpath -w` 会把 `/mnt/f/...` 转成 `F:\...`、把 `/home/...` 转成
 * `\\wsl.localhost\<distro>\...`；原生 Windows 上没有 wslpath，原样返回。
 */
export function toWindowsPath(p, { spawnSyncImpl = spawnSync } = {}) {
  try {
    const r = spawnSyncImpl('wslpath', ['-w', p], { encoding: 'utf8' });
    if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length > 0) {
      return r.stdout.trim();
    }
  } catch {
    /* 原生 Windows：没有 wslpath，走原样返回 */
  }
  return p;
}

/** PowerShell 单引号字符串转义。 */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** VBScript / 命令行里的双引号字面量：把值包进双引号。 */
const quoted = (s) => `"${String(s).replace(/"/g, '')}"`;

/**
 * 由 powershell.exe 路径推出同一 System32 下的 wscript.exe。
 *
 * 为什么要用 wscript：ShellExecute 启动 powershell.exe 时，**即使带
 * `-WindowStyle Hidden` 也会先闪一个控制台窗口**。wscript.exe 是 GUI 子系统
 * 宿主、自身没有控制台，可以用 VBS 把 PowerShell 真正隐藏地拉起。
 *
 * @returns {string|null} 推不出来时返回 null（调用方退回直接调 powershell）
 */
export function deriveWscriptPath(powershell) {
  const p = String(powershell ?? '');
  const m = p.match(/^(.*)[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  if (!m) return null;
  const sep = p.includes('\\') ? '\\' : '/';
  return `${m[1]}${sep}wscript.exe`;
}

/**
 * 组装注册表里 `shell\open\command` 的默认值。
 *
 * 优先走 `wscript.exe run-hidden.vbs <ps1> "%1" <marker>"`（无窗口闪烁）；
 * 推不出 wscript 时退回直接调用 powershell（会有短暂闪烁）。
 */
export function buildProtocolCommand({ powershell, scriptPath, vbsPath, wscript, marker }) {
  const wscriptPath = wscript ?? deriveWscriptPath(powershell);
  if (wscriptPath && vbsPath) {
    const parts = [quoted(wscriptPath), quoted(vbsPath), quoted(scriptPath), '"%1"'];
    if (marker) parts.push(quoted(marker));
    return parts.join(' ');
  }
  return `${quoted(powershell)} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${quoted(scriptPath)} "%1"`;
}

/** 生成注册脚本（ASCII）。导出以便单测断言。 */
export function renderRegisterScript({ powershell, scriptPath, vbsPath, wscript, marker }) {
  const command = buildProtocolCommand({ powershell, scriptPath, vbsPath, wscript, marker });
  return `$ErrorActionPreference = "Stop"
$key = "HKCU:\\Software\\Classes\\${PROTOCOL}"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value ${psQuote(`URL:${PROTOCOL} protocol`)}
New-ItemProperty -Path $key -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
$cmdKey = Join-Path $key "shell\\open\\command"
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name "(default)" -Value ${psQuote(command)}
Write-Output "REGISTERED"
Write-Output ${psQuote(`MARKER=${marker}`)}
`;
}

/** 生成注销脚本（ASCII）。 */
export function renderUnregisterScript() {
  return `$ErrorActionPreference = "SilentlyContinue"
Remove-Item -Path "HKCU:\\Software\\Classes\\${PROTOCOL}" -Recurse -Force
Write-Output "UNREGISTERED"
`;
}

const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

function runPowerShell(powershell, script, { timeoutMs, spawnImpl, spawnSyncImpl }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
  if (spawnImpl) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(powershell, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message ?? error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
      child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
      child.unref?.();
    });
  }
  const r = spawnSyncImpl(powershell, args, { encoding: 'utf8', timeout: timeoutMs });
  return Promise.resolve({
    ok: r?.status === 0,
    code: r?.status ?? null,
    stdout: r?.stdout ?? '',
    stderr: r?.stderr ?? '',
  });
}

/**
 * 注册（或刷新）协议处理器。幂等：每次都覆盖写同样的值。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function registerProtocol({
  powershell,
  scriptPath,
  vbsPath,
  marker = 'DeepSeek Harness',
  timeoutMs = 15000,
  spawnImpl,
  spawnSyncImpl = spawnSync,
}) {
  if (!powershell) return { ok: false, error: 'powershell not found' };
  // 脚本路径和**可执行文件路径**都必须转成 Windows 形式：注册表里的命令由
  // ShellExecute 在 Windows 侧执行，写成 `/mnt/c/...` 会直接失败。
  // 而下面 runPowerShell 仍用原始路径——那是在 WSL 侧启动进程用的。
  const winScript = toWindowsPath(scriptPath, { spawnSyncImpl });
  const winPowerShell = toWindowsPath(powershell, { spawnSyncImpl });
  const winVbs = vbsPath ? toWindowsPath(vbsPath, { spawnSyncImpl }) : undefined;
  const wscript = deriveWscriptPath(powershell);
  const winWscript = wscript ? toWindowsPath(wscript, { spawnSyncImpl }) : undefined;

  const commandArgs = {
    powershell: winPowerShell,
    scriptPath: winScript,
    vbsPath: winVbs,
    wscript: winWscript,
    marker,
  };
  const script = renderRegisterScript(commandArgs);
  const res = await runPowerShell(powershell, script, { timeoutMs, spawnImpl, spawnSyncImpl });
  if (res.ok && /REGISTERED/.test(res.stdout ?? '')) {
    return { ok: true, command: buildProtocolCommand(commandArgs) };
  }
  return { ok: false, error: failureDetail(res) };
}

/** 组装可读的失败原因（注意空字符串不能被 ?? 当成「有值」）。 */
function failureDetail(res) {
  const err = res?.error ? String(res.error) : '';
  const errOut = res?.stderr ? String(res.stderr).trim() : '';
  return err || errOut || `exit ${res?.code ?? 'unknown'}`;
}

/** 注销协议处理器。 */
export async function unregisterProtocol({ powershell, timeoutMs = 15000, spawnImpl, spawnSyncImpl = spawnSync }) {
  if (!powershell) return { ok: false, error: 'powershell not found' };
  const res = await runPowerShell(powershell, renderUnregisterScript(), { timeoutMs, spawnImpl, spawnSyncImpl });
  return res.ok ? { ok: true } : { ok: false, error: failureDetail(res) };
}
