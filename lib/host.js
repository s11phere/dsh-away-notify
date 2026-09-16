/**
 * host.js — dsh-away-notify 宿主侧插件
 *
 * 职责：把 DSH 的会话事件翻译成「要不要提醒」的决策，再交给 notifier 弹 Windows
 * 原生 Toast。是否打扰取决于浏览器半部上报的在场状态（presence）。
 *
 * 针对 0.1.6-alpha.1 的设计取舍：
 *   - **不读 `session.events`**：该属性在 0.1.6 已被删除（只剩 @deprecated 的
 *     `eventAt`/`snapshotEvents`/`ownEvents`）。所有判断都靠实时订阅事件流
 *     自行累计 per-session 状态，因此 replay/resume 的构造期 seed 不会干扰。
 *   - **提问检测走 `user-questions/request` waterfall**，而不是扫 `tool/call`：
 *     0.1.6 的 PTC 独立进程后模型只直呼 `run_code`，扫 tool/call 会漏。
 *   - **不引入 schemastery**：其 ESM 入口没有 `z` 具名导出；用显式默认值合并，
 *     零运行时依赖，行为可预测。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PresenceStore } from './presence.js';
import { Cooldown, decide, classifyTurnEnd } from './policy.js';
import { detectPlatform, notify } from './notifier.js';
import { PROTOCOL, buildProtocolUri, registerProtocol } from './protocol.js';

/** 协议处理器脚本（随包发布）。 */
const LAUNCHER_SCRIPT = fileURLToPath(new URL('../scripts/focus-or-open.ps1', import.meta.url));
/** 无窗口闪烁启动器：wscript 是 GUI 子系统宿主，不会闪控制台。 */
const LAUNCHER_VBS = fileURLToPath(new URL('../scripts/run-hidden.vbs', import.meta.url));

export const name = 'dsh-away-notify';
export const inject = ['sessions'];

const CHANNEL = '/dsh-away-notify';
const MAX_TRACKED_SESSIONS = 256;

/**
 * 浏览器在场上报端点。必须以 `/api/` 开头——`connection.fetch.register` 要求
 * 路径可被 `endpointFromPath("/api", …)` 解析，且这样才落在带鉴权围栏的 /api 前缀内。
 */
const PRESENCE_PATH = '/api/dsh-away-notify';

/**
 * debug 模式下的文件日志位置。
 *
 * 注意：dsh 主进程的环境里**通常没有** `DSH_HOME`（那是注入给工具子进程的），
 * 所以不能只读 env，否则日志会落到 `/tmp`。这里沿用 dsh 自身的默认规则 `~/.dsh`。
 */
export const LOG_PATH = join(
  process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir() || tmpdir(), '.dsh'),
  'dsh-away-notify.log',
);

const REASON_TEXT = {
  completed: '任务已完成',
  error: '任务出错',
  'max-tokens': '输出达到 token 上限',
  aborted: '任务已取消',
  interrupted: '任务中断',
  blocked: '任务被阻塞',
};

/** 全部配置项与默认值。 */
export const DEFAULTS = {
  enabled: true,
  // 五类触发
  onTurnComplete: true,
  onTurnError: true,
  onTurnAborted: true,
  onTurnMaxTokens: true,
  onApproval: true,
  onQuestion: true,
  onGoalComplete: true,
  // 行为
  suppressGoalRounds: true,
  rootsOnly: true,
  cooldownMs: 10000,
  presenceTtlMs: 45000,
  previewMaxChars: 140,
  sound: true,
  openOnClick: true,
  includeToken: true,
  // 注册 `dshnotify:` 协议，让点击通知优先聚焦已有 dsh 浏览器窗口（Windows / WSL 生效）
  useProtocolHandler: true,
  // 用它识别「哪个浏览器窗口里有 dsh」——匹配窗口标题
  focusWindowMarker: 'DeepSeek Harness',
  // 「待跳转会话」有效期：点击通知后，浏览器半部在这个时间窗内取走并切过去
  focusTtlMs: 90000,
  // 安装自检：加载时发一条通知，用于确认通道可用（默认关）
  notifyOnLoad: false,
  titlePrefix: 'DSH',
  appName: 'DeepSeek Harness',
  appId: 'DeepSeek Harness',
  webUrl: '',
  debug: false,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };

  const platform = detectPlatform();
  const presence = new PresenceStore({ ttlMs: cfg.presenceTtlMs });
  const cooldown = new Cooldown();
  const states = new Map();

  /**
   * 「待跳转会话」。
   *
   * 为什么需要它：点击 Toast 打开的是带 token 的 URL，而 token 换 cookie 那一步
   * 会返回 `303 Location: /`，**把所有查询参数都丢掉**（见
   * `dsh-client-connection` 的 `authorizeIndex`）。所以在 URL 上挂
   * `?dshAwayNotifyFocus=…` 根本到不了前端。改为宿主记住目标会话，由浏览器半部
   * 主动来取——这样无论浏览器是复用已有窗口还是新开标签页都能生效。
   */
  let pendingFocus = null; // { sessionId, at }

  /**
   * `dshnotify:` 协议是否可用。注册是异步的，注册成功前退回普通 http URL，
   * 通知功能不受影响。
   */
  let protocolReady = false;

  const log = (level, message, detail) => {
    try {
      const fn = ctx.logger?.[level];
      if (typeof fn === 'function') fn.call(ctx.logger, `dsh-away-notify: ${message}`, detail ?? '');
    } catch {
      /* 诊断绝不能影响会话热路径 */
    }
    if (cfg.debug) {
      // 独立的文件日志：ctx.logger 的输出去向不可控，排查时必须有个确定能读到的地方
      try {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `${JSON.stringify({ time: Date.now(), level, message, detail })}\n`);
      } catch {
        /* ignore */
      }
    }
  };

  // ── 会话状态（实时累计，不依赖已删除的历史读取 API）─────────────────────
  const stateOf = (sid) => {
    let s = states.get(sid);
    if (!s) {
      s = { goalRound: false, goalTerminal: false, approvalPolicy: undefined, lastAssistantText: undefined };
      states.set(sid, s);
      if (states.size > MAX_TRACKED_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
      }
    }
    return s;
  };

  const isSubagent = (session) =>
    session?.header?.origin === 'subagent' || (session?.header?.delegationDepth ?? 0) > 0;

  const titleOf = (session) => {
    try {
      const direct = ctx.sessionTitle?.get?.(session)?.title;
      if (typeof direct === 'string' && direct.length > 0) return direct;
    } catch {
      /* 投影服务可能尚未就绪 */
    }
    try {
      return ctx.sessionProjections?.snapshot?.(session, ['title'])?.values?.title;
    } catch {
      return undefined;
    }
  };

  const sessionById = (sid) => {
    try {
      return ctx.sessions?.get?.(sid);
    } catch {
      return undefined;
    }
  };

  // ── 可点击 URL ─────────────────────────────────────────────────────────
  const defaultBase = () => {
    try {
      const port = ctx.get?.('webServer')?.port;
      if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
    } catch {
      /* 非 web 宿主没有 webServer */
    }
    return 'http://127.0.0.1:3080';
  };

  const connectionService = () => {
    try {
      return ctx.get?.('connection');
    } catch {
      return undefined;
    }
  };

  /**
   * 生成通知的点击目标。
   *
   * - 协议处理器可用时返回 `dshnotify:<base64url(URL)>`，由本地脚本先聚焦已有
   *   dsh 浏览器窗口，找不到才打开新标签页。
   * - 否则退回普通 http URL（浏览器行为不受控，可能新开窗口）。
   *
   * token 只进 URL，**绝不写日志**（下方日志刻意不带 url / uri 字段）。
   */
  const buildLaunchUrl = (sessionId) => {
    const base = (cfg.webUrl && String(cfg.webUrl).trim()) || defaultBase();
    let url = `${String(base).replace(/\/+$/, '')}/`;
    try {
      const conn = connectionService();
      if (conn && cfg.includeToken && typeof conn.authenticatedUrl === 'function') {
        url = conn.authenticatedUrl(url);
      }
    } catch {
      /* 拿不到 token 就退回普通 URL：浏览器已有 cookie 时同样可用 */
    }
    try {
      const u = new URL(url);
      u.searchParams.set('dshAwayNotifyFocus', sessionId);
      url = u.toString();
    } catch {
      /* 保持原样 */
    }
    return protocolReady ? buildProtocolUri(url) : url;
  };

  // ── 通知管线 ───────────────────────────────────────────────────────────
  const fire = (event) => {
    if (!cfg.enabled) return;
    const decision = decide(event, {
      policy: cfg,
      isAttended: (sid) => presence.isAttended(sid),
      cooldown,
    });
    if (!decision.notify) {
      if (cfg.debug) log('info', `已抑制(${decision.reason})`, event.kind);
      return;
    }
    cooldown.mark(decision.key);

    const launch = cfg.openOnClick && event.sessionId ? buildLaunchUrl(event.sessionId) : '';
    // 记住待跳转会话：浏览器半部会在加载 / 重新获得焦点时来取（见 pendingFocus 说明）
    if (cfg.openOnClick && event.sessionId) {
      pendingFocus = { sessionId: event.sessionId, at: Date.now() };
    }
    notify({
      title: decision.title,
      body: decision.body,
      launch,
      sound: cfg.sound,
      appId: cfg.appId,
      target: platform,
      logger: ctx.logger,
    })
      .then((res) => {
        if (res.ok) {
          // 只记通道与原因，不记 url（url 内含鉴权 token）
          log('info', `已通知(${decision.kind})`, { channel: res.channel, sessionId: event.sessionId });
        } else {
          log('warn', `通知失败: ${res.error ?? 'unknown'}`, { channel: res.channel });
        }
      })
      .catch((error) => log('warn', `通知异常: ${String(error?.message ?? error)}`));
  };

  // ── 会话事件 ───────────────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (!cfg.enabled || !session?.id) return;
    const sid = session.id;
    const st = stateOf(sid);
    const subagent = isSubagent(session);

    switch (event?.type) {
      case 'user/message': {
        const source = event.data?.source;
        // /goal 自动推进的回合带 source.kind === 'goal' 且 round > 0
        st.goalRound = source?.kind === 'goal' && (source?.round ?? 0) > 0;
        if (!st.goalRound) st.goalTerminal = false;
        return;
      }

      case 'assistant/message': {
        const text = textOfMessage(event.data?.message);
        if (text) st.lastAssistantText = text;
        return;
      }

      case 'approval/policy': {
        st.approvalPolicy = event.data?.policy;
        return;
      }

      case 'goal/change': {
        const op = event.data?.operation;
        if (op === 'complete' || op === 'block') {
          st.goalTerminal = true;
          fire({
            sessionId: sid,
            sessionTitle: titleOf(session),
            isSubagent: subagent,
            kind: 'goal-complete',
            body: op === 'complete' ? '目标已完成' : '目标被阻塞，需要你处理',
          });
        }
        return;
      }

      case 'approval/asked': {
        // 策略为 never 时审批会被自动拒绝，没有东西在等你
        if (st.approvalPolicy === 'never') return;
        const data = event.data ?? {};
        const detail =
          typeof data.reason === 'string' && data.reason.length > 0 ? `：${truncate(data.reason, 100)}` : '';
        fire({
          sessionId: sid,
          sessionTitle: titleOf(session),
          isSubagent: subagent,
          kind: 'approval',
          body: data.toolName ? `工具 ${data.toolName}${detail}` : '有一项操作等待你的批准',
        });
        return;
      }

      case 'turn/end': {
        const reasonKind = event.data?.reason?.kind;
        if (typeof reasonKind !== 'string') return;
        const kind = classifyTurnEnd(reasonKind);
        let body = REASON_TEXT[reasonKind] ?? '任务已结束';
        if (Number.isInteger(event.data?.turn)) body += `（第 ${event.data.turn} 轮）`;
        if (st.lastAssistantText) body += `\n${truncate(st.lastAssistantText, cfg.previewMaxChars)}`;
        fire({
          sessionId: sid,
          sessionTitle: titleOf(session),
          isSubagent: subagent,
          kind,
          body,
          isGoalRound: st.goalRound && !st.goalTerminal,
        });
        // 一轮结束：清掉本轮的临时标记
        st.goalRound = false;
        st.goalTerminal = false;
        return;
      }

      default:
        return;
    }
  });

  // ── 提问：走 waterfall，覆盖 native 与 PTC 两种调用路径 ─────────────────
  ctx.on('user-questions/request', (request, next) => {
    try {
      if (cfg.enabled && cfg.onQuestion !== false) {
        const sid = request?.agent?.id;
        const session = sid ? sessionById(sid) : undefined;
        const first = Array.isArray(request?.questions) ? request.questions[0] : undefined;
        const question =
          typeof first?.question === 'string' ? truncate(first.question, 120) : 'Agent 正在等待你的确认';
        if (sid) {
          fire({
            sessionId: sid,
            sessionTitle: session ? titleOf(session) : undefined,
            isSubagent: session ? isSubagent(session) : false,
            kind: 'question',
            body: question,
          });
        }
      }
    } catch (error) {
      log('warn', `提问通知失败: ${String(error?.message ?? error)}`);
    }
    // 本插件只是观察者，必须继续 waterfall，否则会打断提问链路
    return next();
  });

  // ── 浏览器在场上报（可选：非 web 宿主没有 connection 服务）──────────────
  //
  // 注意：**不能用 `connection.rpc.handle`**。它在 0.1.6 上不可用——其内部执行
  // `owner.webServer.register(route)`，而 `owner` 是 connection 插件自己的 ctx，
  // 该 ctx 从未注入 webServer（`/api` 路由是在 `ctx.inject(["webServer"], …)` 里
  // 用 webCtx 注册的），因此必然抛 `cannot get property "webServer" without inject`。
  // DSH 自身也零调用该 API。正确通路是 `connection.fetch.register`：它只依赖
  // `owner.effect`，且路径挂在 `/api` 前缀下，同样受 Host/Origin 围栏与浏览器鉴权保护。
  ctx.inject(['connection'], (c) => {
    try {
      c.connection.fetch.register({
        path: PRESENCE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload;
          try {
            payload = await request.json();
          } catch {
            return jsonResponse({ ok: false, error: 'body is not JSON' }, 400);
          }
          try {
            const result = handleReport(payload?.op, payload);
            return jsonResponse(result, 200);
          } catch (error) {
            return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400);
          }
        },
      });
      log('info', `presence 端点已注册: ${PRESENCE_PATH}`);
    } catch (error) {
      log('warn', `presence 端点注册失败: ${String(error?.message ?? error)}`);
    }
  });

  /** presence 端点的业务处理（RPC 与 fetch 两条通路共用）。 */
  function handleReport(op, payload) {
    if (op === 'presence') {
      // sessionId 允许缺省：客户端拿不到当前会话时仍会上报页面级可见性/焦点
      const sessionId =
        typeof payload?.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : undefined;
      const clientId = typeof payload?.clientId === 'string' && payload.clientId.length > 0 ? payload.clientId : undefined;
      presence.report({
        clientId,
        sessionId,
        visible: payload?.visible === true,
        focused: payload?.focused === true,
      });
      // 诊断用：确认浏览器半部确实在上报（排查「为什么没抑制/为什么静音」）
      if (cfg.debug) {
        log('info', '收到在场上报', {
          clientId: clientId ? `${clientId.slice(0, 8)}…` : null,
          sessionId: sessionId ?? null,
          visible: payload?.visible === true,
          focused: payload?.focused === true,
          mode: presence.mode(),
          attended: presence.attendedSessions(),
        });
      }
      return { ok: true };
    }
    if (op === 'state') {
      return {
        ok: true,
        attended: presence.attendedSessionId() ?? null,
        attendedSessions: presence.attendedSessions(),
        mode: presence.mode(),
        sessionTracking: presence.sessionTracking,
        platform: platform.kind,
      };
    }
    if (op === 'pending-focus') {
      const fresh = pendingFocus !== null && Date.now() - pendingFocus.at <= cfg.focusTtlMs;
      if (!fresh && pendingFocus !== null) pendingFocus = null;
      return { ok: true, sessionId: fresh ? pendingFocus.sessionId : null };
    }
    if (op === 'ack-focus') {
      // 只清除被确认的那一个，避免把更新的待跳转覆盖掉
      const acked = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
      if (pendingFocus !== null && (acked === null || pendingFocus.sessionId === acked)) pendingFocus = null;
      return { ok: true };
    }
    throw new Error(`dsh-away-notify: unknown op ${JSON.stringify(op)}`);
  }

  // ── 定时清理过期在场状态 ────────────────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => presence.sweep(), Math.max(5000, Math.floor(cfg.presenceTtlMs / 3)));
    return () => clearInterval(timer);
  }, 'dsh-away-notify: presence sweep');

  log('info', `已加载 (${platform.kind})`, {
    reason: platform.reason,
    powershell: platform.powershell,
    logPath: cfg.debug ? LOG_PATH : undefined,
  });
  if (platform.kind === 'unsupported' || (platform.kind === 'linux' && !platform.powershell)) {
    log('warn', `通知通道可能不可用：${platform.reason}`);
  }

  if (cfg.notifyOnLoad) {
    notify({
      title: `${cfg.titlePrefix} · 通知已就绪`,
      body: `dsh-away-notify 已激活（${platform.kind}）`,
      sound: cfg.sound,
      appId: cfg.appId,
      target: platform,
      logger: ctx.logger,
    })
      .then((res) => log('info', `加载自检通知: ${res.ok ? '成功' : `失败(${res.error})`}`, { channel: res.channel }))
      .catch(() => {});
  }

  // ── 注册 `dshnotify:` 协议（仅 Windows / WSL 有意义）────────────────────
  const canUseProtocol =
    cfg.useProtocolHandler !== false &&
    cfg.openOnClick !== false &&
    (platform.kind === 'windows' || platform.kind === 'wsl') &&
    platform.powershell;

  if (canUseProtocol) {
    registerProtocol({
      powershell: platform.powershell,
      scriptPath: LAUNCHER_SCRIPT,
      vbsPath: LAUNCHER_VBS,
      marker: cfg.focusWindowMarker,
    })
      .then((res) => {
        protocolReady = res.ok === true;
        if (protocolReady) {
          log('info', `已注册 ${PROTOCOL}: 协议（点击通知将优先聚焦已有窗口）`);
        } else {
          log('warn', `注册 ${PROTOCOL}: 协议失败，退回普通 URL：${res.error ?? 'unknown'}`);
        }
      })
      .catch((error) => log('warn', `注册 ${PROTOCOL}: 协议异常：${String(error?.message ?? error)}`));
  } else if (cfg.useProtocolHandler !== false && cfg.openOnClick !== false) {
    log('info', '当前平台不支持自定义协议，点击通知将走普通 URL');
  }
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function textOfMessage(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      return block.text.trim();
    }
  }
  return undefined;
}
