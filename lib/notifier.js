/**
 * notifier.js — 通知投递后端
 *
 * 目标：在三种部署形态下都能弹出「用户看得见」的 Windows / Linux 原生通知：
 *   1. dsh 原生跑在 Windows           -> powershell.exe + WinRT Toast
 *   2. dsh 跑在 WSL 里的 Linux         -> 调 Windows 侧 powershell.exe + WinRT Toast
 *   3. dsh 跑在普通 Linux 桌面          -> notify-send（缺失则降级为日志）
 *
 * 关键工程决策：
 *   - 脚本经 `-EncodedCommand`(UTF-16LE base64) 传入，**不落临时文件**：
 *     避开 WSL 下的 `wslpath` 路径转换，也避开 PowerShell 5.1 以 ANSI 读取
 *     无 BOM UTF-8 脚本导致中文乱码的问题（实测 0xC00CE56D）。
 *   - 脚本本体保持纯 ASCII；标题/正文/AppId/URL 一律以 UTF-8 base64 内联，
 *     在 PowerShell 内解码，因此中文、emoji、代码片段都安全。
 *   - 弹窗进程 detached + unref，绝不阻塞会话热路径。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_APP_ID = 'DeepSeek Harness';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * PowerShell 脚本模板（纯 ASCII）。值以 base64 内联，运行时解码。
 *
 * `scenario=reminder` 是唯一能让横幅**不被系统按时收走**的手段：它会让通知一直
 * 停留在屏幕上，直到用户点掉它。代价是必须至少给一个按钮，否则 Windows 会忽略
 * 该场景（无按钮时静默退化为普通通知）。所以 `persistent` 打开时一定会带上
 * `<actions>`。`duration=long` 是双保险：万一某台机器忽略 reminder，横幅至少
 * 停 25 秒而不是 5 秒。
 *
 * `Tag`/`Group` 是为了之后能用 `History.Remove(tag, group, appId)` 精确撤回
 * 这一条（用户回到 dsh 页面时撤掉，见 host.js 的 dismissOnReturn）。
 */
const PS_TEMPLATE = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function DecB64([string]$b) {
  if ([string]::IsNullOrEmpty($b)) { return "" }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))
}
$title  = DecB64 "__TITLE_B64__"
$body   = DecB64 "__BODY_B64__"
$appId  = DecB64 "__APPID_B64__"
$launch = DecB64 "__LAUNCH_B64__"
$scenario = DecB64 "__SCENARIO_B64__"
$duration = DecB64 "__DURATION_B64__"
$actionLabel = DecB64 "__ACTIONLABEL_B64__"
$tag = DecB64 "__TAG_B64__"
$group = DecB64 "__GROUP_B64__"
$sound  = "__SOUND__" -eq "1"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [System.Security.SecurityElement]::Escape($title)
$b = [System.Security.SecurityElement]::Escape($body)
$q = [char]34
$attrs = ""
if (-not [string]::IsNullOrEmpty($scenario)) { $attrs = $attrs + " scenario=" + $q + [System.Security.SecurityElement]::Escape($scenario) + $q }
if (-not [string]::IsNullOrEmpty($duration)) { $attrs = $attrs + " duration=" + $q + [System.Security.SecurityElement]::Escape($duration) + $q }
if (-not [string]::IsNullOrEmpty($launch)) {
  $attrs = $attrs + " activationType=" + $q + "protocol" + $q + " launch=" + $q + [System.Security.SecurityElement]::Escape($launch) + $q
}
$actions = ""
if (-not [string]::IsNullOrEmpty($actionLabel)) {
  $actArgs = $launch
  $actType = "protocol"
  if ([string]::IsNullOrEmpty($actArgs)) { $actArgs = "dismiss"; $actType = "system" }
  $actions = "<actions><action content=" + $q + [System.Security.SecurityElement]::Escape($actionLabel) + $q + " arguments=" + $q + [System.Security.SecurityElement]::Escape($actArgs) + $q + " activationType=" + $q + $actType + $q + " /></actions>"
}
$audio = ""
if ($sound) { $audio = "<audio src=" + $q + "ms-winsoundevent:Notification.Default" + $q + " />" }
$xml = "<toast" + $attrs + "><visual><binding template=" + $q + "ToastGeneric" + $q + "><text>" + $t + "</text><text>" + $b + "</text></binding></visual>" + $actions + $audio + "</toast>"
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
if (-not [string]::IsNullOrEmpty($tag)) { $toast.Tag = $tag }
if (-not [string]::IsNullOrEmpty($group)) { $toast.Group = $group }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
Write-Output "TOAST_SHOWN"
`;

/**
 * 撤回通知的脚本。按 tag+group 精确移除，避免误删同 appId 下别的通知；
 * tag 为空时才退回整表清理。
 */
const PS_DISMISS_TEMPLATE = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
function DecB64([string]$b) {
  if ([string]::IsNullOrEmpty($b)) { return "" }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))
}
$appId = DecB64 "__APPID_B64__"
$tag   = DecB64 "__TAG_B64__"
$group = DecB64 "__GROUP_B64__"
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
if ([string]::IsNullOrEmpty($tag)) {
  [Windows.UI.Notifications.ToastNotificationManager]::History.Clear($appId)
} else {
  [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, $group, $appId)
}
Write-Output "DISMISSED"
`;

/** 自检脚本：发一条并回读通知中心历史，用于客观验证弹窗是否真的落地。 */
const PS_VERIFY_TEMPLATE = `${PS_TEMPLATE}
Start-Sleep -Milliseconds 1200
try {
  $hist = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId))
  Write-Output ("HISTORY_COUNT=" + $hist.Count)
  if ($hist.Count -gt 0) {
    $nodes = $hist[0].Content.GetElementsByTagName("text")
    if ($nodes.Length -gt 0) { Write-Output ("HISTORY_TITLE=" + $nodes.Item(0).InnerText) }
  }
} catch {
  Write-Output ("HISTORY_ERROR: " + $_.Exception.Message)
}
`;

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/**
 * 探测当前部署形态与可用的通知通道。
 * 纯函数式：不产生副作用，便于单测。
 */
export function detectPlatform(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const procVersion = opts.procVersion ?? readProcVersion();

  if (platform === 'win32') {
    return { kind: 'windows', powershell: opts.powershell ?? findWindowsPowerShell(env), reason: 'process.platform === win32' };
  }
  if (platform === 'darwin') {
    return { kind: 'darwin', powershell: null, reason: 'macOS（本插件仅实现通知降级）' };
  }
  if (platform === 'linux') {
    const isWsl = detectWsl(procVersion, env);
    if (isWsl) {
      const ps = opts.powershell ?? findWindowsPowerShellFromWsl(env);
      return {
        kind: ps ? 'wsl' : 'linux',
        powershell: ps,
        reason: ps
          ? `WSL detected (${env.WSL_DISTRO_NAME ?? 'unknown distro'}), powershell.exe found`
          : 'WSL detected but powershell.exe not found; falling back to Linux channel',
      };
    }
    return { kind: 'linux', powershell: null, reason: 'native Linux' };
  }
  return { kind: 'unsupported', powershell: null, reason: `unsupported platform: ${platform}` };
}

export function detectWsl(procVersion, env = process.env) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return /microsoft|wsl/i.test(procVersion ?? '');
}

function readProcVersion() {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return '';
  }
}

/** Windows 原生：优先 PATH 上的 powershell.exe，其次 System32 固定位置。 */
export function findWindowsPowerShell(env = process.env) {
  const sysRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const candidate = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (env.DSH_NOTIFY_POWERSHELL) return env.DSH_NOTIFY_POWERSHELL;
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * WSL：不依赖 PATH（systemd/cron 等最小环境下 Windows PATH 常常不存在），
 * 扫描 /mnt/<盘符> 下的固定安装位置。
 */
export function findWindowsPowerShellFromWsl(env = process.env) {
  if (env.DSH_NOTIFY_POWERSHELL) return env.DSH_NOTIFY_POWERSHELL;
  const letters = (env.DSH_NOTIFY_WSL_DRIVES ?? 'cdefgh').split('');
  for (const L of letters) {
    for (const l of new Set([L.toLowerCase(), L.toUpperCase()])) {
      const p = `/mnt/${l}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 发送一条通知。永不抛异常：失败时返回 { ok:false, error }，由调用方决定是否记日志。
 * @returns {Promise<{ok:boolean, channel:string, error?:string, stdout?:string}>}
 */
export async function notify(opts = {}) {
  const {
    title = 'DSH',
    body = '',
    launch = '',
    sound = true,
    appId = DEFAULT_APP_ID,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    verify = false,
    // 持久化：reminder 场景 + 一个按钮，横幅停留在屏幕上直到用户处理它
    persistent = false,
    // 给这一条通知打标，便于之后用 dismiss() 精确撤回
    tag = '',
    group = '',
    // 持久化时按钮的文案；给了 launch 就是「打开」，否则是「关闭」
    actionLabel = persistent ? '打开会话' : '',
    target = detectPlatform(opts),
    logger = null,
    spawnImpl = spawn,
  } = opts;

  if (target.kind === 'windows' || target.kind === 'wsl') {
    if (!target.powershell) {
      return { ok: false, channel: 'powershell', error: 'powershell.exe not found' };
    }
    const script = renderTemplate(verify ? PS_VERIFY_TEMPLATE : PS_TEMPLATE, {
      __TITLE_B64__: b64(title),
      __BODY_B64__: b64(body),
      __APPID_B64__: b64(appId),
      __LAUNCH_B64__: b64(launch),
      __SCENARIO_B64__: b64(persistent ? 'reminder' : ''),
      __DURATION_B64__: b64(persistent ? 'long' : ''),
      __ACTIONLABEL_B64__: b64(actionLabel),
      __TAG_B64__: b64(tag),
      __GROUP_B64__: b64(group),
      __SOUND__: sound ? '1' : '0',
    });
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
    const res = await run(target.powershell, args, { timeoutMs, spawnImpl, logger, expect: /TOAST_SHOWN/ });
    return { ...res, channel: `powershell(${target.kind})` };
  }

  if (target.kind === 'linux') {
    // -t 0 = 不过期；持久化时再提到 critical 级别，通知中心不会自动收走
    const args = persistent
      ? ['-a', appId, '-u', 'critical', '-t', '0', title, body]
      : ['-a', appId, '-u', 'normal', title, body];
    const res = await run('notify-send', args, { timeoutMs, spawnImpl, logger });
    if (res.ok && sound) {
      // 尽力而为，失败不影响主流程
      run('canberra-gtk-play', ['-i', 'message'], { timeoutMs: 5000, spawnImpl, logger }).catch(() => {});
    }
    return { ...res, channel: 'notify-send' };
  }

  if (target.kind === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    const res = await run('osascript', ['-e', script], { timeoutMs, spawnImpl, logger });
    return { ...res, channel: 'osascript' };
  }

  return { ok: false, channel: 'none', error: target.reason };
}

/**
 * 撤回之前发出的通知（Windows / WSL 走 `History.Remove`）。
 *
 * 用户回到 dsh 页面时由宿主调用，实现「通知一直停留，直到你点它或回来」的后半句。
 * 与 `notify` 一样永不抛异常。
 *
 * @returns {Promise<{ok:boolean, channel:string, error?:string}>}
 */
export async function dismiss(opts = {}) {
  const {
    appId = DEFAULT_APP_ID,
    tag = '',
    group = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    target = detectPlatform(opts),
    logger = null,
    spawnImpl = spawn,
  } = opts;

  if (target.kind === 'windows' || target.kind === 'wsl') {
    if (!target.powershell) {
      return { ok: false, channel: 'powershell', error: 'powershell.exe not found' };
    }
    const script = renderTemplate(PS_DISMISS_TEMPLATE, {
      __APPID_B64__: b64(appId),
      __TAG_B64__: b64(tag),
      __GROUP_B64__: b64(group),
    });
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
    const res = await run(target.powershell, args, { timeoutMs, spawnImpl, logger, expect: /DISMISSED/ });
    return { ...res, channel: `powershell(${target.kind})` };
  }

  // Linux/macOS 没有等价的、按 id 撤回的通用通道（notify-send 不发回 id），
  // 只能依赖通知中心自身的过期策略；这里明确报告「不支持」而不是假装成功。
  return { ok: false, channel: target.kind, error: 'dismiss is not supported on this platform' };
}

function renderTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(k).join(v);
  return out;
}

function run(cmd, args, { timeoutMs, spawnImpl, logger, expect = /TOAST_SHOWN/ }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
      try { child.kill(); } catch {}
      finish({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (error) => finish({ ok: false, error: String(error?.message ?? error) }));
    child.on('close', (code) => {
      if (code === 0 && expect.test(stdout)) return finish({ ok: true, stdout, stderr });
      if (code === 0 && cmd === 'notify-send') return finish({ ok: true, stdout, stderr });
      if (code === 0 && cmd === 'osascript') return finish({ ok: true, stdout, stderr });
      finish({ ok: false, error: `exit ${code}${stderr ? `: ${stderr.trim()}` : ''}`, stdout, stderr });
    });
    child.unref?.();
  });
}

export const __internals = { PS_TEMPLATE, PS_VERIFY_TEMPLATE, PS_DISMISS_TEMPLATE, b64, encodeCommand, renderTemplate };
