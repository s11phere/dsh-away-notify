/**
 * suppress.test.mjs — 显式抑制注册表的纯逻辑测试。
 *
 * 这是给其它插件用的接口，语义必须精确：引用计数、规则覆盖、规则抛错不得抑制、
 * 诊断可见。全部离线，不碰 DSH。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REASON, SUPPRESS_API_VERSION, SuppressionRegistry } from '../lib/suppress.js';

test('claim 之后 isSuppressed 返回原因，release 后失效', () => {
  const registry = new SuppressionRegistry();
  assert.equal(registry.isSuppressed('s1'), false);

  const release = registry.claim('s1', 'dsh-btw-sidebar');
  assert.equal(registry.isSuppressed('s1'), true);
  assert.equal(registry.reasonFor('s1'), 'dsh-btw-sidebar');

  assert.equal(release(), true);
  assert.equal(registry.isSuppressed('s1'), false);
});

test('释放函数幂等：重复调用只有第一次生效', () => {
  const registry = new SuppressionRegistry();
  const release = registry.claim('s1', 'x');
  assert.equal(release(), true);
  assert.equal(release(), false);
});

test('同一会话被多处声明时按引用计数：一个释放不影响另一个', () => {
  const registry = new SuppressionRegistry();
  const a = registry.claim('s1', 'plugin-a');
  const b = registry.claim('s1', 'plugin-b');
  a();
  assert.equal(registry.isSuppressed('s1'), true, 'plugin-b 仍声明着');
  b();
  assert.equal(registry.isSuppressed('s1'), false);
});

test('release 一次撤销该会话的全部声明并返回数量', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1', 'a');
  registry.claim('s1', 'b');
  assert.equal(registry.release('s1'), 2);
  assert.equal(registry.release('s1'), 0);
});

test('无效的会话 id 不登记，也不出现在诊断里', () => {
  const registry = new SuppressionRegistry();
  assert.equal(registry.claim(undefined, 'x')(), false);
  assert.equal(registry.claim('', 'x')(), false);
  assert.equal(registry.release(42), 0);
  assert.deepEqual(registry.snapshot().sessions, []);
});

test('缺少 reason 时用兜底标签，且单行化截断', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1');
  assert.equal(registry.reasonFor('s1'), DEFAULT_REASON);

  registry.claim('s2', 'a\n\n  b');
  assert.equal(registry.reasonFor('s2'), 'a b');

  registry.claim('s3', 'x'.repeat(500));
  assert.equal(registry.reasonFor('s3').length, 120);
});

test('addRule 按类命中；注销后失效', () => {
  const registry = new SuppressionRegistry();
  const dispose = registry.addRule({
    id: 'btw',
    reason: 'dsh-btw-sidebar',
    match: (sid) => sid.startsWith('side-'),
  });
  assert.equal(registry.reasonFor('side-1'), 'dsh-btw-sidebar');
  assert.equal(registry.reasonFor('main-1'), undefined);

  assert.equal(dispose(), true);
  assert.equal(registry.reasonFor('side-1'), undefined);
  assert.equal(dispose(), false, '重复注销是空操作');
});

test('addRule 会收到归一化事件（规则可按 kind 细分）', () => {
  const registry = new SuppressionRegistry();
  registry.addRule({
    id: 'only-complete',
    reason: 'quiet-complete',
    match: (_sid, event) => event?.kind === 'turn-complete',
  });
  assert.equal(registry.reasonFor('s1', { kind: 'turn-complete' }), 'quiet-complete');
  assert.equal(registry.reasonFor('s1', { kind: 'approval' }), undefined);
});

test('规则抛错时视为不命中（宁可多弹一条，也不让通知链路失效）', () => {
  const registry = new SuppressionRegistry();
  registry.addRule({
    id: 'boom',
    reason: 'boom',
    match: () => {
      throw new Error('rule exploded');
    },
  });
  assert.equal(registry.isSuppressed('s1'), false);
  assert.deepEqual(registry.snapshot().rules, [{ id: 'boom', reason: 'boom', error: 'rule exploded' }]);
});

test('同 id 重复注册覆盖旧规则，旧注销函数不会误删新规则', () => {
  const registry = new SuppressionRegistry();
  const disposeOld = registry.addRule({ id: 'same', reason: 'old', match: () => true });
  registry.addRule({ id: 'same', reason: 'new', match: () => true });
  assert.equal(registry.reasonFor('s1'), 'new');
  assert.equal(disposeOld(), false, '旧注销函数不得删掉新规则');
  assert.equal(registry.reasonFor('s1'), 'new');
});

test('match 不是函数时安全忽略', () => {
  const registry = new SuppressionRegistry();
  assert.equal(registry.addRule({ id: 'bad' })(), false);
  assert.equal(registry.addRule(undefined)(), false);
  assert.equal(registry.isSuppressed('s1'), false);
});

test('逐条声明优先于规则（诊断里能看到具体来源）', () => {
  const registry = new SuppressionRegistry();
  registry.addRule({ id: 'r', reason: 'by-rule', match: () => true });
  registry.claim('s1', 'by-claim');
  assert.equal(registry.reasonFor('s1'), 'by-claim');
  assert.equal(registry.reasonFor('s2'), 'by-rule');
});

test('snapshot 带版本号、会话与规则清单', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1', 'a');
  registry.addRule({ id: 'r', reason: 'b', match: () => false });
  assert.deepEqual(registry.snapshot(), {
    version: SUPPRESS_API_VERSION,
    sessions: [{ sessionId: 's1', reason: 'a' }],
    rules: [{ id: 'r', reason: 'b' }],
  });
});

test('clear 清空全部状态', () => {
  const registry = new SuppressionRegistry();
  const release = registry.claim('s1', 'a');
  registry.addRule({ id: 'r', reason: 'b', match: () => true });
  registry.clear();
  assert.equal(registry.isSuppressed('s1'), false);
  assert.deepEqual(registry.snapshot().sessions, []);
  assert.deepEqual(registry.snapshot().rules, []);
  assert.equal(release(), false);
});

// ── 点击揭示目标（reveal）───────────────────────────────────────────────────

test('reveal 声明揭示目标，但不抑制通知', () => {
  const registry = new SuppressionRegistry();
  const release = registry.reveal('s1', { resource: 'dsh-resource://btw/session/s1', reason: 'btw' });
  assert.deepEqual(registry.revealFor('s1'), { resource: 'dsh-resource://btw/session/s1', reason: 'btw' });
  assert.equal(registry.isSuppressed('s1'), false, '揭示目标不是抑制');
  assert.equal(release(), true);
  assert.equal(registry.revealFor('s1'), undefined);
});

test('resource 无效时不登记', () => {
  const registry = new SuppressionRegistry();
  assert.equal(registry.reveal('s1', { resource: '' })(), false);
  assert.equal(registry.reveal('s1', {})(), false);
  assert.equal(registry.reveal(undefined, { resource: 'dsh-resource://x' })(), false);
  assert.equal(registry.revealFor('s1'), undefined);
});

test('reveal 可带归属主视图会话；不带时形状与旧版一致', () => {
  const registry = new SuppressionRegistry();
  registry.reveal('s1', { resource: 'dsh-resource://btw/session/s1', reason: 'btw' });
  registry.reveal('s2', {
    resource: 'dsh-resource://btw/session/s2',
    mainSessionId: 'm-2',
    reason: 'btw',
  });
  assert.deepEqual(registry.revealFor('s1'), {
    resource: 'dsh-resource://btw/session/s1',
    reason: 'btw',
  }, '没给归属时不得凭空多出字段');
  assert.deepEqual(registry.revealFor('s2'), {
    resource: 'dsh-resource://btw/session/s2',
    mainSessionId: 'm-2',
    reason: 'btw',
  });
});

test('reveal 的 mainSessionId 无效时忽略（不写进揭示目标）', () => {
  const registry = new SuppressionRegistry();
  registry.reveal('s1', { resource: 'dsh-resource://x', mainSessionId: '', reason: 'btw' });
  registry.reveal('s2', { resource: 'dsh-resource://y', mainSessionId: 42, reason: 'btw' });
  assert.equal('mainSessionId' in registry.revealFor('s1'), false);
  assert.equal('mainSessionId' in registry.revealFor('s2'), false);
});

test('snapshot 把归属主视图会话一并回显（排障时能看出点击会切到哪儿）', () => {
  const registry = new SuppressionRegistry();
  registry.reveal('s1', { resource: 'dsh-resource://btw/session/s1', mainSessionId: 'm-1', reason: 'btw' });
  assert.deepEqual(registry.snapshot().sessions, [
    { sessionId: 's1', reveal: { resource: 'dsh-resource://btw/session/s1', mainSessionId: 'm-1', reason: 'btw' } },
  ]);
});

test('抑制与揭示互不干扰：一条会话可以两者都有', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1', 'a');
  registry.reveal('s1', { resource: 'dsh-resource://btw/session/s1', reason: 'a' });
  assert.equal(registry.reasonFor('s1'), 'a');
  assert.deepEqual(registry.revealFor('s1'), { resource: 'dsh-resource://btw/session/s1', reason: 'a' });
});

test('release 一次撤销该会话的抑制与揭示', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1', 'a');
  registry.reveal('s1', { resource: 'dsh-resource://x', reason: 'a' });
  assert.equal(registry.release('s1'), 2);
  assert.equal(registry.isSuppressed('s1'), false);
  assert.equal(registry.revealFor('s1'), undefined);
});

test('snapshot 同时带抑制原因与揭示目标（同源 reason 只留一份）', () => {
  const registry = new SuppressionRegistry();
  registry.claim('s1', 'btw');
  registry.reveal('s1', { resource: 'dsh-resource://btw/session/s1', reason: 'btw' });
  registry.reveal('s2', { resource: 'dsh-resource://btw/session/s2', reason: 'other' });
  assert.deepEqual(registry.snapshot().sessions, [
    { sessionId: 's1', reason: 'btw', reveal: { resource: 'dsh-resource://btw/session/s1' } },
    { sessionId: 's2', reveal: { resource: 'dsh-resource://btw/session/s2', reason: 'other' } },
  ]);
});

// ── 规则上下文（宿主提供的在场信息）────────────────────────────────────────

test('规则能拿到 { attended, pageAttended } 上下文', () => {
  const registry = new SuppressionRegistry();
  registry.addRule({
    id: 'only-while-watched',
    reason: 'watched',
    match: (_sid, _event, context) => context?.pageAttended === true,
  });
  assert.equal(registry.reasonFor('s1', undefined, { pageAttended: false }), undefined);
  assert.equal(registry.reasonFor('s1', undefined, { pageAttended: true }), 'watched');
  assert.equal(registry.reasonFor('s1'), undefined, '没有上下文时不命中');
});

test('规则能同时看事件与上下文（aborted 豁免 + 只看被看着的）', () => {
  const registry = new SuppressionRegistry();
  registry.addRule({
    id: 'btw',
    reason: 'btw',
    match: (_sid, event, context) =>
      event?.kind === 'turn-aborted' || (context?.pageAttended === true && context?.attended === true),
  });
  assert.equal(registry.reasonFor('s1', { kind: 'turn-aborted' }, { pageAttended: false }), 'btw');
  assert.equal(registry.reasonFor('s1', { kind: 'turn-complete' }, { pageAttended: true, attended: false }), undefined);
  assert.equal(registry.reasonFor('s1', { kind: 'turn-complete' }, { pageAttended: true, attended: true }), 'btw');
});
