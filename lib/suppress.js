/**
 * suppress.js — 「会话通知策略」注册表（纯逻辑，无 DSH 依赖）
 *
 * 这是本插件对**其它插件**开放的扩展点，有两件事：
 *
 *   1. **抑制**：声明「不要为这条（或这类）会话弹通知」。典型场景是 dsh-btw-sidebar 的
 *      侧边聊天——它是主会话 fork 出来的**普通会话**，用户正看着它，但浏览器半部上报的
 *      「当前会话」永远是主视图那条，于是宿主的在场判定认不出它，跑完一轮就会误弹。
 *   2. **点击揭示**：声明「点击这条会话的通知时，用哪个界面把它显示出来」。同样是侧边
 *      聊天：点通知应该回到右栏那个 tab，而不是在主视图里开一条会话（见 README 的
 *      「给其他插件的接口」）。
 *
 * 为什么要做成通用注册表，而不是让 away-notify 认识某个插件：
 *   - away-notify **不需要**知道「侧边聊天」是什么，也不需要匹配标题前缀（那种关键词
 *     黑名单一旦用户改了标题就失效，还会把别的插件卷进来）；
 *   - 抑制的**语义**由调用方自己定义（进程内永久 / 面板开着且你在看时 / 只在某个界面
 *     可见时），本模块只负责记账与查询，因此可以完全脱离 DSH 单测。
 *
 * 两种声明方式：
 *   1. `claim(sessionId, reason)` —— 逐条会话抑制；返回释放函数，内部按 token 引用
 *      计数，多个调用方各自释放互不影响。
 *   2. `addRule({ id, reason, match })` —— 按「类」声明；`match(sessionId, event, context)`
 *      由调用方判定（`context` 含 `attended` / `pageAttended`，见下），适合「我这一批
 *      会话都不该打扰」的插件，不必逐条登记。
 *
 * 契约：本模块**绝不抛异常**给调用方。`match` 抛错时记为「不命中」（宁可多弹一条，
 * 也不能因为第三方插件的 bug 让整个通知链路失效），错误信息进 snapshot 供排障。
 */

/** 对外暴露的接口版本。其它插件可据此判断能力面，便于将来演进。 */
export const SUPPRESS_API_VERSION = 1;

/** 未提供 reason 时的兜底原因（会出现在 `已抑制(suppressed:…)` 日志里）。 */
export const DEFAULT_REASON = 'plugin';

/** 把会话 id 归一化：非字符串 / 空串一律视为「无效，不登记」。 */
function normalizeId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/** 把 reason 归一化成单行短文本（它会进日志与诊断端点）。 */
function normalizeReason(reason) {
  if (typeof reason !== 'string') return DEFAULT_REASON;
  const flat = reason.replace(/\s+/g, ' ').trim();
  return flat.length > 0 ? flat.slice(0, 120) : DEFAULT_REASON;
}

export class SuppressionRegistry {
  /**
   * token -> { sessionId, reason, suppress, reveal }
   *
   * `suppress` 与 `reveal` 正交：一条声明可以只抑制、只揭示，或两者兼有。
   * `reveal` 归一化成一个对象 `{ resource, mainSessionId? }`（见 `reveal()`）。
   */
  #claims = new Map();
  /** sessionId -> Set<token>。 */
  #bySession = new Map();
  /** ruleId -> { id, reason, match, error }。 */
  #rules = new Map();
  #seq = 0;

  /**
   * 声明抑制一条会话。
   *
   * @param {string} sessionId - 目标会话。
   * @param {string} [reason] - 原因标签（会出现在日志与诊断里，建议用插件 id）。
   * @returns {() => boolean} 释放函数；重复调用只有第一次生效。id 无效时返回空操作。
   */
  claim(sessionId, reason = DEFAULT_REASON) {
    return this.#add(sessionId, { reason: normalizeReason(reason), suppress: true, reveal: undefined });
  }

  /**
   * 声明一条会话的「点击揭示」目标：点它的通知时，先在右栏打开这个资源地址。
   *
   * 地址是不透明字符串，本模块只负责转发；拿到它的浏览器半部会先试着在右栏打开，
   * 失败（没有 tab 类型认领、右栏服务缺失）再退回主视图。
   *
   * `mainSessionId` 也是可选的，语义是「这个资源所在的右栏属于哪条主视图会话」。
   * **右栏的状态是按主视图会话分域的**（`sidebarRight` 的每个动作都带 sessionId），
   * 所以目标会话不是当前主视图时，浏览器半部必须先把主视图切过去再打开资源；否则
   * tab 会落进当前那条会话的右栏（表现为「点通知后侧栏出现在别人家」）。不传它就
   * 退化为旧行为：直接开在当前挂载的会话里。
   *
   * @param {string} sessionId - 目标会话。
   * @param {{ resource?: string, mainSessionId?: string, reason?: string }} target -
   *   `resource` 是 `dsh-resource://…` 地址；`mainSessionId` 是它的归属主视图会话（可选）。
   * @returns {() => boolean} 释放函数；`resource` 无效时返回空操作。
   */
  reveal(sessionId, { resource, mainSessionId, reason = DEFAULT_REASON } = {}) {
    const address = typeof resource === 'string' && resource.length > 0 ? resource : undefined;
    if (address === undefined) return () => false;
    const owner = typeof mainSessionId === 'string' && mainSessionId.length > 0 ? mainSessionId : undefined;
    return this.#add(sessionId, {
      reason: normalizeReason(reason),
      suppress: false,
      reveal: owner === undefined ? { resource: address } : { resource: address, mainSessionId: owner },
    });
  }

  #add(sessionId, entry) {
    const sid = normalizeId(sessionId);
    if (sid === undefined) return () => false;

    this.#seq += 1;
    const token = this.#seq;
    this.#claims.set(token, { sessionId: sid, ...entry });
    let tokens = this.#bySession.get(sid);
    if (tokens === undefined) {
      tokens = new Set();
      this.#bySession.set(sid, tokens);
    }
    tokens.add(token);

    let released = false;
    return () => {
      if (released) return false;
      released = true;
      return this.#drop(token);
    };
  }

  #drop(token) {
    const claim = this.#claims.get(token);
    if (claim === undefined) return false;
    this.#claims.delete(token);
    const tokens = this.#bySession.get(claim.sessionId);
    if (tokens !== undefined) {
      tokens.delete(token);
      if (tokens.size === 0) this.#bySession.delete(claim.sessionId);
    }
    return true;
  }

  /**
   * 撤销一条会话的**全部**声明（抑制与揭示，不管是谁声明的）。
   *
   * @param {string} sessionId - 目标会话。
   * @returns {number} 实际撤销的声明数。
   */
  release(sessionId) {
    const sid = normalizeId(sessionId);
    if (sid === undefined) return 0;
    const tokens = this.#bySession.get(sid);
    if (tokens === undefined) return 0;
    let n = 0;
    for (const token of [...tokens]) if (this.#drop(token)) n += 1;
    return n;
  }

  /**
   * 注册一条按「类」判定的抑制规则。
   *
   * @param {{ id?: string, reason?: string,
   *   match: (sessionId: string, event?: object, context?: object) => boolean }} rule
   *   `context` 由宿主提供：`{ attended, pageAttended }`——前者是「用户正看着这条会话」，
   *   后者是「用户正看着 dsh 页面（可见 + 有焦点）」。调用方据此实现「只在被看着时静音」
   *   这类语义。`id` 缺省时自动生成；同 id 重复注册会覆盖（热重载友好）。
   * @returns {() => boolean} 注销函数；若期间已被同 id 的新规则覆盖，则不会误删新规则。
   */
  addRule(rule) {
    const match = rule?.match;
    if (typeof match !== 'function') return () => false;
    this.#seq += 1;
    const id = typeof rule?.id === 'string' && rule.id.length > 0 ? rule.id : `rule-${this.#seq}`;
    const entry = { id, reason: normalizeReason(rule?.reason), match, error: undefined };
    this.#rules.set(id, entry);
    return () => {
      if (this.#rules.get(id) !== entry) return false;
      this.#rules.delete(id);
      return true;
    };
  }

  /** 规则是否命中；`match` 抛错时视为不命中，并把错误记进 snapshot。 */
  #ruleHit(entry, sessionId, event, context) {
    try {
      return entry.match(sessionId, event, context) === true;
    } catch (error) {
      entry.error = String(error?.message ?? error);
      return false;
    }
  }

  /**
   * 该会话当前是否被抑制；是则返回原因标签。
   *
   * @param {string} sessionId - 目标会话。
   * @param {object} [event] - 归一化事件（规则判定可用）。
   * @param {object} [context] - `{ attended, pageAttended }`（规则判定可用）。
   * @returns {string | undefined} 原因，未抑制时为 undefined。
   */
  reasonFor(sessionId, event, context) {
    const sid = normalizeId(sessionId);
    if (sid === undefined) return undefined;

    const tokens = this.#bySession.get(sid);
    if (tokens !== undefined) {
      for (const token of tokens) {
        const claim = this.#claims.get(token);
        if (claim !== undefined && claim.suppress) return claim.reason;
      }
    }
    for (const entry of this.#rules.values()) {
      if (this.#ruleHit(entry, sid, event, context)) return entry.reason;
    }
    return undefined;
  }

  /** 是否被抑制（`reasonFor` 的布尔形式）。 */
  isSuppressed(sessionId, event, context) {
    return this.reasonFor(sessionId, event, context) !== undefined;
  }

  /**
   * 该会话的「点击揭示」目标。
   *
   * @param {string} sessionId - 目标会话。
   * @returns {{ resource: string, mainSessionId?: string, reason: string } | undefined}
   *   未声明时为 undefined；`mainSessionId` 只在声明时提供过才出现。
   */
  revealFor(sessionId) {
    const sid = normalizeId(sessionId);
    if (sid === undefined) return undefined;
    const tokens = this.#bySession.get(sid);
    if (tokens === undefined) return undefined;
    for (const token of tokens) {
      const claim = this.#claims.get(token);
      if (claim !== undefined && claim.reveal !== undefined) {
        return { ...claim.reveal, reason: claim.reason };
      }
    }
    return undefined;
  }

  /** 诊断快照：谁被抑制、谁声明了揭示目标、有哪些规则（含规则抛错）。 */
  snapshot() {
    const sessions = [];
    for (const sessionId of this.#bySession.keys()) {
      const reason = this.reasonFor(sessionId);
      const reveal = this.revealFor(sessionId);
      if (reason === undefined && reveal === undefined) continue;
      const entry = { sessionId };
      if (reason !== undefined) entry.reason = reason;
      // reason 与 reveal.reason 常常同源，重复时只留一份，免得诊断输出啰嗦
      if (reveal !== undefined) {
        const shape = { resource: reveal.resource };
        if (reveal.mainSessionId !== undefined) shape.mainSessionId = reveal.mainSessionId;
        entry.reveal = reason === reveal.reason ? shape : { ...shape, reason: reveal.reason };
      }
      sessions.push(entry);
    }
    const rules = [...this.#rules.values()].map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
    return { version: SUPPRESS_API_VERSION, sessions, rules };
  }

  /** 清空全部声明（卸载 / 测试用）。 */
  clear() {
    this.#claims.clear();
    this.#bySession.clear();
    this.#rules.clear();
  }
}
