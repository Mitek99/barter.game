/* barter.game service worker — installability only, deliberately not a cache.
 *
 * The SPA is NOT offline-capable (see README): app.js talks to the bank on
 * every screen, and the responses are signed, per-user, and time-sensitive.
 * Caching them — or the app code that verifies them — would trade a clear
 * "you're offline" message for silently stale balances and, worse, a stale
 * client running against a newer bank. So this worker caches nothing.
 *
 * It exists because "add to home screen" needs it: Chromium only fires
 * `beforeinstallprompt` for a page controlled by a service worker with a fetch
 * handler that yields a response while offline. This one handles exactly that
 * case — top-level navigations — and passes every other request straight to
 * the network by declining to respond.
 *
 * Served by the bank at /:bank/ui/sw.js (see apps/bank/ui.ts) so its scope
 * covers the whole SPA, including the start_url.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — barter.game</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#F3F1EC; color:#1A1712; text-align:center;
         font-family:system-ui,-apple-system,'Segoe UI',sans-serif; padding:1.5rem }
  .mark { width:60px; height:60px; border-radius:17px; background:#3D34D6; margin:0 auto 1.25rem;
          display:flex; align-items:center; justify-content:center }
  .mark span { width:22px; height:22px; border:3.4px solid #fff; border-radius:4px;
               transform:rotate(45deg); display:block }
  h1 { font-size:1.4rem; margin:0 0 0.5rem }
  p { color:#6B665D; max-width:26rem; margin:0 auto 1.25rem }
  button { padding:0.65rem 1rem; border:none; border-radius:12px; background:#3D34D6; color:#fff;
           font:inherit; font-weight:600; cursor:pointer }
  @media (prefers-color-scheme: dark) {
    body { background:#15130E; color:#ECE9E1 }
    p { color:#A8A399 }
    button { background:#9089F0; color:#15130E }
  }
</style></head>
<body><div>
  <div class="mark"><span></span></div>
  <h1>You're offline</h1>
  <p>barter.game needs a connection to reach your bank — balances, vouchers and
     deals all live there. Your keys are untouched; reconnect and log in again.</p>
  <button onclick="location.reload()">Try again</button>
</div></body></html>`;

self.addEventListener('fetch', (event) => {
  // Only top-level navigations. Everything else (app code, the signed
  // /:bank/ui/* API, RPC) is left alone: no respondWith means the browser
  // performs its normal network fetch.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(OFFLINE_PAGE, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    ),
  );
});
