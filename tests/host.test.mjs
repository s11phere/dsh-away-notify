/**
 * host.test.mjs — 用假 ctx 驱动宿主插件，验证「事件 → 决策 → 通知」全链路。
 * 不依赖真实 DSH 运行时，也不会真的弹窗（通过注入的假 ctx 只验证到 policy 层）。
 */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, DEFAULTS } = await import('../lib/host.js');

const PRESENCE_PATH = '/api/dsh-away-notify';

/**
 * 每个测试套件用一个临时 spool 目录。
 *
 * 宿主会在 spool 里写 config.txt 并拉起常驻焦点助手；让它落在插件源码树里既脏，
 * 又可能干扰真实运行中的助手（点击时 enqueue 脚本读到的会是测试留下的 config）。
 */
const TEST_SPOOL = mkdtempSync(join(tmpdir(), 'dshan-spool-'));
after(() => rmSync(TEST_SPOOL, { recursive: true, force: true }));

/**
 * apply 的测试包装：默认把 spool 指向临时目录，避免污染插件目录；默认注入静默
 * 的 spawn 替身，保证用例永远不会真的弹通知或写注册表。需要观察「到底执行了
 * 哪段脚本」的用例传入自己的 `fake.deps`。
 */
const applyHost = (ctx, config = {}, deps = SILENT_DEPS) =>
  apply(ctx, { spoolDir: TEST_SPOOL, ...config }, deps);

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
  const services = new Map();
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
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
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
    services,
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
  applyHost(ctx, {});
  assert.ok(ctx.logs.some(([lvl, msg]) => lvl === 'info' && /已加载/.test(msg)));
  assert.ok(ctx.fetchRoutes.has(PRESENCE_PATH), 'presence 端点应注册在 /api 前缀下');
  assert.match(PRESENCE_PATH, /^\/api\//);
});

test('presence 端点记录在场状态，state 可回读', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  await reportPresence(ctx, 's1', true, true);
  const { status, body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(status, 200);
  assert.equal(body.attended, 's1');
});

test('切走标签页后不再视为在场', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  await reportPresence(ctx, 's1', true, true);
  await reportPresence(ctx, 's1', false, false);
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.attended, null);
});

test('可见但失焦视为离开（焦点在别的应用）', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  await reportPresence(ctx, 's1', true, false);
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.attended, null);
});

test('非法 payload 不抛异常，返回 400', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  assert.equal((await reportPresence(ctx, 42, true, true)).status, 200, '非字符串 sessionId 只是被忽略');
  assert.equal((await callEndpoint(ctx, { op: 'nope' })).status, 400);
});

test('不带 sessionId 的上报进入页面级退化模式', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
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
  applyHost(ctx, {});
  await callEndpoint(ctx, { op: 'presence', visible: false, focused: false });
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.equal(body.mode, 'away');
  assert.equal(body.attended, null);
});

test('端点透传 clientId：同一标签页切换会话后原会话立刻恢复提醒', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
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
  applyHost(ctx, {});
  const route = ctx.fetchRoutes.get(PRESENCE_PATH);
  const request = new Request(`http://127.0.0.1:3081${PRESENCE_PATH}`, { method: 'POST', body: 'not json' });
  const response = await route.fetch(request);
  assert.equal(response.status, 400);
});

test('user-questions/request 必须继续 waterfall（调用 next）', () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
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
  applyHost(ctx, {});
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
  applyHost(ctx, {});
  let called = false;
  ctx.emit('user-questions/request', { questions: [{ question: 'x' }] }, () => {
    called = true;
    return Promise.resolve({ answers: [] });
  });
  assert.equal(called, true);
});

test('未知事件类型被安全忽略', () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  assert.doesNotThrow(() => ctx.emit('session/event', session('s1'), { type: 'nope/event', data: {} }));
});

test('缺少 session.id 的事件被忽略', () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
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
  // 持久通知与实例区分：默认开
  assert.equal(DEFAULTS.persistent, true, '通知应默认一直停留');
  assert.equal(DEFAULTS.titleTag, true, '默认应打实例标题 tag');
  assert.equal(DEFAULTS.dismissOnReturn, true, '默认回到 dsh 时撤回通知');
});

// ── 实例区分与持久通知的端到端接线 ──────────────────────────────────────────
//
// 通知/撤回在测试环境里本来无处落地，所以这里把宿主伪装成 Windows，并在 **spawn
// 这一层**塞一个替身：它把每次 `-EncodedCommand` 的明文记进日志，于是「到底发没
// 发 reminder、回没回 History.Remove」可被断言。
//
// 关键约束（Windows 上实测踩到）：**不能**靠「写一个假的 powershell.exe 让操作
// 系统去执行」——Windows 只把 `.exe` 当 PE 映像加载、完全不认 shebang，那条路在
// Windows 上必然失败，四条依赖「脚本真的发出去了」的用例会永远红。所以 host.js
// 的 apply() 开了第三个参数，把 spawnImpl / spawnSyncImpl 透传下去。

/**
 * 造一个假的 spawn 实现：不依赖操作系统真的能执行什么，因此三个平台行为一致。
 *
 * 断言的内容与旧版完全一样（`-EncodedCommand` 的明文、成功标记、退出码），只是
 * 不再要求 OS 能执行一个假 powershell。
 *
 * `psPath` 只是个**形状正确**的路径字符串（`.../WindowsPowerShell/v1.0/powershell.exe`）：
 * 用来让 `detectPlatform()` 报出 Windows 形态、让 `deriveWscriptPath()` 推出
 * wscript，从而走 enqueue 注册分支。磁盘上并不需要真的存在该文件——它永远不会
 * 被真的执行。早期版本还要顺手放一个空的 wscript.exe，现在也不需要了。
 *
 * @param {{ silent?: boolean }} [opts] - silent 时不落日志，只保证不真弹窗。
 */
function makeFakeSpawn({ silent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshan-ps-'));
  const logPath = join(dir, 'calls.log');

  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};
    if (!silent) {
      const i = Array.isArray(args) ? args.indexOf('-EncodedCommand') : -1;
      if (i >= 0 && typeof args[i + 1] === 'string') appendFileSync(logPath, `${args[i + 1]}\n`);
    }
    // 监听器是在 spawn 返回之后才挂上的，所以事件要推迟到下一个 tick 再发。
    setImmediate(() => {
      child.stdout.emit('data', 'TOAST_SHOWN\nDISMISSED\nREGISTERED\n');
      child.emit('close', 0);
    });
    return child;
  };

  /**
   * `toWindowsPath` 会去调 `wslpath`。这里把它的行为固定下来，免得用例结果随宿主
   * 平台漂移：`/mnt/<盘>/...` 按 `wslpath -w` 的规则转换（WSL 上真实会走的分支），
   * 其余一律报告「没有 wslpath」→ 原样返回（原生 Windows 的真实情形）。
   */
  const spawnSyncImpl = (cmd, args) => {
    const input = Array.isArray(args) ? args[args.length - 1] : '';
    const m = typeof input === 'string' ? /^\/mnt\/([a-z])\/(.*)$/i.exec(input) : null;
    if (m) return { status: 0, stdout: `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}\n` };
    return { status: 1, stdout: '', stderr: '' };
  };

  return {
    dir,
    logPath,
    psPath: join(dir, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    deps: { spawnImpl, spawnSyncImpl },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 默认替身：没有显式传 deps 的用例也一律走假的 spawn，于是测试**永远不会**真的弹
 * 通知，也不会真的去写 `HKCU\Software\Classes\dshnotify`（注册走的也是同一条假
 * spawn）。`DSH_NOTIFY_POWERSHELL` 只用来给 `detectPlatform()` 一个形状正确的
 * Windows 路径，让注册命令走 enqueue 分支。
 */
const REAL_PS_ENV = process.env.DSH_NOTIFY_POWERSHELL;
const SILENT = makeFakeSpawn({ silent: true });
const SILENT_DEPS = SILENT.deps;
process.env.DSH_NOTIFY_POWERSHELL = SILENT.psPath;
after(() => {
  SILENT.cleanup();
  if (REAL_PS_ENV === undefined) delete process.env.DSH_NOTIFY_POWERSHELL;
  else process.env.DSH_NOTIFY_POWERSHELL = REAL_PS_ENV;
});

/** 读出假 spawn 收到的全部脚本明文。 */
function readScripts(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => Buffer.from(l, 'base64').toString('utf16le'));
}

/** 把当前进程伪装成 Windows 并指向形状正确的 powershell 路径，返回还原函数。 */
function pretendWindows(psPath) {
  const realPlatform = process.platform;
  const realPs = process.env.DSH_NOTIFY_POWERSHELL;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.DSH_NOTIFY_POWERSHELL = psPath;
  return () => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realPs === undefined) delete process.env.DSH_NOTIFY_POWERSHELL;
    else process.env.DSH_NOTIFY_POWERSHELL = realPs;
  };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

test('通知以 reminder 场景发出，带回跳 tag（持久停留）', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();

    const notifyScript = readScripts(fake.logPath).find((s) => s.includes('cmVtaW5kZXI=')); // b64('reminder')
    assert.ok(notifyScript, '应发出 reminder 场景的通知');
    assert.match(notifyScript, /bG9uZw==/, '应带 duration=long 兜底');
    assert.match(notifyScript, /<actions>/, 'reminder 必须配按钮');
    assert.match(notifyScript, /\$toast\.Tag/, '应打 tag 以便之后撤回');
  } finally {
    restore();
    fake.cleanup();
  }
});

test('用户回到 dsh 页面时按 tag 撤回持久通知', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();
    assert.ok(
      readScripts(fake.logPath).some((s) => s.includes('cmVtaW5kZXI=')),
      '前提：先得真的发出过通知',
    );

    await reportPresence(ctx, 's1', true, true);
    await settle();

    const dismissScript = readScripts(fake.logPath).find((s) => s.includes('History.Remove'));
    assert.ok(dismissScript, '回到 dsh 后应撤回通知');
    assert.match(dismissScript, /History\.Remove\(\$tag, \$group, \$appId\)/, '必须按 tag 精确撤回');
  } finally {
    restore();
    fake.cleanup();
  }
});

test('只是失焦可见（人在别的应用）不会撤回通知', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();

    await reportPresence(ctx, 's1', true, false);
    await settle();

    assert.ok(
      !readScripts(fake.logPath).some((s) => s.includes('History.Remove')),
      '通知还该留在屏幕上等人回来看',
    );
  } finally {
    restore();
    fake.cleanup();
  }
});

test('别的会话在前台（含心跳）不会撤掉本会话的通知', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.sessions.add(session('s2'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();
    assert.ok(
      readScripts(fake.logPath).some((s) => s.includes('cmVtaW5kZXI=')),
      '前提：s1 的通知已发出',
    );

    // 用户切到 s2 并保持焦点。客户端每 ~15s 会重复上报同样的 visible+focused，
    // 这里连发两次模拟心跳：都不该把 s1 还挂着的通知撤掉。
    await reportPresence(ctx, 's2', true, true);
    await reportPresence(ctx, 's2', true, true);
    await settle();
    assert.ok(
      !readScripts(fake.logPath).some((s) => s.includes('History.Remove')),
      '人在 s2 时不该撤回 s1 的通知（否则后台会话的提醒会被心跳静默撤掉）',
    );

    // 真的切回 s1 才撤
    await reportPresence(ctx, 's1', true, true);
    await settle();
    assert.ok(
      readScripts(fake.logPath).some((s) => s.includes('History.Remove')),
      '看到 s1 后应撤回它的通知',
    );
  } finally {
    restore();
    fake.cleanup();
  }
});

test('dismissOnReturn=false 时不撤回', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, { dismissOnReturn: false }, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();

    await reportPresence(ctx, 's1', true, true);
    await settle();

    assert.ok(!readScripts(fake.logPath).some((s) => s.includes('History.Remove')));
  } finally {
    restore();
    fake.cleanup();
  }
});

test('config 端点按 titleTag 配置回答浏览器半部', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  const { status, body } = await callEndpoint(ctx, { op: 'config' });
  assert.equal(status, 200);
  assert.equal(body.titleTag, true, '默认应让浏览器打实例 tag');

  const ctx2 = makeCtx();
  applyHost(ctx2, { titleTag: false });
  const second = await callEndpoint(ctx2, { op: 'config' });
  assert.equal(second.body.titleTag, false);
});

test('presence sweep 定时器被注册为可清理 effect', () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  assert.ok(ctx.effects.length >= 1, '应注册清理函数');
  assert.equal(typeof ctx.effects[0], 'function');
  ctx.effects[0]();
});

// ── 常驻焦点助手：加载时准备，卸载时收摊 ────────────────────────────────────
//
// 点击延迟从 ~2.1s 降到 ~0.15s 全靠这个助手常驻；这里只验证宿主的接线，助手本身
// 的置前逻辑由 focus-lib.ps1 / focus-helper.ps1 承担（真机验证见 README）。

test('加载时写助手配置，路径必须是 Windows 形式', () => {
  const ctx = makeCtx();
  applyHost(ctx);
  const configPath = join(TEST_SPOOL, 'config.txt');
  assert.ok(existsSync(configPath), '应写入 config.txt');
  const text = readFileSync(configPath, 'utf8');
  assert.match(text, /^marker=DeepSeek Harness$/m);
  assert.match(text, /^tagmode=port$/m);
  assert.match(text, /^helper=.*focus-helper\.ps1$/m);
  assert.match(text, /^direct=.*focus-or-open\.ps1$/m, '回退脚本路径要写进去，助手不在时才有兜底');
  assert.match(text, /^hidden=.*run-hidden\.vbs$/m);
  assert.doesNotMatch(text, /^\w+=.*\/mnt\//m, '注册表那侧执行，不能出现 /mnt 形式');
});

test('titleTag=false 时 config 里的 tagmode 同步变成 off', () => {
  const ctx = makeCtx();
  applyHost(ctx, { titleTag: false });
  assert.match(readFileSync(join(TEST_SPOOL, 'config.txt'), 'utf8'), /^tagmode=off$/m);
});

test('插件卸载时写 stop，让常驻助手退出', () => {
  const ctx = makeCtx();
  applyHost(ctx);
  rmSync(join(TEST_SPOOL, 'stop'), { force: true });
  ctx.dispose();
  assert.ok(existsSync(join(TEST_SPOOL, 'stop')), 'dispose 应留下 stop 文件');
});

test('加载时会清掉上一次残留的 stop（否则新助手一起来就自杀）', () => {
  writeFileSync(join(TEST_SPOOL, 'stop'), 'stale', 'utf8');
  const ctx = makeCtx();
  applyHost(ctx);
  assert.ok(!existsSync(join(TEST_SPOOL, 'stop')), '陈旧的 stop 必须被清掉');
});

test('注册表命令指向 enqueue 脚本并带上 spool：点击路径上没有 PowerShell', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    await settle();
    const registerScript = readScripts(fake.logPath).find((s) => s.includes('dshnotify'));
    assert.ok(registerScript, '应发出注册脚本');
    assert.match(registerScript, /enqueue-focus\.vbs/, '注册表应指向 enqueue 脚本');
    assert.match(registerScript, /dshan-spool-/, '注册命令要带上 spool 目录');
    assert.doesNotMatch(registerScript, /focus-or-open/, '不该把冷脚本塞进点击路径');
    assert.doesNotMatch(registerScript, /focus-helper/, '助手路径走 config.txt，不进注册表');
  } finally {
    restore();
    fake.cleanup();
  }
});

test('启动助手时交给 wscript 的路径必须是 Windows 形式（否则会弹错误对话框）', () => {
  // 真机踩到：wscript.exe 是 Windows 程序，把 `/mnt/d/...` 递过去会被当成未知
  // 选项，并弹出「指定了未知的选项」对话框。路径必须转换，且加 //B 兜底。
  const src = readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /toWindowsPath\(LAUNCHER_VBS\),\s*toWindowsPath\(HELPER_PS1\)/,
    '启动助手的 .vbs 与 .ps1 都要转成 Windows 路径',
  );
  assert.match(src, /'\/\/B'/, '//B 批处理模式：即使将来出错也只静默失败，不弹窗');
  assert.doesNotMatch(src, /\bLAUNCHER_VBS,\s*HELPER_PS1\b/, '不得把 WSL 路径直接交给 wscript');
});

// ── 显式抑制接口（awayNotify 服务）──────────────────────────────────────────
//
// 这是给 dsh-btw-sidebar 这类插件用的扩展点：侧边聊天是普通 fork 会话，浏览器半部
// 上报的「当前会话」永远是主视图那条，所以宿主的在场判定认不出它——必须由 btw 显式
// 声明抑制。这里既验接口面，也验「抑制真的能拦住通知脚本」。

/** 确认服务已提供，并返回它。 */
function awayNotifyOf(ctx) {
  const service = ctx.services.get('awayNotify');
  assert.ok(service, '应提供 awayNotify 服务');
  return service;
}

test('加载时提供 awayNotify 服务，接口面带版本号', () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  const service = awayNotifyOf(ctx);
  assert.equal(service.version, 1);
  for (const method of [
    'suppressSession',
    'releaseSession',
    'isSuppressed',
    'addRule',
    'revealSession',
    'revealFor',
    'snapshot',
  ]) {
    assert.equal(typeof service[method], 'function', `${method} 应是函数`);
  }
  assert.ok(ctx.logs.some(([lvl, msg]) => lvl === 'info' && /awayNotify/.test(msg)));
});

test('context.provide 抛错时只告警，通知链路照常', () => {
  const ctx = makeCtx();
  ctx.provide = () => {
    throw new Error('cannot provide');
  };
  assert.doesNotThrow(() => applyHost(ctx, {}));
  assert.ok(ctx.logs.some(([lvl, msg]) => lvl === 'warn' && /awayNotify 服务失败/.test(msg)));
});

test('被显式抑制的会话不弹通知，释放后恢复', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    const away = awayNotifyOf(ctx);
    ctx.sessions.add(session('s-side'));

    // 模拟 btw：fork 成功后立刻声明抑制
    const release = away.suppressSession('s-side', 'dsh-btw-sidebar');
    assert.equal(away.isSuppressed('s-side'), 'dsh-btw-sidebar');

    ctx.emit('session/event', ctx.sessions.get('s-side'), turnEnd());
    await settle();
    assert.ok(
      !readScripts(fake.logPath).some((s) => s.includes('cmVtaW5kZXI=')),
      '被抑制的会话不应发出任何通知',
    );

    // 释放后同类事件照常提醒（冷却未消耗：抑制发生在冷却之前）
    release();
    assert.equal(away.isSuppressed('s-side'), undefined);
    ctx.emit('session/event', ctx.sessions.get('s-side'), turnEnd(2));
    await settle();
    assert.ok(
      readScripts(fake.logPath).some((s) => s.includes('cmVtaW5kZXI=')),
      '释放后应恢复提醒',
    );
  } finally {
    restore();
    fake.cleanup();
  }
});

test('抑制只作用于目标会话，别的会话照常提醒', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    awayNotifyOf(ctx).suppressSession('s-side', 'dsh-btw-sidebar');
    ctx.sessions.add(session('s-side'));
    ctx.sessions.add(session('s-main'));

    ctx.emit('session/event', ctx.sessions.get('s-main'), turnEnd());
    await settle();
    const scripts = readScripts(fake.logPath).filter((s) => s.includes('cmVtaW5kZXI='));
    assert.equal(scripts.length, 1, '主会话应照常提醒');
    // 通知正文在脚本里是 base64（见 notifier.js 的 __BODY_B64__），解出来核对会话
    const encoded = [...scripts[0].matchAll(/DecB64 "([^"]*)"/g)].map((m) => m[1]);
    assert.match(Buffer.from(encoded[1] ?? '', 'base64').toString('utf8'), /会话s-main/, '提醒的必须是主会话');
  } finally {
    restore();
    fake.cleanup();
  }
});

test('addRule 按「类」抑制；规则抛错时视为不抑制（宁可多弹）', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    const away = awayNotifyOf(ctx);
    const disposeRule = away.addRule({
      id: 'test-plugin',
      reason: 'test-plugin',
      match: (sid) => sid.startsWith('side-'),
    });
    ctx.sessions.add(session('side-1'));
    ctx.emit('session/event', ctx.sessions.get('side-1'), turnEnd());
    await settle();
    assert.ok(!readScripts(fake.logPath).some((s) => s.includes('cmVtaW5kZXI=')));

    disposeRule();
    assert.equal(away.isSuppressed('side-1'), undefined);

    away.addRule({
      id: 'boom',
      reason: 'boom',
      match: () => {
        throw new Error('rule boom');
      },
    });
    assert.equal(away.isSuppressed('side-1'), undefined, '规则抛错不得抑制');
    assert.ok(
      away.snapshot().rules.some((r) => r.id === 'boom' && /rule boom/.test(r.error ?? '')),
      '规则错误要能在诊断里看到',
    );
  } finally {
    restore();
    fake.cleanup();
  }
});

test('state 端点回显被抑制的会话，便于排障', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  awayNotifyOf(ctx).suppressSession('s-side', 'dsh-btw-sidebar');
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.deepEqual(body.suppressed.sessions, [{ sessionId: 's-side', reason: 'dsh-btw-sidebar' }]);
});

// ── 规则上下文与点击揭示 ────────────────────────────────────────────────────

/** 已发出的通知脚本（按 reminder 标记识别，避免把协议注册脚本也算进来）。 */
const reminderScripts = (fake) => readScripts(fake.logPath).filter((s) => s.includes('cmVtaW5kZXI='));

test('规则能拿到在场上下文：页面被看着时才抑制，没人看时照常提醒', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, { cooldownMs: 0 }, fake.deps);
    awayNotifyOf(ctx).addRule({
      id: 'only-while-watched',
      reason: 'watched',
      match: (_sid, _event, context) => context?.pageAttended === true,
    });
    ctx.sessions.add(session('s1'));

    // 没人看页面：规则不命中 → 照常提醒
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd(1));
    await settle();
    assert.equal(reminderScripts(fake).length, 1, '没人看页面时应提醒');

    // 有人看着页面（浏览器心跳可见 + 有焦点）：规则命中 → 抑制
    await reportPresence(ctx, 's1', true, true);
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd(2));
    await settle();
    assert.equal(reminderScripts(fake).length, 1, '页面被看着时规则应命中，不再新增通知');
  } finally {
    restore();
    fake.cleanup();
  }
});

test('pending-focus 带上调用方声明的揭示目标', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    const away = awayNotifyOf(ctx);
    away.revealSession('s-side', { resource: 'dsh-resource://btw/session/s-side', reason: 'dsh-btw-sidebar' });
    ctx.sessions.add(session('s-side'));

    ctx.emit('session/event', ctx.sessions.get('s-side'), turnEnd());
    await settle();

    const { body } = await callEndpoint(ctx, { op: 'pending-focus' });
    assert.equal(body.sessionId, 's-side');
    assert.deepEqual(body.reveal, {
      resource: 'dsh-resource://btw/session/s-side',
      reason: 'dsh-btw-sidebar',
    });
  } finally {
    restore();
    fake.cleanup();
  }
});

test('没有揭示目标时 pending-focus 回 null（浏览器半部退回主视图）', async () => {
  const fake = makeFakeSpawn();
  const restore = pretendWindows(fake.psPath);
  try {
    const ctx = makeCtx();
    applyHost(ctx, {}, fake.deps);
    ctx.sessions.add(session('s1'));
    ctx.emit('session/event', ctx.sessions.get('s1'), turnEnd());
    await settle();

    const { body } = await callEndpoint(ctx, { op: 'pending-focus' });
    assert.equal(body.sessionId, 's1');
    assert.equal(body.reveal, null);
  } finally {
    restore();
    fake.cleanup();
  }
});

test('没有待跳转会话时也回 reveal:null，而不是省略字段', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  const { body } = await callEndpoint(ctx, { op: 'pending-focus' });
  assert.equal(body.sessionId, null);
  assert.equal(body.reveal, null);
});

test('揭示目标也进 state 诊断', async () => {
  const ctx = makeCtx();
  applyHost(ctx, {});
  awayNotifyOf(ctx).revealSession('s-side', { resource: 'dsh-resource://btw/session/s-side', reason: 'btw' });
  const { body } = await callEndpoint(ctx, { op: 'state' });
  assert.deepEqual(body.suppressed.sessions, [
    { sessionId: 's-side', reveal: { resource: 'dsh-resource://btw/session/s-side', reason: 'btw' } },
  ]);
});
