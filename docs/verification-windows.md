# Windows 原生验证记录

[← 返回 README](../README.md)

这份文档记录在 **Windows 原生 dsh** 上对插件做的端到端验证，包含环境、覆盖范围、关键证据，
以及验证期间发现的两个 Windows 独有缺陷。

> 验证时的插件版本是 `a928c5d`（当时的单测结果是 147 pass / 4 fail，4 条是测试自身的
> Linux-only 写法）。这两个缺陷随后都已修掉，当时 `npm test` 在 Windows 上是 **153 pass / 0 fail**
> （2026-09-24 复验时是 **163 pass / 0 fail**，见 [§7.4](#74-本轮新增的自动化用例)）。
> 缺陷的详情与规避方式见 [Windows 安装、避坑与升级](./windows.md)。
>
> **2026-09-24 复验**：dsh `0.1.7-rc.1` 上复现并修掉了「浏览器最小化时点击通知回不到 dsh」
> 的缺陷，见 [§7](#7-2026-09-24-复验dsh-017-rc1点击回跳缺陷与-rc1-适配)。

---

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 Home China 25H2，build 26200.8655 |
| dsh | `0.1.6-alpha.1` |
| node / pnpm | v24.11.0 / 10.20.0 |
| PowerShell | Windows PowerShell **5.1**.26100.8655 |
| 浏览器 | Edge 153.0.4234.32 |
| `DSH_HOME` | `C:\Users\<用户>\.dsh`，profile = `web` |
| **Windows 实例** | `127.0.0.1:`**`3080`**（`dsh web`） |
| **WSL 实例** | `127.0.0.1:`**`3081`**（经 `wslrelay`） |
| 插件检出 | 与 `$DSH_HOME` **不同盘符**（这正是触发跨盘符安装缺陷的条件） |

验证期间 **Windows 与 WSL 两个 dsh 实例同时在线**，两边共用同一个插件检出、同一个
`.focus-spool`、同一个注册表协议键——这让「多实例」一项第一次有了真实环境。

---

## 2. 覆盖结果

| 组 | 项 | 结果 |
|---|---|---|
| **安装** | `dsh plugin add` | ❌ 跨盘符会装出坏插件（详见 [Windows 文档](./windows.md#1-跨盘符安装会装出一个永远不会加载的插件)） |
| | 单测 `npm test` | ⚠️ 147 pass / 4 fail（测试自身的 Linux-only 写法） |
| | `--dump-config` 挂载 | ✅ `- id: dsh-away-notify` 进入 profile 树 |
| **A** 激活自检 | A1–A6 + H1 | ✅ 全部通过，`platform=windows` |
| **B** 触发 | B1 回合完成 | ✅ 两次 |
| | B4 提问 | ✅ 正文即问题内容 |
| | B2 / B3 / B5 | ⬜ 未测 |
| **C** 在场抑制 | C1 看着会话不弹 | ✅ 三次 `已抑制(attended-foreground)` |
| | C2 标签页不可见 | ✅ |
| | C3 可见但窗口失焦 | ✅ |
| | C4 后台会话照常提醒 | ✅ **通知存活 28s 未被心跳误撤** |
| | C5 同标签页切会话 | ✅ 由 C4 反推证实 |
| | C6 / C7 | ⬜ 未测 |
| **D** 持久与撤回 | D1 横幅停留 | ✅ 用户确认 + 客观存活 28s |
| | D2 进通知中心 | ✅ |
| | D3 回 dsh 精确撤回 | ✅ 四次 `已撤回通知(看到会话) … ok=true` |
| | D4 同 tag 替换 | ✅ `dshan-1` 被复用而非叠加 |
| | D5 不同事各自保留 | ✅ `dshan-1/2/3` 并存 |
| **E** 点击回跳 | E1 聚焦已有窗口 | ✅ |
| | E2 切回目标会话 | ✅ 点击 B 的通知后落到会话 B |
| | E3 点击延迟 | ✅ **205 / 125 / 123 ms**（热态 ~125ms） |
| | E4 实例 tag 命中 | ✅ `tag=[dsh:3080]` |
| | E5 多实例不认错 | ✅ **标签页级**通过（窗口级无法测，见 §4） |
| | E6–E9 | ⬜ 未测 |
| **F** 防刷屏 | F2 子代理不打扰 | ✅ `已抑制(subagent-session)` |
| | F1 / F3 / F4 | ⬜ 未测 |
| **G** 配置开关 | — | ⬜ 未测（仅验证 patch 层注入的 `debug`/`notifyOnLoad` 生效） |
| **H** 安全 | H1 日志无 token | ✅ 0 处 |
| | H2 点击 URL 含 token | ⬜ 未复测（平台无关的既有取舍） |

日志总量：66 行；`已通知` ×4、`已抑制` ×4、`已撤回通知` ×4。

---

## 3. 关键证据

### 3.1 激活自检（插件日志原文）

```
已加载 (windows)   {"reason":"process.platform === win32",
                    "powershell":"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"}
焦点助手已启动（点击延迟约 0.15s 而非 2s）
已注册 dshnotify: 协议（点击通知将优先聚焦已有窗口）
加载自检通知: 成功   {"channel":"powershell(windows)"}
presence 端点已注册: /api/dsh-away-notify
收到在场上报  {"sessionId":null,"visible":true,"focused":true,"mode":"page"}
收到在场上报  {"sessionId":"session-…","mode":"session","attended":["session-…"]}
```

日志里 `"url"` / `"launch"` / `"uri"` / `token=` 匹配数为 **0**（不发 URL，符合设计）。

### 3.2 判定与撤回的完整时间线

| 事件 | 对应用例 |
|---|---|
| `vis=False foc=False mode=away` → **`已通知(turn-complete)`** | B1 + C2 |
| `vis=True foc=True` → **`已撤回通知(看到会话) tag=dshan-1 ok=true`** | D3 |
| `已抑制(subagent-session)` | **F2** |
| 第二次 `已通知(turn-complete)`，撤回时 tag 仍是 **`dshan-1`** | D4（同 tag 替换） |
| **`已抑制(attended-foreground)`** ×3 | **C1**（人在页面上不弹） |
| `vis=True foc=False mode=away` → **`已通知(question)`**，撤回 tag `dshan-2` | **C3 + B4 + D5** |
| `已通知(turn-complete)` 且 `sessionId` 是**另一条会话** → 存活 **28s** → 由**那条会话**的在场上报撤回 | **C4 + E2** |

### 3.3 C4：后台会话提醒 + 「别人的心跳误撤通知」的回归

早期版本有个真实缺陷：**人在会话 A 时，会话 B 的通知会被 A 每 15 秒一次的心跳误撤**（实测只活了
2.6 秒）。修复方式是把「待撤回」与**通知所属会话**绑定。

Windows 上实测这条修复：为**会话 B** 发出通知时，被判定在场上的是**会话 A**；之后 A 的心跳至少
上报 3 次，通知**存活了 28 秒**才由**会话 B 的**在场上报撤掉。旧行为会在 **≤15 秒**内误撤。

最后那一撤同时证明了 **E2**：撤回是由会话 B 的在场上报触发的，说明点击通知后页面**确实落到了
会话 B**（`pendingFocus` 通路生效），而不是停在 A。

### 3.4 E4 / E5：多实例精度

这台机器上同时存在两个 dsh 标签（UI Automation 只读枚举得到）：

```
[DSH] tag=[dsh:3081] | 更新插件并制定测试计划 — DeepSeek Harness [dsh:3081]
[DSH] tag=[dsh:3080] | 在 Windows 实例安装插件并验证 — DeepSeek Harness [dsh:3080]
```

真实点击留下的状态是 **`TAB_FOCUSED hwnd=… ok=True tag=[dsh:3080]`**——命中的是 **Windows**
实例，没有跑到 `[dsh:3081]`。

注意状态是 `TAB_FOCUSED` 而不是 `FOCUSED`：`FOCUSED` 是「窗口标题里直接含 marker+tag」的快路径；
从别的标签页点通知时窗口标题里根本没有 `DeepSeek Harness`，走的是 **UI Automation 选中标签页**
那条路。它在同时存在两个 `TabItem` 的情况下选中了正确的那个。

### 3.5 E3：点击延迟

按注册表真实通路（`wscript` → `enqueue-focus.vbs` → spool → 常驻助手 → 置前）复测：

| 轮次 | 点击 → 窗口到前台 | 命中路径 |
|---|---|---|
| 1 | 205 ms | `FOCUSED … tag=[dsh:3080]` |
| 2 | 125 ms | 同上 |
| 3 | 123 ms | 同上 |

第一轮含 `wscript` 冷启动，热态稳定 **~125ms**，与宣称的 0.1-0.2s 吻合。

---

## 4. 平台相关代码的核对

| 位置 | Windows 上的行为 | 结论 |
|---|---|---|
| `detectPlatform()` | `{kind:"windows", powershell:"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"}` | ✅ |
| `deriveWscriptPath()` | 由 powershell 路径推出 **`C:\WINDOWS\System32\wscript.exe`** | ✅ 两种分隔符都吃 |
| `toWindowsPath()` | 原生 Windows 上没有 `wslpath` → 原样返回（现已直接短路，不再尝试 spawn） | ✅ |
| `readProcVersion()` | 读 `/proc/version` 失败 → 返回 `''`，`platform==='win32'` 时根本不看它 | ✅ 无害 |
| `buildProtocolCommand()` | `"C:\WINDOWS\System32\wscript.exe" "…\enqueue-focus.vbs" "%1" "…\.focus-spool"` | ✅ 与注册表实测值一致 |

**局限（如实说明）**：这两个 dsh 标签页在**同一个 Edge 窗口**里（hwnd 相同），所以验证的是
**标签页级**精度，不是**窗口级**。「聚焦错窗口」在这台机器上无法复现（没有第二个浏览器窗口）。
标签页级其实是更难的一环，但窗口级仍属未覆盖。

---

## 5. 复现方式

本仓库不带验证脚本；当时用的工具是个一次性 PowerShell 脚本，做三件事：

1. 读 `$DSH_HOME\dsh-away-notify.log`（需先开 `debug: true`），按 `已通知` / `已抑制` / `已撤回`
   过滤出判定时间线；
2. 用 UI Automation **只读**枚举所有浏览器标签的标题（不切换标签），核对 `[dsh:<port>]`；
3. 检查 `.focus-spool` 的 `config.txt` / `heartbeat` / `last-status.txt`、协议注册表项、助手进程、
   以及用 `ToastNotificationManager.History.GetHistory(appId)` 回读通知中心。

> 写这类脚本时注意：**脚本本身要保持纯 ASCII**（PS 5.1 会以 ANSI 读无 BOM 的 `.ps1`，
> 中文正则会让整个脚本解析失败），日志要用
> `[System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)` 读。详见
> [Windows 文档](./windows.md#4-约束随包的-powershell-脚本必须纯-ascii)。

## 6. 未覆盖项

B2 出错 / B3 审批 / B5 goal、C6 标签页被杀 + TTL 兜底、C7 页面级降级抑制、E5 的**窗口级**、
E6 助手自愈 / E7 冷回退 / E8 标签不在前台 / E9 浏览器全关、F1 冷却 / F3 goal 中间轮 /
F4 审批策略 never、G 全部配置开关、H2 点击 URL 含 token、H3 卸载清理。

其中 E8 那条路径其实被真实点击走到了（状态为 `TAB_FOCUSED`，即「标题没命中 → UIA 选标签」），
行为正确；E6/E7/E9 属未构造。

---

## 7. 2026-09-24 复验：dsh 0.1.7-rc.1、点击回跳缺陷与 rc.1 适配

### 7.1 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 Home China 25H2，build 26200.8655 |
| dsh | **`0.1.7-rc.1`**（本插件检出通过 profile 的 `node_modules` 软链进 dsh） |
| dsh 宿主 | **WSL2**（`platform=wsl`）：本轮复验的 `dsh web` 跑在 WSL 里，浏览器与焦点助手都在 Windows 侧 |
| PowerShell | Windows PowerShell **5.1**.26100.8655 |
| 浏览器 | Edge 153.0.4234.32 |
| 端口 / tag | `127.0.0.1:`**`3080`** ⇄ `[dsh:3080]` |
| 现场证据 | `.focus-spool/last-status.txt` = `FOCUSED hwnd=327758 ok=True tag=[dsh:3080] CACHED` |

### 7.2 复现：为什么点了通知却停在原来那个标签页

用户报告「在浏览器里切到别的标签页 → 进别的应用 → dsh 弹通知 → 点击只把浏览器打开，人还在
原来那个标签页」。现场 `.focus-spool/last-status.txt` 的 `FOCUSED … CACHED` 说明走了「窗口
提到了前台、标签页没切」那条路。**原因是最小化的 Chromium 窗口对 UI Automation 一个 `TabItem`
都不暴露**（不是「没有匹配的标签」）：

```
[minimized]       class=Chrome_WidgetWin_1 tabs=0 ms=36 iconic=True
[minimized-again] class=Chrome_WidgetWin_1 tabs=0 ms=24 iconic=True
[action] SW_RESTORE
[restored] firstTabsMs=94 firstMarkerTabMs=97
```

旧实现在 UIA 搜不到标签后就退化为「聚焦上次命中的窗口」（它会顺手还原窗口），于是**第一次点击
永远回不到 dsh，第二次才行**——正好对应「点了没反应」。

复现方式不打扰真实 dsh 窗口：开一个诱饵 Edge 窗口，标签标题带 **另一个端口 tag**
（`DSH-DECOY DeepSeek Harness [dsh:3099]`），把请求投进同一个 spool，让**常驻助手**按真实
通路处理；再对真实窗口（`[dsh:3080]`）复核一次（切到 DeepL 标签页 → 点击 → `TAB_FOCUSED`）。

| 场景（诱饵窗口 / 真实窗口） | 修复前 | 修复后 |
|---|---|---|
| 标签在后台，窗口正常 | `TAB_FOCUSED` ~100ms | `TAB_FOCUSED` ~180ms |
| 标签在后台 + 窗口**最小化** + 有窗口缓存 | **`FOCUSED … CACHED`（不回 dsh）** | **`TAB_FOCUSED … RESTORED` ~250ms** |
| 标签在后台 + 窗口最小化 + **无**窗口缓存 | `NO_WINDOW`/`TAG_MISS`（新开标签页） | 同上（缓存落盘，助手重启后第一点也认得出） |
| 缺 tag 的旧页面，已知窗口内唯一候选 | 只能新开标签页 | `TAB_FOCUSED … NO_TAG` |
| 缺 tag 的旧页面，已知窗口内多个候选 | **可能切到另一个实例**（真机复现） | 不选（`FOCUSED … CACHED`，宁可不切也不错切） |

修复点：还原（`SW_RESTORE`）→ 每 120ms 重试 UIA（最多 5 轮）→ 缺 tag 兜底**只限已知窗口**且候选
唯一 → 仍然选不中就**聚焦已知窗口并追加打开 URL**（`… CACHED OPENED`）→ 窗口句柄按
`marker|tag` 落盘 `spool/window-cache.txt`。细节见
[点击回跳](./click-focus.md#实测最小化的浏览器窗口对-uia-不暴露标签页)。

### 7.3 rc.1 适配复核（不是猜测，逐条对过 + 真机旁证）

对安装好的 `@deepseek-ai/dsh@0.1.7-rc.1` **包内类型声明**逐项复核：客户端 bundle 装载协议
（`__ModuleLoader__.load` / `dsh.client` 解析）、`byId[].retainedBy.mainView`、
`uiWorkspace.openSession`、`ObservableSnapshot.getSnapshot/subscribe`、`DocumentTitle` 的
`DeepSeek Harness`、host 侧 `session/event`、`turn/end` 的七种 reason、`goal/change` 的
`complete`/`block`、`approval/asked` / `approval/policy`、`user-questions/request` waterfall、
`connection.fetch.register` / `authenticatedUrl`、`sessionTitle.get`、
`sessionProjections.snapshot` —— **全部未变**，因此本次修复不需要任何版本分支。对照表见
[实现说明 §4.1.1](./implementation-notes.md#411-017-rc1-复核2026-09-24)。

真机旁证：

- 焦点助手进程的创建时间与 `dsh web` 启动时间是**同一秒**（host 半部的 `startFocusHelper`
  真的执行了），`.focus-spool/config.txt` 内容正确；
- 浏览器标签标题带 `[dsh:3080]` 后缀（client 半部的 `apply` 真的执行了）；
- `HKCU\Software\Classes\dshnotify\shell\open\command` 指向本检出与 spool，用
  `wscript.exe enqueue-focus.vbs <dshnotify:…> <spool>` 实测走通快路径并得到 `TAB_FOCUSED`。

### 7.4 本轮新增的自动化用例

`node --test`：**163 pass / 0 fail**（原 159 + 4 条：还原后再搜、缓存落盘、缺 tag 兜底只限
已知窗口且候选唯一、`CACHED` 分支仍会兜底打开）。
