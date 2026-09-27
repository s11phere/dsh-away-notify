/**
 * policy.js — 触发判定 / 前台抑制 / 冷却去重（纯逻辑，无 DSH 依赖）
 *
 * 输入是**归一化事件**（由 host.js 的适配层把 DSH 原始会话事件转成这个形状），
 * 因此本模块可以完全脱离 DSH 运行时做单元测试。
 *
 * 归一化事件形状：
 *   {
 *     sessionId: string,
 *     sessionTitle: string,
 *     isSubagent: boolean,
 *     kind: 'turn-complete' | 'turn-error' | 'turn-aborted' | 'turn-max-tokens'
 *         | 'approval' | 'question' | 'goal-complete',
 *     body: string,          // 通知正文（已由适配层提取好的摘要/问题/原因）
 *     turnIndex?: number,
 *   }
 */

export const DEFAULT_POLICY = {
  // 五类触发（用户已全部启用）
  // 注意：这套默认值必须与 host.js 的 DEFAULTS 保持一致。两边曾经对
  // onTurnAborted 给出相反的值（这里 false、host 里 true）；宿主每次都传完整
  // config，所以当时行为由 host 决定、没暴露出来，但单独使用本模块就会拿到
  // 另一个默认值。改动任一侧时请同步另一侧。
  onTurnComplete: true,
  onTurnError: true,
  onTurnAborted: true,
  onTurnMaxTokens: true,
  onApproval: true,
  onQuestion: true,
  onGoalComplete: true,
  // 只提醒主会话，子代理不打扰
  rootsOnly: true,
  // /goal 自动推进的中间轮次保持静默，只在 goal 完成或出错时提醒
  suppressGoalRounds: true,
  // 同一会话同一类通知的最小间隔
  cooldownMs: 10000,
  // 标题前缀
  titlePrefix: 'DSH',
};

const KIND_LABEL = {
  'turn-complete': '回答完成',
  'turn-error': '任务出错',
  'turn-aborted': '任务已停止',
  'turn-max-tokens': '达到输出上限',
  approval: '需要审批',
  question: '需要你的回答',
  'goal-complete': '任务完成',
};

const KIND_FLAG = {
  'turn-complete': 'onTurnComplete',
  'turn-error': 'onTurnError',
  'turn-aborted': 'onTurnAborted',
  'turn-max-tokens': 'onTurnMaxTokens',
  approval: 'onApproval',
  question: 'onQuestion',
  'goal-complete': 'onGoalComplete',
};

/** 该 kind 是否被配置启用。 */
export function isKindEnabled(kind, policy) {
  const flag = KIND_FLAG[kind];
  if (!flag) return false;
  return policy[flag] !== false;
}

/**
 * 冷却/去重器：按 `${sessionId}:${kind}` 记录上次通知时间。
 */
export class Cooldown {
  #entries = new Map();
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  /** 是否允许现在通知；allow=false 时不消耗配额。 */
  allow(key, cooldownMs) {
    if (!cooldownMs || cooldownMs <= 0) return true;
    const last = this.#entries.get(key);
    const now = this.#now();
    if (last !== undefined && now - last < cooldownMs) return false;
    return true;
  }

  /** 记录一次已发生的通知。 */
  mark(key) {
    this.#entries.set(key, this.#now());
  }

  reset() {
    this.#entries.clear();
  }
}

/**
 * 决策核心：给定归一化事件 + 在场状态 + 配置，决定要不要弹、弹什么。
 *
 * @param {object} event 归一化事件
 * @param {object} deps  { policy, isAttended(sessionId), cooldown, suppressionReason(sessionId, event) }
 * @returns {{notify:boolean, reason:string, title?:string, body?:string, kind?:string}}
 */
export function decide(event, deps) {
  const policy = { ...DEFAULT_POLICY, ...(deps.policy ?? {}) };
  const { isAttended = () => false, cooldown, suppressionReason } = deps;

  if (!event?.sessionId) return { notify: false, reason: 'no-session-id' };

  if (policy.rootsOnly && event.isSubagent) {
    return { notify: false, reason: 'subagent-session' };
  }

  if (!isKindEnabled(event.kind, policy)) {
    return { notify: false, reason: `kind-disabled:${event.kind}` };
  }

  // 显式抑制：由其它插件声明的「这条/这类会话不要打扰」（见 suppress.js 与
  // README 的「给其他插件的接口」）。判定在在场与冷却之前——它是无条件的，
  // 与用户是否在看页面、是否刚收到过同类通知都无关。
  const suppressed = typeof suppressionReason === 'function' ? suppressionReason(event.sessionId, event) : undefined;
  if (suppressed) {
    return { notify: false, reason: `suppressed:${suppressed}` };
  }

  // /goal 自动推进的中间轮次不打扰，但终点（goal 完成）与出错照常提醒
  if (policy.suppressGoalRounds && event.isGoalRound && event.kind !== 'goal-complete' && event.kind !== 'turn-error') {
    return { notify: false, reason: 'goal-round-suppressed' };
  }

  // 前台抑制：用户正盯着这个会话就別打扰
  if (isAttended(event.sessionId)) {
    return { notify: false, reason: 'attended-foreground' };
  }

  const key = `${event.sessionId}:${event.kind}`;
  if (cooldown && !cooldown.allow(key, policy.cooldownMs)) {
    return { notify: false, reason: 'cooldown' };
  }

  const label = KIND_LABEL[event.kind] ?? event.kind;
  const title = `${policy.titlePrefix} · ${label}`;
  const body = buildBody(event, policy);
  return { notify: true, reason: 'ok', kind: event.kind, title, body, key };
}

/** 正文：`会话标题 — 摘要`，过长则截断。 */
export function buildBody(event, policy = DEFAULT_POLICY) {
  const max = policy.previewMaxChars ?? 140;
  const parts = [];
  if (event.sessionTitle) parts.push(event.sessionTitle);
  if (event.body) parts.push(String(event.body).replace(/\s+/g, ' ').trim());
  let text = parts.join(' — ');
  if (!text) text = '有新进展';
  if (text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`;
  return text;
}

/** 供日志/诊断使用：把 DSH 的 turn/end reason 映射到归一化 kind。 */
export function classifyTurnEnd(reasonKind) {
  switch (reasonKind) {
    case 'completed':
      return 'turn-complete';
    case 'max-tokens':
    case 'max_tokens':
      return 'turn-max-tokens';
    case 'aborted':
    case 'interrupted':
      return 'turn-aborted';
    case 'error':
    case 'failed':
      return 'turn-error';
    default:
      return 'turn-complete';
  }
}
