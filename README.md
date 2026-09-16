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
- **两级前台抑制**（见下方「在场判定」）：
  - 页面不可见（切到别的标签页）或窗口失焦（切到别的应用）→ **一律提醒**
  - 页面可见有焦点，且能确定你在看哪个会话 → 只抑制**那一个**会话，后台会话照常提醒
  - 页面可见有焦点，但拿不到会话 id → 保守抑制全部（这正是「不在 dsh 页面上才弹」）
- **不做静音黑洞**：在场状态带 45 秒 TTL，标签页崩溃 / 浏览器被关掉后自动视为「离开」，不会永久静音
- **点击回跳**：Toast 可点击，**优先聚焦已有的 dsh 浏览器窗口**（没有才新开），并**自动切到出事的那条会话**
- **防刷屏**：同会话同类型通知有冷却时间；子代理会话默认不打扰；`/goal` 自动推进的中间轮次默认静默，只在目标完成 / 阻塞时提醒
- **原生 Toast 细节**：正文标注会话标题与结果摘要，带系统提示音，通知留在 Windows 通知中心等你

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
      "%1" "DeepSeek Harness"
```

**为什么还要绕一层 wscript**：`ShellExecute` 启动 `powershell.exe` 时，即便传了
`-WindowStyle Hidden`，**也会先闪一个控制台窗口**。`wscript.exe` 是 GUI 子系统宿主、
自身没有控制台，由它执行 `WshShell.Run cmd, 0, False`（0 = 隐藏窗口）拉起 PowerShell
就完全不闪。推不出 `wscript.exe` 路径时会退回直接调用 powershell（会闪，但不至于
不可用）。

Toast 的点击目标随之变成 `dshnotify:<base64url(URL)>`（base64 是为了避开 URL 里的
`&`、引号、`%` 在「命令行 → 注册表 → ShellExecute」链路上的转义问题）。处理脚本
`scripts/focus-or-open.ps1` 的行为：

1. 枚举 msedge / chrome / firefox 的顶层窗口，取标题里含 `DeepSeek Harness` 的那个
   （窗口标题即当前标签页标题，实测确实包含应用名）
2. 找到 → 若最小化先还原，再用 `SetForegroundWindow`（带 `AttachThreadInput`
   绕过前台锁）提到前台
3. 找不到 → 用默认浏览器打开目标 URL

想关掉这个行为：配置 `useProtocolHandler: false`；想彻底清除注册表项，删除
`HKCU\Software\Classes\dshnotify` 即可。

> 依赖 Windows Script Host（`wscript.exe`）。极少数用组策略禁用 WSH 的机器上协议会
> 失效，此时把 `useProtocolHandler` 设为 `false` 即退回普通 URL 行为。

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
    includeToken: true         # URL 带鉴权 token（见下方安全说明）
    useProtocolHandler: true   # 注册 dshnotify: 协议，点击优先聚焦已有窗口
    focusWindowMarker: 'DeepSeek Harness'  # 用窗口标题里的这个串识别 dsh 窗口
    focusTtlMs: 90000          # 「待跳转会话」有效期
    titlePrefix: 'DSH'
    appName: 'DeepSeek Harness'
    appId: 'DeepSeek Harness'  # Windows 通知来源名
    webUrl: ''                 # 留空则自动探测
    debug: false               # 写文件日志
    notifyOnLoad: false        # 加载时发自检通知
```

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
| `lib/host.js` | 宿主插件：事件订阅、状态累计、决策接线、URL 生成、presence 端点 |
| `lib/client.js` | 浏览器半部：在场上报 + 点击回跳切会话 |
| `lib/policy.js` | 纯逻辑：五类触发判定、前台抑制、冷却去重、goal 轮次静默 |
| `lib/presence.js` | 纯逻辑：会话级在场状态表 + TTL |
| `lib/notifier.js` | 通知投递：三态平台探测 + WinRT Toast / notify-send |

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

---

## 已知限制

- **前端不支持 `?session=` 深链**，而且鉴权的 token 换取会 `303` 丢掉查询参数（见上文「点击回跳是怎么实现的」）。所以会话跳转是**由本插件的客户端半部**调 `sessions.open()` 完成的，这也是为什么这个插件必须带客户端半部。
- 跳转的**待跳转会话有 90 秒有效期**（`focusTtlMs`）：超过这个时间再点旧通知，就只回到 dsh 页面、不再强行切会话。
- **聚焦靠窗口标题识别**：脚本用窗口标题里的 `focusWindowMarker`（默认 `DeepSeek Harness`）判断哪个浏览器窗口有 dsh。若 dsh 标签页退到别的标签后面，窗口标题会变成那个标签的标题，可能识别不到 → 退化为打开新标签页。可调 `focusWindowMarker`，或让 dsh 标签页保持在前台。
- 聚焦是**窗口级**的：脚本能把浏览器窗口提到前台，但没有浏览器调试协议（CDP）就无法精确切到某个**标签页**。若 dsh 标签页在该窗口里不是当前标签，提到前台后可能仍需手动切一下；不过它一旦获得焦点，插件也会自动把它切到目标会话。
- 同一条通知被点开后，**新标签页会先落回上次选中的会话、约 1 秒后才切到目标会话**（因为 URL 参数在鉴权重定向时被丢弃，只能由页面加载后主动索取）。实测日志可见这一跳转。
- 普通 Linux 桌面依赖 `notify-send`（多数发行版需自行安装 `libnotify-bin`）；WSL 下不需要，直接走 Windows Toast。
- presence 端点的注册清理绑定在 connection 服务的 fiber 上（框架语义），HMR 重载插件时端点可能不会随之注销，但重复注册是覆盖语义，不会报错。
- 多标签页同时打开时，每个标签页都会独立上报（这是设计如此，多标签都能各自被抑制），因此切换标签页时日志会有较多上报记录。

---

## 许可证

MIT
