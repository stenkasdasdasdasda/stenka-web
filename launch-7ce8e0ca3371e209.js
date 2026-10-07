const hosts = ['https://cf-stenka.furry.by', 'https://dns.furry.by'];
const website = location.origin === 'https://stenka.furry.by';
const status = document.getElementById('status');
let tg = window.Telegram?.WebApp;
const launchParams = new URLSearchParams(location.hash.slice(1));
// Proofs, the browser binding and sessions stay in memory, never URLs or storage.
let initData = launchParams.get('tgWebAppData') || tg?.initData || '';
const pendingNative = new Set();
function nativeCall(method) {
  // Never enlarge a desktop window, including when a late SDK reports unknown.
  if (method === 'expand' && !['android', 'android_x', 'ios'].includes(snapshot().platform)) return;
  tg?.[method]?.();
}
const loginNonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
  b.toString(16).padStart(2, '0'),
).join('');
const requested = website
  ? location.pathname + location.search + location.hash
  : new URLSearchParams(location.search).get('return') || '/app';
const destination = website
  ? requested
  : /^\/app(?:\/|[?#]|$)/.test(requested) && !requested.includes('\\')
    ? requested
    : '/app';
const frames = new Map();
const sessions = new Map();
let selected = null;
let connected = false;
let run = 0;
let backupTimer, failureTimer, clientTimer, retryTimer, sdkTimer;
let pendingShare = null;
if (location.hash && !website) history.replaceState(null, '', location.pathname + location.search);

function snapshot() {
  const insets = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    insets['safe-' + side] = Math.min(200, Math.max(0, Number(tg?.safeAreaInset?.[side]) || 0));
    insets['content-' + side] = Math.min(
      200,
      Math.max(0, Number(tg?.contentSafeAreaInset?.[side]) || 0),
    );
  }
  return {
    initData,
    loginNonce,
    sessionToken: sessions.get(selected?.host) || '',
    // The async SDK may initialize after the sensitive hash has been removed.
    // Its default unknown/6.0 values must not replace the native launch values.
    platform: launchParams.get('tgWebAppPlatform') || tg?.platform || 'unknown',
    version: launchParams.get('tgWebAppVersion') || tg?.version || '0',
    colorScheme: tg?.colorScheme === 'light' ? 'light' : 'dark',
    isFullscreen: !!tg?.isFullscreen,
    insets,
  };
}
function clearTimers() {
  clearTimeout(backupTimer);
  clearTimeout(failureTimer);
  clearTimeout(clientTimer);
  clearTimeout(retryTimer);
}
function discard(record) {
  frames.delete(record.frame.contentWindow);
  record.frame.remove();
}
function fail(reconnect = start) {
  ++run;
  clearTimers();
  for (const record of frames.values()) discard(record);
  selected = null;
  connected = false;
  document.getElementById('loading').hidden = false;
  let seconds = 3;
  const tick = () => {
    status.textContent = `Пытаюсь подключиться… Повтор через ${seconds} с`;
    retryTimer = setTimeout(() => {
      if (--seconds) tick();
      else reconnect();
    }, 1000);
  };
  tick();
}
function choose(record) {
  if (selected && selected !== record) return false;
  if (!selected) {
    selected = record;
    clearTimers();
    for (const other of frames.values()) if (other !== record) discard(other);
    status.textContent = 'Открываем Фурри Стенку…';
    clientTimer = setTimeout(() => {
      if (!connected) fail();
    }, 15000);
  }
  return true;
}
function openFrame(host) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'Фурри Стенка';
  frame.referrerPolicy = 'no-referrer';
  frame.allow = 'clipboard-write; web-share';
  frame.sandbox =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  const target = new URL(
    website ? location.pathname + location.search + location.hash : destination,
    host,
  );
  target.searchParams.set('launcher', website ? 'website' : 'github');
  frame.src = target.href;
  document.body.append(frame);
  frames.set(frame.contentWindow, { frame, host });
}
async function browserStart(attempt) {
  // Ordinary browser visits need no Telegram proof or iframe session.
  for (const host of hosts) {
    try {
      const response = await fetch(host + '/connection-check', {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      });
      const data = await response.json();
      if (attempt !== run) return;
      if (response.ok && data.ok && data.service === 'stenka') {
        const publicDestination = destination.replace(/^\/app(?=\/|[?#]|$)/, '') || '/';
        location.replace(
          host + (publicDestination.startsWith('/') ? publicDestination : '/' + publicDestination),
        );
        return;
      }
    } catch {}
  }
  if (attempt === run) fail();
}
function start() {
  const attempt = ++run;
  clearTimers();
  for (const record of frames.values()) discard(record);
  selected = null;
  connected = false;
  document.getElementById('loading').hidden = false;
  status.textContent = 'Открываем Фурри Стенку…';
  if (!initData && !website) {
    void browserStart(attempt);
    return;
  }
  // Start VDS after 1 second without discarding a still-useful primary request.
  // Only the winning document ever receives Telegram proof and credentials.
  openFrame(hosts[0]);
  backupTimer = setTimeout(() => {
    if (attempt !== run || selected) return;
    openFrame(hosts[1]);
  }, 1000);
  failureTimer = setTimeout(() => {
    if (attempt === run && !selected) fail();
  }, 30000);
}
window.addEventListener('message', (event) => {
  const record = frames.get(event.source);
  if (
    !record ||
    event.origin !== record.host ||
    !event.data ||
    event.data.channel !== 'stenka-launcher-v1'
  )
    return;
  const data = event.data;
  if (data.type === 'document-ready') {
    choose(record);
  } else if (data.type === 'ready' && choose(record)) {
    connected = true;
    clearTimers();
    record.frame.contentWindow.postMessage(
      { channel: 'stenka-launcher-v1', type: 'init', ...snapshot() },
      record.host,
    );
    record.frame.hidden = false;
    document.getElementById('loading').hidden = true;
    document.getElementById('public-content')?.setAttribute('hidden', '');
  } else if (
    website &&
    selected === record &&
    connected &&
    data.type === 'navigation' &&
    typeof data.path === 'string' &&
    data.path.length <= 4000 &&
    /^\/(?!\/)/.test(data.path) &&
    !/[\\\u0000-\u001f]/.test(data.path)
  ) {
    const path = new URL(data.path, location.origin);
    if (path.origin !== location.origin || /^\/auth(?:\/|$)/.test(path.pathname)) return;
    if (
      path.pathname + path.search + path.hash !==
      location.pathname + location.search + location.hash
    )
      history.pushState(null, '', path.pathname + path.search + path.hash);
    if (typeof data.title === 'string' && data.title.length < 300) document.title = data.title;
  } else if (
    selected === record &&
    connected &&
    data.type === 'session' &&
    typeof data.sessionToken === 'string'
  ) {
    if (/^[a-f0-9]{64}$/.test(data.sessionToken)) sessions.set(record.host, data.sessionToken);
    else if (data.sessionToken === '') sessions.delete(record.host);
  } else if (
    selected === record && connected && initData && data.type === 'share-message' &&
    typeof data.requestId === 'string' && /^[a-f0-9-]{36}$/.test(data.requestId) &&
    typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 512 &&
    !/[\u0000-\u0020]/.test(data.id)
  ) {
    const reply = (sent, error = '') => {
      if (selected === record && connected) record.frame.contentWindow.postMessage({
        channel: 'stenka-launcher-v1', type: 'share-result', requestId: data.requestId, sent, error,
      }, record.host);
    };
    if (pendingShare) { reply(false, 'BUSY'); return; }
    const version = Number(snapshot().version.split('.')[0]);
    if (version < 8) { reply(false, 'UNSUPPORTED'); return; }
    let cleanup = () => {};
    let shareTimer;
    pendingShare = cleanup;
    const finish = (sent, error = '') => {
      if (pendingShare !== cleanup) return;
      clearTimeout(shareTimer);
      cleanup(); pendingShare = null; reply(sent, error);
    };
    shareTimer = setTimeout(() => finish(false, 'TIMEOUT'), 120000);
    try {
      const view = window.Telegram?.WebView;
      if (view?.postEvent && view?.onEvent && view?.offEvent) {
        // A delayed SDK may have default version 6.0 after hash sanitization.
        // Use its native transport with the preserved, verified launch version.
        const sent = () => finish(true);
        const failed = (_type, details) => finish(false, typeof details?.error === 'string' ? details.error : 'FAILED');
        view.onEvent('prepared_message_sent', sent);
        view.onEvent('prepared_message_failed', failed);
        cleanup = () => { view.offEvent('prepared_message_sent', sent); view.offEvent('prepared_message_failed', failed); };
        pendingShare = cleanup;
        view.postEvent('web_app_send_prepared_message', false, { id: data.id });
      } else if (tg?.isVersionAtLeast?.('8.0') && tg?.shareMessage) tg.shareMessage(data.id, sent => finish(sent));
      else throw Error('UNAVAILABLE');
    } catch { finish(false, 'UNAVAILABLE'); }
  } else if (
    selected === record &&
    connected &&
    data.type === 'native' &&
    ['ready', 'expand', 'exitFullscreen'].includes(data.method)
  ) {
    try {
      if (tg?.[data.method]) nativeCall(data.method);
      else pendingNative.add(data.method);
    } catch {}
  }
});
const themeChanged = () => {
  if (connected && selected)
    selected.frame.contentWindow.postMessage(
      {
        channel: 'stenka-launcher-v1',
        type: 'theme',
        colorScheme: tg.colorScheme === 'light' ? 'light' : 'dark',
      },
      selected.host,
    );
};
let nativeBound = false;
let launched = false;
function begin() {
  tg = window.Telegram?.WebApp || tg;
  if (!initData) initData = tg?.initData || '';
  if (tg && !nativeBound) {
    nativeBound = true;
    try {
      tg.ready?.();
      nativeCall('expand');
      tg.onEvent?.('themeChanged', themeChanged);
      for (const method of pendingNative) nativeCall(method);
      pendingNative.clear();
    } catch {}
  }
  if (!launched) {
    launched = true;
    clearTimeout(sdkTimer);
    start();
  }
}
const sdkScript = document.querySelector(
  'script[src="https://telegram.org/js/telegram-web-app.js"]',
);
let currentSDK = sdkScript;
function bindSDK(script) {
  script.addEventListener(
    'load',
    () => {
      if (currentSDK === script) begin();
    },
    { once: true },
  );
  const unavailable = () => {
    if (!launched && currentSDK === script) {
      clearTimeout(sdkTimer);
      fail(reloadSDK);
    }
  };
  script.addEventListener('error', unavailable, { once: true });
  sdkTimer = setTimeout(unavailable, 10000);
}
function reloadSDK() {
  clearTimers();
  clearTimeout(sdkTimer);
  status.textContent = 'Открываем Фурри Стенку…';
  currentSDK?.remove();
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://telegram.org/js/telegram-web-app.js';
  currentSDK = script;
  bindSDK(script);
  document.head.append(script);
}
if (sdkScript) bindSDK(sdkScript);
// Native launch proof is sufficient to start connecting immediately. The SDK
// can load in parallel; its late arrival must not restart login or lose events.
if (initData || tg || !sdkScript || website || !launchParams.has('tgWebAppPlatform')) begin();
if (website) window.addEventListener('popstate', start);
