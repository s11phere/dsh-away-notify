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
- **可被其它插件显式抑制 / 改点击落点**：谁建的会话谁说了算，away-notify 不认识任何插件名，也不做
  标题/关键词匹配；插件还能声明「点这条通知时开右栏哪个 tab」（见
  [给其他插件的接口](#给其他插件的接口抑制与点击揭示)）
- **不做静音黑洞**：在场状态带 45 秒 TTL，标签页崩溃 / 浏览器被关掉后自动视为「离开」，不会永久静音
- **点击回跳**：Toast 可点击，**优先回到已有的那个 dsh 标签页**，并**自动切到出事的那条会话**；
  若触发通知的插件声明过[揭示目标](#给其他插件的接口抑制与点击揭示)（例如侧边聊天），则改为**切回它所属的主
  会话**并在右栏**打开/聚焦它那个 tab**，打不开才退回切会话。
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
// -> {ok:true, attended:"session-…", attendedSessions:["session-…"], mode:"session", sessionTracking:true, platform:"windows", suppressed:{version:1,sessions:[],rules:[]}}
```

> 打开浏览器 DevTools 会让页面失焦（`document.hasFocus()` 变 false），插件会判为「离开」——
> 这是预期行为，不是故障；此时查到的 `mode` 可能是 `away`。

机制细节见 [docs/implementation-notes.md](docs/implementation-notes.md#3-在场判定为什么只在你没看的时候才弹)。

---

## 给其他插件的接口：抑制与点击揭示

有些插件会创建**普通会话**，但它们不希望这类会话打扰用户。最典型的是 `dsh-btw-sidebar`：
侧边聊天是主会话 fork 出来的普通会话，而浏览器半部上报的「当前会话」永远是主视图那条
（`retainedBy.mainView`），所以宿主的在场判定**认不出**用户其实正看着侧栏面板里的那一条——
跑完一轮就会误弹。

修法不是让 away-notify 去匹配会话标题（关键词黑名单只要标题一改就失效，还会把别的插件卷进来），
而是把「要不要提醒、点了去哪儿」交给**创建会话的那一方**声明。away-notify 通过一个 cordis 服务
开放这个能力（服务名 `awayNotify`，实现见 [lib/suppress.js](lib/suppress.js)）。

揭示目标可以再带一个「归属主视图会话」（`mainSessionId`）。这不是可选的花活：右栏的状态
（`ctx.sidebarRight`）是**按主视图会话分域**的，`openResource(地址)` 只作用于当前挂载的那条会话，
所以点一条属于会话 A 的右栏通知时若不先切回 A，tab 会落进你当前看的 B 的右栏——左栏也不回原会话，
并且同一资源地址被两个 tab 同时持有（资源注册表按地址引用计数），只关一个不会中止资源流，会话
也就不会归档。声明方知道这个归属（它就是在哪条会话里建的），所以由它告诉 away-notify：

```js
// 在任意宿主侧插件里
const away = ctx.get('awayNotify')            // 或 ctx.inject(['awayNotify'], (c) => …) 等服务就绪
if (away) {
  // ① 抑制
  const release = away.suppressSession('session-abc', 'my-plugin') // 逐条声明；返回释放函数
  away.releaseSession('session-abc')                               // 撤销该会话的全部声明
  away.isSuppressed('session-abc')            // 诊断：返回原因标签或 undefined
  away.addRule({                              // 按「类」声明：自己决定什么条件下静音
    id: 'my-plugin',
    reason: 'my-plugin',
    match: (sessionId, event, context) =>       // context = { attended, pageAttended }
      myIds.has(sessionId) && context.pageAttended,
  })

  // ② 点击揭示：点它的通知时，先在右栏打开这个资源（已在右栏则聚焦那个 tab）。
  //    mainSessionId 可选：该资源所在的右栏属于哪条主视图会话——右栏的状态按会话分域，
  //    目标不是当前会话时浏览器半部会先切过去再打开（不传就开在当前会话里）。
  away.revealSession('session-abc', {
    resource: 'dsh-resource://my-plugin/session/abc',
    mainSessionId: 'session-parent',
    reason: 'my-plugin',
  })
  away.revealFor('session-abc')               // 诊断：{ resource, mainSessionId?, reason } | undefined
  away.snapshot()                             // 诊断：{ version, sessions, rules }
}
```

| 行为 | 说明 |
|---|---|
| 时机 | 抑制在**在场判定与冷却之前**生效，与「是否刚收到过同类通知」无关；是否与在场有关由调用方的规则决定 |
| 上下文 | 规则第三个参数是宿主提供的 `{ attended, pageAttended }`——前者「用户正看着这条会话」，后者「用户正看着 dsh 页面（可见 + 有焦点）」。`dsh-btw-sidebar` 就是用它实现「面板**显示在右栏** **且** 你在看时才静音」 |
| 原因 | `reason` 由调用方给（建议用插件 id），命中时日志写 `已抑制(suppressed:<reason>)` |
| 揭示 | `revealSession` 声明的地址会随 `op:'pending-focus'` 的应答发回浏览器半部：**先在右栏 `openResource(地址)`**（目标 tab 已开着就聚焦它、没开就新开并展开右栏），失败才退回「切到主视图那条会话」。可选的 `mainSessionId` 声明「这个右栏属于哪条主视图会话」：右栏状态按会话分域，目标不是当前会话时会先切主视图、等右栏挂载过去再打开；不传就开在当前会话里。地址对 away-notify 是不透明字符串 |
| 隔离 | away-notify **不认识任何具体插件**，也不做标题/关键词匹配；`match` 抛错视为「不抑制」（宁可多弹一条） |
| 计数 | 逐条声明按 token 引用计数：多个调用方各自释放互不影响；`releaseSession` 一次撤销该会话的**全部**声明（抑制 + 揭示） |
| 缺失 | 对方没装 / 服务未就绪时 `ctx.get('awayNotify')` 返回 `undefined`，调用方自行降级即可（点击退回主视图） |
| 版本 | 接口版本在服务对象的 `version` 字段与 `snapshot().version` 里（当前 `1`） |

排障：presence 端点的 `op:'state'` 会回显 `suppressed: { version, sessions, rules }`
（`sessions` 里同时带 `reason` 与 `reveal`），一眼能看出「这条通知为什么不弹、点了会去哪儿」。
这是给**宿主侧**插件的通路；浏览器侧插件没有对应接口（客户端半部只负责在场上报与执行揭示）。

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
| 日志里是 `已抑制(suppressed:<原因>)` | 别的插件（如 `dsh-btw-sidebar`）显式声明了这条会话不打扰——设计行为，见[给其他插件的接口](#给其他插件的接口抑制与点击揭示) |
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

`policy.js` / `presence.js` / `suppress.js` / `notifier.js` 都不依赖 DSH 运行时，可以脱离 dsh 单测：

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
