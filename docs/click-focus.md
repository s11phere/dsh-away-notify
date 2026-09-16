# 点击回跳与点击延迟

[← 返回 README](../README.md)

点一下通知要完成两件独立的事：

1. **聚焦哪个窗口** —— 把出事那个实例的浏览器窗口提到前台，并切到 dsh 那个标签页；
2. **打开哪条会话** —— 让 dsh 页面切到发通知的那条会话。

第 1 件靠自定义协议 `dshnotify:` + 一个常驻助手，第 2 件靠宿主记住 + 浏览器半部索取。

---

## 1. 聚焦已有窗口 —— `dshnotify:` 自定义协议

普通 http 链接做不到这件事：Toast 的点击由 Windows 交给默认浏览器，插件**无法控制**浏览器是
复用已有窗口还是新开一个。所以插件在加载时注册一个自定义协议（**只写
`HKCU\Software\Classes\dshnotify`，不需要管理员权限**），注册表里的命令长这样：

```
HKCU\Software\Classes\dshnotify\shell\open\command
  = "C:\Windows\System32\wscript.exe"
      "<插件目录>\scripts\enqueue-focus.vbs"
      "%1"
      "<插件目录>\.focus-spool"
```

Toast 的点击目标随之变成 `dshnotify:<base64url(URL)>`。用 base64 而不是明文 URL，是为了避开
URL 里的 `&`、引号、`%` 在「命令行 → 注册表 → ShellExecute」这条链路上被反复转义的问题。

### 为什么还要绕一层 `wscript`

`ShellExecute` 启动 `powershell.exe` 时，即便传了 `-WindowStyle Hidden`，**也会先闪一个控制台
窗口**。`wscript.exe` 是 GUI 子系统宿主、自身没有控制台，由它执行 `WshShell.Run cmd, 0, False`
（`0` = 隐藏窗口）拉起 PowerShell 就完全不闪。推不出 `wscript.exe` 路径时会退回直接调
PowerShell（会闪一下，但不至于不可用）。

> 依赖 Windows Script Host（`wscript.exe`）。极少数用组策略禁用 WSH 的机器上协议会失效，
> 此时把 `useProtocolHandler` 设为 `false` 即退回普通 URL 行为。

### 处理流程（`scripts/enqueue-focus.vbs` → `focus-helper.ps1` / `focus-or-open.ps1`）

`focus-lib.ps1` 是两条路径共用的逻辑库（快路径的助手与冷回退都 dot-source 它），所以匹配规则
只有一份，不会各写一遍而漂移。真正的处理逻辑：

1. 用**一次 `EnumWindows`** 枚举顶层窗口，取标题里含 `DeepSeek Harness` 的那个
   （窗口标题即当前标签页标题；**不按进程名过滤**，所以任何浏览器都适用）；
2. **再要求标题里含本实例的端口 tag** `[dsh:<port>]`（端口从点击 URL 里解出），
   于是只命中出事的那一个实例；
3. 标题命中 → 若最小化先还原，再用 `SetForegroundWindow`（带 `AttachThreadInput` 绕过前台锁）
   提到前台，完事；
4. **标题没命中**（多半只是 dsh 标签页不在前台）→ 用 **UI Automation** 问浏览器自己的标签列表，
   找到标题含 marker + tag 的那个 `TabItem` 并**选中它**，再把窗口提到前台；
5. 连标签都找不到 → 回退到**上次命中的窗口**（`IsWindow` 确认它还活着），仍把窗口提到前台，
   **不再开重复标签页**；
6. 连缓存窗口都没了（浏览器被关掉等）→ 才用默认浏览器打开目标 URL（落点仍然正确）。

> **第 4 步是关键。** 窗口标题只反映**当前**标签页，所以「把窗口提到前台」并不等于「回到
> dsh」——用户会停在原来那个页面上。这正是早期版本「点了通知却没回到 dsh」的原因。
> Chromium 与 Firefox 会把**每个**标签暴露成 UIA `TabItem`，其标题是该标签自己的页面标题，
> 与窗口标题无关，因此 `Select-DshTab` 能准确找到并选中它。
> 实测（本机）：`FindAll` 26ms、`SelectionItemPattern.Select()` 27ms，且只在前几步都没命中时
> 才走这条路。窗口缓存（第 5 步）是 UIA 也找不到时的最后兜底，它会记住上次命中的窗口句柄，
> 多个实例按 `marker|tag` 各记各的。
>
> 顺带一个实测细节：状态行里 `FOCUSED` 表示走的是第 3 步（标题直接命中），`TAB_FOCUSED`
> 表示走了第 4 步（UIA 选中标签）。从别的标签页点通知时必然是后者。

匹配为什么用**字面 `IndexOf`** 而不是 PowerShell 的 `-like`：tag 形如 `[dsh:3080]`，而在
`-like` 的模式里方括号是**字符集**，`*[dsh:3080]*` 几乎能匹配任何标题（只要含有 `d/s/h/:/3/0/8`
里任意一个字符），实例过滤会静默失效。真机踩到过，所以 `Test-TitleContains` 用
`StringComparison::OrdinalIgnoreCase` 的字面包含。

想关掉整个协议行为：配置 `useProtocolHandler: false`；想彻底清除注册表项，删除
`HKCU\Software\Classes\dshnotify` 即可。

---

## 2. 多实例：按端口区分的标题 tag

同一台机器上同时跑 Windows 原生和 WSL 的 dsh 时，**两边浏览器窗口的标题是完全一样的**——dsh
的前端把产品名硬编码成 `DeepSeek Harness`（`dsh-client-ui-layout`），标题格式是
`<会话标题> — DeepSeek Harness`。只按 marker 匹配必然认错窗口，于是点击 WSL 的通知可能把
Windows 那个窗口提到前台。

解决办法是给标题加一个**按端口区分**的后缀：

- 浏览器半部（`lib/client.js`）用 `location.port` 把 `document.title` 变成
  `… — DeepSeek Harness [dsh:3080]`。标题归 `dsh-client-ui-layout` 所有、会话切换时会被整体
  重写，所以客户端用 `MutationObserver` 在每次被覆盖后补回（补写是幂等的，不会打转）。
- 聚焦脚本从**点击 URL 的端口**重建同一个 tag，要求窗口标题同时含 marker 和 tag。用端口而不是
  额外传参，是因为它同时出现在地址栏和通知 URL 上，两边无需额外通信就能推导出同一个值。

由此带来两点：

- **一个协议键就够**。tag 是脚本从 URL 现推的、不写进注册表，所以 Windows 与 WSL 两边注册同一条
  `dshnotify:` 命令互不干扰（后加载的覆盖先加载的，而内容等价）。
- **两个实例的通知仍共用同一个 `appId`**（默认都是 `DeepSeek Harness`），因此在通知中心里外观
  一致、静音设置也共享。这是刻意的：点击能回到正确的窗口之后，就不需要再靠 `appId` /
  `titlePrefix` 去区分来源了。若你仍想分别静音，给其中一个 profile 单独设 `appId` 即可。

回退开关：`titleTag: false` 会让浏览器不再打后缀、协议命令里的 `tagMode` 变成 `off`，退回
「只按 marker 匹配」的旧行为（多实例时会认错窗口）。

---

## 3. 点击延迟：为什么要有一个常驻助手进程

点击一次要付三笔成本：**起 PowerShell**、**编译 P/Invoke**、**找窗口**。最初的实现（注册表直接
指向 `focus-or-open.ps1`）每一笔都重付，真机实测 **2.1 秒**才把窗口提到前台：

| 环节 | 耗时 | 说明 |
|---|---|---|
| `wscript.exe` 启动 | 6ms | 可以忽略 |
| **`powershell.exe` 进程启动** | **~950ms** | 元凶；每次点击都要重付一遍 |
| `Add-Type` 现场编译 P/Invoke | 285ms | 每次点击都要重新编译 C# |
| 找窗口（`GetProcessesByName` ×3） | 436-1101ms | 每次点击重付，见下 |
| 窗口置前 | ~10ms | |

两轮优化分别打掉了前两笔和第三笔：

1. **常驻助手**（`focus-helper.ps1`）—— 插件加载时起一次，把进程启动与 `Add-Type` 付掉，
   点击只剩「VBS 写请求文件 + `FileSystemWatcher` 唤醒」；
2. **一次 `EnumWindows` 找窗口** —— `Process.GetProcessesByName` 单次就会枚举**整台机器的
   进程**（本机 400 进程时 148-213ms），旧代码每次点击调它三次；改成直接枚举顶层窗口读标题
   （实测 0-32ms），完全不碰进程表。

```
点击
 └─ wscript.exe  enqueue-focus.vbs "%1" "<spool>"      ← 只写一个请求文件就退出
      └─ spool/req-*.txt
           └─ focus-helper.ps1（常驻，FileSystemWatcher 唤醒）← 真正置前
```

用 `FileSystemWatcher` 而不是轮询，是因为轮询要做到同等响应速度得每 50ms 醒一次（白烧 10-25%
的一个核），而事件驱动待机几乎不耗 CPU。

### 实测（以「点击 → 窗口到前台」计）

| 阶段 | 耗时 |
|---|---|
| 冷启动版（原始） | ~2100ms |
| + 常驻助手 | ~1200ms |
| + `EnumWindows` | ~100-200ms |
| 助手被杀后的下一次点击 | ~1400ms（自愈，之后恢复 ~200ms） |

在 **Windows 原生 dsh** 上按注册表真实通路复测（命中快路径）：**205 / 125 / 123 ms**——第一轮
含 `wscript` 冷启动，热态稳定 ~125ms。

> 早期 README 把 `172-245ms` 记成「点击延迟」，那实际是「请求文件被助手取走」的耗时，
> 不含真正置前。上表以端到端为准。

### 自愈与兜底

- `enqueue-focus.vbs` 用 `spool/heartbeat` 的新鲜度判断助手死活；不新鲜就顺手拉起它。
- 拉起的是冷助手，所以要等它启动；等不到（或助手彻底起不来）就直接冷跑 `focus-or-open.ps1`。
  **点击永远不会静默失败**，最坏情况只是退化成改前的 ~2 秒。
- 助手只做置前，不参与任何通知逻辑，所以它起不来最多是「点击变慢」。

> 不想要常驻进程：`useProtocolHandler: false` 会退回「点击直接开 URL」（无脚本、最快，
> 但可能多一个重复标签页）。

### 常驻助手与单实例互斥量

助手用命名互斥量保证单实例，名字**按 spool 目录区分**：

```
Local\dsh-away-notify-focus-helper-<SHA1(小写、去掉尾部分隔符的 spool 目录) 的前 12 位十六进制>
```

语义：

| 情形 | 结果 |
|---|---|
| 多个实例**共用同一个 spool**（Windows 原生 + WSL 指向同一份检出，默认如此） | **共享**一个助手 |
| 实例配了**不同的 `spoolDir`** | **各自**有一个助手 |

用 spool 目录的稳定哈希（`SHA1`）而不是 `GetHashCode()`，是因为后者跨进程不稳定，重启一次就会
换名字。

插件卸载时会往自己的 spool 写 `stop` 让助手退出——所以**共用 spool 的实例之间仍会互相影响**：
一方卸载/重载会把共享的那个助手带走，另一方下一次点击退化为冷启动，之后由
`enqueue-focus.vbs` 的心跳自愈恢复。这是「共享一个 spool」的固有代价；要彻底隔离就给两个实例
配不同的 `spoolDir`。

另外，**跨版本升级时可能残留一个旧助手进程**（旧版本用的是全局固定互斥量名），见
[Windows 安装、避坑与升级](./windows.md#2-升级提醒可能残留一个旧版焦点助手进程)。

---

## 4. 打开正确会话 —— 宿主记住 + 客户端索取

**不能用 URL 参数传会话 id**：点击打开的是带 `?token=…` 的 URL，而 dsh 的 token 换 cookie 那一步
返回 `303 Location: /`，**会把所有查询参数丢掉**（见 `dsh-client-connection` 的 `authorizeIndex`）。
实测新开的页面因此落回「上次选中的会话」，而不是出事的那条。

实际通路是：

1. 发通知时宿主记下 `pendingFocus = { sessionId, at }`（默认有效期 90 秒，`focusTtlMs`）；
2. 浏览器半部在**页面加载时**、以及**每次重新获得焦点 / 页面可见时**，调用
   `POST /api/dsh-away-notify {op:'pending-focus'}` 索取目标会话；
3. 拿到就 `sessions.open(sessionId)`，然后 `{op:'ack-focus'}` 回执清除。

因为第 2 步包含「重新获得焦点」，所以即使浏览器只是把已有窗口提到前台、并没有重新加载页面，
那个页面也会自己切到目标会话。URL 上仍保留 `?dshAwayNotifyFocus=…` 作为兼容路径，但当前鉴权
流程下通常到不了前端。

> 这也是为什么这个插件**必须带客户端半部**：会话跳转最终是由页面里的 `sessions.open()` 完成的。
