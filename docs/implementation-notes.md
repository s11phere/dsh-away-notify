# 实现说明（面向 dsh `0.1.7-rc.1`，兼容 `0.1.6` / `0.1.7`）

[← 返回 README](../README.md)

这份文档面向要读代码 / 改代码的人：架构长什么样、为什么这么接线、以及写这个插件时踩到并绕开的坑。

---

## 1. 工作原理

```
浏览器（lib/client.js）                        宿主（lib/host.js）
┌────────────────────────────┐   POST /api/    ┌──────────────────────────────┐
│ 当前会话（§4.1 有版本差异） │  dsh-away-notify│ connection.fetch.register     │
│ visibilitychange / focus /  │ ───────────────►│   → PresenceStore(TTL 45s)    │
│ blur / 心跳 15s             │                 │                               │
│                             │                 │ ctx.on('session/event')       │
│ ?dshAwayNotifyFocus=<id>    │                 │   turn/end · approval/asked   │
│   → uiWorkspace.openSession │                 │   goal/change · user/message  │
└────────────────────────────┘                 │ ctx.on('user-questions/request')│
                                                │        │                      │
                                                │   policy.decide()             │
                                                │   （插件抑制 / 前台抑制 /     │
                                                │     冷却 / 过滤）             │
                                                │        ▼                      │
                                                │   notifier → WinRT Toast      │
                                                └────────▲──────────────────────┘
                                                         │ SuppressionRegistry
                                                         │ ctx.provide('awayNotify')
                                                         │ ← suppressSession / addRule
                                                         │ ← revealSession（点击去哪儿）
                                                ┌────────┴─────────────────────┐
                                                │ 其它宿主插件（如 btw-sidebar）│
                                                │ 声明「什么条件下不打扰」      │
                                                └──────────────────────────────┘
```

---

## 2. 模块划分

| 文件 | 职责 |
|---|---|
| `lib/host.js` | 宿主插件：事件订阅、状态累计、决策接线、URL 生成、presence 端点、拉起焦点助手 |
| `lib/client.js` | 浏览器半部：在场上报 + 点击回跳切会话 + 实例标题 tag |
| `lib/policy.js` | 纯逻辑：五类触发判定、显式抑制、前台抑制、冷却去重、goal 轮次静默 |
| `lib/presence.js` | 纯逻辑：会话级在场状态表 + TTL |
| `lib/suppress.js` | 纯逻辑：会话通知策略注册表（逐条 claim 引用计数 + 按类规则 + 点击揭示目标），即 `awayNotify` 服务的实现 |
| `lib/notifier.js` | 通知投递：三态平台探测 + WinRT Toast（持久化 / 撤回）/ notify-send |
| `lib/protocol.js` | `dshnotify:` 协议：URI 编解码、注册表命令组装（enqueue / direct 两态） |
| `scripts/enqueue-focus.vbs` | 点击入口：只写请求文件，顺带保证助手活着（快路径） |
| `scripts/focus-helper.ps1` | 常驻助手：FileSystemWatcher 唤醒后置前（快路径的执行者） |
| `scripts/focus-lib.ps1` | 共享逻辑：一次 `EnumWindows` 找窗口（marker + 端口 tag 字面匹配）、还原最小化窗口后按 120ms 重试 UI Automation 选标签页、已知窗口内的缺 tag 宽松兜底、窗口缓存（含落盘）、最后才开 URL |
| `scripts/focus-or-open.ps1` | 一次性处理器：助手不可用时的冷回退，也可手工调试 |
| `scripts/run-hidden.vbs` | 无窗口闪烁启动 PowerShell（助手启动与冷回退共用） |
| `scripts/selftest-notify.mjs` | 脱离 dsh 单独验证通知通道并回读通知中心 |
| `scripts/install-windows.ps1` | Windows 安装器：跑 `dsh plugin add` 后校验并修好 pnpm 在跨盘符时弄坏的 junction 与 bundle 注册 |

点击回跳与延迟优化的细节在 [点击回跳与点击延迟](./click-focus.md)。

---

## 3. 在场判定（为什么「只在你没看的时候」才弹）

状态按 **clientId（每个标签页一个，存在 `sessionStorage`）** 记录，而**不是**按会话。这一点很关键：

- 同一标签页从会话 A **切到**会话 B 时，新上报会直接覆盖该标签页的记录，**A 立刻恢复提醒**，
  不必等 TTL 过期。（早期版本按会话存时间戳，导致切换会话后旧会话在 45 秒内仍被当成「正在看」
  而漏报，这是实测踩到并修掉的 bug。）
- 多个标签页各有自己的 clientId，可以**同时**被抑制。

浏览器半部每次上报 `{clientId, sessionId?, visible, focused}`，宿主判定见
[README 的在场判定表](../README.md#在场判定)。正常情况下运行在理想模式（实测日志
`mode=session`，会话 id 正确）。

`sessionId` 缺省的分支是为客户端启动早期准备的：那时 `sessions.list.getSnapshot()` 还是
`phase: "pending"`、`ids` 为空、`current` 为 `undefined`，应用完全就绪后才可用。客户端每次心跳
都会重试，**一旦拿到会话 id 就自动升级，无需重启**。

上报做了去重节流：相同载荷在心跳周期内只发一次，只有状态真正变化（切换标签页 / 失焦 / 切换
会话）才立刻发送。

自查当前判定结果，在页面控制台执行：

```js
fetch('/api/dsh-away-notify',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({op:'state'})}).then(r=>r.json()).then(console.log)
// -> {ok:true, attended:"session-…", attendedSessions:["session-…"], mode:"session", sessionTracking:true, platform:"windows", suppressed:{version:1,sessions:[],rules:[]}}
```

撤回是**按会话**的：宿主用 `outstanding: Map<tag, sessionId>` 记住每条通知属于哪条会话，只在
**该会话**被看到时才撤它，外加无会话归属的（如加载自检）。不这样做的话，用户在会话 A 时，
会话 B 的通知会被 A 每 15 秒一次的心跳顺手撤掉（实测后台会话的通知只活了 2.6 秒）。

### 3.1 抑制与点击揭示（给其它插件的 `awayNotify` 服务）

在场判定只能回答「用户在看**哪条**会话」，回答不了「这条会话是不是**根本不该打扰**」，也
回答不了「点它的通知该去哪儿」。最典型的反例是 `dsh-btw-sidebar` 的侧边聊天：它是主会话 fork
出来的普通会话，用户正看着侧栏面板里的它，但浏览器半部上报的「当前会话」永远是主视图那条
（[§4.1](#41-017-的客户端-api-迁移浏览器半部)），于是 `isAttended(childId)` 为 false，跑完一轮
就误弹；而点通知又会把它当成一条普通会话、在主视图里开出来。

`lib/suppress.js` 的 `SuppressionRegistry` 同时管这两件事（一条声明可以只抑制、只揭示，或两者
兼有，互不干扰）：

- `claim(sessionId, reason)` —— 逐条抑制，内部按自增 token 引用计数，返回释放函数；
  同一会话被多个插件声明时，一个释放不影响另一个。
- `reveal(sessionId, { resource, mainSessionId, reason })` —— 声明「点这条会话的通知时，先在右栏
  打开这个资源地址」。地址对 away-notify 是不透明字符串，它只负责随 `op:'pending-focus'` 的应答
  转发；浏览器半部拿它调 `ctx.sidebarRight.openResource(地址)`——右栏按 `contentId`（就是地址本身）
  查重，**已开着的 tab 会被聚焦而不是重复开一个**；没有 tab 类型认领 / 右栏服务缺失时抛错或
  缺席，就地退回「切主视图那条会话」。可选的 `mainSessionId` 是「这个右栏属于哪条主视图会话」：
  右栏状态按会话分域（`bySession[sessionId]`），`openResource` 只作用于当前挂载的那条，所以目标
  不是当前会话时浏览器半部会先切过去、等 `sidebarRight.mounted` 确认再打开——不带它就退回旧行为
  （直接开在当前会话里）。
- `addRule({ id, reason, match })` —— 按「类」声明；`match(sessionId, event, context)` 的判断权
  在调用方，`context` 是宿主给的 `{ attended, pageAttended }`（「用户在看这条会话」/「用户在看
  dsh 页面」），于是「面板显示在右栏 **且** 你在看时才静音」这种语义不需要 away-notify 懂任何业务。
  规则抛错记为「不命中」（宁可多弹一条，也不能因为第三方插件的 bug 让通知链路失效），错误会进
  `snapshot()` 供排障。
- 查询走 `reasonFor(sessionId, event, context)`（逐条声明优先于规则）与 `revealFor(sessionId)`。

`host.js` 用 `ctx.provide('awayNotify', …)` 把注册表开放出去（`version: 1`），`policy.decide`
里排在场与冷却**之前**判定抑制。为什么不在这里做标题/关键词匹配：那是消费者替生产者猜语义，
标题一改就失效，还会把别的插件的会话卷进来。为什么不自己写一套「侧边会话」识别：DSH 没有可写的
会话标记位（`SessionForkRequest` 只有 `sessionId`/`atSeq`，session header 也没有可扩展字段，
`origin` 只允许 `'subagent'`），所以只能由创建方声明。

跨插件服务的可见性已核实：同为 web profile 里 `insert:` 兄弟条目的 `dsh-workspace-changes` 用
`ctx.provide("workspaceChanges", …)`，`dsh-client-ui-deliverables` 在 `inject` 里列它后直接
`ctx.workspaceChanges.summary(...)` 消费。`provide` 会 `notify` 依赖方，因此 away-notify 晚于
消费方加载也没问题。诊断通路：`op:'state'` 回显 `suppressed`（每条会话带 `reason` 与 `reveal`）。

---

## 4. 针对 dsh `0.1.6` / `0.1.7` 的实现要点

写这个插件时踩到并绕开的坑，都在代码注释里标了位置，这里汇总：

### 4.1 `0.1.7` 的客户端 API 迁移（浏览器半部）

`0.1.7` 把「视图选择」从 sessions 控制器里搬了出去（该控制器源码注释：
*"Host catalog and local reference allocator; view selection remains outside the Controller."*），
浏览器半部因此有两个 API 失效。两处都写成「先试旧、再试新」的兼容形式，
所以同一个 bundle 在 `0.1.6` 与 `0.1.7` 上都能工作：

| 用途 | `0.1.6` | `0.1.7` 替代 | 失效后果（若只写旧 API） |
|---|---|---|---|
| 用户正在看哪个会话 | `sessions.list.getSnapshot().current` | `byId[].retainedBy.mainView > 0` 的那条 | 上报退化为无 sessionId → 宿主进入页面级模式，`dismissOnReturn` 永远匹配不上，通知不再随你回到会话而撤回 |
| 切到目标会话 | `sessions.open(id)` | `uiWorkspace.openSession(id)` | 点击通知回跳静默失败（异常被吞，重试 40 次后放弃） |

`0.1.7` 的列表快照只剩 `{ids, byId, phase, projectionsBySession}`，`current` **不再被任何人写入**，
所以不能只判断「字段不存在」，而要在 `byId` 里找主视图 retain 的那条
（`dsh-client-ui-session` 的 `publishMain` 是它的唯一写入方）。
`uiWorkspace` 可能晚于 `sessions` 就绪，因此切换 API 是**调用时现取**，不是 `apply` 时缓存。

其余宿主侧契约在 `0.1.7` 上未变（已逐条核对）：`session/event`、`turn/end` 的四种
reason、`goal/change` 的 `complete`/`block`、`approval/asked` 的 `toolName`/`reason`、
`approval/policy`、`user-questions/request` waterfall、`connection.fetch.register`、
`sessionTitle.get`、`sessionProjections.snapshot`、`webServer.port`、`connection.authenticatedUrl`。

#### 4.1.1 `0.1.7-rc.1` 复核（2026-09-24）

在安装好的 `@deepseek-ai/dsh@0.1.7-rc.1` 上按**包内类型声明**逐项复核了本插件接触的每个
契约，结论是全部未变（因此本次修复不需要任何版本分支）：

| 契约 | 复核位置（rc.1 包内） | 结论 |
|---|---|---|
| 客户端 bundle 装载协议 | `dsh-client-modules`（`window.__ModuleLoader__.load({id, factory})`、`dsh.client` 声明解析） | 未变；`dsh.client.inject` 仍被解析（`external` 是新增的另一项，本插件两者都为空） |
| 当前会话判定 | `dsh-api-session-controller` 的 `SessionListState`（`ids/byId/phase/projectionsBySession`）+ `dsh-client-ui-session` 的 `publishMain` | `byId[].retainedBy.mainView` 仍是唯一写入方，`dsh-client-ui-layout` 也用同一形状 |
| 会话切换 | `dsh-client-ui-workspace` 的 `UiWorkspace.openSession(target: SessionTarget)` | 存在，签名兼容 |
| 列表订阅 | `dsh-client-store` 的 `ObservableSnapshot`（`getSnapshot` / `subscribe`） | 未变 |
| 浏览器标题 | `dsh-client-ui-layout` 的 `DocumentTitle`（`document.title = "… — DeepSeek Harness"`） | 产品名未变，`focusWindowMarker` 默认值仍然正确 |
| host 事件 | `dsh-session`（`session/event`、`turn/end.reason` 的 `completed/aborted/blocked/error/max-tokens/interrupted/forked`）、`dsh-goal`（`goal/change.operation` 含 `complete`/`block`）、`dsh-user-approval`（`approval/asked` / `approval/policy`，取值 `ask`/`never`）、`dsh-user-questions`（`user-questions/request` waterfall、`request.agent.id`、`request.questions[].question`） | 全部未变 |
| host 服务 | `dsh-client-connection` 的 `HostConnectionHandle`（`fetch.register` / `authenticatedUrl`）、`dsh-session-title.get`、`dsh-session-projection`（`snapshot(session, keys) → { values }`） | 全部未变 |

真机旁证（同一台机器）：插件加载后焦点助手在 **dsh 启动的同一秒**被拉起（host 半部执行了
`startFocusHelper` + 注册协议），浏览器标签标题带 `[dsh:3080]` 后缀（client 半部执行了
`apply`），`HKCU\Software\Classes\dshnotify` 命令指向本检出与 spool——即 rc.1 上两侧都真的
接线成功，而不仅仅是类型上兼容。

### 4.2 `0.1.6` 时代就存在的坑

1. **不能用 `connection.rpc.handle`**。它在 0.1.6 上不可用：内部执行 `owner.webServer.register(route)`，
   而 `owner` 是 connection 插件自己的 ctx，那个 ctx 从未注入 `webServer`（`/api` 路由是在
   `ctx.inject(["webServer"], webCtx => …)` 里用 webCtx 注册的），必然抛
   `cannot get property "webServer" without inject`。DSH 自身对此 API 也是零调用。改用
   `connection.fetch.register({ path: '/api/...' })`——它只依赖 `owner.effect`，且因为挂在 `/api`
   前缀下，**同样受 Host/Origin 围栏与浏览器鉴权保护**（已实测无 cookie 返回 401）。

2. **不能读 `session.events`**。该属性在 0.1.6 已被删除（只剩 `@deprecated` 的
   `eventAt`/`snapshotEvents`/`ownEvents`）。所有判断改为在 `ctx.on('session/event')` 上
   **增量累计** per-session 状态。

3. **提问要走 `user-questions/request` waterfall**，不能扫 `tool/call`。0.1.6 的 PTC 改成独立进程后
   模型只直呼 `run_code`，嵌套的 `ask_user_question` 不会以顶层 `tool/call` 出现，扫描会漏。该
   waterfall 是观察者，必须 `return next()`。

4. **PowerShell 编码坑**：PS 5.1 以 ANSI 读取无 BOM 的 UTF-8 `.ps1` 会**整个解析失败**（实测
   `0xC00CE56D`）。因此把脚本保持**纯 ASCII**，标题 / 正文 / URL 一律以 UTF-8 base64 内联，
   在 PowerShell 内解码。详见 [Windows 文档](./windows.md#4-约束随包的-powershell-脚本必须纯-ascii)。

5. **`-EncodedCommand` 不能再跟其它参数**，所以数据只能内联进脚本。好处是**不落临时文件**，
   连 WSL 的 `wslpath` 路径转换都省了。

6. **成功判定不能靠退出码**：PS 5.1 即使脚本没加载成功也可能退出 0，且 stdout 回读是 OEM 代码页
   （中文会乱码）。因此脚本在 `Show()` 返回后打印 ASCII 标记 `TOAST_SHOWN`，插件以此判成功。

7. **客户端 bundle 不能 require 非 seed 内部包**。`@deepseek-ai/dsh-client-ui-slots` 这类是前端
   shell 的 seed 静态模块（不是 npm 包），而 `dsh-client-runtime` 已彻底退役。本插件的客户端半部
   **不 require 任何模块**。

8. **交给 Windows 程序的路径一律要转换，不只是注册表那一条**。从 WSL 里 `spawn` 一个 Windows exe
   时，**参数里的路径**同样是 Windows 程序在读：把 `/mnt/d/...` 递给 `wscript.exe` 会被当成未知
   选项，并**弹出模态错误对话框**（真机踩到：dsh 启动时弹「指定了未知的选项"…/run-hidden.vbs"」）。
   所以启动焦点助手时 `.vbs` 与 `.ps1` 都经 `toWindowsPath`，并加 `//B` 批处理模式——即使将来
   还有别的错误，也只静默失败，不会弹窗打扰。可执行文件本身仍用 WSL 路径（那是 WSL 侧 `spawn`
   用的）。原生 Windows 上 `toWindowsPath` 直接短路返回。

9. **最小化的 Chromium 窗口对 UI Automation 完全不暴露标签页**（本机 Edge 153 实测：
   `FromHandle` 成功、`ClassName` 正常，但 `FindAll(Descendants, TabItem)` 返回 **0**；
   `SW_RESTORE` 后约 **95ms** 才恢复）。点击回跳因此必须先还原窗口再搜标签，并且要重试；
   否则「窗口提到了前台、人却还在原来那个标签页上」。这一条不是 dsh 版本问题，纯 Windows /
   Chromium 行为，详见[点击回跳的实测](./click-focus.md#实测最小化的浏览器窗口对-uia-不暴露标签页)。

---

## 5. 测试约定

`policy.js` / `presence.js` / `suppress.js` / `notifier.js` 都不依赖 DSH 运行时，因此可以脱离 dsh 单测：

```sh
node --test
```

`tests/host.test.mjs` 用一个假 `ctx` 驱动宿主，其中通知与协议注册的**进程启动**通过
`apply(ctx, config, deps)` 的第三个参数注入假的 `spawnImpl` / `spawnSyncImpl`：

```js
const fake = makeFakeSpawn();                       // 纯 JS 替身，记录 -EncodedCommand 明文
applyHost(ctx, {}, fake.deps);                      // applyHost 默认注入静默替身
```

**新增会触发通知或注册协议的用例时请沿用这条通路**，理由不是洁癖：早期版本是把一段 `#!/bin/sh`
脚本写成 `powershell.exe` 让宿主去执行它，在 Linux/macOS 上能跑，但 **Windows 只会把 `.exe` 当 PE
映像加载、完全不认 shebang**，`spawn` 必然失败，于是四条依赖「脚本真的发出去了」的用例在 Windows
上永远红。现在的做法在三个平台跑同一条路径，测试也不再有任何真实副作用（不弹通知、不写注册表、
不 spawn 真的 `wscript.exe`）。

假 `ctx` 另外实现了 `provide`（记进 `ctx.services`），`tests/host.test.mjs` 据此断言 `awayNotify`
的服务面，并验证「被抑制的会话确实不再产生通知脚本、释放后恢复」「规则能拿到 `pageAttended`」，
`tests/client.test.mjs` 用最小 DOM 桩验证揭示目标的优先级（右栏 → 主视图 → 回执），以及跨会话
揭示的时序（先切归属会话 → 等 `mounted` → 才 `openResource`；右栏还没挂载过去时**不得**开）。
抑制是决策层的事，不能只测 `lib/suppress.js` 就以为接线是对的。

跨插件的**服务注册与消费**则用工作区根目录下的 `.probe/verify-away-notify-suppression.mjs` 验证：
把 away-notify 与 btw 的宿主半部装进同一个最小 cordis 语境，跑一遍「fork → 开面板且被看着就静音 →
切走恢复提醒 → `pending-focus` 带回 reveal → 关面板后恢复 → aborted 永不提醒 → 别的会话不受影响」。
包内的 `node --test` 覆盖不到这一环，但恰恰是最容易「两边都绿、合起来不工作」的地方。

真实机器上的通知通道单独验证（会真的弹窗）：

```powershell
node scripts\selftest-notify.mjs "标题" "正文"
```
