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

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { PresenceStore } from './presence.js';
import { Cooldown, decide, classifyTurnEnd } from './policy.js';
import { SUPPRESS_API_VERSION, SuppressionRegistry } from './suppress.js';
import { detectPlatform, dismiss, notify } from './notifier.js';
import { PROTOCOL, buildProtocolUri, deriveWscriptPath, registerProtocol, toWindowsPath } from './protocol.js';

/** 协议处理器脚本（随包发布）。 */
const LAUNCHER_SCRIPT = fileURLToPath(new URL('../scripts/focus-or-open.ps1', import.meta.url));
/** 无窗口闪烁启动器：wscript 是 GUI 子系统宿主，不会闪控制台。 */
const LAUNCHER_VBS = fileURLToPath(new URL('../scripts/run-hidden.vbs', import.meta.url));
/** 快路径入口：注册表指向它，它只把请求写进 spool 就退出（不起 PowerShell）。 */
const ENQUEUE_VBS = fileURLToPath(new URL('../scripts/enqueue-focus.vbs', import.meta.url));
/** 常驻助手：加载时起一次，之后每次点击都由它立即响应。 */
const HELPER_PS1 = fileURLToPath(new URL('../scripts/focus-helper.ps1', import.meta.url));
/**
 * 点击请求的投递目录。
 *
 * 放在插件目录下而不是 %LOCALAPPDATA%：宿主跑在 WSL 里，用 `toWindowsPath` 就能把
 * 同一个位置同时表示成 `/mnt/d/...` 与 `D:\...`，两侧不必各自摸索路径。挑 Windows
 * 盘而不是纯 WSL 路径，是因为 wscript/VBS 要直接读写它（UNC 路径做文件 IO 可行，
 * 但更容易踩坑），而且注册表要执行的那侧必须拿到 Windows 形式。
 */
const SPOOL_DIR = fileURLToPath(new URL('../.focus-spool', import.meta.url));

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
  // 给浏览器标题追加 ` [dsh:<port>]`，让同机并存的多个 dsh 实例（Windows + WSL）
  // 在窗口层面可区分，从而让点击通知精确聚焦到出事的那一个实例
  titleTag: true,
  // 通知停留在屏幕上，直到用户点它、或用鼠标/键盘把 dsh 窗口切回前台
  persistent: true,
  // 用户回到 dsh 页面时，撤回还挂着的持久通知
  dismissOnReturn: true,
  // 点击请求（spool）与常驻助手的工作目录；留空则用插件目录下的 .focus-spool
  spoolDir: '',
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

/**
 * @param {object} ctx cordis 上下文
 * @param {object} [config] 用户配置（profile 的 cordis.patch.yml 按 id 覆盖）
 * @param {object} [deps] **仅供测试**的注入点：`{ spawnImpl, spawnSyncImpl }`，会被
 *   透传给 notifier / protocol / 助手启动。测试据此就能观察「到底会执行哪一段
 *   脚本」，而不必真的去执行一个假 powershell.exe —— Windows 只会把 `.exe` 当 PE
 *   映像加载，没法用 shell 脚本冒充它，否则这几条用例在 Windows 上必然失败
 *   （详见 tests/host.test.mjs 顶部注释）。生产代码永远不传第三个参数。
 */
export function apply(ctx, config = {}, deps = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const { spawnImpl, spawnSyncImpl } = deps ?? {};

  const platform = detectPlatform();
  const presence = new PresenceStore({ ttlMs: cfg.presenceTtlMs });
  const cooldown = new Cooldown();
  const states = new Map();
  /**
   * 显式抑制注册表：其它插件（例如 dsh-btw-sidebar 的侧边聊天）声明「别为这条
   * 会话弹通知」。见 lib/suppress.js 与 README 的「给其他插件的接口」。
   */
  const suppression = new SuppressionRegistry();

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

  /**
   * 持久通知的 tag 管理。
   *
   * 同一个 `sessionId:kind` 复用同一个 tag —— 在 Windows 上同 tag+group 的通知
   * 是**替换**而不是叠加，所以同一件事反复触发不会在屏幕上堆出一面墙；同时不同
   * 的事各自保留，回来时能一次看全。
   */
  const TOAST_GROUP = 'dshan';
  const tagByKey = new Map();
  let toastSeq = 0;
  /**
   * 已发出、尚未撤回的通知：`tag -> 触发它的会话 id`（无会话归属时为 null）。
   *
   * **必须带上会话 id**：用户在会话 A 上时，会话 B 的通知不该被 A 的**心跳**撤掉。
   * 只有当他真的切到 B（或点了通知）时，才撤 B 的那一条。
   */
  const outstanding = new Map();

  function tagFor(key) {
    let tag = tagByKey.get(key);
    if (tag === undefined) {
      toastSeq += 1;
      tag = `dshan-${toastSeq}`;
      tagByKey.set(key, tag);
    }
    return tag;
  }

  /**
   * 撤回「用户此刻正在看的那个会话」的通知。
   *
   * 逐条按 tag+group 撤，**不用 `History.Clear(appId)`**：多实例并存时那个 appId
   * 是共用的，整表清理会连另一个实例的通知一起抹掉。
   *
   * 关键在于**比对会话**：客户端每 ~15 秒一次心跳都会重复上报 `visible+focused`，
   * 若不做比对，别的会话挂着的通知会被这次心跳顺手撤掉（实测后台会话的通知只活了
   * 2.6 秒）。所以只撤 `viewedSessionId` 对应的那些，外加无会话归属的（如加载自检）。
   *
   * @param {string|undefined} viewedSessionId 本次上报的会话；缺省表示页面级退化模式
   */
  function dismissAttended(viewedSessionId, reason) {
    if (outstanding.size === 0) return;
    const tags = [];
    for (const [tag, sid] of outstanding) {
      if (sid === null || (typeof viewedSessionId === 'string' && sid === viewedSessionId)) tags.push(tag);
    }
    if (tags.length === 0) return;
    for (const tag of tags) outstanding.delete(tag);
    for (const tag of tags) {
      dismiss({ appId: cfg.appId, tag, group: TOAST_GROUP, target: platform, logger: ctx.logger, spawnImpl })
        .then((res) => {
          if (cfg.debug) log('info', `已撤回通知(${reason})`, { tag, ok: res.ok === true });
        })
        .catch(() => {});
    }
  }

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

  // ── 对外接口：显式抑制（见 lib/suppress.js / README「给其他插件的接口」）──
  //
  // 其它插件用 cordis 服务拿它：`ctx.get('awayNotify')` 或 `ctx.inject(['awayNotify'], …)`。
  // 真机先例：`@deepseek-ai/dsh-workspace-changes` 用同样的方式 provide
  // `workspaceChanges` 给同为 loader 条目的 `dsh-client-ui-deliverables` 消费。
  //
  // 用 try/catch 包住：服务注册失败最多是「别人没法抑制」，绝不能把通知链路拖下水。
  try {
    ctx.provide('awayNotify', {
      version: SUPPRESS_API_VERSION,
      /** 逐条声明抑制；返回释放函数（按 token 引用计数，各自释放互不影响）。 */
      suppressSession: (sessionId, reason) => suppression.claim(sessionId, reason),
      /** 撤销一条会话的全部声明（抑制 + 揭示）；返回撤销数量。 */
      releaseSession: (sessionId) => suppression.release(sessionId),
      /** 该会话当前是否被抑制；是则返回原因标签。 */
      isSuppressed: (sessionId) => suppression.reasonFor(sessionId),
      /** 按「类」声明；`match(sessionId, event, context)` 由调用方判定。返回注销函数。 */
      addRule: (rule) => suppression.addRule(rule),
      /**
       * 声明「点击这条会话的通知时，先在右栏打开 `resource`；失败再退回主视图」。
       * 地址是不透明字符串（`dsh-resource://…`），away-notify 只负责转发。
       * `mainSessionId`（可选）表示该资源所在的右栏属于哪条主视图会话——右栏按
       * 主视图会话分域，跨会话时浏览器半部要先切过去再打开（见 lib/suppress.js）。
       */
      revealSession: (sessionId, target) => suppression.reveal(sessionId, target),
      /** 该会话的揭示目标：`{ resource, mainSessionId?, reason } | undefined`。 */
      revealFor: (sessionId) => suppression.revealFor(sessionId),
      /** 诊断快照。 */
      snapshot: () => suppression.snapshot(),
    });
    log('info', `已提供 awayNotify 服务（供其它插件显式抑制/揭示会话，API v${SUPPRESS_API_VERSION}）`);
  } catch (error) {
    log('warn', `提供 awayNotify 服务失败（其它插件将无法显式抑制）：${String(error?.message ?? error)}`);
  }

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

  /**
   * 取会话标题：`dsh-session-title` 的 `get(session).title` 优先，退回
   * `dsh-session-projections` 的 `snapshot(session, ['title']).values.title`。
   *
   * **必须走 `ctx.get(name)`，不能写成 `ctx.sessionTitle`。** 本插件只 `inject: ['sessions']`，
   * 而 cordis 对「已注册但没写进 `inject` 的服务」做直接属性读取会抛
   * `cannot get property "sessionTitle" without inject`；`ctx.get` 才是官方的可选查找
   * （服务缺失返回 undefined，声明与否都不抛）。这里踩过坑：写成直接属性读取时异常被
   * 下方 try/catch 吞掉，`titleOf` 在真机上**永远**返回 undefined，通知正文里的会话标题
   * 从未出现过（单测当时用的假 ctx 恰好与真 cordis 相反，所以没暴露）。回归用例见
   * `tests/host.test.mjs` 的「会话标题必须进到通知正文里」。
   *
   * 两处都包 try/catch：标题只是正文里的一行，拿不到就不加，绝不能影响通知本身。
   */
  const titleOf = (session) => {
    try {
      const direct = ctx.get?.('sessionTitle')?.get?.(session)?.title;
      if (typeof direct === 'string' && direct.length > 0) return direct;
    } catch {
      /* 标题服务不可用或抛错：退回投影 */
    }
    try {
      return ctx.get?.('sessionProjections')?.snapshot?.(session, ['title'])?.values?.title;
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
      // context 交给规则判定：调用方据此实现「只有我被看着时才静音」这类语义
      suppressionReason: (sid, ev) =>
        suppression.reasonFor(sid, ev, {
          attended: presence.isAttended(sid),
          pageAttended: presence.isPageAttended(),
        }),
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
    // 同一件事复用同一个 tag（同 tag+group 在 Windows 上是替换语义），
    // 不同的事各有 tag，回到 dsh 时能一次全部撤回。
    const tag = tagFor(decision.key);
    notify({
      title: decision.title,
      body: decision.body,
      launch,
      sound: cfg.sound,
      appId: cfg.appId,
      persistent: cfg.persistent,
      tag,
      group: TOAST_GROUP,
      target: platform,
      logger: ctx.logger,
      spawnImpl,
    })
      .then((res) => {
        if (res.ok) {
          // 记下这条通知属于哪个会话，之后只在该会话被看到时才撤（见 dismissAttended）
          outstanding.set(tag, event.sessionId ?? null);
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
      // 用户切到某个会话并且页面可见有焦点：撤掉**那个会话**还挂着的持久通知。
      // 这正是「通知一直停留，直到你点它或把 dsh 窗口切回前台」的后半句。
      // 注意只撤该会话的：否则别的会话的心跳会误伤（见 dismissAttended）。
      if (cfg.dismissOnReturn !== false && payload?.visible === true && payload?.focused === true) {
        dismissAttended(sessionId, '看到会话');
      }
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
    if (op === 'config') {
      // 浏览器半部据此决定要不要给标题打实例 tag（见 client.js 的 TITLE_TAG）
      return { ok: true, titleTag: cfg.titleTag !== false, platform: platform.kind };
    }
    if (op === 'state') {
      return {
        ok: true,
        attended: presence.attendedSessionId() ?? null,
        attendedSessions: presence.attendedSessions(),
        mode: presence.mode(),
        sessionTracking: presence.sessionTracking,
        platform: platform.kind,
        // 被其它插件显式抑制的会话（排障用：通知没弹先看这里）
        suppressed: suppression.snapshot(),
      };
    }
    if (op === 'pending-focus') {
      const fresh = pendingFocus !== null && Date.now() - pendingFocus.at <= cfg.focusTtlMs;
      if (!fresh && pendingFocus !== null) pendingFocus = null;
      if (!fresh) return { ok: true, sessionId: null, reveal: null };
      // 揭示目标：调用方（如 btw）声明过「这条会话属于右栏某个 tab」时带上，
      // 浏览器半部会先试在右栏打开它，失败再退回主视图。away-notify 只转发地址。
      return { ok: true, sessionId: pendingFocus.sessionId, reveal: suppression.revealFor(pendingFocus.sessionId) ?? null };
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
      spawnImpl,
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
    const tagMode = cfg.titleTag !== false ? 'port' : 'off';
    const spoolDir = cfg.spoolDir && String(cfg.spoolDir).trim() ? String(cfg.spoolDir).trim() : SPOOL_DIR;
    startFocusHelper(platform, cfg, tagMode, spoolDir, log, spawnImpl);
    registerProtocol({
      mode: 'enqueue',
      powershell: platform.powershell,
      // 回退路径用到的两个脚本：助手不在时由 enqueue 脚本直接冷跑它们
      scriptPath: LAUNCHER_SCRIPT,
      vbsPath: LAUNCHER_VBS,
      // 快路径
      enqueueVbs: ENQUEUE_VBS,
      spoolDir,
      marker: cfg.focusWindowMarker,
      // 让焦点脚本除了 marker 还要求端口 tag，从而只命中本实例的窗口
      tagMode,
      spawnImpl,
      spawnSyncImpl,
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

    // 插件卸载时让助手退出，否则它会一直挂着占内存
    ctx.effect(
      () => () => {
        try {
          if (existsSync(spoolDir)) writeFileSync(join(spoolDir, 'stop'), String(Date.now()), 'utf8');
        } catch {
          /* ignore */
        }
      },
      'dsh-away-notify: focus helper lifecycle',
    );
  } else if (cfg.useProtocolHandler !== false && cfg.openOnClick !== false) {
    log('info', '当前平台不支持自定义协议，点击通知将走普通 URL');
  }
}

/**
 * 准备 spool 并拉起常驻焦点助手。
 *
 * 为什么值得多一个进程：一次点击若走冷 PowerShell，要付 ~950ms 进程启动 +
 * ~285ms 现场编译 P/Invoke + ~200ms 冷程序集加载，实测端到端 ~2.1s。助手把这些
 * 一次性付掉，之后每次点击只剩「写个文件 + FileSystemWatcher 唤醒 + 置前」。
 *
 * 助手只做置前，不参与任何通知逻辑，所以它起不来最多是「点击变慢」——此时
 * enqueue 脚本会检测到心跳过期并直接冷跑 focus-or-open.ps1 兜底。
 */
function startFocusHelper(platform, cfg, tagMode, spoolDir, log, spawnImpl = spawn) {
  try {
    mkdirSync(spoolDir, { recursive: true });
    // 上一次运行留下的 stop 会让新助手立刻退出，先清掉
    try {
      rmSync(join(spoolDir, 'stop'), { force: true });
    } catch {
      /* ignore */
    }

    // config.txt 由 enqueue-focus.vbs 每次点击现读，所以改配置无需重启助手
    const config = [
      `marker=${cfg.focusWindowMarker}`,
      `tagmode=${tagMode}`,
      `helper=${toWindowsPath(HELPER_PS1)}`,
      `direct=${toWindowsPath(LAUNCHER_SCRIPT)}`,
      `hidden=${toWindowsPath(LAUNCHER_VBS)}`,
      '',
    ].join('\r\n');
    writeFileSync(join(spoolDir, 'config.txt'), config, 'utf8');

    const wscript = deriveWscriptPath(platform.powershell);
    if (!wscript) {
      log('warn', '推不出 wscript.exe 路径，焦点助手未启动（点击将走冷启动兜底）');
      return;
    }
    const spoolWin = toWindowsPath(spoolDir);
    // 传给 wscript 的**所有**路径都必须是 Windows 形式。wscript.exe 是 Windows
    // 程序，把 `/mnt/d/...` 递给它会被当成未知选项，并**弹出错误对话框**（真机
    // 踩到：`指定了未知的选项"/mnt/.../run-hidden.vbs"`）。
    // `//B` 是批处理模式：即使将来还有别的错误，也只静默失败，不会再弹窗打扰。
    const child = spawnImpl(
      wscript,
      ['//B', '//Nologo', toWindowsPath(LAUNCHER_VBS), toWindowsPath(HELPER_PS1), '-SpoolDir', spoolWin],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => log('warn', `焦点助手启动失败：${String(error?.message ?? error)}`));
    child.unref?.();
    log('info', '焦点助手已启动（点击延迟约 0.15s 而非 2s）');
  } catch (error) {
    log('warn', `焦点助手启动异常，将走冷启动兜底：${String(error?.message ?? error)}`);
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
