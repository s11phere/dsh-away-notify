import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, Cooldown, classifyTurnEnd, buildBody, isKindEnabled, DEFAULT_POLICY } from '../lib/policy.js';

const ev = (over = {}) => ({
  sessionId: 's1',
  sessionTitle: '重构数据库',
  isSubagent: false,
  kind: 'turn-complete',
  body: '已经把迁移脚本写好了。',
  ...over,
});

test('离开页面时，回合完成会通知', () => {
  const r = decide(ev(), { isAttended: () => false });
  assert.equal(r.notify, true);
  assert.equal(r.kind, 'turn-complete');
  assert.match(r.title, /回答完成/);
  assert.match(r.body, /重构数据库/);
});

test('正在看这个会话时不通知（前台抑制）', () => {
  const r = decide(ev(), { isAttended: (id) => id === 's1' });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'attended-foreground');
});

test('看着 s1 时，后台会话 s2 仍然通知', () => {
  const r = decide(ev({ sessionId: 's2' }), { isAttended: (id) => id === 's1' });
  assert.equal(r.notify, true);
});

test('默认忽略子代理会话', () => {
  const r = decide(ev({ isSubagent: true }), { isAttended: () => false });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'subagent-session');
});

test('rootsOnly=false 时子代理也通知', () => {
  const r = decide(ev({ isSubagent: true }), { isAttended: () => false, policy: { rootsOnly: false } });
  assert.equal(r.notify, true);
});

test('五类触发默认全部开启', () => {
  for (const k of [
    'turn-complete',
    'turn-error',
    'turn-aborted',
    'turn-max-tokens',
    'approval',
    'question',
    'goal-complete',
  ]) {
    assert.equal(isKindEnabled(k, DEFAULT_POLICY), true, `${k} 应默认开启`);
  }
});

test('未知 kind 不通知', () => {
  const r = decide(ev({ kind: 'something-else' }), { isAttended: () => false });
  assert.equal(r.notify, false);
  assert.match(r.reason, /kind-disabled/);
});

test('关闭某个开关后该类不再通知', () => {
  const r = decide(ev({ kind: 'approval' }), { isAttended: () => false, policy: { onApproval: false } });
  assert.equal(r.notify, false);
});

test('冷却窗口内同类通知被抑制，超时后恢复', () => {
  let t = 0;
  const cooldown = new Cooldown({ now: () => t });
  const deps = { isAttended: () => false, cooldown, policy: { cooldownMs: 10000 } };

  const first = decide(ev(), deps);
  assert.equal(first.notify, true);
  cooldown.mark(first.key);

  const second = decide(ev(), deps);
  assert.equal(second.notify, false);
  assert.equal(second.reason, 'cooldown');

  t = 10001;
  const third = decide(ev(), deps);
  assert.equal(third.notify, true);
});

test('冷却按 kind 隔离：完成被抑制不影响审批通知', () => {
  let t = 0;
  const cooldown = new Cooldown({ now: () => t });
  const deps = { isAttended: () => false, cooldown, policy: { cooldownMs: 10000 } };
  const a = decide(ev(), deps);
  cooldown.mark(a.key);
  const b = decide(ev({ kind: 'approval' }), deps);
  assert.equal(b.notify, true);
});

test('冷却按会话隔离', () => {
  const cooldown = new Cooldown({ now: () => 0 });
  const deps = { isAttended: () => false, cooldown, policy: { cooldownMs: 10000 } };
  const a = decide(ev({ sessionId: 's1' }), deps);
  cooldown.mark(a.key);
  const b = decide(ev({ sessionId: 's2' }), deps);
  assert.equal(b.notify, true);
});

test('缺少 sessionId 直接跳过', () => {
  assert.equal(decide(ev({ sessionId: '' }), { isAttended: () => false }).notify, false);
});

test('classifyTurnEnd 覆盖 completed/error/aborted/max-tokens', () => {
  assert.equal(classifyTurnEnd('completed'), 'turn-complete');
  assert.equal(classifyTurnEnd('error'), 'turn-error');
  assert.equal(classifyTurnEnd('failed'), 'turn-error');
  assert.equal(classifyTurnEnd('aborted'), 'turn-aborted');
  assert.equal(classifyTurnEnd('interrupted'), 'turn-aborted');
  assert.equal(classifyTurnEnd('max-tokens'), 'turn-max-tokens');
  assert.equal(classifyTurnEnd('max_tokens'), 'turn-max-tokens');
});

test('goal 中间轮次静默（默认）', () => {
  const r = decide(ev({ isGoalRound: true }), { isAttended: () => false });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'goal-round-suppressed');
});

test('goal 完成时照常提醒', () => {
  const r = decide(ev({ isGoalRound: true, kind: 'goal-complete' }), { isAttended: () => false });
  assert.equal(r.notify, true);
});

test('goal 中间轮次出错时照常提醒', () => {
  const r = decide(ev({ isGoalRound: true, kind: 'turn-error' }), { isAttended: () => false });
  assert.equal(r.notify, true);
});

test('suppressGoalRounds=false 时 goal 中间轮次也提醒', () => {
  const r = decide(ev({ isGoalRound: true }), { isAttended: () => false, policy: { suppressGoalRounds: false } });
  assert.equal(r.notify, true);
});

test('非 goal 会话不受 goal 抑制影响', () => {
  const r = decide(ev({ isGoalRound: false }), { isAttended: () => false });
  assert.equal(r.notify, true);
});

test('buildBody 截断过长正文', () => {
  const body = buildBody(ev({ body: 'x'.repeat(500) }), { previewMaxChars: 40 });
  assert.equal(body.length, 40);
  assert.match(body, /…$/);
});

test('buildBody 在没有摘要时给出兜底文案', () => {
  assert.equal(buildBody({ sessionId: 's1' }), '有新进展');
});

test('buildBody 折叠空白字符', () => {
  const body = buildBody(ev({ sessionTitle: '', body: 'a\n\n  b\tc' }));
  assert.equal(body, 'a b c');
});

// ── 显式抑制（其它插件声明的「这条会话别打扰」）─────────────────────────────

test('被显式抑制的会话不通知，原因带调用方标签', () => {
  const r = decide(ev(), { isAttended: () => false, suppressionReason: () => 'dsh-btw-sidebar' });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'suppressed:dsh-btw-sidebar');
});

test('抑制优先于在场判定与冷却（无条件生效）', () => {
  const r = decide(ev(), {
    isAttended: () => true,
    suppressionReason: () => 'plugin',
  });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'suppressed:plugin');
});

test('suppressionReason 返回 undefined 时照常提醒', () => {
  const r = decide(ev(), { isAttended: () => false, suppressionReason: () => undefined });
  assert.equal(r.notify, true);
});

test('未接线 suppressionReason 时行为与从前一致', () => {
  assert.equal(decide(ev(), { isAttended: () => false }).notify, true);
  // 传了非函数也不应崩
  assert.equal(decide(ev(), { isAttended: () => false, suppressionReason: 'nope' }).notify, true);
});

test('抑制按会话隔离：只压 s1，不压 s2', () => {
  const deps = { isAttended: () => false, suppressionReason: (id) => (id === 's1' ? 'plugin' : undefined) };
  assert.equal(decide(ev({ sessionId: 's1' }), deps).notify, false);
  assert.equal(decide(ev({ sessionId: 's2' }), deps).notify, true);
});
