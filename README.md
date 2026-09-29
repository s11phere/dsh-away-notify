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
> 一键安装器替你兜住这件事，见 [Windows 原生](#windows-原生)。

---

## 安装

### Windows 原生

**先读 [docs/windows.md](docs/windows.md)**（跨盘符会把插件装坏，而且没有任何报错）。用仓库里的
安装器，它会跑正常命令、校验结果、并修好 pnpm 弄坏的东西：

```powershell
cd <插件检出目录>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### WSL / Linux

```sh
dsh plugin --profile web add github:s11phere/dsh-away-notify
```

直接从 GitHub 装（pnpm 会自己去 clone，不需要本地检出）。要装**你改过的**版本，就把最后的 spec
换成检出目录的绝对路径：`dsh plugin --profile web add /path/to/dsh-away-notify`。

### 装完之后

**重启 `dsh web`，并刷新浏览器页面。**

新增 bundle 只有**启动时**才会被读进 `dsh.profile.bundles`；浏览器半部（`client.js`）也需要刷新
页面才会加载。profile 的 `cordis.patch.yml` 是热监视的，改配置不用重启。

验证是否挂上（不启动服务）：

```sh
dsh --profile web --dump-config | grep -A2 dsh-away-notify
```

### 首次接线自检

先确认「通知通道」本身是通的，不必等真实的回合结束：

```sh
node scripts/selftest-notify.mjs "标题" "正文"
```

它会实际弹一条 Toast，并回读 Windows 通知中心来客观确认落地。再要看插件侧的日志（`已加载` /
`已抑制(<原因>)` / `已撤回通知`），在 profile 的 `cordis.patch.yml` 里临时打开 `notifyOnLoad` 与
`debug`，步骤与接线成功的标志见
[docs/windows.md 的「通知通道自检」](docs/windows.md#3-通知通道自检)——**确认通路后记得把这两项
关掉**。

> 出问题了先看[故障排查](docs/troubleshooting.md)：不弹 / 点了回不去 / 提醒赖着不走都有对照表。

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
    includeToken: true         # URL 带鉴权 token（取舍见 docs/security.md）
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
> `includeToken` 的取舍（token 会进本机通知历史）见[安全说明](docs/security.md)。

---

## 功能

- **五类触发**（可分别开关）：回合完成、出错 / 中断 / 达到输出上限、等待审批、agent 提问、goal 完成
- **一直停留**：通知用 Windows 的 `scenario="reminder"` 发出，**不会被系统几秒后收走**——它待在
  屏幕上，直到你点它、或**切到它对应的那条会话**。撤回是**按会话**的：待在 dsh 里看别的会话不会
  误撤后台会话的通知（早期版本会，已修）
- **两级前台抑制**：见下方[在场判定](#在场判定)
- **不做静音黑洞**：在场状态带 45 秒 TTL，标签页崩溃 / 浏览器被关掉后自动视为「离开」，不会永久静音
- **点击回跳**：Toast 可点击，**优先回到已有的那个 dsh 标签页**，并**自动切到出事的那条会话**；
  浏览器窗口**最小化**时也回得去（最小化的 Chromium 窗口对 UI Automation 一个标签都不暴露，脚本
  会先把窗口还原、再选标签页）。点击后约 **0.1-0.2 秒**就把对应窗口提到前台，代价是多一个常驻的
  小助手进程。原理与实测见 [docs/click-focus.md](docs/click-focus.md)
- **多实例也认得准**：同一台机器上并存 Windows 原生与 WSL 的 dsh 时，浏览器标题带按端口区分的
  `[dsh:<port>]` 后缀，点击通知仍会聚焦到**出事的那一个实例**；细节与回退开关见
  [docs/windows.md](docs/windows.md#5-多个-dsh-实例并存windows-原生--wsl)
- **防刷屏**：同会话同类型通知有冷却时间；同一件事反复触发是**替换**而不是叠加（同 tag+group 的
  通知在 Windows 上是替换语义）；子代理会话默认不打扰；`/goal` 自动推进的中间轮次默认静默，只在
  目标完成 / 阻塞时提醒
- **原生 Toast 细节**：正文标注会话标题与结果摘要，带系统提示音，并带一个可点的操作按钮
- **可以被别的插件接管**：谁建的会话谁说了算——其它插件能声明「这条会话别打扰」以及「点它的通知
  时在右栏打开哪个 tab」，away-notify 不认识任何具体插件、也不做标题匹配，见
  [给其他插件的接口](docs/plugin-api.md)

---

## 在场判定

状态按**标签页**记录（每个标签页一个 clientId，存在 `sessionStorage`），而不是按会话——所以同一
标签页从会话 A **切到**会话 B 时，新上报会直接覆盖，**A 立刻恢复提醒**，不必等 TTL 过期。

| 情况 | 行为 |
|---|---|
| 没有任何「新鲜 + 可见 + 有焦点」的标签页 | **提醒**（视为离开） |
| 有，且能确定它在看哪个会话 | **只抑制该会话**，后台会话照常提醒（理想模式） |
| 有，但拿不到会话 id | 抑制全部（保守降级，等价于「不在页面上才弹」） |

换句话说：**切到别的标签页**（页面不可见）或**切到别的应用**（窗口失焦）→ 一律提醒。

> 打开浏览器 DevTools 会让页面失焦（`document.hasFocus()` 变 false），插件会判为「离开」——
> 这是预期行为，不是故障；此时在控制台查到的 `mode` 可能是 `away`。

上报字段、拿不到会话 id 时的自动升级、以及自查当前判定结果的控制台片段，见
[docs/implementation-notes.md](docs/implementation-notes.md#3-在场判定为什么只在你没看的时候才弹)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/windows.md](docs/windows.md) | **Windows 安装避坑**（跨盘符会装坏）、升级提醒、通知通道自检、纯 ASCII 约束、多实例共存 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 故障排查：不弹 / 点了回不去 / 提醒赖着不走等现象的对照表 |
| [docs/click-focus.md](docs/click-focus.md) | 点击回跳原理：`dshnotify:` 协议、常驻助手、UI Automation 选标签、点击延迟账、会话跳转 |
| [docs/plugin-api.md](docs/plugin-api.md) | 给其它宿主插件的 `awayNotify` 接口：抑制会话、按规则静音、改写点击落点（右栏揭示） |
| [docs/security.md](docs/security.md) | `includeToken` 的取舍：token 会进本机通知历史 |
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
**不要**再靠「写个假的 `powershell.exe` 让系统去执行」（Windows 只认 PE 映像，不认 shebang）；
假 `ctx` 的服务读取严格性、跨插件接口如何验证，见
[测试约定](docs/implementation-notes.md#5-测试约定)。

改动后建议在真机跑一遍 `node scripts/selftest-notify.mjs` 确认通知通道，再重启 dsh 手动过一遍
「离开 → 收到通知 → 点击回跳」。

---

## 许可证

MIT
