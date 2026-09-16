# dsh-away-notify

像 Codex 那样提醒你：**只有当你没在看 dsh 页面时**，任务完成 / 出错 / 等待审批 / agent 提问 / goal 完成才弹桌面通知，点击通知能回到对应会话。

同时支持两种部署：

| 部署形态 | 通知通道 |
|---|---|
| dsh 原生跑在 Windows | `powershell.exe` → WinRT Toast |
| dsh 跑在 WSL 里（本仓库的主要场景） | 调 Windows 侧 `powershell.exe` → WinRT Toast |
| dsh 跑在普通 Linux 桌面 | `notify-send`（缺失则降级为只记日志） |

零运行时依赖、零构建，`dsh plugin add` 装完即用。

---

## 功能

- **五类触发**（可分别开关）：回合完成、出错 / 中断 / 达到输出上限、等待审批、agent 提问、goal 完成
- **一直停留**：通知用 Windows 的 `scenario="reminder"` 发出，**不会被系统几秒后收走**——
  它待在屏幕上，直到你点它、或**切到它对应的那条会话**。撤回是**按会话**的：只是待在 dsh
  里看别的会话不会误撤后台会话的通知（早期版本会，已修）
- **两级前台抑制**（见下方「在场判定」）：
  - 页面不可见（切到别的标签页）或窗口失焦（切到别的应用）→ **一律提醒**
  - 页面可见有焦点，且能确定你在看哪个会话 → 只抑制**那一个**会话，后台会话照常提醒
  - 页面可见有焦点，但拿不到会话 id → 保守抑制全部（这正是「不在 dsh 页面上才弹」）
- **不做静音黑洞**：在场状态带 45 秒 TTL，标签页崩溃 / 浏览器被关掉后自动视为「离开」，不会永久静音
- **点击回跳**：Toast 可点击，**优先回到已有的那个 dsh 标签页**（窗口标题命中不了时用 UI Automation 选中对应标签；都没有才新开），并**自动切到出事的那条会话**
- **多实例也认得准**：同一台机器上并存 Windows 原生与 WSL 的 dsh 时，点击通知仍会聚焦到
  **出事的那一个实例**的窗口，不会跑错（见下方「多个 dsh 实例并存」）
- **点击即到**：点击后约 **0.1-0.2 秒**就把对应窗口提到前台（改前是 2.1 秒，见下方
  「点击延迟」的两轮优化）。代价是多一个常驻的小助手进程
- **防刷屏**：同会话同类型通知有冷却时间；同一件事反复触发是**替换**而不是叠加
  （同 tag+group 的通知在 Windows 上是替换语义）；子代理会话默认不打扰；
  `/goal` 自动推进的中间轮次默认静默，只在目标完成 / 阻塞时提醒
- **原生 Toast 细节**：正文标注会话标题与结果摘要，带系统提示音，并带一个可点的操作按钮

### 点击回跳是怎么实现的

分两件事：**聚焦哪个窗口** 和 **打开哪条会话**。

#### 1. 聚焦已有窗口 —— `dshnotify:` 自定义协议

普通 http 链接做不到这一点：Toast 的点击由 Windows 交给默认浏览器，插件无法控制
浏览器是复用已有窗口还是新开。所以插件在加载时注册一个自定义协议
（**只写 `HKCU\Software\Classes\dshnotify`，不需要管理员权限**）：

```
HKCU\Software\Classes\dshnotify\shell\open\command
  = "C:\Windows\System32\wscript.exe"
      "<插件目录>\scripts\run-hidden.vbs"
      "<插件目录>\scripts\focus-or-open.ps1"
      "%1" "DeepSeek Harness" "port"
```

最后一个参数是 `tagMode`（`port` / `off`），对应配置项 `titleTag`，见下方
「多个 dsh 实例并存」。

**为什么还要绕一层 wscript**：`ShellExecute` 启动 `powershell.exe` 时，即便传了
`-WindowStyle Hidden`，**也会先闪一个控制台窗口**。`wscript.exe` 是 GUI 子系统宿主、
自身没有控制台，由它执行 `WshShell.Run cmd, 0, False`（0 = 隐藏窗口）拉起 PowerShell
就完全不闪。推不出 `wscript.exe` 路径时会退回直接调用 powershell（会闪，但不至于
不可用）。

Toast 的点击目标随之变成 `dshnotify:<base64url(URL)>`（base64 是为了避开 URL 里的
`&`、引号、`%` 在「命令行 → 注册表 → ShellExecute」链路上的转义问题）。处理脚本
`scripts/focus-or-open.ps1` 的行为：

1. 用一次 `EnumWindows` 枚举顶层窗口，取标题里含 `DeepSeek Harness` 的那个
   （窗口标题即当前标签页标题；不按进程名过滤，所以任何浏览器都适用）
2. **再要求标题里含本实例的端口 tag** `[dsh:<port>]`（端口从点击 URL 里解出），
   于是只命中出事的那一个实例
3. 标题命中 → 若最小化先还原，再用 `SetForegroundWindow`（带 `AttachThreadInput`
   绕过前台锁）提到前台，完事
4. **标题没命中**（多半只是 dsh 标签页不在前台）→ 用 **UI Automation** 问浏览器自己的
   标签列表，找到标题含 marker + tag 的那个 `TabItem` 并**选中它**，再把窗口提到前台
5. 连标签都找不到 → 回退到上次命中的窗口（`IsWindow` 确认还活着），仍把窗口提到前台，
   **不再开重复标签页**
6. 连缓存窗口都没了（浏览器被关等）→ 才用默认浏览器打开目标 URL（落点仍然正确）

> 第 4 步是关键。窗口标题只反映**当前**标签页，所以「把窗口提到前台」并不等于「回到
> dsh」——用户会停在原来那个页面上（这正是早期版本「点了通知却没回到 dsh」的原因）。
> Chromium 与 Firefox 会把**每个**标签暴露成 UIA `TabItem`，其标题是该标签自己的页面
> 标题，跟窗口标题无关，因此 `Select-DshTab` 能准确找到并选中它。本机实测：`FindAll`
> 26ms、`SelectionItemPattern.Select()` 27ms，且只在前几步都没命中时才走这条路。
> 窗口缓存（第 5 步）是 UIA 也找不到时的最后兜底；它会记住上次命中的窗口句柄，多个实例
> 按 `marker|tag` 各记各的。

想关掉这个行为：配置 `useProtocolHandler: false`；想彻底清除注册表项，删除
`HKCU\Software\Classes\dshnotify` 即可。

> 依赖 Windows Script Host（`wscript.exe`）。极少数用组策略禁用 WSH 的机器上协议会
> 失效，此时把 `useProtocolHandler` 设为 `false` 即退回普通 URL 行为。

#### 多个 dsh 实例并存（Windows 原生 + WSL）

同一台机器上同时跑 Windows 原生和 WSL 的 dsh 时，**两边浏览器窗口的标题是完全一样的**——
dsh 的前端把产品名硬编码成 `DeepSeek Harness`（`dsh-client-ui-layout`），标题格式是
`<会话标题> — DeepSeek Harness`。只按 marker 匹配必然认错窗口，于是点击 WSL 的通知
可能把 Windows 那个窗口提到前台。

解决办法是给标题加一个**按端口区分**的后缀：

- 浏览器半部（`lib/client.js`）用 `location.port` 把 `document.title` 变成
  `… — DeepSeek Harness [dsh:3081]`。标题归 `dsh-client-ui-layout` 所有、会话切换时
  会被整体重写，所以客户端用 `MutationObserver` 在每次被覆盖后补回（补写是幂等的，
  不会打转）。
- 聚焦脚本从**点击 URL 的端口**重建同一个 tag，要求窗口标题同时含 marker 和 tag。
  用端口而不是额外传参，是因为它同时出现在地址栏和通知 URL 上，两边无需额外通信
  就能推导出同一个值。

由此带来两点：

- **一个协议键就够**。tag 是脚本从 URL 现推的，不写进注册表，所以 Windows 与 WSL
  两边注册同一条 `dshnotify:` 命令也互不干扰（后加载的覆盖先加载的，而内容等价）。
- **两个实例的通知仍共用同一个 `appId`**（默认都是 `DeepSeek Harness`），因此在通知
  中心里外观一致、静音设置也共享。这是刻意的：点击能回到正确的窗口之后，就不需要
  再靠 `appId` / `titlePrefix` 去区分来源了。若你仍想分别静音，给其中一个 profile
  单独设 `appId` 即可。

回退开关：`titleTag: false` 会让浏览器不再打后缀、协议命令里的 `tagMode` 变成 `off`，
退回「只按 marker 匹配」的旧行为（多实例时会认错窗口）。

#### 点击延迟：为什么要有一个常驻助手进程

点击一次要付三笔成本：**起 PowerShell**、**编译 P/Invoke**、**找窗口**。最初的实现
（注册表直接指向 `focus-or-open.ps1`）每一笔都重付，真机实测 **2.1 秒**才把窗口提到前台：

| 环节 | 耗时 | 说明 |
|---|---|---|
| `wscript.exe` 启动 | 6ms | 可以忽略 |
| **`powershell.exe` 进程启动** | **~950ms** | 元凶；每次点击都要重付一遍 |
| `Add-Type` 现场编译 P/Invoke | 285ms | 每次点击都要重新编译 C# |
| 找窗口（`GetProcessesByName` ×3） | 436-1101ms | 每次点击重付，见下 |
| 窗口置前 | ~10ms | |

两轮优化分别打掉了前两笔和第三笔：

1. **常驻助手**（`focus-helper.ps1`）—— 插件加载时起一次，把进程启动与 Add-Type 付掉，
   点击只剩「VBS 写请求文件 + FileSystemWatcher 唤醒」。
2. **一次 `EnumWindows` 找窗口** —— `Process.GetProcessesByName` 单次就会枚举整台机器的
   进程（本机 400 进程时 148-213ms），旧代码每次点击调它三次；改成直接枚举顶层窗口读标题
   （实测 0-32ms），完全不碰进程表。

```
点击
 └─ wscript.exe  enqueue-focus.vbs "%1" "<spool>"      ← 只写一个请求文件就退出
      └─ spool/req-*.txt
           └─ focus-helper.ps1（常驻，FileSystemWatcher 唤醒）← 真正置前
```

`focus-helper.ps1` 在插件加载时起一次，把进程启动与 Add-Type 付掉并一直待命；点击时只剩
「VBS 写文件 + 事件唤醒 + 一次 EnumWindows + 置前」。用 `FileSystemWatcher` 而不是轮询，
是因为轮询要做到同等响应速度得每 50ms 醒一次（白烧 10-25% 的一个核），而事件驱动待机
几乎不耗 CPU。

实测（同一台机器，以「点击 → 窗口到前台」计）：

| 阶段 | 点击 → 窗口到前台 |
|---|---|
| 冷启动版（原始） | ~2100ms |
| + 常驻助手 | ~1200ms |
| + `EnumWindows`（当前） | **~100-200ms** |
| 助手被杀后的下一次点击 | ~1400ms（自愈，之后恢复 ~200ms） |

> 早期 README 把 `172-245ms` 记成「点击延迟」，那实际是「请求文件被助手取走」的耗时，
> 不含真正置前。上表以端到端为准。

`focus-lib.ps1` 是两条路径共用的逻辑库：`focus-helper.ps1`（快路径）和
`focus-or-open.ps1`（回退）都 dot-source 它，所以匹配规则不会各写一份而漂移。

自愈与兜底：

- enqueue 脚本用 `spool/heartbeat` 的新鲜度判断助手死活；不新鲜就顺手拉起它。
- 拉起的是冷助手，所以要等它启动；等不到（或助手彻底起不来）就直接冷跑
  `focus-or-open.ps1`。**点击永远不会静默失败**，最坏情况只是退化成改前的 ~2 秒。
- 助手用命名互斥量保证单实例；插件卸载时写 `spool/stop` 让它退出。

> 不想要常驻进程：`useProtocolHandler: false` 会退回「点击直接开 URL」（无脚本，最快，
> 但可能多一个重复标签页）。

#### 2. 打开正确会话 —— 宿主记住 + 客户端索取

**不能用 URL 参数传会话 id**：点击打开的是带 `?token=…` 的 URL，而 dsh 的 token 换
cookie 那一步返回 `303 Location: /`，**会把所有查询参数丢掉**（见
`dsh-client-connection` 的 `authorizeIndex`）。实测新开的页面因此落回「上次选中的
会话」，而不是出事的那条。

实际通路是：

1. 发通知时宿主记下 `pendingFocus = { sessionId, at }`（默认有效期 90 秒，`focusTtlMs`）
2. 浏览器半部在**页面加载时**、以及**每次重新获得焦点/页面可见时**，调用
   `POST /api/dsh-away-notify {op:'pending-focus'}` 索取目标会话
3. 拿到就 `sessions.open(sessionId)`，然后 `{op:'ack-focus'}` 回执清除

因为第 2 步包含「重新获得焦点」，所以即使浏览器只是把已有窗口提到前台、并没有重新
加载页面，那个页面也会自己切到目标会话。URL 上仍保留 `?dshAwayNotifyFocus=…` 作为
兼容路径，但当前鉴权流程下通常到不了前端。

### 在场判定

状态按 **clientId（每个标签页一个，存在 `sessionStorage`）** 记录，而不是按会话。
这一点很关键：

- 同一标签页从会话 A **切到**会话 B 时，新上报会直接覆盖该标签页的记录，
  **A 立刻恢复提醒**，不必等 TTL 过期。
  （早期版本按会话存时间戳，导致切换会话后旧会话在 45 秒内仍被当成「正在看」而漏报，
  这是实测踩到并修掉的 bug。）
- 多个标签页各有自己的 clientId，可以**同时**被抑制。

浏览器半部每次上报 `{clientId, sessionId?, visible, focused}`，宿主判定：

| 情况 | 行为 |
|---|---|
| 没有任何「新鲜 + 可见 + 有焦点」的标签页 | **提醒**（视为离开） |
| 有，且能确定它在看哪个会话 | **只抑制该会话**，后台会话照常提醒（理想模式） |
| 有，但拿不到会话 id | 抑制全部（保守降级，等价于「不在页面上才弹」） |

正常情况下运行在理想模式（实测日志 `mode=session`，会话 id 正确）。`sessionId` 缺省的
分支是为客户端启动早期准备的：那时 `sessions.list.getSnapshot()` 还是
`phase: "pending"`、`ids` 为空、`current` 为 `undefined`，应用完全就绪后才可用。
客户端每次心跳都会重试，**一旦拿到会话 id 就自动升级，无需重启**。

> 注意：打开浏览器 DevTools 会让页面失去焦点（`document.hasFocus()` 变 false），
> 此时插件会判为「离开」——这是预期行为，不是故障。若在控制台里查询状态，看到的
> `mode` 可能是 `away`。

另外，上报做了去重节流：相同载荷在心跳周期内只发一次，只有状态真正变化
（切换标签页 / 失焦 / 切换会话）才立刻发送。

想自查当前判定结果，可在页面控制台执行：

```js
fetch('/api/dsh-away-notify',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({op:'state'})}).then(r=>r.json()).then(console.log)
// -> {ok:true, attended:"session-…", attendedSessions:["session-…"], mode:"session", sessionTracking:true, platform:"wsl"}
```

---

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-away-notify
```

装完**重启 `dsh web`** 并刷新浏览器页面。

验证是否挂上（不启动服务）：

```sh
dsh --profile web --dump-config | grep -A2 dsh-away-notify
```

### Windows 上必须先看这一节（跨盘符会装出坏插件）

在 Windows 上，只要**插件检出与 `$DSH_HOME`（默认 `C:\Users\<你>\.dsh`）不在同一个盘符**，
上面那条 `dsh plugin add` 就会**静默装出一个永远不会加载的插件**：

- pnpm 的 `hoisted` nodeLinker（由 dsh 的 profile 模板自己写进 `pnpm-workspace.yaml`）
  会把 `link:` 的**绝对路径当成相对路径**解析，于是建出的 junction 指向
  `C:\Users\<你>\.dsh\profiles\web\F:\project\...\dsh-away-notify`
  —— profile 目录被硬拼在绝对路径前面，包根本解析不到；
- 包解析不到 → `dsh plugin` 认为它「没有声明 `dsh.bundle`」，于是**不把它加进
  `dsh.profile.bundles`**，并打一条**方向完全错误**的 warning：

  ```
  dsh: warning: dsh-away-notify declares no dsh.bundle - installed as a plain dependency
  ```

- 更糟的是**命令退出码是 0**。而且**它还会把已经注册好的 bundle 删掉**：重跑一次
  `pnpm install` / `dsh plugin add` 会让一个原本工作正常的安装从
  `dsh.profile.bundles` 里消失。也就是说「重装一次」等于「把插件悄悄卸掉」。

**用这个脚本装**（它会跑正常命令，然后**校验**结果并修好 pnpm 弄坏的东西）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

它会：跑 `dsh plugin add` → 检查 junction 是否真能解析 → 坏了就用 `rmdir` + `mklink /J`
重建（**绝不 `Remove-Item -Recurse`**：PS 5.1 会顺着 junction 把目标内容删掉，也就是
把你的插件源码删了）→ 确认包名在 `dsh.profile.bundles` 里 → 用 `--dump-config` 复验。
`-WhatIfOnly` 只报告不改动，`-Profile <名字>` 可指定别的 profile。

**想根治**（让原版 `dsh plugin add` 也能用）二选一：

1. 把插件检出放到与 `$DSH_HOME` **同一个盘符**；或
2. 把 profile 的 `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` 改成 `isolated`
   （实测跨盘符可用；但 `hoisted` 是 dsh 模板刻意选的，改动前想清楚）。

### 首次接线自检

在 profile 的 `cordis.patch.yml` 里打开自检，重启后应立刻收到一条「通知已就绪」的 Toast：

```yaml
- id: dsh-away-notify
  config:
    notifyOnLoad: true
    debug: true
```

`debug: true` 会把插件日志写到 `$DSH_HOME/dsh-away-notify.log`。确认通路后把这两项关掉。

也可以脱离 DSH 单独验证通知通道：

```sh
node scripts/selftest-notify.mjs "标题" "正文"
```

它会实际弹一条 Toast，并回读 Windows 通知中心来客观确认落地。

---

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（该文件被热监视，但**新增 bundle 后首次仍需重启**）：

```yaml
- id: dsh-away-notify
  config:
    # 五类触发
    onTurnComplete: true
    onTurnError: true
    onTurnAborted: true
    onTurnMaxTokens: true
    onApproval: true
    onQuestion: true
    onGoalComplete: true
    # 行为
    suppressGoalRounds: true   # /goal 中间轮次静默
    rootsOnly: true            # 子代理会话不打扰
    cooldownMs: 10000          # 同会话同类型最小间隔
    presenceTtlMs: 45000       # 在场状态有效期
    previewMaxChars: 140       # 正文摘要截断长度
    sound: true                # 系统提示音
    openOnClick: true          # Toast 可点击回跳
    persistent: true           # 通知一直停留，直到点它或切回 dsh
    dismissOnReturn: true      # 切到某会话时撤回它自己的通知（按会话比对，不误伤别的会话）
    includeToken: true         # URL 带鉴权 token（见下方安全说明）
    useProtocolHandler: true   # 注册 dshnotify: 协议，点击优先聚焦已有窗口
    titleTag: true             # 给标题加 [dsh:<port>]，多实例时精确聚焦对应窗口
    spoolDir: ''               # 点击请求与焦点助手的工作目录；留空 = <插件目录>/.focus-spool
    focusWindowMarker: 'DeepSeek Harness'  # 用窗口标题里的这个串识别 dsh 窗口
    focusTtlMs: 90000          # 「待跳转会话」有效期
    titlePrefix: 'DSH'
    appName: 'DeepSeek Harness'
    appId: 'DeepSeek Harness'  # Windows 通知来源名
    webUrl: ''                 # 留空则自动探测
    debug: false               # 写文件日志
    notifyOnLoad: false        # 加载时发自检通知
```

> `appName` 目前**没有接线**（声明了但无处读取），改它不会有效果；要区分通知来源请改 `appId`。

---

## 安全说明：`includeToken`

dsh 的 Web UI 在端口上要求鉴权（裸访问返回 `401 dsh web authentication required`）。
`includeToken: true`（默认）会把进程的启动 token 拼进 Toast 的点击 URL，好处是**即使浏览器完全关闭，点击通知也能直接进入界面**。

代价是：该 token 会出现在**本机 Windows 通知中心的历史记录**里。它是一个 localhost 令牌，且通知历史只有本机可见，但如果你不接受这一点，改成 `includeToken: false`——那样在浏览器已打开（有 cookie）时一切照常，只有浏览器全关时点击会落到 401 页面。

插件**不会**把该 URL 写进日志。

---

## 工作原理

```
浏览器（lib/client.js）                        宿主（lib/host.js）
┌────────────────────────────┐   POST /api/    ┌──────────────────────────────┐
│ sessions.list 当前会话      │  dsh-away-notify│ connection.fetch.register     │
│ visibilitychange / focus /  │ ───────────────►│   → PresenceStore(TTL 45s)    │
│ blur / 心跳 15s             │                 │                               │
│                             │                 │ ctx.on('session/event')       │
│ ?dshAwayNotifyFocus=<id>    │                 │   turn/end · approval/asked   │
│   → sessions.open(id)       │                 │   goal/change · user/message  │
└────────────────────────────┘                 │ ctx.on('user-questions/request')│
                                                │        │                      │
                                                │   policy.decide()             │
                                                │   （前台抑制 / 冷却 / 过滤）   │
                                                │        ▼                      │
                                                │   notifier → WinRT Toast      │
                                                └──────────────────────────────┘
```

### 模块划分

| 文件 | 职责 |
|---|---|
| `lib/host.js` | 宿主插件：事件订阅、状态累计、决策接线、URL 生成、presence 端点、拉起焦点助手 |
| `lib/client.js` | 浏览器半部：在场上报 + 点击回跳切会话 + 实例标题 tag |
| `lib/policy.js` | 纯逻辑：五类触发判定、前台抑制、冷却去重、goal 轮次静默 |
| `lib/presence.js` | 纯逻辑：会话级在场状态表 + TTL |
| `lib/notifier.js` | 通知投递：三态平台探测 + WinRT Toast（持久化 / 撤回）/ notify-send |
| `lib/protocol.js` | `dshnotify:` 协议：URI 编解码、注册表命令组装（enqueue / direct 两态） |
| `scripts/enqueue-focus.vbs` | 点击入口：只写请求文件，顺带保证助手活着（快路径） |
| `scripts/focus-helper.ps1` | 常驻助手：FileSystemWatcher 唤醒后置前（快路径的执行者） |
| `scripts/focus-lib.ps1` | 共享逻辑：一次 `EnumWindows` 找窗口（marker + 端口 tag 字面匹配）、UI Automation 选中标签页、置前、窗口缓存兜底、最后才开 URL |
| `scripts/focus-or-open.ps1` | 一次性处理器：助手不可用时的冷回退，也可手工调试 |
| `scripts/run-hidden.vbs` | 无窗口闪烁启动 PowerShell（助手启动与冷回退共用） |
| `scripts/selftest-notify.mjs` | 脱离 dsh 单独验证通知通道并回读通知中心 |
| `scripts/install-windows.ps1` | Windows 安装器：跑 `dsh plugin add` 后校验并修好 pnpm 在跨盘符时弄坏的 junction 与 bundle 注册（见「Windows 上必须先看这一节」） |

`policy.js` / `presence.js` / `notifier.js` 都不依赖 DSH 运行时，因此可以脱离 dsh 单测：

```sh
node --test
```

---

## 针对 0.1.6-alpha.1 的实现要点

写这个插件时踩到并绕开的坑，都在代码注释里标了位置，这里汇总：

1. **不能用 `connection.rpc.handle`**。它在 0.1.6 上不可用：内部执行 `owner.webServer.register(route)`，而 `owner` 是 connection 插件自己的 ctx，那个 ctx 从未注入 `webServer`（`/api` 路由是在 `ctx.inject(["webServer"], webCtx => …)` 里用 webCtx 注册的），必然抛 `cannot get property "webServer" without inject`。DSH 自身对此 API 也是零调用。改用 `connection.fetch.register({ path: '/api/...' })`——它只依赖 `owner.effect`，且因为挂在 `/api` 前缀下，**同样受 Host/Origin 围栏与浏览器鉴权保护**（已实测无 cookie 返回 401）。

2. **不能读 `session.events`**。该属性在 0.1.6 已被删除（只剩 `@deprecated` 的 `eventAt`/`snapshotEvents`/`ownEvents`）。所有判断改为在 `ctx.on('session/event')` 上**增量累计** per-session 状态。

3. **提问要走 `user-questions/request` waterfall**，不能扫 `tool/call`。0.1.6 的 PTC 改成独立进程后模型只直呼 `run_code`，嵌套的 `ask_user_question` 不会以顶层 `tool/call` 出现，扫描会漏。该 waterfall 是观察者，必须 `return next()`。

4. **PowerShell 编码坑**：PS 5.1 以 ANSI 读取无 BOM 的 UTF-8 `.ps1` 会整个解析失败（实测 `0xC00CE56D`）。因此把脚本保持**纯 ASCII**，标题 / 正文 / URL 一律以 UTF-8 base64 内联，在 PowerShell 内解码。

5. **`-EncodedCommand` 不能再跟其它参数**，所以数据只能内联进脚本。好处是**不落临时文件**，连 WSL 的 `wslpath` 路径转换都省了。

6. **成功判定不能靠退出码**：PS 5.1 即使脚本没加载成功也可能退出 0，且 stdout 回读是 OEM 代码页（中文会乱码）。因此脚本在 `Show()` 返回后打印 ASCII 标记 `TOAST_SHOWN`，插件以此判成功。

7. **客户端 bundle 不能 require 非 seed 内部包**。`@deepseek-ai/dsh-client-ui-slots` 这类是前端 shell 的 seed 静态模块（不是 npm 包），而 `dsh-client-runtime` 已彻底退役。本插件的客户端半部不 require 任何模块。

8. **交给 Windows 程序的路径一律要转换，不只是注册表那一条**。从 WSL 里 `spawn` 一个 Windows exe 时，**参数里的路径**同样是 Windows 程序在读：把 `/mnt/d/...` 递给 `wscript.exe` 会被当成未知选项，并**弹出模态错误对话框**（真机踩到：dsh 启动时弹「指定了未知的选项"…/run-hidden.vbs"」）。所以启动焦点助手时 `.vbs` 与 `.ps1` 都经 `toWindowsPath`，并加 `//B` 批处理模式——即使将来还有别的错误，也只静默失败，不会弹窗打扰。可执行文件本身仍用 WSL 路径（那是 WSL 侧 `spawn` 用的）。

---

## 已知限制

- **前端不支持 `?session=` 深链**，而且鉴权的 token 换取会 `303` 丢掉查询参数（见上文「点击回跳是怎么实现的」）。所以会话跳转是**由本插件的客户端半部**调 `sessions.open()` 完成的，这也是为什么这个插件必须带客户端半部。
- 跳转的**待跳转会话有 90 秒有效期**（`focusTtlMs`）：超过这个时间再点旧通知，就只回到 dsh 页面、不再强行切会话。
- **聚焦 = 窗口标题 + UI Automation**：先在顶层窗口标题里找 marker + tag；找不到时用 UI Automation 选中对应的浏览器**标签页**（Chromium 与 Firefox 会把每个标签暴露成 `TabItem`），所以 dsh 标签不在前台时点击也能真正回到 dsh。只有当 UIA 不可用（组策略禁用、或非 Chromium/Firefox 的浏览器）时，才退化为「只把上次命中的窗口提到前台」，此时需要手动点一下 dsh 标签。
- 同一条通知被点开后，若走的是**新开标签页**那条路，新页面会先落回上次选中的会话、约 1 秒后才切到目标会话（因为 URL 参数在鉴权重定向时被丢弃，只能由页面加载后主动索取）。实测日志可见这一跳转。
- **持久通知依赖 `scenario="reminder"` + 一个按钮**：Windows 会忽略没有按钮的 reminder 场景（退化成普通通知，几秒后收走）。插件因此在持久化时总会带上按钮。另外 `reminder` 通知不会被 Focus Assist / 勿扰静默掉，这是系统行为。
- **`titleTag` 会改写标签页标题**：这是多实例精确聚焦的代价（`… — DeepSeek Harness [dsh:3081]`）。不喜欢可以设 `titleTag: false`，代价是多个实例并存时会认错窗口。
- **焦点助手是个常驻 PowerShell 进程**（约 50-70MB），这是把点击端到端从 2.1s 降到 ~0.1-0.2s 的代价，见「点击延迟」。互斥量**按 spool 目录区分**（`Local\dsh-away-notify-focus-helper-<spool 目录的短哈希>`）：共用同一个 spool 的多个实例（Windows 原生 + WSL 指向同一份检出）**共享**一个助手，而配了不同 `spoolDir` 的实例各自有一个。插件卸载时会往自己的 spool 写 `stop` 让它退出——所以**共用 spool 的实例之间仍会互相影响**：一方卸载/重载会把共享的那个助手带走，下一次点击由 `enqueue-focus.vbs` 检测到心跳过期后重新拉起（约 1.4s），之后恢复 ~0.2s。若助手意外死亡，行为同上。
- **助手重载期间可能有一次慢点击**：插件 HMR 重载时旧助手收到 `stop` 退出、新助手可能因互斥量抢先失败而退出，于是下一次点击要等心跳过期后重新拉起。只影响一次。
- 普通 Linux 桌面依赖 `notify-send`（多数发行版需自行安装 `libnotify-bin`）；WSL 下不需要，直接走 Windows Toast。Linux 上持久化用 `notify-send -u critical -t 0` 近似，但**撤回通知没有通用通道**，`dismissOnReturn` 在 Linux 上不生效。
- presence 端点的注册清理绑定在 connection 服务的 fiber 上（框架语义），HMR 重载插件时端点可能不会随之注销，但重复注册是覆盖语义，不会报错。
- 多标签页同时打开时，每个标签页都会独立上报（这是设计如此，多标签都能各自被抑制），因此切换标签页时日志会有较多上报记录。
- **测试不产生真实副作用**：宿主测试通过 `apply(ctx, config, deps)` 的第三个参数注入假的 `spawnImpl` / `spawnSyncImpl`，因此既不会真的弹通知，也不会真的写 `HKCU\Software\Classes\dshnotify`，`spoolDir` 也指向临时目录。**这不是可选的洁癖**：早期版本把一段 `#!/bin/sh` 脚本写成 `powershell.exe` 再让宿主去执行它，在 Linux/macOS 上能跑，但在 Windows 上**必然失败**（Windows 只把 `.exe` 当 PE 映像加载、不认 shebang），四条依赖「脚本真的发出去了」的用例会永远红。新增会触发通知或注册协议的用例时，请通过 `applyHost(ctx, config, fake.deps)` 沿用这条通路。

---

## 许可证

MIT
