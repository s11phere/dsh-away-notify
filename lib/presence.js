/**
 * presence.js — 「谁在看哪个会话」状态表（宿主侧）
 *
 * 关键设计：按 **clientId（每个标签页一个）** 记录状态，而不是按 sessionId。
 *
 * 为什么：如果按 sessionId 存「上次被看到的时间 + TTL」，那么同一个标签页从会话 A
 * 切到会话 B 之后，A 的记录在 TTL 内依然「新鲜」，会被继续当成「用户正在看 A」而
 * 抑制 A 的通知——实测就是这个 bug。按 clientId 存之后，同一标签页的新上报会**直接
 * 覆盖**旧记录，A 立刻失效；而多个标签页各有自己的 clientId，可以同时被抑制。
 *
 * 判定规则：
 *   1. 没有任何「新鲜 + 可见 + 有焦点」的客户端 → 视为离开，一律提醒。
 *   2. 有，且该客户端能给出会话 id → 只抑制它正在看的那个会话，后台会话照常提醒。
 *   3. 有，但客户端**从未**能给出会话 id → 保守抑制全部（等价于「不在页面上才弹」）。
 *   4. 某个客户端能给会话信息、另一个给不出 → 给不出的那个保守视为「可能在看我」。
 */

export const DEFAULT_TTL_MS = 45000;

/** 退化模式下 `attendedSessionId()` 返回的通配标记。 */
export const PAGE_WIDE = '*';

/** 缺省客户端标识（客户端未提供时退化用）。 */
export const DEFAULT_CLIENT = 'default';

export class PresenceStore {
  #ttlMs;
  #now;
  #clients = new Map(); // clientId -> { sessionId, visible, focused, at }
  #sawSessionId = false;

  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get ttlMs() {
    return this.#ttlMs;
  }

  set ttlMs(v) {
    this.#ttlMs = v;
  }

  #fresh(entry) {
    return this.#now() - entry.at <= this.#ttlMs;
  }

  /** 当前「新鲜 + 可见 + 有焦点」的客户端记录。 */
  #attended() {
    const out = [];
    for (const entry of this.#clients.values()) {
      if (this.#fresh(entry) && entry.visible && entry.focused) out.push(entry);
    }
    return out;
  }

  /**
   * 记录一次上报。`sessionId` 允许缺省——缺省表示「该客户端此刻无法确定用户在看哪个
   * 会话」，此时仍记录页面级的可见性/焦点。
   */
  report({ clientId, sessionId, visible = false, focused = false, at = null } = {}) {
    const key = typeof clientId === 'string' && clientId.length > 0 ? clientId : DEFAULT_CLIENT;
    const valid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
    if (valid !== undefined) this.#sawSessionId = true;
    // 同一 clientId 直接覆盖：切换会话时旧会话立刻失效（这正是修掉的那个 bug）
    this.#clients.set(key, { sessionId: valid, visible: !!visible, focused: !!focused, at: at ?? this.#now() });
  }

  /** 页面本身是否有客户端正被用户看着。 */
  isPageAttended() {
    return this.#attended().length > 0;
  }

  /** 是否已经能拿到会话级信息。 */
  get sessionTracking() {
    return this.#sawSessionId;
  }

  /** 某个会话当前是否「正在被看着」。 */
  isAttended(sessionId) {
    const attended = this.#attended();
    if (attended.length === 0) return false;
    if (!this.#sawSessionId) return true; // 退化：不知道在看哪个会话 -> 保守抑制
    // 能归因的按会话匹配；不能归因的客户端保守视为「可能在看我」
    return attended.some((entry) => entry.sessionId === undefined || entry.sessionId === sessionId);
  }

  /** 当前正在被看的全部会话 id。 */
  attendedSessions() {
    const out = new Set();
    for (const entry of this.#attended()) if (entry.sessionId !== undefined) out.add(entry.sessionId);
    return [...out];
  }

  /** 诊断用：正在被看的会话 id；退化模式返回 `'*'`；没人看返回 null。 */
  attendedSessionId() {
    if (!this.isPageAttended()) return null;
    const sessions = this.attendedSessions();
    if (sessions.length > 0) return sessions[0];
    return PAGE_WIDE;
  }

  /** 当前生效的模式，供诊断。 */
  mode() {
    const attended = this.#attended();
    if (attended.length === 0) return 'away';
    return attended.some((entry) => entry.sessionId !== undefined) ? 'session' : 'page';
  }

  /** 清理过期条目，返回清理数量。 */
  sweep() {
    let n = 0;
    for (const [key, entry] of this.#clients) {
      if (!this.#fresh(entry)) {
        this.#clients.delete(key);
        n++;
      }
    }
    return n;
  }

  /** 诊断快照。 */
  snapshot() {
    const now = this.#now();
    const clients = {};
    for (const [key, entry] of this.#clients) {
      clients[key] = {
        ...entry,
        ageMs: now - entry.at,
        attended: this.#fresh(entry) && entry.visible && entry.focused,
      };
    }
    return {
      mode: this.mode(),
      sessionTracking: this.#sawSessionId,
      attendedSessions: this.attendedSessions(),
      clients,
    };
  }

  clear() {
    this.#clients.clear();
    this.#sawSessionId = false;
  }
}
