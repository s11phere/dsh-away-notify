import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceStore, PAGE_WIDE } from '../lib/presence.js';

function makeStore(ttlMs = 45000) {
  let t = 1_000_000;
  const store = new PresenceStore({ ttlMs, now: () => t });
  return { store, advance: (ms) => { t += ms; } };
}

const watch = (store, clientId, sessionId) =>
  store.report({ clientId, sessionId, visible: true, focused: true });

// ── 基础 ────────────────────────────────────────────────────────────────────

test('未上报时视为离开', () => {
  const { store } = makeStore();
  assert.equal(store.isAttended('s1'), false);
  assert.equal(store.mode(), 'away');
  assert.equal(store.attendedSessionId(), null);
});

test('会话级：只看正在看的那个会话，后台会话照常提醒', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  assert.equal(store.isAttended('s1'), true);
  assert.equal(store.isAttended('s2'), false, '后台会话应仍然提醒');
  assert.equal(store.mode(), 'session');
  assert.deepEqual(store.attendedSessions(), ['s1']);
});

test('页面不可见 / 窗口失焦 = 离开', () => {
  const { store } = makeStore();
  store.report({ clientId: 'tab1', sessionId: 's1', visible: false, focused: true });
  assert.equal(store.isAttended('s1'), false);
  store.report({ clientId: 'tab1', sessionId: 's1', visible: true, focused: false });
  assert.equal(store.isAttended('s1'), false);
  assert.equal(store.mode(), 'away');
});

// ── 回归：同一标签页切换会话 ────────────────────────────────────────────────

test('回归：同一标签页切到别的会话后，原会话必须立刻不再被抑制', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  assert.equal(store.isAttended('s1'), true);

  // 同一个 clientId 上报了新会话 —— 旧会话必须立刻失效，
  // 不能因为「45 秒 TTL 内还新鲜」而继续抑制（真机上就是这个问题）
  watch(store, 'tab1', 's2');
  assert.equal(store.isAttended('s1'), false, '切换会话后原会话应立即恢复提醒');
  assert.equal(store.isAttended('s2'), true);
  assert.deepEqual(store.attendedSessions(), ['s2']);
});

test('回归：切换会话不受 TTL 影响（不需要等 45 秒）', () => {
  const { store, advance } = makeStore(45000);
  watch(store, 'tab1', 's1');
  advance(1000);
  watch(store, 'tab1', 's2');
  assert.equal(store.isAttended('s1'), false);
});

// ── 多标签页 ────────────────────────────────────────────────────────────────

test('多标签页：两个标签页各看一个会话，两个都被抑制', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  watch(store, 'tab2', 's2');
  assert.equal(store.isAttended('s1'), true);
  assert.equal(store.isAttended('s2'), true);
  assert.equal(store.isAttended('s3'), false);
  assert.deepEqual(store.attendedSessions().sort(), ['s1', 's2']);
});

test('多标签页：一个标签页切走后不影响另一个', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  watch(store, 'tab2', 's2');
  store.report({ clientId: 'tab2', sessionId: 's2', visible: false, focused: false });
  assert.equal(store.isAttended('s1'), true);
  assert.equal(store.isAttended('s2'), false);
});

// ── 页面级退化（启动早期拿不到会话 id）──────────────────────────────────────

test('退化模式：上报从未带 sessionId 时按页面级保守抑制', () => {
  const { store } = makeStore();
  store.report({ clientId: 'tab1', visible: true, focused: true });
  assert.equal(store.sessionTracking, false);
  assert.equal(store.mode(), 'page');
  assert.equal(store.isAttended('任意会话'), true);
  assert.equal(store.attendedSessionId(), PAGE_WIDE);
});

test('退化模式：页面不可见 / 失焦时仍然提醒', () => {
  const { store } = makeStore();
  store.report({ clientId: 'tab1', visible: false, focused: false });
  assert.equal(store.isAttended('任意会话'), false);
  store.report({ clientId: 'tab1', visible: true, focused: false });
  assert.equal(store.isAttended('任意会话'), false);
});

test('曾经拿到过会话 id 后，切换到无 id 上报仍保守抑制', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  assert.equal(store.isAttended('s2'), false);
  // 客户端此刻解析不出会话 -> 无法归因 -> 保守视为「可能在看我」
  store.report({ clientId: 'tab1', visible: true, focused: true });
  assert.equal(store.isAttended('s2'), true);
});

// ── TTL ─────────────────────────────────────────────────────────────────────

test('TTL 过期后视为离开（标签页崩溃/断连不会永久静音）', () => {
  const { store, advance } = makeStore(45000);
  watch(store, 'tab1', 's1');
  assert.equal(store.isAttended('s1'), true);
  advance(44000);
  assert.equal(store.isAttended('s1'), true, '未过期仍应在场');
  advance(2000);
  assert.equal(store.isAttended('s1'), false, '超过 TTL 应视为离开');
});

test('心跳刷新 TTL：持续上报不会过期', () => {
  const { store, advance } = makeStore(45000);
  for (let i = 0; i < 5; i++) {
    advance(15000);
    watch(store, 'tab1', 's1');
  }
  assert.equal(store.isAttended('s1'), true);
});

// ── 杂项 ────────────────────────────────────────────────────────────────────

test('缺少 clientId 时退化到单一缺省客户端', () => {
  const { store } = makeStore();
  store.report({ sessionId: 's1', visible: true, focused: true });
  assert.equal(store.isAttended('s1'), true);
  // 同一缺省 clientId 再报 s2 -> s1 立刻失效
  store.report({ sessionId: 's2', visible: true, focused: true });
  assert.equal(store.isAttended('s1'), false);
});

test('空/非法 sessionId 不会开启会话级跟踪', () => {
  const { store } = makeStore();
  for (const bad of ['', null, 42, undefined]) {
    store.report({ clientId: 'tab1', sessionId: bad, visible: true, focused: true });
  }
  assert.equal(store.sessionTracking, false);
  assert.equal(store.mode(), 'page');
});

test('report 无参数不抛异常', () => {
  const { store } = makeStore();
  assert.doesNotThrow(() => store.report());
  assert.equal(store.mode(), 'away');
});

test('sweep 清理过期客户端', () => {
  const { store, advance } = makeStore(1000);
  watch(store, 'tab1', 's1');
  watch(store, 'tab2', 's2');
  advance(1500);
  assert.equal(store.sweep(), 2);
  assert.equal(store.mode(), 'away');
  assert.deepEqual(store.snapshot().clients, {});
});

test('snapshot 输出诊断信息', () => {
  const { store, advance } = makeStore(1000);
  watch(store, 'tab1', 's1');
  advance(200);
  const snap = store.snapshot();
  assert.equal(snap.mode, 'session');
  assert.equal(snap.sessionTracking, true);
  assert.deepEqual(snap.attendedSessions, ['s1']);
  assert.equal(snap.clients.tab1.ageMs, 200);
  assert.equal(snap.clients.tab1.attended, true);
});

test('clear 复位全部状态', () => {
  const { store } = makeStore();
  watch(store, 'tab1', 's1');
  store.clear();
  assert.equal(store.mode(), 'away');
  assert.equal(store.sessionTracking, false);
  assert.deepEqual(store.snapshot().clients, {});
});
