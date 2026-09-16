# 实现说明（针对 dsh `0.1.6-alpha.1`）

[← 返回 README](../README.md)

这份文档面向要读代码 / 改代码的人：架构长什么样、为什么这么接线、以及写这个插件时踩到并绕开的坑。

---

## 1. 工作原理

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

---

## 2. 模块划分

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
// -> {ok:true, attended:"session-…", attendedSessions:["session-…"], mode:"session", sessionTracking:true, platform:"windows"}
```

撤回是**按会话**的：宿主用 `outstanding: Map<tag, sessionId>` 记住每条通知属于哪条会话，只在
**该会话**被看到时才撤它，外加无会话归属的（如加载自检）。不这样做的话，用户在会话 A 时，
会话 B 的通知会被 A 每 15 秒一次的心跳顺手撤掉（实测后台会话的通知只活了 2.6 秒）。

---

## 4. 针对 `0.1.6-alpha.1` 的实现要点

写这个插件时踩到并绕开的坑，都在代码注释里标了位置，这里汇总：

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

---

## 5. 测试约定

`policy.js` / `presence.js` / `notifier.js` 都不依赖 DSH 运行时，因此可以脱离 dsh 单测：

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

真实机器上的通知通道单独验证（会真的弹窗）：

```powershell
node scripts\selftest-notify.mjs "标题" "正文"
```
