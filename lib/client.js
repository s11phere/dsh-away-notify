/**
 * client.js — dsh-away-notify 浏览器半部
 *
 * 只做三件事：
 *   1. 把「用户正在看哪个会话 + 标签页是否可见 + 窗口是否有焦点」上报给宿主，
 *      宿主的 PresenceStore 据此决定要不要弹通知（前台抑制）。
 *   2. 处理点击通知回跳：URL 上带 `dshAwayNotifyFocus=<sessionId>`，本模块在页面
 *      加载后把该会话切到前台。
 *   3. 给 `document.title` 追加一个**按端口区分**的后缀（` [dsh:<port>]`），让同一
 *      台机器上并存的多个 dsh 实例（例如 Windows 原生 + WSL）在浏览器窗口标题上
 *      可区分，从而让 `dshnotify:` 处理器能精确聚焦到出事的那一个实例的窗口。
 *      详见 scripts/focus-or-open.ps1 的说明。
 *
 * 约束（0.1.6）：
 *   - 客户端 bundle 必须用 `window.__ModuleLoader__.load({id, factory})` 形式。
 *   - **只能 require seed 静态模块**（react/cordis/store/ui-slots/…）；require 任何
 *     非 seed 的内部包会直接抛错。本模块不 require 任何东西。
 *   - 前端不支持 `?session=` 深链，所以会话跳转只能在这里用 `sessions.open()` 做。
 *   - 上报不用 `connection.rpc`（该 API 在 0.1.6 不可用），而是 POST 到宿主注册在
 *     `/api` 前缀下的精确路由；浏览器会自动带上同源鉴权 cookie。
 *
 * 注意：`inject` 故意留空。若把 `sessions` 写进 `inject`，而该服务在客户端容器里
 * 不可用或晚就绪，`apply` 会一直不被调用，插件将完全静默——这正是本插件第一版
 * 在真机上 `attended: null` 的原因。改为 apply 先无条件挂上 DOM 监听，再用
 * `ctx.inject(['sessions'], …)` 在服务就绪后接过会话相关的部分。
 */

window.__ModuleLoader__.load({
  id: 'dsh-away-notify',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    // ── 诊断开关（排查问题时置 true，浏览器控制台可见）────────────────────
    const DIAG = false;
    const diag = (...args) => {
      if (DIAG) console.log('[dsh-away-notify]', ...args);
    };

    /** 与宿主 `connection.fetch.register` 注册的路径必须完全一致。 */
    const PRESENCE_PATH = '/api/dsh-away-notify';
    /** 心跳间隔：远小于宿主 presenceTtlMs(45s)，标签页崩溃后能及时判定为「离开」。 */
    const HEARTBEAT_MS = 15000;
    /** 点击通知回跳时 URL 上携带会话 id 的参数名。 */
    const FOCUS_PARAM = 'dshAwayNotifyFocus';

    /**
     * 本实例的窗口标题后缀。
     *
     * 格式必须与 `scripts/focus-or-open.ps1` 里从目标 URL 端口重建的那个完全一致
     * （`[dsh:<port>]`），否则聚焦脚本找不到窗口。用端口而不是别的标识，是因为它
     * 同时出现在浏览器地址栏和通知里的 URL 上——脚本无需额外传参就能推导出来。
     */
    const TITLE_TAG = (() => {
      try {
        const port = location.port || (location.protocol === 'https:' ? '443' : '80');
        return port ? ` [dsh:${port}]` : '';
      } catch {
        return '';
      }
    })();

    // 见文件头说明：留空，避免 apply 被依赖阻塞而永不执行。
    const inject = [];

    /**
     * 每个标签页一个稳定标识。宿主按它记录「谁在看哪个会话」，这样同一标签页切换
     * 会话时旧会话会立刻失效；多个标签页则各自独立、可同时被抑制。
     * 用 sessionStorage 让同一标签页刷新后仍是同一个 id，避免刷新期间残留旧记录。
     */
    const CLIENT_ID = (() => {
      const KEY = 'dshAwayNotifyClientId';
      const make = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
      try {
        const existing = sessionStorage.getItem(KEY);
        if (existing) return existing;
        const fresh = make();
        sessionStorage.setItem(KEY, fresh);
        return fresh;
      } catch {
        return make();
      }
    })();

    /** 只在首次拿不到会话 id 时提示一次，避免每 15 秒刷屏。 */
    let warnedNoSession = false;

    /**
     * 上报去重节流：会话列表订阅会在短时间内连续触发（实测同一秒 12 次），
     * 而状态其实没变。相同载荷在心跳周期内只发一次；真正变化（切换标签页/失焦）
     * 会立刻发出。
     */
    let lastPayloadKey = null;
    let lastSentAt = 0;

    /** 当前被选中的会话 id（列表快照的 current）。 */
    function currentSessionId(sessionCtx) {
      try {
        const snapshot = sessionCtx?.sessions?.list?.getSnapshot?.();
        const current = snapshot?.current;
        return typeof current === 'string' && current.length > 0 ? current : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 上报一次在场状态。任何失败都被吞掉——上报绝不影响页面本身。
     * `visible` 与 `focused` 分开上报，宿主据此区分「切到别的标签页」和
     * 「标签页可见但焦点在别的应用」。
     */
    function report(sessionCtx) {
      try {
        const sessionId = currentSessionId(sessionCtx);
        const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
        const focused =
          typeof document !== 'undefined' && typeof document.hasFocus === 'function'
            ? document.hasFocus()
            : false;
        // 会话 id 拿不到也要上报：宿主会退化为「页面级在场」判定
        if (sessionId === undefined && !warnedNoSession) {
          warnedNoSession = true;
          diag('拿不到会话 id，退化为页面级在场判定（可见=', visible, '焦点=', focused, '）');
        }
        if (sessionId !== undefined) warnedNoSession = false;
        const payload = sessionId === undefined
          ? { op: 'presence', clientId: CLIENT_ID, visible, focused }
          : { op: 'presence', clientId: CLIENT_ID, sessionId, visible, focused };

        // 去重节流：相同载荷在心跳周期内只发一次
        const key = `${sessionId ?? ''}|${visible}|${focused}`;
        const now = Date.now();
        if (key === lastPayloadKey && now - lastSentAt < HEARTBEAT_MS) return;
        lastPayloadKey = key;
        lastSentAt = now;

        const pending = fetch(PRESENCE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch (error) {
        diag('上报异常', String(error?.message ?? error));
      }
    }

    /** 当前页面是否可见且有焦点。 */
    function isVisibleAndFocused() {
      const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
      const focused =
        typeof document !== 'undefined' && typeof document.hasFocus === 'function'
          ? document.hasFocus()
          : false;
      return visible && focused;
    }

    /** 把某个会话切到前台，必要时等会话列表就绪。 */
    function switchTo(sessionCtx, target, { giveUpWhenReady = true } = {}) {
      let tries = 0;
      const attempt = () => {
        tries += 1;
        try {
          const snapshot = sessionCtx?.sessions?.list?.getSnapshot?.();
          const listed =
            snapshot?.byId !== undefined && Object.prototype.hasOwnProperty.call(snapshot.byId, target);
          if (listed) {
            sessionCtx.sessions.open(target);
            diag('已切到目标会话', target);
            return true;
          }
          if (giveUpWhenReady && snapshot?.phase === 'ready') {
            diag('目标会话不在列表中，放弃', target);
            return false;
          }
        } catch {
          /* ignore */
        }
        if (tries < 40) setTimeout(attempt, 250);
        return false;
      };
      return attempt();
    }

    /**
     * 取一次宿主记录的「待跳转会话」并切过去。
     *
     * 这是点击 Toast 回到正确会话的**主通路**：token 换 cookie 的 303 会丢掉 URL
     * 参数，所以不能依赖 `?dshAwayNotifyFocus=`。改为每次页面加载 / 重新获得焦点
     * 时向宿主索取，取到后回执清除。
     */
    function consumePendingFocus(sessionCtx) {
      if (sessionCtx === undefined || sessionCtx === null) return;
      fetch(PRESENCE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'pending-focus' }),
      })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
          const target = data?.sessionId;
          if (typeof target !== 'string' || target.length === 0) return;
          if (currentSessionId(sessionCtx) === target) {
            // 已经在目标会话上，直接回执即可
            ackFocus(target);
            return;
          }
          switchTo(sessionCtx, target, { giveUpWhenReady: false });
          ackFocus(target);
        })
        .catch(() => {});
    }

    function ackFocus(sessionId) {
      fetch(PRESENCE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'ack-focus', sessionId }),
      }).catch(() => {});
    }

    /**
     * 兼容路径：页面带 `?dshAwayNotifyFocus=<id>` 打开时切过去。
     * 注意当前 dsh 的 token 换取流程会 303 到 `/` 丢掉查询参数，所以这条通常不生效，
     * 真正的通路是上面的 `consumePendingFocus`。保留它以防将来前端/鉴权行为变化。
     */
    function focusFromUrl(sessionCtx) {
      if (typeof location === 'undefined' || typeof history === 'undefined') return;
      let target;
      try {
        target = new URLSearchParams(location.search).get(FOCUS_PARAM);
      } catch {
        return;
      }
      if (typeof target !== 'string' || target.length === 0) return;
      diag('检测到 URL 回跳目标会话', target);

      // 立刻从地址栏移除，避免刷新时重复触发、也避免 token 残留在浏览器历史里
      try {
        const clean = new URL(location.href);
        clean.searchParams.delete(FOCUS_PARAM);
        history.replaceState(history.state, '', clean.toString());
      } catch {
        /* ignore */
      }
      switchTo(sessionCtx, target);
    }

    // ── 窗口标题 tag ───────────────────────────────────────────────────────
    //
    // 标题由 dsh-client-ui-layout 拥有（它在会话切换时整体重写 document.title），
    // 所以这里不能只写一次：用 MutationObserver 在每次被覆盖后重新补上后缀。
    // applyTitleTag 自身幂等（已带后缀就直接返回），不会和观察者打成死循环。
    let titleTagOn = false;
    let titleObserver = null;

    function applyTitleTag() {
      if (!titleTagOn || TITLE_TAG === '') return;
      try {
        const current = document.title;
        if (typeof current !== 'string' || current.endsWith(TITLE_TAG)) return;
        document.title = current + TITLE_TAG;
      } catch {
        /* ignore */
      }
    }

    function setTitleTag(on) {
      if (on === titleTagOn) return;
      titleTagOn = on;
      try {
        if (on) {
          applyTitleTag();
          if (titleObserver === null && typeof MutationObserver === 'function') {
            const root = document.head ?? document.documentElement;
            if (root) {
              titleObserver = new MutationObserver(applyTitleTag);
              titleObserver.observe(root, { childList: true, subtree: true, characterData: true });
            }
          }
        } else {
          if (titleObserver !== null) {
            titleObserver.disconnect();
            titleObserver = null;
          }
          if (TITLE_TAG !== '' && typeof document.title === 'string' && document.title.endsWith(TITLE_TAG)) {
            document.title = document.title.slice(0, -TITLE_TAG.length);
          }
        }
      } catch {
        /* ignore */
      }
    }

    /**
     * 问宿主要不要打 tag。
     *
     * 失败时**保持默认开启**：宿主的聚焦脚本默认也要求 tag，两边默认一致才不会
     * 出现「脚本等 tag、页面没打」而每次都退化去新开标签页的情况。
     */
    function loadTitleTagConfig() {
      fetch(PRESENCE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'config' }),
      })
        .then((res) => (res && res.ok ? res.json() : null))
        .then((data) => {
          if (data && typeof data.titleTag === 'boolean') setTitleTag(data.titleTag);
        })
        .catch(() => {});
    }

    function apply(ctx) {
      diag('apply 被调用', {
        visibility: typeof document !== 'undefined' ? document.visibilityState : 'no-document',
        hasEffect: typeof ctx.effect,
      });

      // 标题 tag 先无条件打开（与宿主聚焦脚本的默认一致），再按宿主配置决定去留
      setTitleTag(true);
      loadTitleTagConfig();

      // 会话就绪后才有值的上下文；DOM 监听不依赖它
      let sessionCtx;

      /** 常规上报。 */
      const onChange = () => report(sessionCtx);

      /**
       * 回到前台/页面时：先上报，再尝试取一次「待跳转会话」。
       * 这样即使浏览器只是**聚焦已有窗口**（没有重新加载页面），也能完成跳转。
       */
      const onRegain = () => {
        report(sessionCtx);
        if (isVisibleAndFocused()) consumePendingFocus(sessionCtx);
      };

      const domTargets = [];
      const bind = (target, type, handler) => {
        target.addEventListener(type, handler);
        domTargets.push([target, type, handler, false]);
      };
      if (typeof document !== 'undefined') {
        bind(document, 'visibilitychange', onRegain);
      }
      if (typeof window !== 'undefined') {
        for (const type of ['focus', 'pageshow']) bind(window, type, onRegain);
        for (const type of ['blur', 'pagehide']) bind(window, type, onChange);
      }

      // sessions 就绪后接管：订阅列表变化 + 首次上报 + 处理回跳
      let unsubscribeList;
      try {
        ctx.inject(['sessions'], (c) => {
          sessionCtx = c;
          diag('sessions 已就绪', {
            hasList: !!c.sessions?.list,
            phase: (() => {
              try {
                return c.sessions?.list?.getSnapshot?.()?.phase;
              } catch (error) {
                return `throw:${String(error?.message ?? error)}`;
              }
            })(),
          });
          try {
            unsubscribeList = c.sessions?.list?.subscribe?.(onChange);
          } catch {
            /* ignore */
          }
          onChange();
          // 主通路：向宿主索取待跳转会话
          consumePendingFocus(c);
          // 兼容通路：URL 参数（当前鉴权流程会丢掉它）
          focusFromUrl(c);
        });
      } catch (error) {
        diag('注入 sessions 失败', String(error?.message ?? error));
      }

      const timer = setInterval(onChange, HEARTBEAT_MS);

      ctx.effect(
        () => () => {
          clearInterval(timer);
          try {
            setTitleTag(false);
          } catch {
            /* ignore */
          }
          try {
            unsubscribeList?.();
          } catch {
            /* ignore */
          }
          for (const [target, type, handler, capture] of domTargets) {
            try {
              target.removeEventListener(type, handler, capture);
            } catch {
              /* ignore */
            }
          }
        },
        'dsh-away-notify: presence reporting',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    diag('bundle 求值完毕，导出已就绪');
    return module.exports;
  },
});
