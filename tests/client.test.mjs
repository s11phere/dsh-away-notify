/**
 * client.test.mjs — 在最小 DOM 桩上加载浏览器半部，验证 bundle 契约与运行时行为。
 * 这能在不开浏览器的情况下抓到 client.js 的语法/运行时错误。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const PRESENCE_PATH = '/api/dsh-away-notify';
const FOCUS_PARAM = 'dshAwayNotifyFocus';

/** 建立最小 DOM 桩并加载 client.js，返回其导出。 */
async function loadClientModule({ search = '', pendingFocusReply = null, titleTagReply } = {}) {
  const listeners = [];
  const registrations = [];
  const observerInstances = [];

  const documentStub = {
    visibilityState: 'visible',
    hasFocus: () => true,
    title: '我的会话 — DeepSeek Harness',
    head: {},
    addEventListener: (type, handler) => listeners.push(['document', type, handler]),
    removeEventListener: (type, handler) => {
      const i = listeners.findIndex(([t, ty, h]) => t === 'document' && ty === type && h === handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  /** 可手动触发的 MutationObserver 替身：Node 里没有 DOM 的这一个。 */
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      this.callback();
    }
  }

  const windowStub = {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
    addEventListener: (type, handler) => listeners.push(['window', type, handler]),
    removeEventListener: (type, handler) => {
      const i = listeners.findIndex(([t, ty, h]) => t === 'window' && ty === type && h === handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  const fetchCalls = [];
  const replaced = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
  };

  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    let reqBody = {};
    try {
      reqBody = JSON.parse(init?.body ?? '{}');
    } catch {
      /* ignore */
    }
    // 宿主的 pending-focus / config 应答由测试控制
    let payload = { ok: true };
    if (reqBody.op === 'pending-focus') payload = { ok: true, sessionId: pendingFocusReply };
    else if (reqBody.op === 'config' && titleTagReply !== undefined) {
      payload = { ok: true, titleTag: titleTagReply };
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  };
  globalThis.location = {
    search,
    href: `http://127.0.0.1:3081/${search}`,
    port: '3081',
    protocol: 'http:',
  };
  globalThis.history = { state: null, replaceState: () => {} };

  // 每次都要重新求值模块（client.js 顶层有副作用）
  const url = new URL('../lib/client.js', import.meta.url);
  url.searchParams.set('t', String(Math.random()));
  await import(url.href);

  const registration = registrations.at(-1);
  const clientModule = registration.factory(() => {
    throw new Error('客户端 bundle 不应 require 任何模块');
  });

  return {
    registration,
    clientModule,
    listeners,
    fetchCalls,
    documentStub,
    windowStub,
    observerInstances,
    /** 模拟 dsh-client-ui-layout 重写 document.title，然后触发观察者。 */
    overwriteTitle: (next) => {
      documentStub.title = next;
      for (const o of observerInstances) if (!o.disconnected) o.trigger();
    },
    restore: () => {
      globalThis.window = replaced.window;
      globalThis.document = replaced.document;
      globalThis.location = replaced.location;
      globalThis.history = replaced.history;
      globalThis.fetch = replaced.fetch;
      globalThis.MutationObserver = replaced.MutationObserver;
    },
  };
}

function makeClientCtx({
  current = 's1',
  byId = { s1: {}, s2: {} },
  phase = 'ready',
  sessionsOpen = true,
  withWorkspace = false,
} = {}) {
  const opened = [];
  const openedViaWorkspace = [];
  const subscribed = [];
  const injectedDeps = [];
  const disposers = [];
  const state = { current, byId, phase };
  const sessions = {
    list: {
      getSnapshot: () => ({ ...state }),
      subscribe: (fn) => {
        subscribed.push(fn);
        return () => {};
      },
    },
  };
  // dsh 0.1.7 的 ClientSessions 上已无 open；sessionsOpen:false 用来模拟它
  if (sessionsOpen) sessions.open = (id) => opened.push(id);
  const ctx = {
    sessions,
    // 生产代码用 ctx.inject([...], cb) 在服务就绪后接管；
    // 这里同步回调，模拟「服务已就绪」。
    inject: (deps, cb) => {
      injectedDeps.push(deps);
      cb(ctx);
    },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
    setCurrent: (id) => {
      state.current = id;
    },
    opened,
    openedViaWorkspace,
    subscribed,
    injectedDeps,
    dispose: () => {
      for (const d of disposers.splice(0)) d();
    },
  };
  // dsh 0.1.7 的会话切换服务
  if (withWorkspace) {
    ctx.uiWorkspace = { openSession: (id) => openedViaWorkspace.push(id) };
  }
  return ctx;
}

const loaded = [];
afterEach(() => {
  while (loaded.length > 0) {
    const l = loaded.pop();
    try {
      l.ctx?.dispose?.();
    } catch {
      /* ignore */
    }
    l.mod.restore();
  }
});

async function boot(options, ctxOptions) {
  const mod = await loadClientModule(options);
  const ctx = makeClientCtx(ctxOptions);
  mod.clientModule.apply(ctx);
  loaded.push({ mod, ctx });
  return { mod, ctx };
}

test('bundle 使用 __ModuleLoader__.load 且 id 正确', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  assert.equal(mod.registration.id, 'dsh-away-notify');
  assert.equal(typeof mod.registration.factory, 'function');
});

test('导出 apply 与 inject，且刻意不声明 inject 依赖（避免 apply 被阻塞）', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  assert.equal(typeof mod.clientModule.apply, 'function');
  assert.deepEqual(mod.clientModule.inject, [], 'inject 必须为空，否则 sessions 不可用时插件会完全静默');
});

test('apply 内部按需注入 sessions 与 uiWorkspace（都不写进 inject 数组，避免被阻塞）', async () => {
  const { ctx } = await boot();
  assert.deepEqual(ctx.injectedDeps, [['sessions'], ['uiWorkspace']]);
});

test('apply 后立即上报一次 presence 到正确端点', async () => {
  const { mod } = await boot();
  assert.ok(mod.fetchCalls.length >= 1, '应至少上报一次');
  // 启动时还会先发一次 config（问宿主标题 tag 开关），所以按 op 定位而不是取第一条
  const call = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(call, '应至少上报一次 presence');
  assert.equal(call.url, PRESENCE_PATH);
  assert.equal(call.init.method, 'POST');
  const body = JSON.parse(call.init.body);
  assert.equal(body.op, 'presence');
  assert.equal(body.sessionId, 's1');
  assert.equal(body.visible, true);
  assert.equal(body.focused, true);
  assert.equal(typeof body.clientId, 'string');
  assert.ok(body.clientId.length > 0, '必须带 clientId，宿主才能按标签页记录在场状态');
});

test('所有上报带同一个 clientId（同一标签页内稳定）', async () => {
  const { mod } = await boot();
  mod.documentStub.visibilityState = 'hidden';
  mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2]();
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const ids = new Set(presence.map((c) => JSON.parse(c.init.body).clientId));
  assert.equal(ids.size, 1, '同一页面内 clientId 必须稳定');
});

test('注册 visibilitychange 与 window focus/blur 监听', async () => {
  const { mod } = await boot();
  const types = mod.listeners.map(([t, ty]) => `${t}:${ty}`);
  assert.ok(types.includes('document:visibilitychange'));
  assert.ok(types.includes('window:focus'));
  assert.ok(types.includes('window:blur'));
});

test('标签页不可见时上报 visible=false', async () => {
  const { mod } = await boot();
  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  const last = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(last.visible, false);
});

test('窗口失焦时上报 focused=false', async () => {
  const { mod } = await boot();
  mod.documentStub.hasFocus = () => false;
  const handler = mod.listeners.find(([t, ty]) => t === 'window' && ty === 'blur')[2];
  handler();
  const last = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(last.focused, false);
});

test('拿不到当前会话时退化为页面级上报（仍发请求，但不带 sessionId）', async () => {
  // 注意：必须传空串而不是 undefined —— 解构默认值会把 undefined 还原成 's1'
  const { mod } = await boot({}, { current: '' });
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1, '即使没有会话 id 也必须上报，否则宿主无法做页面级抑制');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.equal(body.op, 'presence');
  assert.equal('sessionId' in body, false);
  assert.equal(body.visible, true);
  assert.equal(body.focused, true);
});

// ── dsh 0.1.7：视图选择搬出 sessions 控制器 ─────────────────────────────────

test('0.1.7：快照没有 current 时，用 retainedBy.mainView 判定正在看的会话', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        s1: { id: 's1', retainedBy: { other: 2 } },
        s2: { id: 's2', retainedBy: { mainView: 1 } },
      },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1, '仍应上报');
  assert.equal(JSON.parse(presence.at(-1).init.body).sessionId, 's2', '应以 mainView retain 的那条为准');
});

test('0.1.7：byId 里没有任何 mainView retain 时退化为页面级上报', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: {
        s1: { id: 's1', retainedBy: {} },
        s2: { id: 's2', retainedBy: { other: 3 } },
      },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  const body = JSON.parse(presence.at(-1).init.body);
  assert.equal('sessionId' in body, false, '没有归因就不该编造一个会话 id');
});

test('0.1.7：retainedBy 结构缺失/异常时不会崩，退化为页面级', async () => {
  const { mod } = await boot(
    {},
    {
      current: '',
      byId: { s1: { id: 's1' }, s2: { id: 's2', retainedBy: null } },
    },
  );
  const presence = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'presence');
  assert.ok(presence.length >= 1);
  assert.equal('sessionId' in JSON.parse(presence.at(-1).init.body), false);
});

test('切换会话时通过 list.subscribe 立刻重报新会话', async () => {
  const { mod, ctx } = await boot();
  assert.equal(ctx.subscribed.length, 1, '应订阅会话列表');
  const before = mod.fetchCalls.length;
  ctx.setCurrent('s2');
  ctx.subscribed[0]();
  assert.ok(mod.fetchCalls.length > before, '会话变化应触发重报');
  const body = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(body.sessionId, 's2');
});

test('状态没变时不上报（去重节流，避免订阅连续触发造成突刺）', async () => {
  const { mod, ctx } = await boot();
  const before = mod.fetchCalls.length;
  for (let i = 0; i < 12; i++) ctx.subscribed[0]();
  assert.equal(mod.fetchCalls.length, before, '载荷相同应被去重');
});

test('可见性变化立刻上报（不被节流吞掉）', async () => {
  const { mod } = await boot();
  const before = mod.fetchCalls.length;
  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  assert.equal(mod.fetchCalls.length, before + 1, '状态真正变化应立刻发出');
  const body = JSON.parse(mod.fetchCalls.at(-1).init.body);
  assert.equal(body.visible, false);
});

test('URL 带 focus 参数时会 open 对应会话', async () => {
  const { ctx } = await boot({ search: `?${FOCUS_PARAM}=s2` });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, ['s2']);
});

test('URL 带 focus 参数但会话不存在时不 open，也不会崩', async () => {
  const { ctx } = await boot({ search: `?${FOCUS_PARAM}=missing` }, { byId: { s1: {} }, phase: 'ready' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
});

test('无 focus 参数时不会 open 任何会话', async () => {
  const { ctx } = await boot();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
});

test('0.1.7：sessions 上无 open 时，回跳改走 uiWorkspace.openSession', async () => {
  const { ctx } = await boot(
    { search: `?${FOCUS_PARAM}=s2` },
    { sessionsOpen: false, withWorkspace: true },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedViaWorkspace, ['s2'], '应通过 uiWorkspace 切到目标会话');
  assert.deepEqual(ctx.opened, [], '0.1.7 不该再去碰已移除的 sessions.open');
});

test('0.1.7：待跳转回执同样走 uiWorkspace.openSession', async () => {
  const { ctx } = await boot(
    { pendingFocusReply: 's2' },
    { sessionsOpen: false, withWorkspace: true },
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.openedViaWorkspace, ['s2']);
});

test('0.1.7：uiWorkspace 晚于 sessions 就绪时仍能切过去（切换时现取）', async () => {
  // 先按「workspace 还没注入」建 ctx，apply 之后再挂上服务，模拟注入回调晚到
  const mod = await loadClientModule({ search: `?${FOCUS_PARAM}=s2` });
  const ctx = makeClientCtx({ sessionsOpen: false });
  mod.clientModule.apply(ctx);
  loaded.push({ mod, ctx });

  // switchTo 会重试；此时补上 uiWorkspace 服务
  const openedViaWorkspace = [];
  ctx.uiWorkspace = { openSession: (id) => openedViaWorkspace.push(id) };
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(openedViaWorkspace, ['s2']);
});

// ── 待跳转会话（点击 Toast 回跳的主通路）─────────────────────────────────────

test('加载时向宿主索取待跳转会话并切过去', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: 's2' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'pending-focus'),
    '应主动索取待跳转会话',
  );
  assert.deepEqual(ctx.opened, ['s2']);
});

test('切过去之后回执清除，避免重复跳转', async () => {
  const { mod } = await boot({ pendingFocusReply: 's2' });
  await new Promise((r) => setTimeout(r, 30));
  const ack = mod.fetchCalls.find((c) => JSON.parse(c.init.body).op === 'ack-focus');
  assert.ok(ack, '应发送 ack-focus');
  assert.equal(JSON.parse(ack.init.body).sessionId, 's2');
});

test('已经在目标会话上时不重复 open，但仍回执', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: 's1' }, { current: 's1' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, [], '已在目标会话上不应再 open');
  assert.ok(mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'));
});

test('宿主没有待跳转会话时什么都不做', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ctx.opened, []);
  assert.equal(
    mod.fetchCalls.some((c) => JSON.parse(c.init.body).op === 'ack-focus'),
    false,
    '没有目标就不该回执',
  );
});

test('重新获得焦点时再次索取待跳转会话（浏览器只聚焦不重载的场景）', async () => {
  const { mod, ctx } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 20));
  const before = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;

  const handler = mod.listeners.find(([t, ty]) => t === 'window' && ty === 'focus')[2];
  handler();
  await new Promise((r) => setTimeout(r, 20));

  const after = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;
  assert.ok(after > before, '获得焦点时应再取一次');
});

test('页面不可见时不去索取待跳转会话', async () => {
  const { mod } = await boot({ pendingFocusReply: null });
  await new Promise((r) => setTimeout(r, 20));
  const before = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;

  mod.documentStub.visibilityState = 'hidden';
  const handler = mod.listeners.find(([t, ty]) => t === 'document' && ty === 'visibilitychange')[2];
  handler();
  await new Promise((r) => setTimeout(r, 20));

  const after = mod.fetchCalls.filter((c) => JSON.parse(c.init.body).op === 'pending-focus').length;
  assert.equal(after, before, '不可见时不该索取');
});

test('上报失败（fetch reject）不会抛出未处理异常', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  const ctx = makeClientCtx();
  assert.doesNotThrow(() => mod.clientModule.apply(ctx));
  await new Promise((r) => setTimeout(r, 20));
  ctx.dispose();
});

// ── 实例标题 tag（多实例窗口区分）────────────────────────────────────────────

test('启动即给标题追加本实例端口 tag', async () => {
  const { mod } = await boot();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
});

test('标题被布局插件重写后自动补回 tag（且不会重复叠加）', async () => {
  const { mod } = await boot();
  assert.ok(mod.observerInstances.length > 0, '应挂上 MutationObserver');

  mod.overwriteTitle('另一个会话 — DeepSeek Harness');
  assert.equal(mod.documentStub.title, '另一个会话 — DeepSeek Harness [dsh:3081]');

  // 再触发一次：已经带 tag，不应叠加成两个
  mod.overwriteTitle('另一个会话 — DeepSeek Harness [dsh:3081]');
  assert.equal(mod.documentStub.title, '另一个会话 — DeepSeek Harness [dsh:3081]');
});

test('宿主配置 titleTag=false 时撤下 tag 并断开观察者', async () => {
  const { mod } = await boot({ titleTagReply: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness', '应还原成原始标题');
  assert.ok(
    mod.observerInstances.every((o) => o.disconnected),
    '应断开观察者，避免继续改写标题',
  );
});

test('config 请求失败时保持 tag 开着（与宿主脚本默认一致）', async () => {
  const mod = await loadClientModule();
  loaded.push({ mod });
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  const ctx = makeClientCtx();
  mod.clientModule.apply(ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
  ctx.dispose();
});

test('dispose 时撤下 tag', async () => {
  const { mod, ctx } = await boot();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness [dsh:3081]');
  ctx.dispose();
  assert.equal(mod.documentStub.title, '我的会话 — DeepSeek Harness');
});
