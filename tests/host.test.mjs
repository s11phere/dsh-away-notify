/**
 * host.test.mjs — 用假 ctx 驱动宿主插件，验证「事件 → 决策 → 通知」全链路。
 * 不依赖真实 DSH 运行时，也不会真的弹窗（通过注入的假 ctx 只验证到 policy 层）。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { apply, DEFAULTS } = await import('../lib/host.js');

const PRESENCE_PATH = '/api/dsh-away-notify';

/** 每个测试创建的 ctx 在结束后统一 dispose，否则 sweep 定时器会吊住事件循环。 */
const created = [];
afterEach(() => {
  while (created.length > 0) {
    try {
      created.pop().dispose();
    } catch {
      /* ignore */
    }
  }
});

/** 构造一个够用的假 Cordis ctx。 */
function makeCtx() {
  const handlers = new Map();
  const effects = [];
  const fetchRoutes = new Map();
  const logs = [];
  const disposers = [];
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
    },
    sessions: {
      _map: new Map(),
      get(id) {
        return this._map.get(id);
      },
      add(session) {
        this._map.set(session.id, session);
      },
    },
    sessionTitle: { get: (s) => ({ title: s.__title }) },
    get(name) {
      if (name === 'webServer') return { port: 3081 };
      if (name === 'connection') return ctx.connection;
      return undefined;
    },
    connection: undefined,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    inject(deps, cb) {
      if (deps.includes('connection')) {
        ctx.connection = { fetch: { register: (route) => fetchRoutes.set(route.path, route) } };
      }
      cb(ctx);
    },
    effect(fn) {
      const disposer = fn();
      effects.push(disposer);
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    emit(event, ...args) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
    dispose() {
      for (const d of disposers.splice(0)) {
        try {
          d();
        } catch {
          /* ignore */
        }
      }
    },
    logs,
    fetchRoutes,
    effects,
  };
  created.push(ctx);
  return ctx;
}

function session(id, over = {}) {
  return { id, header: { origin: 'root', delegationDepth: 0 }, __title: `会话${id}`, ...over };
}

const turnEnd = (turn = 1, kind = 'completed') => ({
  type: 'turn/end',
  seq: turn * 10,
  data: { turn, reason: { kind } },
});

/** 调用宿主注册的 presence 端点。 */
async function callEndpoint(ctx, payload) {
  const route = ctx.fetchRoutes.get(PRESENCE_PATH);
  assert.ok(route, 'presence 端点应已注册');
  const request = new Request(`http://127.0.0.1:3081${PRESENCE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

const reportPresence = (ctx, sessionId, visible, focused) =>
  callEndpoint(ctx, { op: 'presence', sessionId, visible, focused });

test('加载后注册 session/event、user-questions/request 与 presence 端点', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.ok(ctx.logs.some(([lvl, msg]) => lvl === 'info' && /已加载/.test(msg)));
  assert.ok(ctx.fetchRoutes.has(PRESENCE_PATH), 'presence 端点应注册在 /api 前缀下');
  assert.match(PRESENCE_PATH, /^\/api\//);
});

test('presence 端点记录在场状态，state 可回读', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await reportPresence(ctx, 's1', true, true);
  const { status, body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(status, 200);
  assert.equal(body.attended, 's1');
});

test('切走标签页后不再视为在场', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await reportPresence(ctx, 's1', true, true);
  await reportPresence(ctx, 's1', false, false);
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.attended, null);
});

test('可见但失焦视为离开（焦点在别的应用）', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await reportPresence(ctx, 's1', true, false);
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.attended, null);
});

test('非法 payload 不抛异常，返回 400', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.equal((await reportPresence(ctx, 42, true, true)).status, 200, '非字符串 sessionId 只是被忽略');
  assert.equal((await callEndpoint(ctx, { op: 'nope' })).status, 400);
});

test('不带 sessionId 的上报进入页面级退化模式', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  // 模拟浏览器拿不到当前会话的场景
  const res = await callEndpoint(ctx, { op: 'presence', visible: true, focused: true });
  assert.equal(res.status, 200);
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.mode, 'page');
  assert.equal(body.sessionTracking, false);
  assert.equal(body.attended, '*', '退化模式应返回通配标记，表示「整页在场」');
});

test('页面不可见时退化模式也不抑制', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  await callEndpoint(ctx, { op: 'presence', visible: false, focused: false });
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.mode, 'away');
  assert.equal(body.attended, null);
});

test('端点透传 clientId：同一标签页切换会话后原会话立刻恢复提醒', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const send = (sessionId) =>
    callEndpoint(ctx, { op: 'presence', clientId: 'tab1', sessionId, visible: true, focused: true });

  await send('s1');
  let { body } = await callEndpoint(ctx, { op: 'state' });
  assert.deepEqual(body.attendedSessions, ['s1']);

  await send('s2');
  ({ body } = await callEndpoint(ctx, { op: 'state' }));
  assert.deepEqual(body.attendedSessions, ['s2'], '旧会话不应继续被抑制');
});

test('非 JSON 请求体返回 400', async () => {
  const ctx = makeCtx();
  apply(ctx, {});
  const route = ctx.fetchRoutes.get(PRESENCE_PATH);
  const request = new Request(`http://127.0.0.1:3081${PRESENCE_PATH}`, { method: 'POST', body: 'not json' });
  const response = await route.fetch(request);
  assert.equal(response.status, 400);
});

test('user-questions/request 必须继续 waterfall（调用 next）', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  ctx.sessions.add(session('s1'));
  let called = false;
  ctx.emit(
    'user-questions/request',
    { questions: [{ id: 'q1', question: '要继续吗？' }], agent: { id: 's1' } },
    () => {
      called = true;
      return Promise.resolve({ answers: [] });
    },
  );
  assert.equal(called, true, '必须调用 next()，否则会打断提问链路');
});

test('user-questions/request 内部抛错也仍然调用 next()', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  ctx.sessionTitle = {
    get() {
      throw new Error('projection boom');
    },
  };
  ctx.sessions.add(session('s1'));
  let called = false;
  ctx.emit('user-questions/request', { questions: [{ question: 'x' }], agent: { id: 's1' } }, () => {
    called = true;
    return Promise.resolve({ answers: [] });
  });
  assert.equal(called, true);
});

test('缺少 agent 的提问请求不会崩，也不会误发通知', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  let called = false;
  ctx.emit('user-questions/request', { questions: [{ question: 'x' }] }, () => {
    called = true;
    return Promise.resolve({ answers: [] });
  });
  assert.equal(called, true);
});

test('未知事件类型被安全忽略', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.doesNotThrow(() => ctx.emit('session/event', session('s1'), { type: 'nope/event', data: {} }));
});

test('缺少 session.id 的事件被忽略', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.doesNotThrow(() => ctx.emit('session/event', {}, turnEnd()));
});

test('五类触发 + 关键行为默认值正确', () => {
  for (const k of [
    'onTurnComplete',
    'onTurnError',
    'onTurnAborted',
    'onTurnMaxTokens',
    'onApproval',
    'onQuestion',
    'onGoalComplete',
  ]) {
    assert.equal(DEFAULTS[k], true, `${k} 应默认 true`);
  }
  assert.equal(DEFAULTS.suppressGoalRounds, true);
  assert.equal(DEFAULTS.rootsOnly, true);
  assert.equal(DEFAULTS.openOnClick, true);
  assert.equal(DEFAULTS.includeToken, true);
  assert.equal(DEFAULTS.sound, true);
  assert.equal(DEFAULTS.notifyOnLoad, false);
  assert.equal(DEFAULTS.debug, false);
});

test('presence sweep 定时器被注册为可清理 effect', () => {
  const ctx = makeCtx();
  apply(ctx, {});
  assert.ok(ctx.effects.length >= 1, '应注册清理函数');
  assert.equal(typeof ctx.effects[0], 'function');
  ctx.effects[0]();
});
