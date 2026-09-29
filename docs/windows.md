# Windows 安装、避坑与升级

[← 返回 README](../README.md)

Windows 是这套插件的主要运行环境——**dsh 原生跑在 Windows**、以及 **dsh 跑在 WSL 里**
两种情况都是走 Windows Toast，见 [README 的部署形态表](../README.md#部署形态)。也正因为
要跨「WSL 的 Linux 路径 / Windows 的路径」这条边界，安装与升级环节有几个 Windows 独有的坑，
踩中任何一个都会让你以为「插件装了却没反应」。

---

## 1. 跨盘符安装会装出一个**永远不会加载**的插件

> 这一条是**静默**的：命令退出码 0，只有一条容易被忽略的 warning，插件却在重启后完全不加载。
> 建议直接用 [`scripts/install-windows.ps1`](#怎么办) 安装，它会替你校验并修好。

### 症状

```powershell
dsh plugin --profile web add F:\project\tools\plugin\dsh-away-notify
```

命令看起来成功了：

```
+ dsh-away-notify link:F:/project/tools/plugin/dsh-away-notify
dsh: warning: dsh-away-notify declares no dsh.bundle - installed as a plain dependency,
             not a profile layer (a later update that gains one activates it automatically)
```

但插件重启后不生效。检查 profile 会发现依赖写进去了、`dsh.profile.bundles` 却没变：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"
# { "dependencies": { "dsh-away-notify": "link:F:/project/tools/plugin/dsh-away-notify" },
#   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app" ] } } }
```

那条 warning **是假线索**：插件好好地声明着 `dsh.bundle`，真正的原因是 pnpm 建的 junction
指向了一个不存在的路径，包解析不到，于是 `dsh` 认为它「没有声明 `dsh.bundle`」。

### 根因

pnpm 把 `link:` 里的**绝对路径当成了相对路径**拼在 profile 目录后面：

```
linkType = Junction
target   = C:\Users\<你>\.dsh\profiles\web\F:\project\tools\plugin\dsh-away-notify
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ profile 目录被硬拼在前面
resolves = False   (node_modules\dsh-away-notify\package.json 不存在)
```

隔离实验（在独立 scratch 目录里复现，排除 profile 自身因素）：

| scratch 盘符 | nodeLinker | link 目标 | junction 实际目标 | 可解析 |
|---|---|---|---|---|
| 同盘符 | 默认 (isolated) | 绝对路径 | 绝对路径 | ✅ |
| 同盘符 | **hoisted** | 绝对路径 | 绝对路径 | ✅ |
| 另一盘符 | 默认 (isolated) | 绝对路径 | 绝对路径 | ✅ |
| **另一盘符** | **hoisted** | 绝对路径 | **`<scratch>\F:\...\dsh-away-notify`** | ❌ |

**触发条件 = `nodeLinker: hoisted` × link 目标与 profile 不同盘符**。而 `hoisted` 是 dsh 的
profile 模板**自己**写进 `pnpm-workspace.yaml` 的（`@deepseek-ai/dsh-app-boot/lib/index.js`），
所以每个 Windows 用户的 profile 都带这个设置。

WSL 上之所以没这个问题：WSL 侧检出的路径是 `/mnt/f/...`，是**同一文件系统内的 POSIX 绝对路径**，
`link:` 解析正常；Windows 侧 profile 在 C:、检出在 F:，跨盘符根本没有相对路径可表示。

### 后果比「装不上」更糟：重跑一次会把插件**注销**

`dsh plugin` 的 reconcile 规则是「列在 `dependencies` 里、但解析不出 `dsh.bundle` 的包要移出
`dsh.profile.bundles`」，坏 junction 恰好让它解析不出。实测：

```
bundles 重跑前: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-away-notify
bundles 重跑后: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app      ← 插件被悄悄注销
```

也就是说，一个**本来工作正常**的 Windows 安装，只要再碰一次 `dsh plugin add` /
`pnpm install`（升级、加别的插件、甚至只是重装），下次重启后就会**无声地消失**。

### 怎么办

**推荐：用仓库里的安装器。** 它跑正常命令，然后**校验**结果并修好 pnpm 弄坏的东西：

```powershell
cd <插件检出目录>
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
# 只报告不改动：      ... -WhatIfOnly
# 装到别的 profile：  ... -Profile tui
```

它做五件事：

1. 照常跑 `dsh plugin --profile <名字> add <检出目录>`；
2. 确认依赖已写进 profile 的 `package.json`；
3. **检查 junction 是否真能解析**（`node_modules/<包名>/package.json` 在不在）。坏了就修：先用
   `rmdir` 删掉，再 `mklink /J` 指回真正的检出目录；
4. 确认包名在 `dsh.profile.bundles` 里，不在就补上；
5. 用 `dsh --profile <名字> --dump-config` 复验插件真的进了 profile 树。

> ⚠️ **手工修的时候绝对不要用 `Remove-Item -Recurse`**：Windows PowerShell 5.1 会**顺着
> junction 进到目标目录**并删掉里面的内容——也就是把你的插件源码删了。用 `rmdir`（只删链接）
> 或 `[System.IO.Directory]::Delete($path, $false)`。安装器里就是这么做的，并且会先确认那个
> 路径确实是 reparse point，否则拒绝删除。

**想根治**（让原版 `dsh plugin add` 也能正常用）二选一：

| 方案 | 做法 | 代价 |
|---|---|---|
| (a) | 把插件检出放在与 `$DSH_HOME` **同一个盘符** | 最省事，`dsh plugin add` 原样可用；检出位置受限 |
| (b) | 把 profile 的 `pnpm-workspace.yaml` 里 `nodeLinker: hoisted` 改成 `isolated` | 实测跨盘符可用；但 `hoisted` 是 dsh 模板刻意选的，改动前想清楚 |

---

## 2. 升级提醒：可能残留一个旧版焦点助手进程

**只在「从早期版本升级到本版本」时出现一次。**

早期版本的焦点助手用的是一个**全局固定**的互斥量名（`Local\dsh-away-notify-focus-helper`）。
现在它按 spool 目录区分了（见 [点击回跳与点击延迟](./click-focus.md#常驻助手与单实例互斥量)），
于是新版助手用**新名字**抢锁，不会再被旧助手挡住——结果是升级后可能**同时存在两个助手进程**。

另外插件热重载时，「旧助手收到 `stop` 退出」这一步本身是有竞态的：dispose 写 `stop`、
紧接着 apply 又会把 `stop` 删掉（为了让新助手不会一起来就自杀），只要这两步在一秒内完成，
旧助手那次轮询就可能根本没看见 `stop`。

**处理**：升级后确认一下助手只有一个，多了就结束掉旧的：

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'focus-helper\.ps1' } |
  Select-Object ProcessId, CreationDate, CommandLine
```

只保留启动时间最新的那个，其余 `Stop-Process -Id <pid> -Force`。或者干脆**重启 dsh**，
新助手会自己起好。

---

## 3. 通知通道自检

装完想确认「通知到底能不能弹」，不用等真实的回合结束：

```powershell
node scripts\selftest-notify.mjs "标题" "正文"
```

它会**真的弹一条 Toast**，并回读 Windows 通知中心来客观确认落地（打印 `HISTORY_COUNT` 与
标题）。这也是排查「插件加载了但没弹」时应该先做的一步——它把「通道」和「触发判定」两件事
分开验证了。

打算从插件侧看日志，就在 profile 的 `cordis.patch.yml` 里临时开：

```yaml
- id: dsh-away-notify
  config:
    notifyOnLoad: true   # 加载时弹一条「通知已就绪」，确认接线
    debug: true          # 写 $DSH_HOME\dsh-away-notify.log
```

`debug: true` 会把判定过程（`已通知` / `已抑制(原因)` / `已撤回通知(看到会话)` / `收到在场上报`）
逐行写进日志文件。**确认通路后建议把这两项关掉**：`notifyOnLoad` 会让每次启动都弹一条自检，
`debug` 的日志会一直增长。

接线成功的标志：重启后应立刻收到一条 Toast，日志里出现 `已加载 (windows)` /
`已注册 dshnotify: 协议` / `presence 端点已注册` / `焦点助手已启动`。

---

## 4. 约束：随包的 PowerShell 脚本必须**纯 ASCII**

Windows PowerShell 5.1 读取**没有 BOM** 的 UTF-8 `.ps1` 时用的是 ANSI 代码页，任何一个非 ASCII
字符都会让**整个脚本解析失败**（实测 `0xC00CE56D`）。所以 `scripts/*.ps1` 一律保持纯 ASCII，
标题 / 正文 / URL 以 UTF-8 base64 内联、在 PowerShell 内解码。

自己写配套脚本（比如改动证据采集脚本）时同样受这条约束——这不是洁癖，是真会炸：

```
Unexpected token '"message"' in expression or statement.
Missing closing '}' in statement or block.
```

`protocol.test.mjs` 里有一条用例会扫描所有随包脚本，确保它们仍然是纯 ASCII。

---

## 5. 多个 dsh 实例并存（Windows 原生 + WSL）

同一台机器上同时跑 Windows 原生和 WSL 的 dsh 时，两边浏览器窗口的标题**完全一样**（dsh 前端
把产品名硬编码成 `DeepSeek Harness`），只按标题匹配必然认错窗口。

插件用**按端口区分的标题后缀**解决：浏览器半部把标题写成
`… — DeepSeek Harness [dsh:3080]`，聚焦脚本从点击 URL 的端口重建同一个 tag，
**要求 marker 与 tag 同时命中**。所以点击 Windows 实例的通知不会跑到 WSL 那个标签页上去。

回退开关：`titleTag: false` 会让浏览器不再打后缀，退回「只按 marker 匹配」的旧行为
（多实例时会认错窗口）。

两个实例在默认配置下还有两点共享，都是刻意的：

- **共用同一个 `appId`**（默认 `DeepSeek Harness`）：通知中心里外观一致、静音设置也共享。
  想分别静音就给其中一个 profile 单独设 `appId`。
- **共用同一个 spool 目录**（都在插件检出目录下的 `.focus-spool`，除非显式配 `spoolDir`）：
  于是也**共用同一个焦点助手进程**。互斥量按 spool 区分意味着「同 spool = 同一个助手」，
  好处是省一个进程；代价是**一方卸载/重载会把共享的助手带走**（它会往 spool 写 `stop`），
  另一方下一次点击退化成冷启动（约 1.4s），之后由 `enqueue-focus.vbs` 的心跳自愈恢复。
  想彻底隔离就给两个实例配不同的 `spoolDir`。

细节见 [点击回跳与点击延迟](./click-focus.md)。

---

## 6. 故障排查

清单在 [故障排查](./troubleshooting.md)——那里是排查时最方便对照的位置，
本文件负责的是每个现象背后的**原因**（§1 跨盘符、§2 残留助手、§3 通道自检）。
