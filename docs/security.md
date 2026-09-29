# 安全说明：`includeToken`

[← 返回 README](../README.md)

dsh 的 Web UI 在端口上要求鉴权（裸访问返回 `401 dsh web authentication required`）。
`includeToken: true`（默认）会把进程的启动 token 拼进 Toast 的点击 URL，好处是**即使浏览器完全
关闭，点击通知也能直接进入界面**。

代价是：该 token 会出现在**本机 Windows 通知中心的历史记录**里。它是一个 localhost 令牌，且通知
历史只有本机可见；如果你不接受这一点，改成 `includeToken: false`——那样在浏览器已打开（有 cookie）
时一切照常，只有浏览器全关时点击会落到 401 页面。

插件**不会**把该 URL 写进日志（有单测与真机日志双重确认）。
