# 故障排查

[← 返回 README](../README.md)

这份清单是「装完之后没反应 / 弹得不合预期 / 点了回不去」时最方便对照的地方。每条只写**先查什么**；
现象背后的原因（跨盘符、残留助手、通道自检）在 [Windows 安装、避坑与升级](./windows.md)，
判定与抑制的日志语义在[实现说明](./implementation-notes.md)。

排查的第一步永远是**把「通知通道」和「触发判定」分开验证**：通道不通时先跑
`node scripts/selftest-notify.mjs "标题" "正文"`（它会真的弹一条并回读通知中心）；通道 OK 再开
`debug: true` 看是「没触发」还是「被抑制了」。

---

| 现象 | 先查什么 |
|---|---|
| 重启后完全没有反应 | `dsh --profile web --dump-config` 里有没有 `- id: dsh-away-notify`？没有就是跨盘符安装问题，见 [Windows 安装 §1](./windows.md#1-跨盘符安装会装出一个永远不会加载的插件) |
| 挂上了但不弹 | 先单独验证通道：`node scripts/selftest-notify.mjs`。通道 OK 就开 `debug: true` 看 `已抑制(<原因>)` |
| 一直不弹，日志里全是 `已抑制(attended-foreground)` | 你正看着那条会话——设计行为。切到别的标签页或别的应用再试 |
| 日志里是 `已抑制(subagent-session)` | 子代理会话默认不打扰（`rootsOnly: true`） |
| 日志里是 `已抑制(suppressed:<原因>)` | 别的插件（如 `dsh-btw-sidebar`）显式声明了这条会话不打扰——设计行为，见[给其他插件的接口](./plugin-api.md) |
| 点了通知没回到 dsh | 看 `.focus-spool/last-status.txt`：`FOCUSED` / `TAB_FOCUSED` 说明脚本执行了；`TAG_MISS` 说明标题里没有本实例的 tag（检查 `titleTag`、以及页面是否已刷新）；`NO_WINDOW` 说明连 marker 都没匹配到。**`FOCUSED … CACHED`** 表示窗口提到了前台但标签页没选中（浏览器不支持 UI Automation / 组策略禁用）。旧版本遇到「浏览器最小化」就会走到这里——更新插件后**重启 dsh** 让焦点助手换成新脚本 |
| 第一次点不回去、第二次才行 | 这是 v0.1.7-alpha.1 上的真实缺陷（浏览器最小化时 Chromium 不向 UI Automation 暴露标签页，旧脚本只聚焦不切标签）。本版本已修：先把窗口还原再选标签页。若仍复现，确认 `.focus-spool/last-status.txt` 里有没有 `RESTORED`，并检查助手进程的启动时间是否早于插件更新 |
| 点了通知多出一个标签页 | 说明标签页确实选不中（旧页面没有 tag、浏览器非 Chromium/Firefox、或 dsh 标签已不存在），脚本按「宁可多开也不把你留在原标签页」处理，状态行以 `OPENED` 结尾 |
| 点击要等一两秒 | 助手进程不在了。看 `.focus-spool/heartbeat` 的 mtime 是不是一秒一跳，见 [升级提醒](./windows.md#2-升级提醒可能残留一个旧版焦点助手进程) |
| 通知几秒就消失 | 只有 `persistent: true` 才会用 `scenario="reminder"` + 按钮常驻；另外 reminder 场景**必须带按钮**，否则 Windows 会退化成普通通知 |
| 回到 dsh 后提醒还赖着不走 | 控制台 `op:'state'` 看 `sessionTracking`。为 `false` 说明客户端拿不到会话 id，按会话撤回（`dismissOnReturn`）不生效。旧 bundle 跑在新 dsh 上会这样：更新插件后**刷新页面** |
| 页面控制台查到 `mode: away` | 你开着 DevTools，页面失焦了——预期行为 |
