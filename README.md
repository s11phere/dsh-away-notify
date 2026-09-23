# dsh-away-notify

像 Codex 那样提醒你：**只有当你没在看 dsh 页面时**，任务完成 / 出错 / 等待审批 / agent 提问 /
goal 完成才弹桌面通知，点击通知能回到对应会话。

零运行时依赖、零构建，`dsh plugin add` 装完即用。

## 部署形态

| 部署形态 | 通知通道 |
|---|---|
| dsh 原生跑在 Windows | `powershell.exe` → WinRT Toast |
| dsh 跑在 WSL 里 | 调 Windows 侧 `powershell.exe` → WinRT Toast |
| dsh 跑在普通 Linux 桌面 | `notify-send`（缺失则降级为只记日志） |

> ⚠️ **Windows 用户请先看 [docs/windows.md](docs/windows.md)。** 插件检出与 `$DSH_HOME` 不在
> 同一盘符时，`dsh plugin add` 会**静默装出一个永远不会加载的插件**——退出码还是 0。仓库里带了
> 一键安装器替你兜住这件事，见[安装](#windows)。

---

## 功能

- **五类触发**（可分别开关）：回合完成、出错 / 中断 / 达到输出上限、等待审批、agent 提问、goal 完成
- **一直停留**：通知用 Windows 的 `scenario="reminder"` 发出，**不会被系统几秒后收走**——它待在
  屏幕上，直到你点它、或**切到它对应的那条会话**。撤回是**按会话**的：待在 dsh 里看别的会话不会
  误撤后台会话的通知（早期版本会，已修）
- **两级前台抑制**：见下方[在场判定](#在场判定)
- **不做静音黑洞**：在场状态带 45 秒 TTL，标签页崩溃 / 浏览器被关掉后自动视为「离开」，不会永久静音
- **点击回跳**：Toast 可点击，**优先回到已有的那个 dsh 标签页**，并**自动切到出事的那条会话**。
  浏览器窗口**最小化**时也回得去：最小化的 Chromium 窗口对 UI Automation **一个标签都不暴露**，
  所以脚本会先把窗口还原、再选标签页（早期版本在这里只会把窗口提到前台，人却停在原来那个
  标签页上）。真的选不中标签时，宁可多开一个标签页也不把你留在原标签页
- **多实例也认得准**：同一台机器上并存 Windows 原生与 WSL 的 dsh 时，点击通知仍会聚焦到**出事的
  那一个实例**
- **点击即到**：点击后约 **0.1-0.2 秒**就把对应窗口提到前台（改前是 2.1 秒；窗口最小化时约
  0.25 秒，多付一次 `SW_RESTORE`）。代价是多一个常驻的小助手进程
- **防刷屏**：同会话同类型通知有冷却时间；同一件事反复触发是**替换**而不是叠加（同 tag+group 的
  通知在 Windows 上是替换语义）；子代理会话默认不打扰；`/goal` 自动推进的中间轮次默认静默，只在
  目标完成 / 阻塞时提醒
- **原生 Toast 细节**：正文标注会话标题与结果摘要，带系统提示音，并带一个可点的操作按钮

点击回跳与延迟优化的原理见 [docs/click-focus.md](docs/click-focus.md)。

### 在场判定

状态按**标签页**记录（每个标签页一个 clientId，存在 `sessionStorage`），而不是按会话——所以同一
标签页从会话 A **切到**会话 B 时，新上报会直接覆盖，**A 立刻恢复提醒**，不必等 TTL 过期。

| 情况 | 行为 |
|---|---|
| 没有任何「新鲜 + 可见 + 有焦点」的标签页 | **提醒**（视为离开） |
| 有，且能确定它在看哪个会话 | **只抑制该会话**，后台会话照常提醒（理想模式） |
| 有，但拿不到会话 id | 抑制全部（保守降级，等价于「不在页面上才弹」） |

换句话说：**切到别的标签页**（页面不可见）或**切到别的应用**（窗口失焦）→ 一律提醒。

自查当前判定结果，在页面控制台执行：

```js
fetch('/api/dsh-away-notify',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({op:'state'})}).then(r=>r.json()).then(console.log)
// -> {ok:true, attended:"session-…", attendedSessions:["session-…"], mode:"session", sessionTracking:true, platform:"windows"}
```

> 打开浏览器 DevTools 会让页面失焦（`document.hasFocus()` 变 false），插件会判为「离开」——
> 这是预期行为，不是故障；此时查到的 `mode` 可能是 `away`。

机制细节见 [docs/implementation-notes.md](docs/implementation-notes.md#3-在场判定为什么只在你没看的时候才弹)。

---

## 安装

### Windows

**先读 [docs/windows.md](docs/windows.md)**（跨盘符会把插件装坏，而且没有任何报错）。用仓库里的
安装器，它会跑正常命令、校验结果、并修好 pnpm 弄坏的东西：

```powershell
cd <插件检出目录>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### WSL / Linux

```sh
dsh plugin --profile web add /path/to/dsh-away-notify
```

### 装完之后

**重启 `dsh web`，并刷新浏览器页面。**

新增 bundle 只有**启动时**才会被读进 `dsh.profile.bundles`；浏览器半部（`client.js`）也需要刷新
页面才会加载。profile 的 `cordis.patch.yml` 是热监视的，改配置不用重启。

验证是否挂上（不启动服务）：

```sh
dsh --profile web --dump-config | grep -A2 dsh-away-notify
```

### 首次接线自检

在 profile 的 `cordis.patch.yml` 里临时打开自检：

```yaml
- id: dsh-away-notify
  config:
    notifyOnLoad: true   # 加载时弹一条「通知已就绪」，确认接线
    debug: true          # 写 $DSH_HOME/dsh-away-notify.log
```

重启后应立刻收到一条 Toast，日志里会出现 `已加载 (windows)` / `已注册 dshnotify: 协议` /
`presence 端点已注册` / `焦点助手已启动`。**确认通路后把这两项关掉**（`notifyOnLoad` 会让每次启动
都弹一条自检，`debug` 的日志会一直增长）。

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
`includeToken: true`（默认）会把进程的启动 token 拼进 Toast 的点击 URL，好处是**即使浏览器完全
关闭，点击通知也能直接进入界面**。

代价是：该 token 会出现在**本机 Windows 通知中心的历史记录**里。它是一个 localhost 令牌，且通知
历史只有本机可见；如果你不接受这一点，改成 `includeToken: false`——那样在浏览器已打开（有 cookie）
时一切照常，只有浏览器全关时点击会落到 401 页面。

插件**不会**把该 URL 写进日志（有单测与真机日志双重确认）。

---

## 多实例（Windows 原生 + WSL 并存）

同一台机器上同时跑两个 dsh 时，**两边浏览器窗口的标题完全一样**，只按标题匹配必然认错窗口。
插件给标题加一个**按端口区分**的后缀（`… — DeepSeek Harness [dsh:3080]`），聚焦脚本要求 marker
与 tag 同时命中，因此点击哪个实例的通知就回到哪个实例。

回退开关：`titleTag: false` 会让浏览器不再打后缀，退回「只按 marker 匹配」的旧行为（多实例时会
认错窗口）。

两个实例在默认配置下共用同一个 `appId` 和同一个 spool（也就是**共用同一个焦点助手进程**），
细节与影响见 [docs/windows.md](docs/windows.md#5-多个-dsh-实例并存windows-原生--wsl)。

---

## 故障排查

| 现象 | 先查什么 |
|---|---|
| 重启后完全没有反应 | `dsh --profile web --dump-config` 里有没有 `- id: dsh-away-notify`？没有就是跨盘符安装问题，见 [docs/windows.md](docs/windows.md#1-跨盘符安装会装出一个永远不会加载的插件) |
| 挂上了但不弹 | 先单独验证通道：`node scripts\selftest-notify.mjs`。通道 OK 就开 `debug: true` 看 `已抑制(<原因>)` |
| 一直不弹，日志里全是 `已抑制(attended-foreground)` | 你正看着那条会话——设计行为。切到别的标签页或别的应用再试 |
| 日志里是 `已抑制(subagent-session)` | 子代理会话默认不打扰（`rootsOnly: true`） |
| 点了通知没回到 dsh | 看 `.focus-spool\last-status.txt`：`FOCUSED` / `TAB_FOCUSED` 说明脚本执行了；`TAG_MISS` 说明标题里没有本实例的 tag（检查 `titleTag`、以及页面是否已刷新）；`NO_WINDOW` 说明连 marker 都没匹配到。**`FOCUSED … CACHED`** 表示窗口提到了前台但标签页没选中（浏览器不支持 UI Automation / 组策略禁用）。旧版本遇到「浏览器最小化」就会走到这里——更新插件后**重启 dsh** 让焦点助手换成新脚本 |
| 第一次点不回去、第二次才行 | 这是 v0.1.7-alpha.1 上的真实缺陷（浏览器最小化时 Chromium 不向 UI Automation 暴露标签页，旧脚本只聚焦不切标签）。本版本已修：先把窗口还原再选标签页。若仍复现，确认 `.focus-spool\last-status.txt` 里有没有 `RESTORED`，并检查助手进程的启动时间是否早于插件更新 |
| 点了通知多出一个标签页 | 说明标签页确实选不中（旧页面没有 tag、浏览器非 Chromium/Firefox、或 dsh 标签已不存在），脚本按「宁可多开也不把你留在原标签页」处理，状态行以 `OPENED` 结尾 |
| 点击要等一两秒 | 助手进程不在了。看 `.focus-spool\heartbeat` 的 mtime 是不是一秒一跳，见 [docs/windows.md](docs/windows.md#2-升级提醒可能残留一个旧版焦点助手进程) |
| 通知几秒就消失 | 只有 `persistent: true` 才会用 `scenario="reminder"` + 按钮常驻；另外 reminder 场景**必须带按钮**，否则 Windows 会退化成普通通知 |
| 回到 dsh 后提醒还赖着不走 | 控制台 `op:'state'` 看 `sessionTracking`。为 `false` 说明客户端拿不到会话 id，按会话撤回（`dismissOnReturn`）不生效。旧 bundle 跑在新 dsh 上会这样：更新插件后**刷新页面** |
| 页面控制台查到 `mode: away` | 你开着 DevTools，页面失焦了——预期行为 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/windows.md](docs/windows.md) | **Windows 安装避坑**（跨盘符会装坏）、升级提醒、通知通道自检、纯 ASCII 约束、多实例共存 |
| [docs/click-focus.md](docs/click-focus.md) | 点击回跳原理：`dshnotify:` 协议、常驻助手、UI Automation 选标签、点击延迟账、会话跳转 |
| [docs/implementation-notes.md](docs/implementation-notes.md) | 架构图、模块划分、在场判定机制、针对 dsh `0.1.6` / `0.1.7` 的实现要点、测试约定 |
| [docs/known-limitations.md](docs/known-limitations.md) | 完整的已知限制（会话跳转 / 聚焦 / 通知 / 进程资源 / 框架行为） |
| [docs/verification-windows.md](docs/verification-windows.md) | Windows 原生端到端验证记录：环境、覆盖矩阵、真实日志证据、两个 Windows 独有缺陷 |

---

## 开发

`policy.js` / `presence.js` / `notifier.js` 都不依赖 DSH 运行时，可以脱离 dsh 单测：

```sh
node --test
```

新增会触发通知或注册协议的用例时，请沿用 `apply(ctx, config, deps)` 的 spawn 注入通路——
**不要**再靠「写个假的 `powershell.exe` 让系统去执行」（Windows 只认 PE 映像，不认 shebang），
详见 [测试约定](docs/implementation-notes.md#5-测试约定)。

改动后建议在真机跑一遍 `node scripts/selftest-notify.mjs` 确认通知通道，再重启 dsh 手动过一遍
「离开 → 收到通知 → 点击回跳」。

---

## 许可证

MIT
