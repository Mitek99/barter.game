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
         background:#f7f6fb; color:#2d3748; text-align:center;
         font-family:system-ui,-apple-system,'Segoe UI',sans-serif; padding:1.5rem }
  .mark { width:60px; height:60px; margin:0 auto 1.25rem }
  .mark svg { display:block; width:100%; height:100% }
  h1 { font-size:1.4rem; margin:0 0 0.5rem }
  p { color:#64748d; max-width:26rem; margin:0 auto 1.25rem }
  button { padding:0.65rem 1.25rem; border:none; border-radius:999px; background:#7239d6; color:#fff;
           font:inherit; font-weight:700; cursor:pointer;
           box-shadow:0 8px 20px rgba(114,57,214,.28) }
  @media (prefers-color-scheme: dark) {
    body { background:#1a1325; color:#ece7f7 }
    p { color:#aba1c4 }
    button { background:#8f60de; color:#1a1325 }
  }
</style></head>
<body><div>
  <div class="mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="137" ry="137" fill="#1a1325"/><circle cx="256" cy="256" r="192" fill="none" stroke="#8f60de" stroke-width="32"/><path d="M164 213 H 320" stroke="#ffffff" stroke-width="28" stroke-linecap="round" fill="none"/><path d="M284 171 L 334 213 L 284 256" stroke="#ffffff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M348 306 H 192" stroke="#ff8c39" stroke-width="28" stroke-linecap="round" fill="none"/><path d="M228 263 L 178 306 L 228 348" stroke="#ff8c39" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div>
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
