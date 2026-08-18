import {
  base58Encode,
  base58Decode,
  canonicalizeWithoutSig,
  collectMediaRefs,
  genKeyPair,
  hashDoc,
  newUlid,
  publicKeyOf,
  sha256Base58,
  signDoc,
  validatePost,
  verifyDoc,
  verifyPostTree,
} from './protocol.js';
import { qrDataUrl, startScanner } from './qr.js';

// ---------------- key encryption (PBKDF2 + AES-GCM) ----------------

// ---------------- key encryption (PBKDF2 + AES-GCM) ----------------

async function deriveKey(password, salt, iterations = 250000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptSeed(seed, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, seed));
  return {
    kdf: 'pbkdf2-sha256',
    iterations: 250000,
    salt: arrayBufferToBase64url(salt),
    nonce: arrayBufferToBase64url(iv),
    ciphertext: arrayBufferToBase64url(ciphertext),
    aead: 'aes-256-gcm'
  };
}

async function decryptSeed(blob, password) {
  const salt = base64urlToArrayBuffer(blob.salt);
  const iv = base64urlToArrayBuffer(blob.nonce);
  const ciphertext = base64urlToArrayBuffer(blob.ciphertext);
  const key = await deriveKey(password, salt, blob.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plain);
}

function arrayBufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToArrayBuffer(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------- state ----------------

const state = {
  bankName: '',
  bankPubkey: '',
  bankUrl: '',
  basePath: '',
  user: null, // { handle, pubkey, privateKey }
  uiState: null,
  // undefined = not probed yet; true/false after the /admin/overview probe.
  isAdmin: undefined,
};

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean);
  state.bankName = parts[0] || 'bank';
  state.basePath = `/${state.bankName}`;
}
parsePath();

// ---------------- API ----------------

async function fetchConfig() {
  const res = await fetch(`${state.basePath}/ui/config`);
  const cfg = await res.json();
  state.bankPubkey = cfg.pubkey;
  state.bankUrl = cfg.url;
  return cfg;
}

// Build an Error from a bank error WITHOUT the numeric JSON-RPC code prefix —
// users should see the human message ("handle taken"), not "-32008: handle
// taken". The code is kept as a property for any logic that needs it.
function bankError(code, message) {
  const e = new Error(message || `Request failed (${code})`);
  e.code = code;
  return e;
}

async function rpcCall(method, params, toPubkey) {
  const id = newUlid();
  const envelope = {
    jsonrpc: '2.0', id, method, params,
    pubkey: state.user.pubkey,
    to: toPubkey || state.bankPubkey,
    sig: ''
  };
  envelope.sig = signDoc(envelope, state.user.privateKey);
  const res = await fetch(`${state.basePath}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });
  const data = await res.json();
  if (data.error) throw bankError(data.error.code, data.error.message);
  return data.result;
}

async function signedRequest(method, path, body) {
  const authdoc = {
    pubkey: state.user.pubkey,
    method,
    path: `${state.basePath}/ui${path}`,
    id: newUlid(),
    ts: Date.now(),
    body_sha256: body ? sha256Base58(JSON.stringify(body)) : null
  };
  const sig = signDoc(authdoc, state.user.privateKey);
  const token = `${arrayBufferToBase64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${state.basePath}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw bankError(data.code, data.message);
  return data;
}

async function uiGet(path) { return signedRequest('GET', path, null); }
async function uiPost(path, body) { return signedRequest('POST', path, body); }
async function uiPut(path, body) { return signedRequest('PUT', path, body); }
async function uiDelete(path) { return signedRequest('DELETE', path, null); }

// An admin is just a registered user whose pubkey the operator listed in
// BANK_ADMINS; the bank answers 403 for everyone else. Probed once per
// session — the 403 is the normal "not an admin" answer, not an error.
async function probeAdmin() {
  if (!state.user || state.isAdmin !== undefined) return;
  try { await uiGet('/admin/overview'); state.isAdmin = true; }
  catch { state.isAdmin = false; }
  route(); // repaint so the Admin nav item reflects the answer
}

// ---------------- cross-bank calls ----------------
// A scanned invoice/cheque may live at another bank (the voucher's issuing
// bank). These variants address an explicit bank base URL + pubkey instead of
// the bank the SPA is served from.

async function rpcCallAt(base, toPubkey, method, params) {
  const envelope = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: state.user.pubkey, to: toPubkey, sig: ''
  };
  envelope.sig = signDoc(envelope, state.user.privateKey);
  const res = await fetch(`${base.replace(/\/$/, '')}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });
  const data = await res.json();
  if (data.error) throw bankError(data.error.code, data.error.message);
  return data.result;
}

async function signedRequestAt(base, method, path, body) {
  const clean = base.replace(/\/$/, '');
  // The auth doc signs the request's real pathname (+ query) at the target bank.
  const u = new URL(`${clean}/ui${path}`, location.origin);
  const authdoc = {
    pubkey: state.user.pubkey, method, path: u.pathname + u.search,
    id: newUlid(), ts: Date.now(),
    body_sha256: body ? sha256Base58(JSON.stringify(body)) : null
  };
  const sig = signDoc(authdoc, state.user.privateKey);
  const token = `${arrayBufferToBase64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${clean}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw bankError(data.code, data.message);
  return data;
}

// Where to reach the bank that issues a voucher (order side.bank — pinned in
// the holder's signed Order). Tries: this bank, the envelope's serving bank,
// the user's pinned banks, then the Address directory at this bank.
async function resolveVoucherBank(side, env) {
  if (side.bank === state.bankPubkey) return { pubkey: state.bankPubkey, url: state.bankUrl };
  if (env && env.bank === side.bank && env.bank_url) return { pubkey: side.bank, url: env.bank_url };
  try {
    const pinned = await uiGet('/banks');
    const hit = (pinned || []).find(b => b.pubkey === side.bank);
    if (hit) return { pubkey: side.bank, url: hit.url };
  } catch { /* fall through */ }
  try {
    const addr = await rpcCall('get_address', { pubkey: side.bank });
    if (addr && addr.url) return { pubkey: side.bank, url: addr.url };
  } catch { /* fall through */ }
  throw new Error('this voucher is issued at a bank this app cannot reach — scan the QR from the issuer\'s bank or pin their bank under Network');
}

// ---------------- holdings across banks ----------------
// A voucher lives at its issuing bank, so claiming a foreign cheque puts the
// balance THERE, not at the bank this SPA is served from. The protocol already
// exposes this to the holder: `list_accounts` and `get_account_balance` are
// signed RPCs any bank will answer. Aggregate over this bank + pinned banks.

async function remoteHoldings(bankRef) {
  const res = await rpcCallAt(bankRef.url, bankRef.pubkey, 'list_accounts', {});
  const byHash = {};
  (res.vouchers || []).forEach(v => { byHash[hashDoc(v)] = v; });
  const out = [];
  for (const a of (res.accounts || [])) {
    const account = hashDoc(a);
    const bal = await rpcCallAt(bankRef.url, bankRef.pubkey, 'get_account_balance', { account_hash: account }).catch(() => null);
    out.push({
      bank: bankRef.pubkey,
      bank_url: bankRef.url,
      remote: true,
      voucher: a.voucher,
      name: (byHash[a.voucher] || {}).name || 'Unknown',
      account,
      // null (not 0) when the balance RPC failed — the dashboard renders '—' so
      // a transient error is never shown as a real zero balance.
      current: bal ? bal.current : null,
      pending: bal ? bal.pending : null,
    });
  }
  return out;
}

async function localHoldings() {
  // The LOCAL portfolio is load-bearing: let its failure propagate so callers
  // show an error rather than a false "no balances yet".
  const local = await uiGet('/portfolio');
  return (local.holdings || []).map(h => ({ ...h, remote: false }));
}

/**
 * Holdings at every pinned bank, delivered PER BANK as each answer arrives:
 * `onBatch(list)` fires once per reachable bank. A slow or unreachable bank
 * holds up nothing — its batch simply never lands (its error is swallowed).
 */
async function remoteHoldingsProgressive(onBatch) {
  const banks = await uiGet('/banks').catch(() => []);
  const remotes = (banks || []).filter(b => b.pubkey && b.pubkey !== state.bankPubkey);
  await Promise.all(remotes.map(b =>
    remoteHoldings(b).then(list => { if (list.length) onBatch(list); }).catch(() => {})));
}

async function allHoldings() {
  const local = await localHoldings();
  const out = [...local];
  await remoteHoldingsProgressive(list => out.push(...list));
  return out;
}

// Remember which bank coordinates a deal so the deal screen polls the right
// place (a claimed cheque's deal lives at the voucher's bank, not ours).
function rememberDealBank(dealId, bankRef) {
  try { localStorage.setItem(`barter.dealbank.${dealId}`, JSON.stringify(bankRef)); } catch { /* ignore */ }
}
function dealBankFor(dealId) {
  try {
    const raw = localStorage.getItem(`barter.dealbank.${dealId}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

// ---------------- router ----------------

// Route segment → screen title, so the loading shell can highlight the right
// nav tab while the async screen fetches.
const ROUTE_TITLES = {
  '': 'Dashboard', vouchers: 'Vouchers', orders: 'Orders', invoices: 'Invoices',
  cheques: 'Cheques', registry: 'Registry', activity: 'Activity',
  network: 'Network', scan: 'Scan', settings: 'Settings', deal: 'Deal', posts: 'Posts',
  admin: 'Admin',
};

// route() is a coalescing scheduler: many actions do `location.hash = X; route()`,
// and changing the hash ALSO fires the hashchange listener — so a naive route()
// rendered twice per navigation (and, on the deal screen, armed two pollers).
// Collapsing to one render per microtask fixes that; renderRoute does the work.
let routeQueued = false;
let lastRenderedHash = null;
let dealTimer = null; // the single live deal-refresh timer (see renderDeal)
function route() {
  if (routeQueued) return;
  routeQueued = true;
  // A macrotask (not queueMicrotask): the `location.hash = X` in a handler queues
  // its hashchange as a macrotask, so the coalescing window must span one too —
  // otherwise `hash = X; route()` still renders twice.
  setTimeout(() => { routeQueued = false; renderRoute(); }, 0);
}

function renderRoute() {
  const hash = location.hash.slice(1) || '/';
  const [p, ...rest] = hash.split('/').filter(Boolean);
  const app = document.getElementById('app');
  stopActiveScanner();
  // Any pending deal poll belongs to the screen we're leaving/refreshing — drop
  // it so pollers never stack; renderDeal re-arms exactly one.
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }

  // An in-place refresh (same hash — e.g. the deal screen's 3s self-poll, or a
  // "Retry" button) must NOT flash the skeleton or steal focus; only a genuine
  // navigation does.
  const isRefresh = hash === lastRenderedHash;
  lastRenderedHash = hash;

  if (!isRefresh) {
    if (state.user && p !== 'land') {
      app.innerHTML = header(ROUTE_TITLES[p || ''] || '') +
        `<div class="container"><div class="skeleton" aria-live="polite"><span class="spinner"></span> Loading…</div></div>`;
    } else {
      app.innerHTML = '';
    }
  }

  // After a genuine navigation, move focus to the screen heading so
  // keyboard/screen-reader users land on the new content. Skip on refresh.
  Promise.resolve(dispatch(app, p, rest))
    .then(() => { if (!isRefresh) moveFocusToMain(); })
    .catch(() => {});
}

function dispatch(app, p, rest) {
  // Landing routes work logged-out (they carry the register CTA themselves).
  if (p === 'land' && rest[0] && rest[1]) return renderLanding(app, rest[0], rest[1]);

  if (!state.user) {
    if (p === 'register') return renderRegister(app);
    if (p === 'connect') return renderConnect(app);
    if (p === 'unlock') return renderUnlock(app);
    return renderWelcome(app);
  }

  if (p === 'unlock') return renderUnlock(app);
  probeAdmin(); // fire-and-forget; sets state.isAdmin once per session
  if (p === 'admin') return renderAdmin(app);
  if (p === 'vouchers' && rest[0] === 'new') return renderCreateVoucher(app);
  if (p === 'vouchers' && rest[0]) return renderVoucherDetail(app, rest[0]);
  if (p === 'vouchers') return renderVouchers(app);
  if (p === 'orders' && rest[0] === 'new') return renderCreateOrder(app, rest[1]);
  if (p === 'orders') return renderOrders(app);
  if (p === 'invoices' && rest[0] === 'new') return renderCreateInvoice(app, rest[1]);
  if (p === 'invoices') return renderInvoices(app);
  if (p === 'cheques' && rest[0] === 'new') return renderCreateCheque(app, rest[1]);
  if (p === 'cheques') return renderCheques(app);
  // Discover merged into Home; keep old links working.
  if (p === 'discover') { location.replace('#/'); return; }
  if (p === 'registry') return renderRegistry(app);
  if (p === 'posts') return renderPosts(app, rest[0]);
  if (p === 'deal' && rest[0]) return renderDeal(app, rest[0]);
  if (p === 'activity') return renderActivity(app);
  if (p === 'network') return renderNetwork(app);
  if (p === 'scan') return renderScan(app);
  if (p === 'settings') return renderSettings(app);
  return renderDashboard(app);
}

// Move focus to the first heading of the freshly rendered screen (skipping the
// loading skeleton), making it programmatically focusable first.
function moveFocusToMain() {
  const app = document.getElementById('app');
  if (!app || app.querySelector('.skeleton')) return; // still loading; render will re-focus
  // Don't steal focus from a field a screen just focused on purpose (e.g. the
  // login password input) — that field is where the user needs to be.
  const active = document.activeElement;
  if (active && app.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
  const h = app.querySelector('h1, h2, h3');
  if (!h) return;
  h.setAttribute('tabindex', '-1');
  try { h.focus({ preventScroll: true }); } catch { h.focus(); }
}
window.skipToContent = function() { moveFocusToMain(); };

// ---------------- voucher post feeds (protocol/post-feed.md) ----------------

// There is deliberately no global timeline: a feed is the reader's own trust
// graph. The client merges list_posts(author, voucher) across every followed
// author x every known bank, newest-first, de-duplicated by content hash
// (post-feed.md §7). "Followed" here is the trusted-issuer list plus yourself.
async function feedAuthors() {
  // Follows, NOT trusted issuers: reading someone and vouching for their
  // currency are different decisions. The bank applies the default (follow
  // your own bank) so a brand-new account still has a feed.
  const follows = await uiGet('/follows').catch(() => []);
  const keys = (follows || []).filter(Boolean);
  if (state.user && !keys.includes(state.user.pubkey)) keys.unshift(state.user.pubkey);
  return keys;
}

async function feedBanks() {
  const bases = [{ url: state.bankUrl || state.basePath, pubkey: state.bankPubkey }];
  const pinned = await uiGet('/banks').catch(() => []);
  (pinned || []).forEach(b => {
    if (b.url && !bases.some(x => x.url === b.url)) bases.push({ url: b.url, pubkey: b.pubkey });
  });
  return bases;
}

/**
 * Merge one page from every (author, bank) source. Each source is already
 * newest-first, so a k-way merge by ULID yields a correct global order without
 * the bank doing any cross-author ranking.
 *
 * Every post is signature-checked here — including its embedded ancestors —
 * before it is allowed into the feed. A bank serves what it stored; trusting
 * it to have verified is not the reader's job.
 */
async function loadFeed(voucherFilter, limit = 30) {
  const [authors, banks] = await Promise.all([feedAuthors(), feedBanks()]);
  if (!authors.length) return { posts: [], authors, unreachable: [] };

  const unreachable = [];
  const results = await Promise.all(
    banks.flatMap(b => authors.map(async author => {
      try {
        const r = await rpcCallAt(b.url, b.pubkey, 'list_posts', {
          pubkey: author, voucher_hash: voucherFilter || 'all', limit,
        });
        // Keep the serving bank with each post: its media refs resolve THERE
        // (and copying them is the reposter's job, post-feed.md §5).
        return ((r && r.items) || []).map(p => ({ p, src: b.url }));
      } catch {
        const label = b.url;
        if (!unreachable.includes(label)) unreachable.push(label);
        return [];
      }
    })),
  );

  const byHash = new Map();
  results.flat().forEach(({ p, src }) => {
    let hash;
    try { hash = hashDoc(p); } catch { return; }
    if (byHash.has(hash)) return;
    // Fail closed: an unverifiable post is dropped, not rendered with a warning.
    // Shape is checked as well as signature — a signature only proves the
    // author meant those bytes, not that `voucher` is a hash rather than an
    // array of markup. This is the same validator the bank applies on intake,
    // so an honest bank cannot be storing anything this rejects.
    try { validatePost(p); } catch { return; }
    try { if (!verifyPostTree(p)) return; } catch { return; }
    byHash.set(hash, { post: p, bankUrl: src });
  });

  const posts = [...byHash.entries()]
    .map(([hash, { post, bankUrl }]) => ({ hash, post, bankUrl }))
    .sort((a, b) => (a.post.ulid < b.post.ulid ? 1 : a.post.ulid > b.post.ulid ? -1 : 0));
  return { posts, authors, unreachable };
}

// Markdown is NOT rendered — body_md is escaped and shown as text, with only
// newlines honoured. Rendering author-controlled markdown to HTML would hand
// every post author an injection surface; that is a deliberate omission, not
// an oversight.
function postBody(md) {
  return escapeHtml(String(md || '')).replace(/\n/g, '<br>');
}

/** postAuthorLabel returns "you" for the reader, which does not take an -'s. */
function possessive(label) {
  return label === 'you' ? 'your' : `${label}'s`;
}

function postAuthorLabel(pubkey, names) {
  if (state.user && pubkey === state.user.pubkey) return 'you';
  // A bank has no registered handle, so /ui/resolve never names it — but the
  // bank reposts every user post, so it is the most frequent author in the
  // feed and must not render as raw base58.
  if (pubkey === state.bankPubkey) return state.user ? `${state.bankName} (your bank)` : `${state.bankName} (bank)`;
  return names[pubkey] || pubkey.slice(0, 10) + '…';
}

/**
 * A quoted ancestor, shown as a compact strip under the card it belongs to.
 * It carries a thumbnail (its own first attachment, else its voucher's art) so
 * a conversation still reads as pictures — but small, because the card's own
 * hero is the subject and a quote must never compete with it.
 */
function renderEmbedded(p, names, kind, vMap = {}, ctx = null, bankUrl = null) {
  if (!p) return '';
  const v = vMap[p.voucher] ? ` · ${escapeHtml(vMap[p.voucher])}` : '';
  const thumb = ctx ? quoteThumb(p, bankUrl, ctx) : '';
  return `<div class="quote">
    ${thumb}
    <div style="min-width:0">
      <div class="small">${escapeHtml(kind)} <b>${escapeHtml(postAuthorLabel(p.pubkey, names))}</b>${v}</div>
      <div class="small">${postBody(p.body_md)}</div>
    </div>
  </div>
  ${renderEmbedded(p.reply_to, names, 'in reply to', vMap, ctx, bankUrl)}
  ${renderEmbedded(p.repost, names, 'reposted', vMap, ctx, bankUrl)}`;
}

function quoteThumb(p, bankUrl, ctx) {
  const first = (Array.isArray(p.media) ? p.media : []).find(r => typeof r === 'string' && r);
  const src = first
    ? mediaSrc(bankUrl, first)
    : metaSrc(ctx.vMeta[p.voucher], ctx.vInfo[p.voucher], 'square');
  if (!src) return '';
  return `<img class="quote-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`;
}

/**
 * Render an issuer-supplied SVG.
 *
 * NEVER inline this into the DOM. An SVG can carry <script>, event handlers
 * and <foreignObject>, and the bank reposts every user post — so an inline
 * icon would execute in the session of everyone who follows that bank. A
 * data: URI inside <img> renders the picture with scripting disabled, which
 * is the whole point of doing it this way.
 */
function svgDataUri(svg) {
  if (typeof svg !== 'string' || !svg.trim()) return '';
  // As a standalone document (which a data: URI is) an SVG only renders when
  // its root declares the SVG namespace — hand-typed icons routinely omit it.
  let s = svg;
  if (!/<svg[^>]*\sxmlns=/i.test(s)) {
    s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(s)))}`;
}

function svgImg(svg, size, alt) {
  const url = svgDataUri(svg);
  if (!url) return '';
  return `<img src="${url}" alt="${escapeHtml(alt)}" width="${size}" height="${size}"
    style="width:${size}px;height:${size}px;border-radius:6px;object-fit:contain;flex:0 0 auto">`;
}

// ---------------- media vault (post-feed.md §5) ----------------
// Images live in the bank's content-addressed vault; docs carry refs
// "<hash>.<ext>". The extension makes GET /media/<ref> statically servable
// with the right Content-Type (CDN-friendly); the hash makes it immutable.

const EXT_BY_MIME = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif',
};

function mediaSrc(bankUrl, ref) {
  return `${(bankUrl || state.bankUrl || state.basePath).replace(/\/$/, '')}/media/${ref}`;
}

/** Upload bytes to OUR bank's vault; returns the "<hash>.<ext>" ref. */
async function uploadMediaBytes(bytes, ext) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const body = { data_base64: btoa(bin), ext };
  const authdoc = {
    pubkey: state.user.pubkey, method: 'POST', path: `${state.basePath}/media`,
    id: newUlid(), ts: Date.now(), body_sha256: sha256Base58(JSON.stringify(body)),
  };
  const sig = signDoc(authdoc, state.user.privateKey);
  const token = `${arrayBufferToBase64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${state.basePath}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw bankError(data.code, data.message);
  return data.ref || data.hash;
}

async function uploadMediaFile(file) {
  const ext = EXT_BY_MIME[file.type];
  if (!ext) throw new Error(`Unsupported image type: ${file.type || 'unknown'} — use SVG, PNG, JPEG, WebP or GIF`);
  return uploadMediaBytes(new Uint8Array(await file.arrayBuffer()), ext);
}

/**
 * Make OUR bank hold every media ref an embedded tree commits to, copying
 * missing blobs from the bank the post came from. The accepting bank rejects
 * a post whose blobs it does not hold (post-feed.md §5) — so replying to or
 * reposting a post from another bank starts with this copy step. Content
 * addressing keeps the embedded signatures valid: the same bytes are the same
 * ref at every bank.
 */
async function copyTreeMedia(post, sourceBankUrl) {
  const refs = collectMediaRefs(post);
  if (refs.length > 64) throw new Error('This thread references too many attachments to copy');
  // The parent's serving bank first, then every bank we know — a pre-existing
  // embed may reference blobs its own bank never held (they live where the
  // ORIGINAL post was stored), and content addressing makes any holder a
  // valid source.
  const known = await feedBanks().catch(() => []);
  const sources = [sourceBankUrl, ...known.map(b => b.url)]
    .filter(Boolean).filter((u, i, a) => a.indexOf(u) === i);
  for (const ref of refs) {
    const ours = await fetch(mediaSrc(null, ref))
      .then(r => { if (r.body) r.body.cancel(); return r.ok; }).catch(() => false);
    if (ours) continue;
    let copied = false;
    for (const src of sources) {
      try {
        const res = await fetch(mediaSrc(src, ref));
        if (!res.ok) { if (res.body) res.body.cancel(); continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const dot = ref.lastIndexOf('.');
        // A legacy bare-hash ref carries no extension — take the type the
        // source actually served, never a guess.
        const ext = dot > 0 ? ref.slice(dot + 1)
          : EXT_BY_MIME[(res.headers.get('Content-Type') || '').split(';')[0].trim()];
        if (!ext) throw new Error(`Attachment ${ref.slice(0, 12)}… is not an image type this bank stores`);
        await uploadMediaBytes(bytes, ext);
        copied = true;
        break;
      } catch (e) {
        if (e && /is not an image type/.test(e.message || '')) throw e;
        /* try the next source */
      }
    }
    if (!copied) throw new Error(`Couldn't copy attachment ${ref.slice(0, 12)}… from any bank you know`);
  }
}

/**
 * A voucher's icon/square from its cached meta: prefer the media ref (an
 * immutable vault URL at the voucher's bank), fall back to the legacy inline
 * SVG (rendered via data: URI — never inlined into the DOM).
 */
function metaSrc(meta, info, which) {
  if (!meta) return '';
  const ref = which === 'square' ? (meta.square || meta.icon) : (meta.icon || meta.square);
  if (ref) return mediaSrc(info && info.bank_url, ref);
  const svg = which === 'square' ? (meta.square_svg || meta.icon_svg) : (meta.icon_svg || meta.square_svg);
  return svgDataUri(svg);
}

function metaImg(meta, info, size, which, round = false) {
  const src = metaSrc(meta, info, which);
  if (!src) return '';
  return `<img src="${escapeHtml(src)}" alt="" width="${size}" height="${size}" loading="lazy"
    style="width:${size}px;height:${size}px;border-radius:${round ? '50%' : '6px'};object-fit:cover;flex:0 0 auto">`;
}

/**
 * The hero of a feed card: attachments full-bleed at 1:1, several of them a
 * swipeable strip. A post with no attachment falls back to its voucher's
 * square card image — which is what that image is FOR, and it means every
 * post has something to look at, since a post is always anchored to a voucher.
 *
 * Each slide links to the raw vault URL rather than opening a lightbox: the
 * blob is immutable and public, so a new tab is the whole feature.
 */
function postHero(post, bankUrl, meta, info, alt) {
  const list = (Array.isArray(post.media) ? post.media : []).filter(r => typeof r === 'string' && r);
  const attached = list.length > 0;
  // NOTE: `post` here is the post the picture comes from, which on a commented
  // repost is deeper than the card's subject — see postCard.
  const srcs = attached
    ? list.map(r => mediaSrc(bankUrl, r))
    : [metaSrc(meta, info, 'square')].filter(Boolean);
  if (!srcs.length) return '';
  // The picture IS the post here, so it needs a real text alternative — and it
  // must say whether it is the author's photo or the voucher's stand-in card.
  const label = attached ? alt.photo : alt.card;
  const slides = srcs.map((s, i) => {
    const a = escapeHtml(srcs.length > 1 ? `${label} (${i + 1} of ${srcs.length})` : label);
    const img = `<img src="${escapeHtml(s)}" alt="${a}" loading="lazy" decoding="async">`;
    // Legacy inline artwork is a data: URI, and browsers refuse a top-level
    // navigation to one — a link there is a link that does nothing.
    return s.startsWith('data:')
      ? img
      : `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer">${img}</a>`;
  }).join('');
  const dots = srcs.length > 1
    ? `<div class="post-dots">${srcs.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>`
    : '';
  return `<div class="post-media"><div class="post-strip">${slides}</div>${dots}</div>`;
}

// Scroll does not bubble, so the strip indicator is driven from one capturing
// listener instead of a handler per card (a feed renders dozens).
document.addEventListener('scroll', (e) => {
  const strip = e.target;
  if (!strip || !strip.classList || !strip.classList.contains('post-strip')) return;
  const dots = strip.parentElement && strip.parentElement.querySelector('.post-dots');
  if (!dots) return;
  const i = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth));
  Array.from(dots.children).forEach((d, j) => d.classList.toggle('on', j === i));
}, true);

/**
 * One card in the feed, shaped like a photo feed: attribution, the picture at
 * full width, then caption and actions beneath it.
 *
 * A repost's SUBJECT is the post being reposted — the reposter is demoted to a
 * ribbon. Banks auto-repost everything their users publish, so without this
 * hoist a new account (which follows only its bank) would see a wall of grey
 * quote boxes with every picture buried one level down.
 */
function postCard(entry, ctx) {
  const { hash, post, bankUrl } = entry;
  const { names, vMap, vMeta, vInfo, followSet } = ctx;
  // Hoist ONLY through pure amplification. A repost that adds words or pictures
  // of its own is somebody speaking, and their post is the card; a repost that
  // adds nothing is a delivery mechanism, and the original is the card.
  let subject = post;
  while (!postAdds(subject) && subject.repost) subject = subject.repost;
  // Act on what the card SHOWS. The subject arrived embedded and fully signed,
  // so remember it by hash: replying to it needs no round-trip, and it works
  // even at a bank that stores it only inside its parent.
  let actOn = hash;
  if (subject !== post) {
    try {
      actOn = hashDoc(subject);
      embeddedPosts.set(actOn, { post: subject, bankUrl });
    } catch { actOn = hash; }
  }
  // The picture is whatever the card is POINTING AT. Someone who reposts with
  // "look at this" and no photo of their own is pointing at the original's
  // photos; showing the voucher's generic card art there would be a downgrade.
  let art = subject;
  while (!hasMedia(art) && art.repost) art = art.repost;
  const meta = vMeta[subject.voucher];
  const info = vInfo[subject.voucher];
  const vName = vMap[subject.voucher] || String(subject.voucher || '').slice(0, 10) + '…';
  return `<div class="card post">
    ${subject === post ? '' : `<div class="post-ribbon small">↻ ${escapeHtml(postAuthorLabel(post.pubkey, names))} reposted</div>`}
    <div class="post-head">
      ${metaImg(meta, info, 38, 'icon', true)}
      <div style="min-width:0">
        <div><b>${escapeHtml(postAuthorLabel(subject.pubkey, names))}</b></div>
        <div class="small"><a href="#/posts/${escapeHtml(subject.voucher)}">${escapeHtml(vName)}</a>${subject.voucher_meta ? ' · new look' : ''}</div>
      </div>
    </div>
    ${postHero(art, bankUrl, meta, info, {
      photo: `Photo from ${possessive(postAuthorLabel(art.pubkey, names))} post about ${vName}`,
      card: `Card image for ${vName}`,
    })}
    <div class="post-body">
      ${subject.body_md ? `<div>${postBody(subject.body_md)}</div>` : ''}
      ${renderEmbedded(subject.reply_to, names, 'in reply to', vMap, ctx, bankUrl)}
      ${renderEmbedded(subject.repost, names, 'reposted', vMap, ctx, bankUrl)}
      <div class="flex" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap">
        ${ctx.readOnly
          ? `<a class="btn" href="#/register">Create an identity to reply or trade</a>`
          : `<button class="btn secondary" onclick="startReply('${jsStr(actOn)}')">Reply</button>
        <button class="btn secondary" onclick="repostPost('${jsStr(actOn)}')">Repost</button>
        ${followTarget(subject, followSet)}
        ${wantTarget(subject, vMap)}`}
      </div>
    </div>
  </div>`;
}

/** hash → the full signed post + the bank it was served from. Rebuilt per feed render. */
const embeddedPosts = new Map();

function hasMedia(post) {
  return Array.isArray(post.media) && post.media.some(r => typeof r === 'string' && r);
}

/** Did this post contribute anything of its own, or is it pure amplification? */
function postAdds(post) {
  return !!(String(post.body_md || '').trim() || hasMedia(post));
}

/**
 * Drop a PURE repost — one that adds neither words nor pictures of its own,
 * like the bank's automatic one — when its original is already in the feed.
 * Following your bank and the people on it is the normal case, and it would
 * otherwise show the same picture twice in a row. A repost that says or shows
 * something stays, even with the original right above it.
 */
function dedupeReposts(posts) {
  const present = new Set(posts.map(e => e.hash));
  return posts.filter(({ post }) => {
    if (postAdds(post)) return true;
    for (let inner = post.repost; inner; inner = inner.repost) {
      let h;
      try { h = hashDoc(inner); } catch { return true; }
      if (present.has(h)) return false;
    }
    return true;
  });
}

/**
 * "Follow author" points at the person whose post you are LOOKING AT — which,
 * on a bank's repost, is the original author and not the bank you already
 * follow. If you already follow them, offer whoever they were answering
 * instead: a thread is how you meet the next person.
 */
function followTarget(subject, followSet) {
  const candidates = [
    subject.pubkey,
    subject.reply_to && subject.reply_to.pubkey,
    subject.repost && subject.repost.pubkey,
  ];
  for (const pk of candidates) {
    if (!pk || followSet.has(pk)) continue;
    if (state.user && pk === state.user.pubkey) continue;
    return `<button class="btn secondary" onclick="followAuthor('${jsStr(pk)}')">Follow author</button>`;
  }
  return '';
}

/**
 * "Trade for this" — the action a post about a voucher is FOR. Without it a
 * reader had to memorise the voucher, find its issuer's pubkey elsewhere,
 * trust them by hand, then go and build an order: nothing linked the feed to
 * the trade.
 *
 * Offered on any post whose voucher we could resolve, except your own
 * currency (you cannot swap a voucher for itself).
 */
function wantTarget(post, vMap) {
  const h = post.voucher;
  if (!h || !vMap[h]) return '';
  const info = (window.__feedVouchers || {})[h];
  if (info && state.user && info.issuer === state.user.pubkey) return '';
  return `<button class="btn" onclick="wantVoucher('${jsStr(h)}')">Trade for this</button>`;
}

/**
 * Make the advertised voucher usable, then open a swap preloaded with it.
 *
 * Trusting the issuer is what puts a voucher into `knownVouchers()`, which is
 * what the order form's choosers are built from — so without this step the
 * thing you just read about is not even selectable. Pins the issuer's bank too
 * when it is not ours, or the deal cannot be addressed later.
 */
window.wantVoucher = async function(voucherHash) {
  const info = (window.__feedVouchers || {})[voucherHash];
  if (!info) { toast('Could not resolve that voucher', 'error'); return; }
  try {
    await uiPost('/trusted', { pubkey: info.issuer, note: 'from a post' }).catch(() => {});
    if (info.bank && info.bank !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: info.bank, url: info.bank_url }).catch(() => {});
    }
  } catch { /* trusting is best-effort; the form still opens */ }
  location.hash = `#/orders/new/${voucherHash}`;
  route();
};

/**
 * Everything a feed-driven screen needs, assembled once: the merged feed,
 * display names, and per-voucher {name, issuer, bank, meta}. Shared by the
 * Posts screen and Discover — both are views over the same follows graph.
 */
async function buildFeedContext(voucherFilter) {
  let vouchers = [];
  let feed = { posts: [], authors: [], unreachable: [] };
  let failed = false;
  try {
    [vouchers, feed] = await Promise.all([knownVouchers().catch(() => []), loadFeed(voucherFilter)]);
  } catch { failed = true; }

  // Resolve labels for EVERY pubkey and voucher the feed actually mentions —
  // not just the reader's own trust list. A repost embeds a post by someone the
  // reader may not follow, and it anchors to a voucher the reader may not hold;
  // both would otherwise render as raw base58.
  const mentionedAuthors = new Set(feed.authors);
  const mentionedVouchers = new Set();
  const walk = p => {
    if (!p) return;
    if (p.pubkey) mentionedAuthors.add(p.pubkey);
    if (p.voucher) mentionedVouchers.add(p.voucher);
    walk(p.reply_to);
    walk(p.repost);
  };
  feed.posts.forEach(({ post }) => walk(post));

  const names = {};
  // A bank has no registered handle, so /ui/resolve never names one. Every
  // pinned bank reposts its own users, so an unnamed foreign bank is the most
  // frequent author in a cross-bank feed — and would read as raw base58.
  const feedBankList = await feedBanks().catch(() => []);
  const bankNames = (await Promise.all(feedBankList.map(async b => {
    if (!b.pubkey || b.pubkey === state.bankPubkey) return null;
    try {
      const info = await fetch(`${b.url}/barter-bank.json`).then(r => r.json());
      if (!info || !info.name) return null;
      return { pubkey: b.pubkey, name: info.name, host: new URL(b.url).host.split('.')[0] };
    } catch { return null; } // unreachable bank: fall back to base58
  }))).filter(Boolean);
  bankNames.forEach(b => {
    // The same bank name runs on more than one deployment, so say which host
    // when the name alone would point at two different banks.
    const twins = bankNames.filter(o => o.name === b.name).length > 1;
    names[b.pubkey] = twins ? `${b.name} (bank at ${b.host})` : `${b.name} (bank)`;
  });
  const bases = await issuerResolveBases().catch(() => []);
  await Promise.all([...mentionedAuthors].map(async pk => {
    if (state.user && pk === state.user.pubkey) return;
    const r = await resolveIssuerAt(bases, pk).catch(() => null);
    if (r && r.handle) names[pk] = r.handle;
  }));

  const vMap = {};
  // vInfo carries the issuer and bank as well as the name, because acting on a
  // post ("I want that voucher") means trusting the voucher's ISSUER — who is
  // not necessarily the post's author. A reply or a bank repost is anchored to
  // someone else's voucher.
  const vInfo = {};
  vouchers.forEach(v => { vMap[v.hash] = v.name; });
  const knownBanks = await feedBanks().catch(() => []);
  await Promise.all([...mentionedVouchers].map(async h => {
    for (const b of knownBanks) {
      try {
        const v = await rpcCallAt(b.url, b.pubkey, 'get_voucher', { voucher_hash: h });
        if (v && v.name) {
          if (!vMap[h]) vMap[h] = v.name;
          vInfo[h] = { name: v.name, issuer: v.pubkey, bank: b.pubkey, bank_url: b.url };
          return;
        }
      } catch { /* this bank does not carry it */ }
    }
  }));
  window.__feedVouchers = vInfo;

  // One cheap read per voucher for its current presentation — the bank keeps
  // the latest release cached (or synthesizes it from the Voucher's own
  // images), so no feed scanning is needed.
  const vMeta = {};
  await Promise.all([...mentionedVouchers].map(async h => {
    const info = vInfo[h];
    if (!info) return;
    try {
      const m = await rpcCallAt(info.bank_url, info.bank, 'get_voucher_meta', { voucher_hash: h });
      if (m) vMeta[h] = m;
    } catch { /* no meta released */ }
  }));

  return { vouchers, feed, failed, names, vMap, vInfo, vMeta };
}

async function renderPosts(app, voucherFilter) {
  app.innerHTML = header('Posts') + `<div class="container"><p class="small">Loading feed…</p></div>`;

  const { vouchers, feed, failed, names, vMap, vMeta, vInfo } = await buildFeedContext(voucherFilter);
  const selected = voucherFilter && vMap[voucherFilter] ? voucherFilter : '';

  const filterBar = `<div class="card">
    <label for="feed-voucher">Feed</label>
    <select id="feed-voucher" onchange="onFeedFilterChange()">
      <option value=""${selected ? '' : ' selected'}>Everything from people I follow</option>
      ${vouchers.map(v => `<option value="${escapeHtml(v.hash)}"${v.hash === selected ? ' selected' : ''}>${escapeHtml(v.name)} — ${escapeHtml(v.issuer)}</option>`).join('')}
    </select>
    <p class="small">Posts are anchored to a voucher. You see the people you <a href="#/network">follow</a> — there is no global timeline. You follow your bank by default, and it reposts what its users publish.</p>
  </div>`;

  const mine = vouchers.filter(v => v.issuer === 'you');
  const composer = vouchers.length
    ? `<div class="card">
        <h3>Say something</h3>
        <label for="post-voucher">About which voucher</label>
        ${voucherChooser('post-voucher', vouchers, selected || vouchers[0].hash)}
        <label for="post-body">Post</label>
        <textarea id="post-body" rows="3" placeholder="Redeem at booth 12 all Saturday…"></textarea>
        <label for="post-files">Attach images <span class="small">(optional — stored by hash in the bank's vault)</span></label>
        <input type="file" id="post-files" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif" multiple>
        <div class="small" id="post-reply-note"></div>
        ${mine.length ? `
        <label><input type="checkbox" id="post-meta" onchange="toggleMetaFields()">
          Also update this voucher's look and description</label>
        <div id="post-meta-fields" style="display:none">
          <p class="small">Only you can restyle a voucher you issue. The text above becomes its description, and the newest release wins — the voucher itself never changes, so balances denominated in it are untouched. Images are uploaded to the vault and referenced by hash.</p>
          <label for="post-icon-file">Icon <span class="small">(small round mark — SVG or PNG)</span></label>
          <input type="file" id="post-icon-file" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif">
          <label for="post-square-file">Square card image</label>
          <input type="file" id="post-square-file" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif">
        </div>` : ''}
        <button class="btn" id="post-submit" onclick="submitPost()">Post</button>
        <div class="error" id="post-err"></div>
      </div>`
    : card('Nothing to post about yet', `
        <p class="small">A post is anchored to a voucher. Mint one, or trust an issuer, and you can post about it.</p>
        <a class="btn secondary" href="#/vouchers/new">Mint a voucher</a>`);

  const followSet = new Set(feed.authors);
  const ctx = { names, vMap, vMeta, vInfo, followSet };
  embeddedPosts.clear();
  const shown = dedupeReposts(feed.posts);
  const list = shown.length
    ? shown.map(entry => postCard(entry, ctx)).join('')
    : `<div class="card"><p class="small">No posts yet from you or the issuers you trust${selected ? ' about this voucher' : ''}.</p></div>`;

  const warn = feed.unreachable.length
    ? `<div class="card"><p class="small">Couldn't reach: ${feed.unreachable.map(escapeHtml).join(', ')}</p></div>`
    : '';

  app.innerHTML = header('Posts') + `<div class="container">
    <div class="feed">${failed ? loadError('the feed') : `${filterBar}${composer}${warn}${list}`}</div>
  </div>`;
}

window.toggleMetaFields = function() {
  const on = document.getElementById('post-meta').checked;
  document.getElementById('post-meta-fields').style.display = on ? '' : 'none';
};

window.onFeedFilterChange = function() {
  const v = document.getElementById('feed-voucher').value;
  location.hash = v ? `#/posts/${v}` : '#/posts';
  route();
};

// The post being replied to / reposted, kept out of the DOM so the embedded
// parent is the exact signed object the bank returned.
let pendingParent = null;

async function fetchPostByHash(hash) {
  // Posts the feed already holds in full because they arrived embedded in a
  // repost. A bank may store such a post ONLY inside its parent, so this is
  // not merely a cache — without it, replying to a reposted post can fail.
  const held = embeddedPosts.get(hash);
  if (held) return held;
  const banks = await feedBanks();
  for (const b of banks) {
    try {
      const p = await rpcCallAt(b.url, b.pubkey, 'get_post', { post_hash: hash });
      // The serving bank travels with the post: its media refs resolve there,
      // and a reply/repost must copy those blobs to OUR bank before submit.
      if (p) return { post: p, bankUrl: b.url };
    } catch { /* try the next bank */ }
  }
  return null;
}

window.startReply = async function(hash) {
  const found = await fetchPostByHash(hash);
  if (!found) return toast('Could not load that post', 'error');
  const parent = found.post;
  pendingParent = { kind: 'reply_to', post: parent, bankUrl: found.bankUrl };
  const note = document.getElementById('post-reply-note');
  if (note) note.innerHTML = `Replying to <b>${escapeHtml((parent.body_md || '').slice(0, 60))}</b> — <a href="#" onclick="clearParent();return false">cancel</a>`;
  const sel = document.getElementById('post-voucher');
  if (sel) sel.value = parent.voucher;
  const body = document.getElementById('post-body');
  if (body) body.focus();
};

window.repostPost = async function(hash) {
  const found = await fetchPostByHash(hash);
  if (!found) return toast('Could not load that post', 'error');
  const parent = found.post;
  pendingParent = { kind: 'repost', post: parent, bankUrl: found.bankUrl };
  const note = document.getElementById('post-reply-note');
  if (note) note.innerHTML = `Reposting <b>${escapeHtml((parent.body_md || '').slice(0, 60))}</b> — <a href="#" onclick="clearParent();return false">cancel</a>`;
  const sel = document.getElementById('post-voucher');
  if (sel) sel.value = parent.voucher;
  const body = document.getElementById('post-body');
  if (body) body.focus();
};

window.addFollow = async function() {
  const el = document.getElementById('n-follow-pk');
  const pk = (el.value || '').trim();
  if (!pk) return toast('Enter a pubkey', 'error');
  await window.followAuthor(pk);
};
window.followAuthor = async function(pubkey) {
  try { await uiPost('/follows', { pubkey }); toast('Following'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.unfollowAuthor = async function(pubkey) {
  try { await signedRequest('DELETE', `/follows/${pubkey}`, null); toast('Unfollowed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};

window.clearParent = function() {
  pendingParent = null;
  const note = document.getElementById('post-reply-note');
  if (note) note.textContent = '';
};

window.submitPost = async function() {
  const err = document.getElementById('post-err');
  const btn = document.getElementById('post-submit');
  err.textContent = '';
  const voucher = document.getElementById('post-voucher').value;
  const body = document.getElementById('post-body').value.trim();
  // A repost may carry no commentary of its own (post-feed.md §4); a plain
  // post or reply must say something.
  if (!body && !(pendingParent && pendingParent.kind === 'repost')) {
    err.textContent = 'Write something first'; return;
  }
  if (!voucher) { err.textContent = 'Pick a voucher to anchor this post to'; return; }

  const release = lockBtn(btn);
  try {
    const post = {
      type: 'post', pubkey: state.user.pubkey, ulid: newUlid(),
      voucher, body_md: body,
    };
    if (pendingParent) {
      post[pendingParent.kind] = pendingParent.post;
      // Our bank rejects a post whose embedded tree references blobs it does
      // not hold — copy them over from the parent's bank first (§5).
      await copyTreeMedia(pendingParent.post, pendingParent.bankUrl);
    }
    // Attachments upload first; the post then carries their refs.
    const filesEl = document.getElementById('post-files');
    const files = filesEl ? [...(filesEl.files || [])] : [];
    if (files.length) {
      post.media = [];
      for (const f of files) post.media.push(await uploadMediaFile(f));
    }
    const metaBox = document.getElementById('post-meta');
    if (metaBox && metaBox.checked) {
      const iconFile = (document.getElementById('post-icon-file').files || [])[0];
      const squareFile = (document.getElementById('post-square-file').files || [])[0];
      if (!iconFile && !squareFile && !body) {
        err.textContent = 'Add an image or a description to release meta'; release(); return;
      }
      post.voucher_meta = true;
      if (iconFile) post.icon = await uploadMediaFile(iconFile);
      if (squareFile) post.square = await uploadMediaFile(squareFile);
    }
    post.sig = signDoc(post, state.user.privateKey);
    await rpcCall('submit_docs', { docs: [post] });
    pendingParent = null;
    toast('Posted');
    route();
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

// Keyboard handling for the mobile sheet/drawer (registered once): Escape
// closes and restores focus; Tab is trapped inside the open sheet.
document.addEventListener('keydown', (e) => {
  const s = document.getElementById('new-sheet');
  const sheetOpen = s && s.classList.contains('open');
  if (e.key === 'Escape') {
    if (sheetOpen) { closeSheets(); const b = document.querySelector('.bn-new'); if (b) b.focus(); return; }
    const nav = document.getElementById('mainnav');
    if (nav && nav.classList.contains('open')) {
      nav.classList.remove('open');
      const btn = document.querySelector('.nav-toggle');
      if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
    }
    return;
  }
  if (e.key === 'Tab' && sheetOpen) {
    const items = s.querySelectorAll('.sheet-item');
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

window.addEventListener('hashchange', route);
// Exposed so inline "Retry"/"Refresh" controls can re-render the current screen
// in place (no full page reload, which would wipe the in-memory key).
window.route = route;

// ---------------- UI components ----------------

function header(title) {
  const on = (t) => title === t ? ' class="active"' : '';
  // A visually-hidden screen heading: gives every screen (the list screens have
  // no other heading) an <h1> for the router's focus-to-heading + skip-link to
  // land on, and announces the screen name to screen readers.
  return `<a href="#" class="skip-link" onclick="skipToContent();return false">Skip to content</a>
  <h1 class="sr-only">${escapeHtml(title || 'barter.game')}</h1>
  <div class="header">
    <div class="brand">
      <div class="logo-mark"><span></span></div>
      <div><strong>${escapeHtml(state.bankName)}</strong> <span class="mono small">${escapeHtml(state.user?.pubkey.slice(0, 12) || '')}…</span></div>
    </div>
    <nav class="nav" id="mainnav" aria-label="Primary">
      <a href="#/"${on('Dashboard')}>Home</a>
      <a href="#/vouchers"${on('Vouchers')}>Vouchers</a>
      <a href="#/orders"${on('Orders')}>Orders</a>
      <a href="#/invoices"${on('Invoices')}>Invoices</a>
      <a href="#/cheques"${on('Cheques')}>Cheques</a>
      <a href="#/posts"${on('Posts')}>Posts</a>
      <a href="#/registry"${on('Registry')}>Registry</a>
      <a href="#/activity"${on('Activity')}>Activity</a>
      <a href="#/network"${on('Network')}>Network</a>
      <a href="#/scan"${on('Scan')}>Scan</a>
      ${state.isAdmin ? `<a href="#/admin"${on('Admin')}>Admin</a>` : ''}
      <a href="#/settings"${on('Settings')}>Settings</a>
      <a href="#/unlock" class="logout" onclick="logout();return false">Log out</a>
    </nav>
    <div class="header-actions">
      <button class="btn secondary nav-toggle" onclick="toggleNav()" aria-controls="mainnav" aria-expanded="false" aria-label="Open menu">Menu</button>
    </div>
  </div>
  ${bottomNav(title)}
  <main id="main-region">`;
  // NOTE: the <main> is intentionally left open — each screen appends its
  // content right after header(), so the content becomes main's children and
  // the parser auto-closes main at the end of #app. This wraps the screen body
  // (not the nav) in a single main landmark without touching every render.
}

// Persistent mobile bottom bar (quick access) + the "New" action sheet. Hidden
// on desktop via CSS; the top nav collapses into the Menu drawer on small
// screens for the full screen list.
function bottomNav(title) {
  const act = (t) => title === t ? ' active' : '';
  const ic = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    voucher: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.2a2.3 2.3 0 0 0 0 5.6V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.2a2.3 2.3 0 0 0 0-5.6z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/></svg>',
  };
  return `
  <div class="sheet-overlay" id="new-sheet" onclick="if(event.target===this)closeSheets()">
    <div class="sheet" role="menu" aria-label="Create new">
      <div class="sheet-title">Create</div>
      <a href="#/invoices/new" class="sheet-item" role="menuitem" onclick="closeSheets()">Invoice <span class="small">request a payment</span></a>
      <a href="#/cheques/new" class="sheet-item" role="menuitem" onclick="closeSheets()">Cheque <span class="small">send someone funds</span></a>
      <a href="#/orders/new" class="sheet-item" role="menuitem" onclick="closeSheets()">Swap <span class="small">trade one voucher for another</span></a>
      <a href="#/vouchers/new" class="sheet-item" role="menuitem" onclick="closeSheets()">Voucher <span class="small">mint your own</span></a>
      <button class="sheet-item cancel" onclick="closeSheets()">Cancel</button>
    </div>
  </div>
  <nav class="bottomnav" aria-label="Quick actions">
    <a href="#/" class="bn-item${act('Dashboard')}">${ic.home}<span>Home</span></a>
    <a href="#/vouchers" class="bn-item${act('Vouchers')}">${ic.voucher}<span>Vouchers</span></a>
    <button class="bn-item bn-new" onclick="toggleNewSheet(event)" aria-haspopup="true" aria-label="Create new">${ic.plus}<span>New</span></button>
    <a href="#/scan" class="bn-item${act('Scan')}">${ic.scan}<span>Scan</span></a>
  </nav>`;
}

window.toggleNav = function() {
  const nav = document.getElementById('mainnav');
  const btn = document.querySelector('.nav-toggle');
  if (!nav) return;
  const open = nav.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
};
window.toggleNewSheet = function(e) {
  if (e) e.stopPropagation();
  const s = document.getElementById('new-sheet');
  if (!s) return;
  const opening = !s.classList.contains('open');
  // Only one overlay at a time: opening the sheet closes the Menu drawer.
  const nav = document.getElementById('mainnav');
  if (nav) nav.classList.remove('open');
  const navBtn = document.querySelector('.nav-toggle');
  if (navBtn) navBtn.setAttribute('aria-expanded', 'false');
  s.classList.toggle('open', opening);
  const newBtn = document.querySelector('.bn-new');
  if (newBtn) newBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  if (opening) {
    const first = s.querySelector('.sheet-item');
    if (first) first.focus();
  } else if (newBtn) {
    newBtn.focus(); // restore focus to the trigger on close
  }
};
window.closeSheets = function() {
  const s = document.getElementById('new-sheet');
  if (s) s.classList.remove('open');
  const nav = document.getElementById('mainnav');
  if (nav) nav.classList.remove('open');
  const navBtn = document.querySelector('.nav-toggle');
  if (navBtn) navBtn.setAttribute('aria-expanded', 'false');
  const newBtn = document.querySelector('.bn-new');
  if (newBtn) newBtn.setAttribute('aria-expanded', 'false');
};

function card(title, body) { return `<div class="card"><h3>${escapeHtml(title)}</h3>${body}</div>`; }

// A "couldn't load" state, distinct from a genuine empty state — a bank outage,
// timeout, or clock-skew auth failure must never read as "you have nothing".
function loadError(what) {
  return `<div class="small error">Couldn't load ${escapeHtml(what)} — the bank may be unreachable. <button class="btn secondary" onclick="route()">Retry</button></div>`;
}

// Progressive section loading. Screens that collect data across MULTIPLE banks
// paint their shell immediately and fill each placeholder as its data arrives:
// a slow or unreachable pinned bank must never hold up the rest of the screen.
// A fill landing after the user navigated away finds no element and is a no-op.
const SECTION_SPINNER = '<p class="small"><span class="spinner"></span> Loading…</p>';
function fillSection(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// Escapes AFTER stringifying, never before: a value that is not a string is
// exactly the case worth escaping — an array of attacker-chosen strings
// stringifies to raw quotes and would break straight out of an attribute.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape a value for embedding as a single-quoted JS string literal INSIDE a
// double-quoted HTML attribute (e.g. onclick="fn('${jsStr(x)}')"). The browser
// HTML-decodes the attribute first, then the JS engine parses it, so we must
// survive both passes: backslash-escape for JS (so quotes/newlines can't break
// out of the string after decoding) and HTML-encode the attribute delimiters.
// Prefer data-* attributes + addEventListener for new code; this guards the
// remaining inline handlers that carry attacker-influenced strings.
function jsStr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/</g, '\\x3C')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `small ${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  t.style.cssText = 'position:fixed;bottom:1rem;right:1rem;background:var(--card);padding:0.75rem 1rem;border:1px solid var(--border);border-radius:0.5rem;z-index:100';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------------- session persistence ----------------
// The decrypted seed is mirrored into sessionStorage so a page refresh keeps
// the session. sessionStorage is the right lifetime: it survives reloads but
// dies with the tab, never crosses origins, and logout/auto-lock clears it.
// (localStorage would outlive a browser restart — too long-lived for a raw
// key.) The bank still only ever sees the PBKDF2+AES-GCM ciphertext.
const SESSION_KEY = `barter.session.${state.bankName}`;
function saveSession(handle, seed) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ handle, seed: base58Encode(seed) })); } catch { /* ignore */ }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
function restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const { handle, seed } = JSON.parse(raw);
    const privateKey = base58Decode(seed);
    if (typeof handle !== 'string' || privateKey.length !== 32) return false;
    const { pubkeyBase58 } = publicKeyOf(privateKey);
    state.user = { handle, pubkey: pubkeyBase58, privateKey };
    return true;
  } catch { return false; }
}

// Drops the decrypted key from memory and session storage, and returns to the
// login screen. There is no server session to end, so this is the whole of
// "logging out".
window.logout = function() {
  state.user = null;
  state.uiState = null;
  state.isAdmin = undefined;
  clearSession();
  location.hash = '#/unlock';
  route();
};
// Kept as an alias: the idle timer below still "locks" the session, and any
// older handler referencing lock() keeps working.
window.lock = window.logout;

// ---------------- screens ----------------

async function renderWelcome(app) {
  const cfg = await fetchConfig().catch(() => null);
  // The feed IS the landing: like the authenticated home, the post stream is
  // the main content. The pitch shrinks to a compact header with the sign-up
  // and login actions; the posts make the argument.
  app.innerHTML = `<div class="container">
    <div class="card" style="margin-top:1.2rem">
      <div class="flex" style="justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
        <div class="flex" style="align-items:center;gap:.7rem;min-width:0">
          <div class="logo-mark"><span></span></div>
          <div style="min-width:0">
            <div style="font-weight:700">Mint your own currency.</div>
            <div class="small">A currency only you can issue — settled with people who already trust you.</div>
          </div>
        </div>
        <div class="flex" style="gap:.5rem;flex-wrap:wrap">
          <a class="btn" href="#/register">Create an identity</a>
          <a class="btn secondary" href="#/unlock">Log in</a>
        </div>
      </div>
      ${cfg ? `<div class="small" style="margin-top:.8rem">Connected to <b>${escapeHtml(cfg.name)}</b> · <span class="mono">${escapeHtml(cfg.pubkey.slice(0, 16))}…</span> · protocol v1</div>` : ''}
      <div class="small" style="margin-top:.4rem"><a href="#/connect">I have a raw key instead</a> · handle + password login · key encrypted in this browser, never sent to the bank</div>
    </div>
    ${installSlot('banner')}
  </div>
  <div class="container" id="public-feed"></div>`;
  // A slow or empty feed never delays the landing itself.
  loadPublicFeed().catch(() => {});
}

/**
 * The logged-out landing shows the bank's own feed — its auto-reposts of the
 * user posts it accepted, which is the curated public face of the bank
 * (post-feed.md). Served unsigned at /ui/feed; every post is still
 * signature-verified here before it renders, exactly like the logged-in
 * feed. An empty or unreachable feed simply leaves the hero alone.
 */
async function loadPublicFeed() {
  const slot = document.getElementById('public-feed');
  if (!slot) return;
  const res = await fetch(`${state.basePath}/ui/feed`)
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!res || !Array.isArray(res.items) || !res.items.length) return;

  // Fail closed, same as loadFeed: shape AND signature, embedded trees too.
  const entries = [];
  const seen = new Set();
  for (const p of res.items) {
    let hash;
    try { hash = hashDoc(p); } catch { continue; }
    if (seen.has(hash)) continue;
    seen.add(hash);
    try { validatePost(p); } catch { continue; }
    try { if (!verifyPostTree(p)) continue; } catch { continue; }
    entries.push({ hash, post: p, bankUrl: state.basePath });
  }
  if (!entries.length) return;

  // Handle labels for every mentioned author via the public resolve route.
  const mentionedAuthors = new Set();
  const walk = p => {
    if (!p) return;
    if (p.pubkey) mentionedAuthors.add(p.pubkey);
    walk(p.reply_to);
    walk(p.repost);
  };
  entries.forEach(e => walk(e.post));
  const names = {};
  await Promise.all([...mentionedAuthors].map(async pk => {
    if (pk === state.bankPubkey) return;
    try {
      const r = await fetch(`${state.basePath}/ui/resolve/${pk}`)
        .then(x => (x.ok ? x.json() : null));
      if (r && r.handle) names[pk] = r.handle;
    } catch { /* base58 fallback */ }
  }));

  // Voucher names/issuers and released meta ride along in the feed response.
  const vMap = {}, vInfo = {}, vMeta = {};
  Object.entries(res.vouchers || {}).forEach(([h, v]) => {
    if (v && v.name) {
      vMap[h] = v.name;
      vInfo[h] = { name: v.name, issuer: v.pubkey, bank: state.bankPubkey, bank_url: state.bankUrl || state.basePath };
    }
  });
  Object.entries(res.meta || {}).forEach(([h, m]) => { if (m) vMeta[h] = m; });

  embeddedPosts.clear();
  const ctx = { names, vMap, vMeta, vInfo, followSet: new Set(), readOnly: true };
  const cards = dedupeReposts(entries).map(e => postCard(e, ctx)).join('');
  if (!cards) return;

  // The same shelf the authenticated home shows under its feed: every voucher
  // sighted in the stream, as a tile. Logged-out, the trade action becomes the
  // sign-up call to action.
  const seenVouchers = [];
  const seenV = new Set();
  const noteVoucher = p => {
    if (!p) return;
    if (p.voucher && !seenV.has(p.voucher)) { seenV.add(p.voucher); seenVouchers.push(p.voucher); }
    noteVoucher(p.reply_to);
    noteVoucher(p.repost);
  };
  entries.forEach(e => noteVoucher(e.post));
  const shelf = seenVouchers.map(h => {
    const info = vInfo[h];
    if (!info) return '';
    const meta = vMeta[h];
    const desc = meta && meta.description_md
      ? `<p class="small">${escapeHtml(meta.description_md.slice(0, 160))}${meta.description_md.length > 160 ? '…' : ''}</p>` : '';
    const art = metaSrc(meta, info, 'square');
    return `<div class="card tile">
      ${art ? `<div class="tile-art"><img src="${escapeHtml(art)}" alt="" loading="lazy" decoding="async"></div>` : ''}
      <div class="tile-body">
        <div><strong>${escapeHtml(info.name)}</strong></div>
        <div class="small">issued by <b>${escapeHtml(postAuthorLabel(info.issuer, names))}</b></div>
        ${desc}
        <div class="flex" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap">
          <a class="btn" href="#/register">Create an identity to trade</a>
        </div>
      </div>
    </div>`;
  }).filter(Boolean).join('');

  slot.innerHTML = `<h3 style="margin-top:1.4rem">Latest from ${escapeHtml(state.bankName)}</h3>
    <p class="small">What this bank's members are posting — every card is one the bank chose to repost, so there is no spam. <a href="#/register">Create an identity</a> to reply or trade.</p>
    <div class="feed">${cards}</div>
    ${shelf ? `<h3 style="margin-top:2rem">Vouchers in this feed</h3>
      <p class="small">Everything above, as a shelf.</p><div class="tile-grid">${shelf}</div>` : ''}`;
}

const MIN_PASSWORD = 8;

function renderRegister(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Create account', `
      <form id="r-form" onsubmit="doRegister();return false">
      <label for="r-handle">Handle <span class="small">(2–32 chars: a–z, 0–9, _ or -)</span></label>
      <input id="r-handle" name="username" autocomplete="username" placeholder="alice">
      <label for="r-pass">Password <span class="small">(${MIN_PASSWORD}+ characters — there is no recovery, so make it strong and save it)</span></label>
      <input id="r-pass" name="new-password" type="password" autocomplete="new-password" placeholder="••••••••">
      <label for="r-pass2">Confirm password</label>
      <input id="r-pass2" name="confirm-password" type="password" autocomplete="new-password" placeholder="••••••••">
      <label><input type="checkbox" id="r-ack"> I understand there is no password recovery</label>
      <button class="btn" type="submit" style="width:100%;margin-top:1rem">Create</button>
      <p class="small error" id="r-err"></p>
      </form>
    `)}
    <p style="text-align:center"><a href="#/">Back</a></p>
  </div>`;
}

window.doRegister = async function() {
  // Lowercase to match the bank's rule (it requires lowercase), so a stray
  // capital doesn't bounce a raw "-32600 handle must be…" back at the user.
  const handle = document.getElementById('r-handle').value.trim().toLowerCase();
  const pass = document.getElementById('r-pass').value;
  const pass2 = document.getElementById('r-pass2').value;
  const ack = document.getElementById('r-ack').checked;
  const err = document.getElementById('r-err');
  if (!handle) { err.textContent = 'Choose a handle'; return; }
  if (!/^[a-z0-9_-]{2,32}$/.test(handle)) { err.textContent = 'Handle must be 2–32 characters, using only a–z, 0–9, _ or -'; return; }
  if (pass.length < MIN_PASSWORD) { err.textContent = `Password must be at least ${MIN_PASSWORD} characters`; return; }
  if (pass !== pass2) { err.textContent = 'Passwords do not match'; return; }
  if (!ack) { err.textContent = 'Please acknowledge there is no password recovery'; return; }
  try {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const keystore = await encryptSeed(privateKey, pass);
    const proof = signDoc({ handle, pubkey: pubkeyBase58, keystore_sha256: hashDoc(keystore) }, privateKey);
    const res = await fetch(`${state.basePath}/ui/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, pubkey: pubkeyBase58, keystore, proof })
    });
    const data = await res.json();
    if (data.code) throw bankError(data.code, data.message);
    rememberHandle(handle);
    state.user = { handle, pubkey: pubkeyBase58, privateKey };
    saveSession(handle, privateKey);
    // The account exists now; a transient /state blip must not bounce the user
    // back to a register error (a retry would hit "handle taken"). Fall back to
    // a default state, exactly like doUnlock.
    state.uiState = await uiGet('/state').catch(() => ({ pubkey: pubkeyBase58, trusted: [], contacts: [], banks: [], catalog: [], drafts: [], prefs: {}, rev: 0 }));
    toast(`Welcome, ${handle}`);
    if (resumePendingAction()) return;
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = e.message;
  }
};

function renderConnect(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Restore from recovery kit', `
      <p class="small">Have the <b>recovery kit</b> file you downloaded from Settings? Load it and enter its password to restore your account — no bank lookup needed.</p>
      <label for="c-kit">Recovery kit (.json)</label><input id="c-kit" type="file" accept="application/json,.json">
      <label for="c-kit-pass">Password</label><input id="c-kit-pass" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="restoreFromKit(this)">Restore</button>
      <p class="small error" id="c-kit-err"></p>
    `)}
    ${card('Or paste a raw key', `
      <label for="c-key">Base58 private key / seed</label>
      <textarea id="c-key" rows="3" placeholder="paste 32-byte base58 seed"></textarea>
      <button class="btn secondary" style="width:100%;margin-top:1rem" onclick="doConnect()">Connect</button>
      <p class="small error" id="c-err"></p>
    `)}
    <p style="text-align:center"><a href="#/">Back</a></p>
  </div>`;
}

// Restore an account from a downloaded recovery kit: decrypt its keystore with
// the password locally (no bank round-trip), so it works even if the account's
// bank is unreachable.
window.restoreFromKit = async function(btn) {
  const fileEl = document.getElementById('c-kit');
  const pass = document.getElementById('c-kit-pass').value;
  const err = document.getElementById('c-kit-err');
  const file = fileEl.files && fileEl.files[0];
  if (!file) { err.textContent = 'Choose your recovery kit file'; return; }
  if (!pass) { err.textContent = 'Enter the password you set for this account'; return; }
  const release = lockBtn(btn);
  try {
    let kit;
    try { kit = JSON.parse(await file.text()); } catch { throw new Error('That file is not a valid recovery kit'); }
    if (!kit || !kit.keystore || !kit.pubkey) throw new Error('That file is not a barter.game recovery kit');
    let seed;
    try { seed = await decryptSeed(kit.keystore, pass); } catch { throw new Error('Wrong password for this recovery kit'); }
    const { pubkeyBase58 } = publicKeyOf(seed);
    if (pubkeyBase58 !== kit.pubkey) throw new Error('Wrong password for this recovery kit');
    const handle = kit.handle || pubkeyBase58.slice(0, 8);
    rememberHandle(handle);
    state.user = { handle, pubkey: pubkeyBase58, privateKey: seed };
    saveSession(handle, seed);
    state.uiState = await uiGet('/state').catch(() => ({ pubkey: pubkeyBase58, trusted: [], contacts: [], banks: [], catalog: [], drafts: [], prefs: {}, rev: 0 }));
    toast(`Welcome back, ${handle}`);
    location.hash = '#/';
    route();
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

window.doConnect = async function() {
  const keyStr = document.getElementById('c-key').value.trim();
  const err = document.getElementById('c-err');
  try {
    const privateKey = base58Decode(keyStr);
    if (privateKey.length !== 32) throw new Error('seed must be 32 bytes');
    const { pubkeyBase58 } = publicKeyOf(privateKey);
    state.user = { pubkey: pubkeyBase58, privateKey, handle: pubkeyBase58.slice(0, 8) };
    saveSession(state.user.handle, privateKey);
    state.uiState = await uiGet('/state').catch(() => null);
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = e.message;
  }
};

function renderUnlock(app) {
  const last = rememberedHandle();
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Log in', `
      <form id="u-form" onsubmit="doUnlock();return false">
      <label for="u-handle">Handle</label><input id="u-handle" name="username" placeholder="alice" autocomplete="username" value="${escapeHtml(last)}">
      <label for="u-pass">Password</label><input id="u-pass" name="password" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:1rem">Log in</button>
      <p class="small error" id="u-err"></p>
      <p class="small">No password recovery. Lost password = lost account.</p>
      </form>
    `)}
    <p style="text-align:center" class="small">New here? <a href="#/register">Create account</a> · <a href="#/">Back</a></p>
  </div>`;
  const h = document.getElementById('u-handle');
  if (last) document.getElementById('u-pass').focus(); else h.focus();
}

window.doUnlock = async function() {
  const handle = document.getElementById('u-handle').value.trim();
  const pass = document.getElementById('u-pass').value;
  const err = document.getElementById('u-err');
  if (!handle || !pass) { err.textContent = 'Enter your handle and password'; return; }
  try {
    const res = await fetch(`${state.basePath}/ui/keystore/${encodeURIComponent(handle)}`);
    const data = await res.json();
    if (data.code || !data.keystore) {
      if (res.status === 404) err.textContent = 'No account with that handle at this bank';
      else if (res.status === 429) {
        const wait = data.retry_after ? ` Try again in ${data.retry_after}s.` : ' Wait a minute and try again.';
        err.textContent = `Too many attempts.${wait}`;
      } else err.textContent = 'Could not log in — please try again';
      return;
    }
    let seed;
    try {
      seed = await decryptSeed(data.keystore, pass);
    } catch { err.textContent = 'Wrong password'; return; }
    const { pubkeyBase58 } = publicKeyOf(seed);
    if (pubkeyBase58 !== data.pubkey) { err.textContent = 'Wrong password'; return; }
    rememberHandle(handle);
    state.user = { handle, pubkey: pubkeyBase58, privateKey: seed };
    saveSession(handle, seed);
    state.uiState = await uiGet('/state').catch(() => ({ pubkey: pubkeyBase58, trusted: [], contacts: [], banks: [], catalog: [], drafts: [], prefs: {}, rev: 0 }));
    if (resumePendingAction()) return;
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = 'Could not log in — network error';
  }
};

// Remember the last handle used at this bank (handle only — never the key or
// password) so the login form can prefill it for returning users.
function rememberHandle(handle) {
  try { localStorage.setItem(`barter.handle.${state.bankName}`, handle); } catch { /* ignore */ }
}
function rememberedHandle() {
  try { return localStorage.getItem(`barter.handle.${state.bankName}`) || ''; } catch { return ''; }
}

// The Balances card body, shared by the progressive fills. While remote banks
// are still answering, a quiet note says so instead of flashing "no balances".
function balancesGrid(holdings, checkingRemote) {
  const amt = (n) => n === null || n === undefined ? '—' : n;
  const grid = holdings.length ? `<div class="grid">${holdings.map(h => `
    <div>
      <div class="small">${escapeHtml(h.name)}${h.remote ? ` <span class="chip" title="${escapeHtml(h.bank_url || '')}">@ ${escapeHtml((h.bank || '').slice(0, 8))}…</span>` : ''}</div>
      <div><strong>${amt(h.current)}</strong> <span class="small">pending ${amt(h.pending)}</span></div>
      <div class="mono small">${escapeHtml(h.account.slice(0,12))}…</div>
    </div>
  `).join('')}</div>` : '<p class="small">No balances yet</p>';
  return grid + (checkingRemote ? '<p class="small">Checking pinned banks…</p>' : '');
}

async function renderDashboard(app) {
  // Paint the shell immediately; every data section fills in on its own
  // timeline, local bank first, pinned banks as they answer (fillSection).
  let body = header('Dashboard');
  body += `<div class="container">`;
  body += `<div class="card"><h3>Balances</h3><div id="dash-bal">${SECTION_SPINNER}</div></div>`;
  body += card('Quick actions', `<div class="flex" style="flex-wrap:wrap;gap:0.6rem">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <a class="btn secondary" href="#/invoices/new">New invoice</a>
    <a class="btn secondary" href="#/cheques/new">New cheque</a>
  </div>`);
  body += installSlot('banner');
  body += `<div class="card"><h3>Recent activity</h3><div id="dash-act">${SECTION_SPINNER}</div></div>`;
  body += `<h3 style="margin-top:2rem">Discover</h3><div id="dash-disc">${SECTION_SPINNER}</div>`;
  body += `</div>`;
  app.innerHTML = body;

  (async () => {
    const local = await localHoldings();
    fillSection('dash-bal', balancesGrid(local, true));
    const holdings = [...local];
    await remoteHoldingsProgressive(list => {
      holdings.push(...list);
      fillSection('dash-bal', balancesGrid(holdings, true));
    });
    fillSection('dash-bal', balancesGrid(holdings, false));
  })().catch(() => fillSection('dash-bal', loadError('balances')));

  uiGet('/history?limit=5').then(history => fillSection('dash-act',
    (history.events || []).map(e => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span class="mono small">${escapeHtml(e.deal_id.slice(0,12))}…</span>
      <span>${e.direction === 'credit' ? '↓ received' : '↑ sent'} ${escapeHtml(String(e.amount))} ${escapeHtml(e.voucher_name || e.voucher.slice(0,8))}</span>
      <span class="chip state-${escapeHtml(e.state)}">${escapeHtml(e.state)}</span>
    </div>`).join('') || '<p class="small">No activity</p>'))
    .catch(() => fillSection('dash-act', loadError('activity')));

  // discoverSections catches its own errors and renders them inline.
  discoverSections().then(html => fillSection('dash-disc', html));
}

// ---------------- operator admin ----------------
// Everything the bank manages, read-only, plus the one write an operator
// needs: carrying a post into the bank's curated feed by hand. The server
// refuses non-admins; the sections below just render their 403 as a loadError.

async function renderAdmin(app) {
  const [overview, users, accounts, records, postsRes] = await Promise.all([
    uiGet('/admin/overview').catch(() => null),
    uiGet('/admin/users').catch(() => null),
    uiGet('/admin/accounts').catch(() => null),
    uiGet('/admin/records').catch(() => null),
    uiGet('/admin/posts?limit=100').catch(() => null),
  ]);
  let body = header('Admin');
  body += `<div class="container">`;

  const tile = (n, label) => `<div><div style="font-size:1.4rem;font-weight:700">${escapeHtml(String(n))}</div><div class="small">${label}</div></div>`;
  const states = overview && overview.records_by_state
    ? Object.entries(overview.records_by_state).map(([s, n]) => `<span class="chip state-${escapeHtml(s)}">${escapeHtml(s)} ${n}</span>`).join(' ')
    : '';
  body += card('Overview', overview ? `<div class="grid">
    ${tile(overview.users, 'registered users')}
    ${tile(overview.vouchers, 'vouchers')}
    ${tile(overview.accounts, 'accounts')}
    ${tile(overview.records, 'records')}
    ${tile(overview.active_holds, 'active holds')}
    ${tile(overview.posts, 'posts stored')}
  </div>${states ? `<div style="margin-top:.7rem">${states}</div>` : ''}` : loadError('the overview'));

  body += card('Users', users ? (users.users.map(u => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span><b>${escapeHtml(u.handle)}</b>${u.admin ? ' <span class="chip">admin</span>' : ''}</span>
      <span class="mono small">${escapeHtml(u.pubkey.slice(0, 12))}…</span>
      <span class="small">${u.accounts} account${u.accounts === 1 ? '' : 's'}</span>
    </div>`).join('') || '<p class="small">No users yet</p>') : loadError('users'));

  body += card('Holdings', accounts ? (accounts.accounts.map(a => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span>${escapeHtml(a.name)} <span class="small">· ${escapeHtml(a.holder_handle || a.holder.slice(0, 8))}</span></span>
      <span><strong>${a.balance.current}</strong> <span class="small">${escapeHtml(a.voucher_name || '')}${a.balance.pending ? ` · pending ${a.balance.pending}` : ''}</span></span>
    </div>`).join('') || '<p class="small">No accounts yet</p>') : loadError('holdings'));

  body += card('Transactions', records ? (records.records.map(r => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span class="mono small">${escapeHtml(r.deal_id.slice(0, 12))}…</span>
      <span>${r.direction === 'credit' ? '↓' : '↑'} ${escapeHtml(String(r.amount))} ${escapeHtml(r.voucher_name || '')} <span class="small">${escapeHtml(r.holder_handle || '')}</span></span>
      <span class="chip state-${escapeHtml(r.state)}">${escapeHtml(r.state)}</span>
    </div>`).join('') || '<p class="small">No records yet</p>') : loadError('transactions'));

  const vNames = (postsRes && postsRes.vouchers) || {};
  body += card('Posts', postsRes ? `<p class="small">Everything stored at this bank. Carried posts already reach the bank's public feed; the rest can be carried by hand.</p>` + (postsRes.posts.map(p => `
    <div class="card post">
      <div class="post-head">
        <div style="min-width:0">
          <div><b>${escapeHtml(p.author_handle || p.author.slice(0, 8))}</b>${p.is_bank ? ' <span class="chip">bank</span>' : ''}</div>
          <div class="small">${escapeHtml(vNames[p.voucher] || (p.voucher || '').slice(0, 10) + '…')}${p.media ? ` · ${p.media} media` : ''}</div>
        </div>
      </div>
      <div class="post-body">
        ${p.excerpt ? `<div>${escapeHtml(p.excerpt)}</div>` : '<div class="small">(no text)</div>'}
        <div class="flex" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap">
          ${p.is_bank || p.bank_reposted
            ? '<span class="small">↻ carried by the bank</span>'
            : `<button class="btn" onclick="adminRepost(this, '${jsStr(p.hash)}')">Repost as ${escapeHtml(state.bankName)}</button>`}
        </div>
      </div>
    </div>`).join('') || '<p class="small">No posts yet</p>') : loadError('posts'));

  body += `</div>`;
  app.innerHTML = body;
}

window.adminRepost = async function(btn, hash) {
  const release = lockBtn(btn);
  try {
    const r = await uiPost('/admin/repost', { hash });
    toast(r.already ? 'Already carried by the bank' : `Reposted as ${state.bankName}`);
    route();
  } catch (e) {
    release();
    toast(e.message, 'error');
  }
};

// A voucher tile: the square art when the doc carries images, the name, and
// one line of context. The whole tile links to the voucher's detail screen.
function voucherTile(hash, opts) {
  const art = opts.art ? `<div class="tile-art"><img src="${escapeHtml(opts.art)}" alt="" loading="lazy" decoding="async"></div>` : '';
  return `<a class="card tile" href="#/vouchers/${escapeHtml(hash)}" style="text-decoration:none;color:inherit">
    ${art}
    <div class="tile-body">
      <div><strong>${escapeHtml(opts.name)}</strong></div>
      ${opts.sub ? `<div class="small">${opts.sub}</div>` : ''}
      ${opts.stat ? `<div style="margin-top:.3rem">${opts.stat}</div>` : ''}
    </div>
  </a>`;
}

// Art straight from the Voucher doc's own images: images[0] = icon,
// images[1] = square (bank-schema.md convention); refs resolve at the
// voucher's bank, which is not necessarily ours.
function voucherDocArt(v, bankUrl) {
  const images = Array.isArray(v.images) ? v.images.filter(Boolean) : [];
  const ref = images[1] || images[0];
  return ref ? mediaSrc(bankUrl, ref) : '';
}

// The "You hold" section body, shared by the progressive fills: one tile per
// voucher, balances summed across accounts. While pinned banks are still
// answering, a quiet note says so instead of flashing a premature empty state.
function holdTilesHtml(holdings, checkingRemote) {
  const heldByVoucher = new Map();
  holdings.forEach(h => {
    const cur = heldByVoucher.get(h.voucher) || { name: h.name, current: 0, pending: 0, unknown: false, remote: false };
    if (h.current === null || h.current === undefined) cur.unknown = true;
    else cur.current += h.current;
    cur.pending += h.pending || 0;
    if (h.remote) cur.remote = true;
    heldByVoucher.set(h.voucher, cur);
  });
  const tiles = heldByVoucher.size ? `<div class="tile-grid">${[...heldByVoucher].map(([hash, h]) =>
    voucherTile(hash, {
      name: h.name,
      sub: h.remote ? 'at a pinned bank' : '',
      stat: `<strong>${h.unknown ? '—' : h.current}</strong>${h.pending ? ` <span class="small">pending ${h.pending}</span>` : ''}`,
    })).join('')}</div>`
    : '<p class="small">Nothing held yet — accept a swap, pay an invoice, or claim a cheque.</p>';
  return tiles + (checkingRemote ? '<p class="small">Checking pinned banks…</p>' : '');
}

async function renderVouchers(app) {
  let body = header('Vouchers') + `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem;gap:.6rem;flex-wrap:wrap">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <button class="btn secondary" onclick="showShare('i', '${jsStr(state.user.pubkey)}', 'My issuer profile')">Share my profile QR</button>
  </div>`;
  body += `<h3>Issued by you</h3><div id="v-mine">${SECTION_SPINNER}</div>`;
  body += `<h3 style="margin-top:2rem">You hold</h3><div id="v-hold">${SECTION_SPINNER}</div>`;
  body += `<h3 style="margin-top:2rem">You follow</h3><div id="v-follow">${SECTION_SPINNER}</div>`;
  body += `</div>`;
  app.innerHTML = body;

  // 1. Issued by you — a single local RPC, lands first.
  const mineP = rpcCall('list_vouchers', { filter: 'mine' })
    .then(mine => {
      fillSection('v-mine', mine.length ? `<div class="tile-grid">${mine.map(v => {
        const hash = hashDoc(v);
        return voucherTile(hash, {
          name: v.name,
          art: voucherDocArt(v, state.bankUrl),
          sub: `${v.limit !== undefined ? `limit ${v.limit}` : 'unlimited'}${v.integer ? ' · integer' : ''}`,
        });
      }).join('')}</div>`
        : '<p class="small">No vouchers yet. <a href="#/vouchers/new">Create one.</a></p>');
      return mine;
    })
    .catch(() => { fillSection('v-mine', loadError('your vouchers')); return []; });

  // 2. You hold — local portfolio first, each pinned bank merges as it answers.
  const holdP = (async () => {
    const local = await localHoldings();
    fillSection('v-hold', holdTilesHtml(local, true));
    const holdings = [...local];
    await remoteHoldingsProgressive(list => {
      holdings.push(...list);
      fillSection('v-hold', holdTilesHtml(holdings, true));
    });
    fillSection('v-hold', holdTilesHtml(holdings, false));
    return holdings;
  })().catch(() => { fillSection('v-hold', loadError('your holdings')); return []; });

  // 3. You follow — trusted issuers resolved across their banks, minus what
  // the sections above already show (your own issues and your holdings).
  Promise.all([mineP, holdP, uiGet('/trusted').catch(() => []), issuerResolveBases()])
    .then(async ([mine, holdings, trusted, bases]) => {
      const seenF = new Set([...mine.map(v => hashDoc(v)), ...holdings.map(h => h.voucher)]);
      const followed = [];
      const resolved = await Promise.all((trusted || []).map(t =>
        resolveIssuerAt(bases, typeof t === 'string' ? t : t.pubkey).catch(() => null)));
      resolved.forEach(r => {
        if (!r || !Array.isArray(r.vouchers)) return;
        r.vouchers.forEach(v => {
          if (!v || typeof v.name !== 'string') return;
          const hash = hashDoc(v);
          if (seenF.has(hash)) return;
          seenF.add(hash);
          followed.push({ v, hash, who: r.handle || (r.pubkey || '').slice(0, 8) + '…', bankUrl: r.bank_url });
        });
      });
      fillSection('v-follow', followed.length ? `<div class="tile-grid">${followed.map(f => voucherTile(f.hash, {
        name: f.v.name,
        art: voucherDocArt(f.v, f.bankUrl),
        sub: `issued by ${escapeHtml(f.who)}`,
      })).join('')}</div>`
        : '<p class="small">Nothing followed beyond what you already hold. <a href="#/network">Trust an issuer</a> or <a href="#/registry">browse the registry</a>.</p>');
    })
    .catch(() => fillSection('v-follow', loadError('followed vouchers')));
}

// Voucher detail: what it is, your position in it, and every action the
// voucher supports — trade, invoice, cheque, post, and its QR. The head card
// paints as soon as ANY known bank answers with the doc; presentation (meta),
// your position, and the actions each fill in on their own timeline.
async function renderVoucherDetail(app, hash) {
  app.innerHTML = header('Vouchers') + `<div class="container">
    <p class="small"><a href="#/vouchers">← All vouchers</a></p>
    <div id="v-head">${SECTION_SPINNER}</div>
    <div id="v-pos"></div>
    <div id="v-act">${SECTION_SPINNER}</div>
  </div>`;

  const banks = await feedBanks().catch(() => [{ url: state.bankUrl || state.basePath, pubkey: state.bankPubkey }]);
  const found = await Promise.any(banks.map(b =>
    rpcCallAt(b.url, b.pubkey, 'get_voucher', { voucher_hash: hash })
      .then(doc => { if (!doc || !doc.name) throw new Error('not carried here'); return { doc, at: b }; })
  )).catch(() => null);
  if (!found) {
    fillSection('v-head', card('Voucher', '<p class="small">Unknown voucher at every bank you know.</p>'));
    document.getElementById('v-act')?.remove();
    return;
  }
  const { doc: v, at } = found;
  const shortIssuer = v.pubkey === state.user.pubkey ? 'you' : v.pubkey.slice(0, 8) + '…';

  const headHtml = (meta, issuerLabel) => {
    const art = metaSrc(meta, { bank_url: at.url }, 'square') || voucherDocArt(v, at.url);
    const desc = (meta && meta.description_md) || v.description_md || '';
    return `<div class="card">
    <div class="flex" style="gap:1rem;align-items:flex-start;flex-wrap:wrap">
      ${art ? `<img src="${escapeHtml(art)}" alt="" style="width:96px;height:96px;border-radius:12px;object-fit:cover;flex:0 0 auto">` : ''}
      <div style="min-width:0;flex:1">
        <div style="font-size:1.2rem"><strong>${escapeHtml(v.name)}</strong></div>
        <div class="small">issued by <b>${escapeHtml(issuerLabel)}</b> · ${escapeHtml(at.url.replace(/^https?:\/\//, ''))}</div>
        <div class="small">${v.limit !== undefined ? `limit ${v.limit}` : 'unlimited'}${v.integer ? ' · integer amounts' : ''}</div>
        ${expiryNote(v.expires)}
      </div>
    </div>
    ${desc ? `<p class="small" style="margin-top:.8rem">${escapeHtml(desc)}</p>` : ''}
  </div>`;
  };
  fillSection('v-head', headHtml(null, shortIssuer));

  // Enriched head (released look + issuer handle) repaints once, when both
  // best-effort reads settle.
  Promise.all([
    rpcCallAt(at.url, at.pubkey, 'get_voucher_meta', { voucher_hash: hash }).catch(() => null),
    issuerResolveBases().then(bases => resolveIssuerAt(bases, v.pubkey)).catch(() => null),
  ]).then(([meta, issuerInfo]) => {
    const label = v.pubkey === state.user.pubkey ? 'you' : (issuerInfo && issuerInfo.handle) || shortIssuer;
    if (meta || label !== shortIssuer) fillSection('v-head', headHtml(meta, label));
  });

  // Your position fills in only when you actually hold some.
  allHoldings().then(holdings => {
    const mineAccounts = (holdings || []).filter(h => h.voucher === hash);
    if (mineAccounts.length) {
      fillSection('v-pos', card('Your position', mineAccounts.map(h => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
        <span class="mono small">${escapeHtml(h.account.slice(0, 12))}…${h.remote ? ' <span class="chip">remote</span>' : ''}</span>
        <span><strong>${h.current === null || h.current === undefined ? '—' : h.current}</strong> <span class="small">pending ${h.pending ?? '—'}</span></span>
      </div>`).join('')));
    }
  }).catch(() => {});

  // Actions depend on the chooser set (own + trusted issuers), which resolves
  // issuers across banks — fill when it lands.
  knownVouchers().then(known => {
    const usable = (known || []).some(k => k.hash === hash);
    fillSection('v-act', card('Actions', `<div class="flex" style="flex-wrap:wrap;gap:0.6rem">
    ${usable ? `
      <a class="btn" href="#/orders/new/${escapeHtml(hash)}">Trade</a>
      <a class="btn secondary" href="#/invoices/new/${escapeHtml(hash)}">Invoice</a>
      <a class="btn secondary" href="#/cheques/new/${escapeHtml(hash)}">Cheque</a>
      <a class="btn secondary" href="#/posts/${escapeHtml(hash)}">Post about it</a>`
    : `<span class="small">Trust the issuer to trade, invoice, or write cheques in this voucher:</span>
       <button class="btn" onclick="wantVoucher('${jsStr(hash)}')">Trade for this</button>`}
      <button class="btn secondary" onclick="showShare('i', '${jsStr(v.pubkey)}', 'Voucher QR — ${jsStr(v.name)}', '${jsStr(at.url)}')">Voucher QR</button>
    </div>
    <p class="small" style="margin-top:.7rem"><a href="#/posts/${escapeHtml(hash)}">Read its feed →</a></p>`));
  }).catch(() => fillSection('v-act', card('Actions', loadError('the actions'))));
}

function renderCreateVoucher(app) {
  app.innerHTML = header('Create voucher') + `<div class="container">
    ${card('New voucher', `
      <label for="v-name">Name</label><input id="v-name" placeholder="1 hour consulting">
      <label for="v-desc">Description (markdown)</label><textarea id="v-desc" rows="3"></textarea>
      <label for="v-limit">Supply limit <span class="small">(optional — max you will ever issue)</span></label><input id="v-limit" type="number" min="0" step="any" placeholder="unlimited">
      <label for="v-expires">Expires <span class="small">(optional — the voucher is void after this date)</span></label><input id="v-expires" type="date">
      <label for="v-icon">Icon <span class="small">(optional — stored by hash in the bank's vault; a later meta release can replace it)</span></label>
      <input type="file" id="v-icon" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif">
      <label for="v-square">Square card image <span class="small">(optional)</span></label>
      <input type="file" id="v-square" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif">
      <label><input type="checkbox" id="v-int"> Integer amounts only</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateVoucher(this)">Create & sign</button>
      <p class="small error" id="v-err"></p>
    `)}
  </div>`;
}

window.doCreateVoucher = async function(btn) {
  const name = document.getElementById('v-name').value.trim();
  const desc = document.getElementById('v-desc').value.trim();
  const limit = document.getElementById('v-limit').value;
  const expires = document.getElementById('v-expires').value; // YYYY-MM-DD or ''
  const integer = document.getElementById('v-int').checked;
  const err = document.getElementById('v-err');
  if (!name) { err.textContent = 'Name required'; return; }
  if (limit && (!Number.isFinite(Number(limit)) || Number(limit) <= 0)) { err.textContent = 'Supply limit must be a positive number, or left blank'; return; }
  const release = lockBtn(btn);
  try {
    const voucher = { type: 'voucher', pubkey: state.user.pubkey, ulid: newUlid(), bank: state.bankPubkey, name };
    // Images upload to the vault first; the doc carries only their refs, and
    // the bank refuses a voucher whose blobs it does not hold.
    const iconFile = (document.getElementById('v-icon').files || [])[0];
    const squareFile = (document.getElementById('v-square').files || [])[0];
    if (iconFile || squareFile) {
      const icon = iconFile ? await uploadMediaFile(iconFile) : null;
      const square = squareFile ? await uploadMediaFile(squareFile) : null;
      // images[0] = icon, images[1] = square, by convention (bank-schema.md).
      voucher.images = square ? [icon || square, square] : [icon];
    }
    if (desc) voucher.description_md = desc;
    if (limit) voucher.limit = Number(limit);
    // Protocol wants an ISO 8601 datetime; treat the picked day as end-of-day UTC.
    if (expires) voucher.expires = new Date(expires + 'T23:59:59Z').toISOString();
    if (integer) voucher.integer = true;
    voucher.sig = signDoc(voucher, state.user.privateKey);

    const voucherHash = hashDoc(voucher);
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: `${name} (issuer)`, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);

    await rpcCall('submit_docs', { docs: [voucher, account] });
    location.hash = '#/vouchers';
    route();
    toast('Voucher created');
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

async function renderInvoices(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders?kind=invoice'); } catch { failed = true; }
  const names = await voucherNameMap();
  // Guard against non-invoice rows: a bank that ignores ?kind= (or older data)
  // could return cheques/two-sided orders, which have no credit side.
  const invoices = (orders.orders || []).filter(o => o.credit);
  let body = header('Invoices');
  body += `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/invoices/new">New invoice</a></div>`;
  body += failed ? loadError('your invoices') : (invoices.map(o => `
    <div class="card">
      <div>Receive ${escapeHtml(String(o.credit.max))} ${vName(names, o.credit.voucher)}</div>
      <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
      <div class="small">state: ${escapeHtml(String(o.state))}</div>
      <button class="btn secondary" onclick="showShare('v', '${jsStr(o.order)}', 'Invoice — scan to pay')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No invoices yet.</p>');
  body += `</div>`;
  app.innerHTML = body;
}

// A trusted issuer may bank ELSEWHERE — their handle and vouchers only resolve
// at their own bank, not ours. applyTrust pins that bank, so resolve a pubkey
// against our bank first, then each pinned bank, and use the first hit.
async function issuerResolveBases() {
  const bases = [state.bankUrl || state.basePath];
  const pinned = await uiGet('/banks').catch(() => []);
  (pinned || []).forEach(b => { if (b.url && !bases.includes(b.url)) bases.push(b.url); });
  return bases;
}
async function resolveIssuerAt(bases, pubkey) {
  for (const base of bases) {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/ui/resolve/${pubkey}`).then(x => x.json());
      if (r && (r.handle || (Array.isArray(r.vouchers) && r.vouchers.length))) {
        return { ...r, pubkey };
      }
    } catch { /* try next base */ }
  }
  return { pubkey, vouchers: [] };
}

// Vouchers the user can pick when authoring orders/invoices/cheques: their own
// issued vouchers plus those of issuers they trust (resolved across their banks).
// This replaces pasting raw voucher hashes.
async function knownVouchers() {
  const out = [];
  const seen = new Set();
  const add = (v, issuer) => {
    if (!v || typeof v.name !== 'string') return;
    const hash = hashDoc(v);
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, name: v.name, issuer, integer: !!v.integer });
  };
  let coreFailed = false;
  const [mine, trusted, bases] = await Promise.all([
    rpcCall('list_vouchers', { filter: 'mine' }).catch(() => { coreFailed = true; return []; }),
    uiGet('/trusted').catch(() => []),
    issuerResolveBases(),
  ]);
  (mine || []).forEach(v => add(v, 'you'));
  const resolved = await Promise.all((trusted || []).map(t =>
    resolveIssuerAt(bases, typeof t === 'string' ? t : t.pubkey)));
  resolved.forEach(r => {
    if (!r || !Array.isArray(r.vouchers)) return;
    const who = r.handle || (r.pubkey || '').slice(0, 8) + '…';
    r.vouchers.forEach(v => add(v, who));
  });
  // Flag a real load failure so callers can distinguish "you have none" from
  // "the bank is down" (see the Create forms).
  out.failed = coreFailed;
  return out;
}
function voucherChooser(id, vouchers, selected) {
  return `<select id="${id}">${vouchers.map(v =>
    `<option value="${escapeHtml(v.hash)}" data-int="${v.integer ? '1' : ''}"${v.hash === selected ? ' selected' : ''}>${escapeHtml(v.name)} — ${escapeHtml(v.issuer)}</option>`
  ).join('')}</select>`;
}
// True when the currently-selected voucher in a chooser is issued in whole units.
function chooserIsInteger(selectId) {
  const sel = document.getElementById(selectId);
  return !!(sel && sel.selectedOptions[0] && sel.selectedOptions[0].dataset.int === '1');
}
// hash → voucher name, for showing names (not raw hashes) in the Invoices/
// Cheques/Orders lists. Best-effort: unknown vouchers fall back to a short hash.
async function voucherNameMap() {
  const m = {};
  (await knownVouchers().catch(() => [])).forEach(v => { m[v.hash] = v.name; });
  return m;
}
function vName(map, hash) {
  return hash ? escapeHtml(map[hash] || hash.slice(0, 10) + '…') : '';
}
// Disable a submit button while its async handler runs, so a double-click (or a
// slow round-trip) can't fire the same create twice. Returns a release fn to
// call on error; on success the handler navigates away and the button is gone.
function lockBtn(btn) {
  if (!btn) return () => {};
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  return () => { btn.disabled = false; btn.textContent = label; };
}
function noVouchersNotice() {
  return `<p class="small">No vouchers to choose from yet. <a href="#/vouchers/new">Create one</a> or <a href="#/network">trust an issuer</a> first.</p>`;
}
// A usable amount is a finite number greater than zero.
function badAmount(n) { return !Number.isFinite(n) || n <= 0; }

// Render a voucher's expiry as a small note, flagging it red once past.
function expiryNote(expires) {
  if (!expires) return '';
  const d = new Date(expires);
  if (isNaN(d)) return '';
  const day = d.toISOString().slice(0, 10);
  const past = d.getTime() < Date.now();
  return past
    ? `<div class="small error">expired ${escapeHtml(day)}</div>`
    : `<div class="small">expires ${escapeHtml(day)}</div>`;
}

async function renderCreateInvoice(app, voucherHash) {
  const vouchers = await knownVouchers();
  // Arriving from a voucher's detail screen: preselect it when it is ours to use.
  const selected = voucherHash && vouchers.some(v => v.hash === voucherHash) ? voucherHash : undefined;
  app.innerHTML = header('New invoice') + `<div class="container">
    ${card('Request a payment (invoice)', vouchers.length ? `
      <p class="small">Creates a shareable request: whoever opens it pays you the amount below, in the chosen voucher.</p>
      <label for="i-voucher">Voucher to receive</label>${voucherChooser('i-voucher', vouchers, selected)}
      <label for="i-acct">Account name <span class="small">(where the payment lands)</span></label><input id="i-acct" value="receiving">
      <label for="i-amount">Amount to receive</label><input id="i-amount" type="number" min="0" step="any" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateInvoice(this)">Create invoice</button>
      <p class="small error" id="i-err"></p>
    ` : (vouchers.failed ? loadError('your vouchers') : noVouchersNotice()))}
  </div>`;
}

window.doCreateInvoice = async function(btn) {
  const voucherHash = document.getElementById('i-voucher').value.trim();
  const acctName = document.getElementById('i-acct').value.trim();
  const amount = Number(document.getElementById('i-amount').value);
  const err = document.getElementById('i-err');
  if (badAmount(amount)) { err.textContent = 'Enter an amount greater than zero'; return; }
  if (chooserIsInteger('i-voucher') && !Number.isInteger(amount)) { err.textContent = 'This voucher is issued in whole units only — enter a whole number'; return; }
  const release = lockBtn(btn);
  try {
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: acctName, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);
    const accountHash = hashDoc(account);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1,
      credit: { account: accountHash, voucher: voucherHash, bank: state.bankPubkey, min: amount, max: amount },
      lead: false };
    order.sig = signDoc(order, state.user.privateKey);
    const orderHash = hashDoc(order);
    await rpcCall('submit_docs', { docs: [order, account], publish_offers: [orderHash] });
    location.hash = '#/invoices';
    route();
    toast('Invoice created — share its QR so someone can pay it');
    // Pop the shareable QR straight away, mirroring the cheque flow.
    showShare('v', orderHash, 'Invoice — scan to pay');
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

async function renderCheques(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders?kind=cheque'); } catch { failed = true; }
  const names = await voucherNameMap();
  const cheques = (orders.orders || []).filter(o => o.debit && !o.credit);
  let body = header('Cheques') + `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/cheques/new">New cheque</a></div>`;
  body += `<p class="small">A cheque lets someone claim a fixed amount of your voucher. Share its QR with the recipient.</p>`;
  body += failed ? loadError('your cheques') : (cheques.map(o => `
    <div class="card">
      <div>Pay out ${escapeHtml(String(o.debit.max))} ${vName(names, o.debit.voucher)}</div>
      <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
      <div class="small">state: ${escapeHtml(String(o.state))}</div>
      <button class="btn secondary" onclick="showShare('q', '${jsStr(o.order)}', 'Cheque — scan to claim')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No cheques yet.</p>');
  body += `</div>`;
  app.innerHTML = body;
}

async function renderCreateCheque(app, voucherHash) {
  const vouchers = await knownVouchers();
  // Arriving from a voucher's detail screen: preselect it when it is ours to use.
  const selected = voucherHash && vouchers.some(v => v.hash === voucherHash) ? voucherHash : undefined;
  app.innerHTML = header('New cheque') + `<div class="container">
    ${card('Write a cheque', vouchers.length ? `
      <p class="small">Creates a shareable link: whoever opens it claims the amount below from you, in the chosen voucher.</p>
      <label for="q-voucher">Voucher to pay out</label>${voucherChooser('q-voucher', vouchers, selected)}
      <label for="q-acct">Account name <span class="small">(paid from)</span></label><input id="q-acct" value="spending">
      <label for="q-amount">Amount to pay</label><input id="q-amount" type="number" min="0" step="any" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateCheque(this)">Create cheque</button>
      <p class="small error" id="q-err"></p>
    ` : (vouchers.failed ? loadError('your vouchers') : noVouchersNotice()))}
  </div>`;
}

window.doCreateCheque = async function(btn) {
  const voucherHash = document.getElementById('q-voucher').value.trim();
  const acctName = document.getElementById('q-acct').value.trim();
  const amount = Number(document.getElementById('q-amount').value);
  const err = document.getElementById('q-err');
  if (badAmount(amount)) { err.textContent = 'Enter an amount greater than zero'; return; }
  if (chooserIsInteger('q-voucher') && !Number.isInteger(amount)) { err.textContent = 'This voucher is issued in whole units only — enter a whole number'; return; }
  const release = lockBtn(btn);
  try {
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: acctName, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);
    const accountHash = hashDoc(account);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1,
      debit: { account: accountHash, voucher: voucherHash, bank: state.bankPubkey, min: amount, max: amount },
      lead: true };
    order.sig = signDoc(order, state.user.privateKey);
    const orderHash = hashDoc(order);
    await rpcCall('submit_docs', { docs: [order, account], publish_offers: [orderHash] });
    location.hash = '#/cheques';
    route();
    toast('Cheque created — share its QR to let someone claim it');
    // Pop the shareable QR straight away — the point of a cheque is to send it.
    showShare('q', orderHash, 'Cheque — scan to claim');
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

// A `/o/<value>` Barter Link resolves an **Offer** hash, not an Order hash, so
// sharing `o.order` produces a link that always 404s. `/ui/orders` already
// returns the derived Offer hashes for each order; share the first of those.
// An order published with no offer (the "list publicly" box left unticked) has
// nothing shareable — say so instead of handing out a dead link.
function twoSidedShare(o) {
  const offer = Array.isArray(o.offers) && o.offers.length ? o.offers[0] : null;
  if (!offer) return `<div class="small">Not listed publicly — no shareable link</div>`;
  return `<button class="btn secondary" onclick="showShare('o', '${jsStr(offer)}', 'Swap — scan to trade')">Share QR</button>`;
}

async function renderOrders(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders'); } catch { failed = true; }
  const names = await voucherNameMap();
  app.innerHTML = header('Orders') + `<div class="container">
    <div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/orders/new">New order</a></div>
    ${failed ? loadError('your orders') : (orders.orders.map(o => `
      <div class="card">
        <div>${o.kind === 'two-sided' ? 'Swap' : escapeHtml(String(o.kind))}${o.lead ? ' · settles first' : ''}</div>
        <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
        <div class="small">${o.debit ? `give up to ${escapeHtml(String(o.debit.max))} ${vName(names, o.debit.voucher)}` : ''} ${o.credit ? `· receive up to ${escapeHtml(String(o.credit.max))} ${vName(names, o.credit.voucher)}` : ''}</div>
        ${o.kind === 'two-sided'
          ? `<div class="small">at most <b>${escapeHtml(fmtRate(o.rate))} ×</b> ${vName(names, o.debit.voucher)} for each <b>${vName(names, o.credit.voucher)}</b></div>`
          : ''}
        ${o.kind === 'invoice' ? `<button class="btn secondary" onclick="showShare('v', '${jsStr(o.order)}', 'Invoice — scan to pay')">Share QR</button>` : ''}
        ${o.kind === 'cheque' ? `<button class="btn secondary" onclick="showShare('q', '${jsStr(o.order)}', 'Cheque — scan to claim')">Share QR</button>` : ''}
        ${o.kind === 'two-sided' ? twoSidedShare(o) : ''}
      </div>
    `).join('') || '<p class="small">No orders yet.</p>')}
  </div>`;
}

async function renderCreateOrder(app, wantVoucherHash) {
  const vouchers = await knownVouchers();
  // Arriving from "Trade for this": preselect what you are trying to get, and
  // default "you give" to something else so the two are never the same voucher.
  const want = wantVoucherHash && vouchers.some(v => v.hash === wantVoucherHash)
    ? wantVoucherHash : '';
  const giveDefault = want ? (vouchers.find(v => v.hash !== want) || {}).hash : undefined;
  app.innerHTML = header('New order') + `<div class="container">
    ${card('Offer a swap', vouchers.length ? `
      <p class="small">Offer to trade one voucher for another. The exchange rate is set by the two amounts you enter.</p>
      ${want ? `<p class="small">Preloaded from a post: you are asking for <b>${escapeHtml(vouchers.find(v => v.hash === want).name)}</b>.</p>` : ''}
      <label for="o-dv">You give (voucher)</label>${voucherChooser('o-dv', vouchers, giveDefault).replace('<select ', '<select onchange="updateRate()" ')}
      <label for="o-dmax">Amount you give (up to)</label><input id="o-dmax" type="number" min="0" step="any" value="100" oninput="updateRate()">
      <label for="o-cv">You receive (voucher)</label>${voucherChooser('o-cv', vouchers, want).replace('<select ', '<select onchange="updateRate()" ')}
      <label for="o-cmax">Amount you receive (up to)</label><input id="o-cmax" type="number" min="0" step="any" value="90" oninput="updateRate()">
      <div class="card" style="margin:.6rem 0;padding:.6rem .8rem">
        <div class="small">Your rate — the <b>most</b> you will pay</div>
        <div id="o-rate">—</div>
        <p class="small">A ceiling, not a fixed price: the bank refuses any deal whose total ratio is worse than this, so a partial match can only ever be better for you.</p>
      </div>
      <label><input type="checkbox" id="o-lead"> Settle my side first <span class="small">(the counterparty may not reciprocate)</span></label>
      <label><input type="checkbox" id="o-pub" checked> List publicly so others can discover this</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateOrder(this)">Create order</button>
      <p class="small error" id="o-err"></p>
    ` : (vouchers.failed ? loadError('your vouchers') : noVouchersNotice()))}
  </div>`;
  // innerHTML does not run inline scripts, so seed the readout after render.
  if (vouchers.length) window.updateRate();
}

/**
 * Show the rate the two amounts imply. The rate is derived rather than typed
 * (two inputs cannot then contradict each other) — but deriving it is not a
 * reason to hide it: it is the price of the trade, and it was previously
 * invisible at every surface, so the shipped defaults quietly meant "I will
 * pay up to 1.111 of mine per 1 of yours".
 */
window.updateRate = function() {
  const el = document.getElementById('o-rate');
  if (!el) return;
  const d = Number(document.getElementById('o-dmax').value);
  const c = Number(document.getElementById('o-cmax').value);
  const dn = voucherNameOf('o-dv'), cn = voucherNameOf('o-cv');
  if (!(d > 0) || !(c > 0)) { el.textContent = '—'; return; }
  // Voucher names already carry their unit ("1 hour of tutoring"), so quoting
  // "per 1 <name>" would read "per 1 1 hour of tutoring".
  el.innerHTML = `<b>${escapeHtml(fmtRate(d / c))} ×</b> ${escapeHtml(dn)}
    <span class="small">for each</span> <b>${escapeHtml(cn)}</b>`;
};
function voucherNameOf(selectId) {
  const sel = document.getElementById(selectId);
  const opt = sel && sel.selectedOptions[0];
  return opt ? opt.textContent.split(' — ')[0] : 'unit';
}
// Trim float noise (100/90 is 1.1111111111111112) without hiding real precision.
function fmtRate(r) {
  return String(Math.round(r * 10000) / 10000);
}

window.doCreateOrder = async function(btn) {
  const dv = document.getElementById('o-dv').value.trim();
  const dmax = Number(document.getElementById('o-dmax').value);
  const cv = document.getElementById('o-cv').value.trim();
  const cmax = Number(document.getElementById('o-cmax').value);
  const lead = document.getElementById('o-lead').checked;
  const pub = document.getElementById('o-pub').checked;
  const err = document.getElementById('o-err');
  if (dv === cv) { err.textContent = 'Pick two different vouchers — you cannot swap a voucher for itself'; return; }
  if (badAmount(dmax) || badAmount(cmax)) { err.textContent = 'Both amounts must be greater than zero'; return; }
  if (chooserIsInteger('o-dv') && !Number.isInteger(dmax)) { err.textContent = 'The voucher you give is in whole units only — enter a whole number'; return; }
  if (chooserIsInteger('o-cv') && !Number.isInteger(cmax)) { err.textContent = 'The voucher you receive is in whole units only — enter a whole number'; return; }
  // Rate is derived from the two amounts, not hand-typed — they can never disagree.
  const rate = dmax / cmax;
  const release = lockBtn(btn);
  try {
    const dAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'giving', voucher: dv };
    dAccount.sig = signDoc(dAccount, state.user.privateKey);
    const cAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'receiving', voucher: cv };
    cAccount.sig = signDoc(cAccount, state.user.privateKey);
    const dHash = hashDoc(dAccount), cHash = hashDoc(cAccount);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate,
      debit: { account: dHash, voucher: dv, bank: state.bankPubkey, min: 0, max: dmax },
      credit: { account: cHash, voucher: cv, bank: state.bankPubkey, min: 0, max: cmax },
      lead };
    order.sig = signDoc(order, state.user.privateKey);
    const oHash = hashDoc(order);
    const docs = [order, dAccount, cAccount];
    await rpcCall('submit_docs', { docs, publish_offers: pub ? [oHash] : [] });
    location.hash = '#/orders';
    route();
    toast(pub ? 'Order created and listed publicly' : 'Order created');
  } catch (e) {
    release();
    err.textContent = e.message;
  }
};

/**
 * Discover — vouchers surfacing through posts from the people you follow
 * (discovery.md §5). Every post is anchored to a voucher, so the merged feed
 * IS a stream of voucher sightings: de-duplicate them newest-first, dress
 * each in its released meta (image, description), and offer the actions that
 * close the loop — trade for it, read its feed, follow its issuer. Open
 * offers on vouchers you already know remain below as a second channel.
 * Rendered as a section of Home (renderDashboard); returns HTML, never throws.
 */
async function discoverSections() {
  const { feed, failed, names, vMap, vInfo, vMeta } = await buildFeedContext('');
  const known = await knownVouchers().catch(() => []);
  const nameByHash = {};
  known.forEach(v => { nameByHash[v.hash] = v.name; });
  let body = '';

  // Discovery IS the feed: you meet a voucher by seeing someone's picture of
  // it. The gallery and the open offers stay underneath as the index and the
  // shortcut, but the pictures come first.
  const followSet = new Set(feed.authors);
  const ctx = { names, vMap, vMeta, vInfo, followSet };
  embeddedPosts.clear();
  const stream = dedupeReposts(feed.posts).map(entry => postCard(entry, ctx)).join('');

  // --- vouchers seen in the feed, newest sighting first --------------------
  const seenVouchers = [];
  const seenSet = new Set();
  const noteVoucher = p => {
    if (!p) return;
    if (p.voucher && !seenSet.has(p.voucher)) { seenSet.add(p.voucher); seenVouchers.push(p.voucher); }
    noteVoucher(p.reply_to);
    noteVoucher(p.repost);
  };
  feed.posts.forEach(({ post }) => noteVoucher(post));

  const cards = seenVouchers.map(h => {
    const info = vInfo[h];
    if (!info) return '';
    const meta = vMeta[h];
    const mine = state.user && info.issuer === state.user.pubkey;
    const issuerLabel = postAuthorLabel(info.issuer, names);
    const desc = meta && meta.description_md
      ? `<p class="small">${escapeHtml(meta.description_md.slice(0, 160))}${meta.description_md.length > 160 ? '…' : ''}</p>` : '';
    // The square card image is the tile — a gallery of what is on offer reads
    // faster than a list of names, and it is the same art the feed shows.
    const art = metaSrc(meta, info, 'square');
    return `<div class="card tile">
      ${art ? `<div class="tile-art"><img src="${escapeHtml(art)}" alt="" loading="lazy" decoding="async"></div>` : ''}
      <div class="tile-body">
        <div><strong>${escapeHtml(info.name)}</strong></div>
        <div class="small">issued by <b>${escapeHtml(issuerLabel)}</b></div>
        ${desc}
        <div class="flex" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap">
          ${mine ? '<span class="small">This is your voucher.</span>'
            : `<button class="btn" onclick="wantVoucher('${jsStr(h)}')">Trade for this</button>`}
          <a class="btn secondary" href="#/posts/${escapeHtml(h)}">Read its feed</a>
          ${!mine && !followSet.has(info.issuer)
            ? `<button class="btn secondary" onclick="followAuthor('${jsStr(info.issuer)}')">Follow issuer</button>` : ''}
        </div>
      </div>
    </div>`;
  }).filter(Boolean).join('');
  const gallery = cards ? `<div class="tile-grid">${cards}</div>` : '';

  body += `<p class="small">What the people you <a href="#/network">follow</a> are posting — your bank reposts what its users publish, so following your bank is enough to start. There is no global search: your follows are the index. <a href="#/posts">Post something</a> yourself.</p>`;
  if (failed) {
    body += loadError('the feed');
  } else if (!stream) {
    body += `<div class="card"><p class="small">Nothing discovered yet. Follow more people under <a href="#/network">Network</a>, browse <a href="#/registry">the registry</a>, or check back once the people you follow have posted.</p></div>`;
  } else {
    body += `<div class="feed">${stream}</div>`;
    if (gallery) {
      body += `<h3 style="margin-top:2rem">Vouchers in your feed</h3>
        <p class="small">Everything above, as a shelf.</p>${gallery}`;
    }
  }

  // --- open offers on vouchers you already know (second channel) -----------
  if (!known.length) {
    body += card('Open offers', `<p class="small">To see tradable offers you first need a voucher you issue, or an issuer you trust. <a href="#/vouchers/new">Create a voucher</a> or trade for one above.</p>`);
    return body;
  }
  // Poll our own bank AND every pinned bank for offers on the vouchers we know.
  // (The bank defaults `vouchers` to an empty catalog and `banks` to pinned-only,
  // so both must be sent explicitly or nothing is ever discovered.)
  const pinned = await uiGet('/banks').catch(() => []);
  const banks = [{ pubkey: state.bankPubkey, url: state.bankUrl }];
  (pinned || []).forEach(b => { if (b.pubkey && b.pubkey !== state.bankPubkey) banks.push({ pubkey: b.pubkey, url: b.url }); });
  const vouchers = known.map(v => v.hash);
  let res;
  try { res = await uiPost('/discover', { banks, vouchers, intentions: ['sell', 'buy'] }); }
  catch (e) { res = { offers: [], error: e.message, unreachable: [] }; }
  // The same order can surface from several (bank × voucher × intention) polls.
  const seen = new Set();
  const uniq = (res.offers || []).filter(o => { const k = o.order || o.offer; if (!k || seen.has(k)) return false; seen.add(k); return true; });
  // Attacker-influenced strings (from a polled bank) never enter inline JS — the
  // click handler reads the full offer object back from this stash by index.
  window.__discoverOffers = uniq;
  const name = (h) => h ? (nameByHash[h] || (h.slice(0, 8) + '…')) : '';
  body += card('Offers', uniq.map((o, i) => {
    const give = o.debit ? `give ${escapeHtml(String(o.debit.max))} ${escapeHtml(name(o.debit.voucher))}` : '';
    const get = o.credit ? `get ${escapeHtml(String(o.credit.max))} ${escapeHtml(name(o.credit.voucher))}` : '';
    const summary = [give, get].filter(Boolean).join(' · ') || 'offer';
    const twoSided = o.debit && o.credit;
    return `<div class="card">
      <div><strong>${summary}</strong></div>
      <div class="small">at bank ${escapeHtml((o.bank || '').slice(0, 12))}…</div>
      ${twoSided
        ? `<button class="btn" data-idx="${i}" onclick="acceptOfferByIdx(this)">Accept swap</button>`
        : `<p class="small">One-sided offer — open its link to pay or claim.</p>`}
    </div>`;
  }).join('') || '<p class="small">No offers found at your bank or pinned banks yet. Publish an order, or pin more banks under Network.</p>');
  const unreachable = res.unreachable || [];
  if (unreachable.length) {
    body += card('Couldn\'t reach', unreachable.map(u => `<div class="small">bank ${escapeHtml((u.bank || '').slice(0, 12))}…</div>`).join(''));
  }
  if (res.error) body += `<p class="error small">${escapeHtml(res.error)}</p>`;
  body += `<p class="small"><a href="#/registry">Browse this bank's voucher registry →</a></p>`;
  return body;
}

// Browse the bank's public voucher registry, grouped by issuer, so a newcomer
// can find issuers/vouchers and trust them. (INPUTS: "check a bank's public
// registry of vouchers, optionally filtered by issuer".)
async function renderRegistry(app) {
  let vouchers = [], failed = false;
  try { vouchers = await rpcCall('list_vouchers', {}); } catch { failed = true; }
  const trusted = new Set((await uiGet('/trusted').catch(() => [])).map(t => typeof t === 'string' ? t : t.pubkey));
  // Group vouchers by issuer pubkey.
  const byIssuer = new Map();
  (vouchers || []).forEach(v => {
    if (!v || !v.pubkey) return;
    if (!byIssuer.has(v.pubkey)) byIssuer.set(v.pubkey, []);
    byIssuer.get(v.pubkey).push(v);
  });
  // Resolve each issuer's handle at this bank (best-effort).
  const issuers = [...byIssuer.keys()];
  const handles = {};
  await Promise.all(issuers.map(pk =>
    fetch(`${(state.bankUrl || state.basePath).replace(/\/$/, '')}/ui/resolve/${pk}`)
      .then(r => r.json()).then(r => { handles[pk] = r.handle || ''; }).catch(() => {})));
  let body = header('Registry') + `<div class="container">`;
  body += `<p class="small">Vouchers issued at ${escapeHtml(state.bankName)}. Trust an issuer to use their vouchers in your orders.</p>`;
  if (failed) {
    body += loadError('the registry');
  } else if (!issuers.length) {
    body += `<p class="small">No public vouchers at this bank yet.</p>`;
  } else {
    body += issuers.map(pk => {
      const isMe = state.user && pk === state.user.pubkey;
      const isTrusted = trusted.has(pk) || isMe;
      const who = handles[pk] || (pk.slice(0, 12) + '…');
      const vs = byIssuer.get(pk);
      return card(who, `
        <div class="mono small">${escapeHtml(pk.slice(0, 24))}…</div>
        ${vs.map(v => `<div class="small">• ${escapeHtml(v.name)}</div>${expiryNote(v.expires)}`).join('')}
        ${isMe ? '<p class="small">This is you.</p>'
          : isTrusted ? '<p class="small success">✓ Trusted</p>'
          : `<button class="btn secondary" data-pk="${escapeHtml(pk)}" data-handle="${escapeHtml(handles[pk] || '')}" onclick="trustFromRegistry(this)">Trust ${escapeHtml(who)}</button>`}
      `);
    }).join('');
  }
  app.innerHTML = body + `</div>`;
}

window.trustFromRegistry = async function(btn) {
  const pubkey = btn.dataset.pk;
  const handle = btn.dataset.handle || '';
  try {
    await uiPost('/trusted', { pubkey, note: '' });
    toast(`You now trust ${handle || pubkey.slice(0, 12)}`);
    route();
  } catch (e) { toast(e.message, 'error'); }
};

// Accept a discovered two-sided swap by index into the Discover stash. The
// offer object is read back from the stash so nothing attacker-controlled is
// interpolated into markup.
window.acceptOfferByIdx = function(btn) {
  const o = (window.__discoverOffers || [])[Number(btn.dataset.idx)];
  if (!o) { toast('Offer no longer available — refresh Home', 'error'); return; }
  return window.acceptSwap(o, btn);
};

// Core swap-accept, shared by Discover and the offer landing: build the mirror
// order (I give what they want, receive what they give), submit it, then propose
// the deal pairing it with theirs.
window.acceptSwap = async function acceptSwap(o, btn) {
  if (!o.debit || !o.credit) { toast('One-sided offer — open its link to pay or claim', 'error'); return; }
  if (btn && btn.disabled) return;
  // Cross-bank swaps need the mirror order submitted to two banks; not yet
  // supported here. Single-bank (both vouchers at one bank) is the common case.
  if (o.debit.bank !== o.credit.bank) {
    toast('This swap spans two banks — not supported yet', 'error');
    return;
  }
  const theyGive = o.debit;   // voucher A they give (I receive)
  const theyWant = o.credit;  // voucher B they want (I give)
  const known = await knownVouchers().catch(() => []);
  const nm = {}; known.forEach(v => { nm[v.hash] = v.name; });
  const nameOf = (h) => nm[h] || (h.slice(0, 8) + '…');
  if (!window.confirm(`Accept this swap?\n\nYou give ${theyWant.max} ${nameOf(theyWant.voucher)}\nYou receive ${theyGive.max} ${nameOf(theyGive.voucher)}`)) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try {
    const vbank = await resolveVoucherBank(theyGive, { bank: o.bank, bank_url: o.bank_url });
    if (vbank.pubkey !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: vbank.pubkey, url: vbank.url }).catch(() => {});
    }
    // I must hold voucher B (what they want) to give it. Reuse a funded account.
    const mine = await rpcCallAt(vbank.url, vbank.pubkey, 'list_accounts', {}).catch(() => ({ accounts: [] }));
    const docs = [];
    let giveAccount = null;
    for (const a of (mine.accounts || []).filter(a => a.voucher === theyWant.voucher).map(a => hashDoc(a))) {
      const bal = await rpcCallAt(vbank.url, vbank.pubkey, 'get_account_balance', { account_hash: a }).catch(() => null);
      if (bal && (bal.current - bal.pending) >= theyWant.max) { giveAccount = a; break; }
    }
    if (!giveAccount) throw new Error(`you need ${theyWant.max} ${nameOf(theyWant.voucher)} at this bank to accept`);
    // Receiving account for voucher A — reuse or create fresh.
    let recvAccount = (mine.accounts || []).filter(a => a.voucher === theyGive.voucher).map(a => hashDoc(a))[0] || null;
    if (!recvAccount) {
      const acct = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'receiving', voucher: theyGive.voucher };
      acct.sig = signDoc(acct, state.user.privateKey);
      recvAccount = hashDoc(acct);
      docs.push(acct);
    }
    const myOrder = {
      type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: theyWant.max / theyGive.max,
      debit: { account: giveAccount, voucher: theyWant.voucher, bank: theyWant.bank, min: 0, max: theyWant.max },
      credit: { account: recvAccount, voucher: theyGive.voucher, bank: theyGive.bank, min: 0, max: theyGive.max },
      lead: false,
    };
    myOrder.sig = signDoc(myOrder, state.user.privateKey);
    const myHash = hashDoc(myOrder);
    docs.push(myOrder);
    await rpcCallAt(vbank.url, vbank.pubkey, 'submit_docs', { docs });
    const res = await signedRequestAt(vbank.url, 'POST', '/propose_deal', {
      offer1: { hash: o.order, debit_amount: theyGive.max, credit_amount: theyWant.max },
      offer2: { hash: myHash, debit_amount: theyWant.max, credit_amount: theyGive.max },
      banks: [{ pubkey: vbank.pubkey, url: vbank.url }],
    });
    rememberDealBank(res.deal_id, vbank);
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    toast(e.message, 'error');
  }
}

async function renderDeal(app, dealId) {
  // A deal proposed at another bank (e.g. a claimed cheque at the voucher's
  // issuing bank) is polled there, not at the SPA's own bank.
  const remote = dealBankFor(dealId);
  let status = null, errored = false;
  try {
    status = await (remote && remote.pubkey !== state.bankPubkey
      ? signedRequestAt(remote.url, 'GET', `/deal/${dealId}`, null)
      : uiGet(`/deal/${dealId}`));
  } catch { errored = true; }
  let body = header('Deal') + `<div class="container">`;
  if (errored || !status) {
    // A blank/failed read right after propose is almost always transient
    // (replication lag, a network blip, clock skew). Keep polling instead of
    // dead-ending on "Not found", and never blank the screen permanently.
    body += card(`Deal ${escapeHtml(dealId.slice(0, 12))}…`, `
      <p class="small">Connecting to the bank… this can take a moment right after a deal is proposed. This page keeps retrying.</p>
      <button class="btn secondary" onclick="route()">Retry now</button>`);
    app.innerHTML = body + `</div>`;
    dealTimer = setTimeout(() => { if (location.hash === `#/deal/${dealId}`) route(); }, 3000);
    return;
  }
  {
    const done = status.state === 'settled' || status.state === 'rejected';
    const tick = (b) => b ? '✓' : '·';
    // Every leg below is minted by the SAME bank (the one we polled), so the
    // bank is named once, not repeated per leg. Each leg says what it MOVES.
    const legHtml = status.legs.map(l => {
      const who = l.mine ? 'You' : 'Counterparty';
      const verb = l.direction === 'credit'
        ? (l.mine ? 'receive' : 'receives')
        : (l.mine ? 'give' : 'gives');
      const what = l.voucher_name || (l.voucher ? l.voucher.slice(0, 10) + '…' : '');
      const headline = l.direction
        ? `${who} ${verb} <strong>${l.amount}</strong> ${escapeHtml(what)}`
        : escapeHtml((l.records && l.records[0] || '').slice(0, 16) + '…');
      return `<div class="card">
        <div>${headline}</div>
        <div class="small">ready ${tick(l.ready)} → hold ${tick(l.hold)} → settle ${tick(l.settle)}</div>
      </div>`;
    }).join('');
    const bankPk = status.legs[0] && status.legs[0].bank ? status.legs[0].bank : '';
    body += card(`Deal ${escapeHtml(dealId.slice(0,12))}…`, `
      <p>state: <span class="chip state-${escapeHtml(status.state)}">${escapeHtml(status.state)}</span></p>
      ${status.state === 'settled' ? '<p class="small success">✓ Settled — every leg signed ready → hold → settle. Balances are updated.</p>' : ''}
      ${status.state === 'rejected' ? '<p class="small error">This deal was rejected; no balances moved.</p>' : ''}
      ${legHtml}
      ${bankPk ? `<p class="small">Legs settled at bank <span class="mono">${escapeHtml(bankPk.slice(0,16))}…</span></p>` : ''}
      ${done
        ? `<a class="btn" href="#/">Back to balances</a>`
        : `<p class="small">Waiting for the banks to sign… this page refreshes itself.</p>
           <button class="btn secondary" onclick="route()">Refresh now</button>`}
    `);
  }
  body += `</div>`;
  app.innerHTML = body;
  if (status && status.state !== 'settled' && status.state !== 'rejected') {
    dealTimer = setTimeout(() => { if (location.hash === `#/deal/${dealId}`) route(); }, 3000);
  }
}

async function renderSettings(app) {
  app.innerHTML = header('Settings') + `<div class="container">
    ${card('Identity', `
      <p>Handle: ${escapeHtml(state.user.handle || '')}</p>
      <p class="mono small">${escapeHtml(state.user.pubkey)}</p>
      <button class="btn secondary" onclick="showShare('i', '${jsStr(state.user.pubkey)}', 'My issuer profile')">My profile QR</button>
    `)}
    ${card('Bank', `
      <p>${escapeHtml(state.bankName)}</p>
      <p class="mono small">${escapeHtml(state.bankPubkey)}</p>
      <p class="small">${escapeHtml(state.bankUrl)}</p>
    `)}
    ${installSlot('settings')}
    ${card('Recovery kit', `
      <p class="small">Download your encrypted keystore. Together with your password it restores this account anywhere; without the password it is useless — and there is no password recovery.</p>
      <button class="btn secondary" onclick="downloadBackup()">Download encrypted backup</button>
    `)}
    ${card('Actions', `
      <button class="btn danger" onclick="logout()">Log out</button>
    `)}
  </div>`;
}

window.downloadBackup = async function() {
  try {
    const res = await fetch(`${state.basePath}/ui/keystore/${state.user.handle}`);
    const data = await res.json();
    if (data.code) throw new Error(data.message || 'no server keystore for this handle');
    const kit = {
      barter_recovery_kit: 1,
      handle: state.user.handle,
      pubkey: state.user.pubkey,
      bank: { name: state.bankName, pubkey: state.bankPubkey, url: state.bankUrl },
      keystore: data.keystore,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `barter-recovery-${state.user.handle}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ---------------- share modal (QR) ----------------

// Build the public Barter Link for a kind/value at this bank and show it as a
// QR + copyable link. REFERENCE mode links per the spec's QR byte budget.
window.showShare = function(kind, value, title, baseUrl) {
  // baseUrl lets a foreign entity's QR (e.g. a trusted issuer who banks
  // elsewhere) point at THEIR bank, where it actually resolves — not ours.
  const base = (baseUrl || state.bankUrl).replace(/\/+$/, '');
  const link = `${base}/${kind}/${value}`;
  let dataUrl = '';
  try { dataUrl = qrDataUrl(link); } catch (e) { toast(e.message, 'error'); return; }
  const opener = document.activeElement; // return focus here on close
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <h3 id="share-title">${escapeHtml(title || 'Share')}</h3>
      <img class="qr" src="${dataUrl}" alt="QR code for ${escapeHtml(title || 'this link')}">
      <div class="mono small" style="word-break:break-all;margin:0.5rem 0">${escapeHtml(link)}</div>
      <div class="flex">
        <button class="btn" id="share-copy">Copy link</button>
        <button class="btn secondary" id="share-close">Close</button>
      </div>
    </div>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
  // Escape closes; Tab is trapped inside the dialog.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#share-close').onclick = close;
  overlay.querySelector('#share-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch { toast('Copy failed — select the text manually', 'error'); }
  };
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('#share-copy').focus();
};

// ---------------- scanning + Barter Link handling ----------------

let activeScannerStop = null;
function stopActiveScanner() {
  if (activeScannerStop) { try { activeScannerStop(); } catch {} activeScannerStop = null; }
}

async function renderScan(app) {
  app.innerHTML = header('Scan') + `<div class="container" style="max-width:480px">
    ${card('Scan a Barter QR', `
      <video id="scan-video" style="width:100%;border-radius:0.5rem;background:#000"></video>
      <p class="small" id="scan-status">Requesting camera…</p>
      <label for="scan-manual">…or paste a Barter Link</label>
      <input id="scan-manual" placeholder="https://…/alice/i/PUBKEY">
      <button class="btn" style="width:100%;margin-top:0.5rem" onclick="handleScanned(document.getElementById('scan-manual').value.trim())">Open link</button>
    `)}
  </div>`;
  const video = document.getElementById('scan-video');
  const status = document.getElementById('scan-status');
  try {
    activeScannerStop = await startScanner(video, (text) => {
      activeScannerStop = null;
      window.handleScanned(text);
    });
    status.textContent = 'Point the camera at a barter QR code.';
  } catch (e) {
    status.textContent = `Camera unavailable (${e.message}). Paste a link below instead.`;
  }
}

// Parse a scanned/pasted Barter Link and dispatch to the landing handler.
window.handleScanned = function(text) {
  if (!text) return;
  try {
    const u = new URL(text);
    const m = u.pathname.match(/\/(i|v|q|o|x)\/([^/]+?)(?:\.json)?$/);
    if (!m) { toast('Not a Barter Link', 'error'); return; }
    // Same bank origin → in-app landing; foreign bank → carry the origin+path.
    sessionStorage.setItem('barter_scan_origin', `${u.origin}${u.pathname.replace(/\/(i|v|q|o|x)\/.*$/, '')}`);
    location.hash = `#/land/${m[1]}/${m[2]}`;
    route();
  } catch {
    toast('Not a valid URL', 'error');
  }
};

// Fetch the machine payload for a landing target. Prefers the scanned bank
// base (may be a foreign bank), falls back to this SPA's own bank.
async function fetchBarterEnvelope(kind, value) {
  const scanBase = sessionStorage.getItem('barter_scan_origin');
  const bases = [];
  if (scanBase) bases.push(scanBase);
  bases.push(state.bankUrl || state.basePath);
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/${kind}/${value}?format=json`);
      if (!res.ok) continue;
      const env = await res.json();
      if (env && Array.isArray(env.docs)) return { env, base };
    } catch { /* try next base */ }
  }
  throw new Error('could not fetch the signed documents');
}

// Verify every doc in the envelope client-side before trusting anything.
function verifyEnvelope(env) {
  for (const doc of env.docs) {
    if (!doc.sig || !verifyDoc(doc, doc.sig, doc.pubkey)) {
      throw new Error(`signature check failed on a ${doc.type} document`);
    }
  }
  return true;
}

// ---------------- landing journeys ----------------

async function renderLanding(app, kind, value) {
  let env, base;
  try {
    ({ env, base } = await fetchBarterEnvelope(kind, value));
    verifyEnvelope(env);
  } catch (e) {
    app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
      ${card('Barter Link', `<p class="error">${escapeHtml(e.message)}</p><p><a href="#/">Home</a></p>`)}</div>`;
    return;
  }

  const verified = `<p class="small success">✓ Signatures verified in this browser</p>`;

  if (env.kind === 'profile') {
    const handle = env.handle || (env.pubkey || value).slice(0, 12) + '…';
    const vouchers = env.docs.filter(d => d.type === 'voucher');
    const body = `
      <h2>${escapeHtml(handle)}</h2>
      <p class="mono small">${escapeHtml(env.pubkey || value)}</p>
      ${verified}
      ${vouchers.map(v => `<div class="card"><strong>${escapeHtml(v.name)}</strong>${v.description_md ? `<p class="small">${escapeHtml(v.description_md)}</p>` : ''}</div>`).join('') || '<p class="small">No vouchers published yet.</p>'}
    `;
    if (!state.user) {
      // Remember only to RETURN to this profile after auth — never arm a silent
      // auto-trust just because the profile was viewed. The explicit Trust
      // button below (logged-in branch) is the only thing that adds trust.
      sessionStorage.setItem('barter_pending', JSON.stringify({ action: 'view', kind: 'i', value }));
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card('Issuer profile', body + `
        <p class="small">After you sign in you can choose to trust <b>${escapeHtml(handle)}</b>.</p>
        <a class="btn" style="display:block;text-align:center" href="#/register">Register to continue</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in to continue</a>
        ${otherBankCta('i', value, env.bank_url)}
      `)}</div>`;
    } else {
      app.innerHTML = header('Profile') + `<div class="container" style="max-width:480px">${card('Issuer profile', body + `
        <label for="trust-note">Note <span class="small">(optional)</span></label>
        <textarea id="trust-note" rows="2" placeholder="e.g. met at the train station, seemed OK"></textarea>
        <button class="btn" style="width:100%" data-pk="${escapeHtml(env.pubkey || value)}" data-handle="${escapeHtml(env.handle || '')}" data-bank="${escapeHtml(env.bank || '')}" data-bankurl="${escapeHtml(env.bank_url || '')}" onclick="applyTrust(this)">Trust ${escapeHtml(handle)}</button>
      `)}</div>`;
    }
    return;
  }

  if (env.kind === 'invoice' || env.kind === 'cheque') {
    const order = env.docs.find(d => d.type === 'order');
    const side = env.kind === 'invoice' ? order.credit : order.debit;
    // The bank now bundles the referenced Voucher doc (verified above), so the
    // recipient sees WHAT they pay/claim by name — not a bare hash.
    const voucherDoc = env.docs.find(d => d.type === 'voucher' && hashDoc(d) === side.voucher);
    const voucherName = voucherDoc ? voucherDoc.name : null;
    const who = env.handle || order.pubkey.slice(0, 12) + '…';
    const amount = side.min === side.max ? String(side.max) : `${side.min}–${side.max}`;
    const verb = env.kind === 'invoice' ? 'Pay' : 'Claim';
    const body = `
      <h2>${env.kind === 'invoice' ? `Pay ${escapeHtml(who)}` : `Cheque from ${escapeHtml(who)}`}</h2>
      ${verified}
      <div class="card">
        <div>Amount: <strong>${escapeHtml(amount)}${voucherName ? ` ${escapeHtml(voucherName)}` : ''}</strong></div>
        ${voucherName && voucherDoc.description_md ? `<div class="small">${escapeHtml(voucherDoc.description_md)}</div>` : ''}
        ${voucherDoc ? expiryNote(voucherDoc.expires) : ''}
        <div class="mono small">voucher ${voucherName ? `${escapeHtml(voucherName)} · ` : ''}${escapeHtml(side.voucher.slice(0, 16))}…</div>
      </div>`;
    sessionStorage.setItem('barter_pending', JSON.stringify({ action: env.kind, orderHash: hashDoc(order), kind, value, base }));
    if (!state.user) {
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card(env.kind, body + `
        <a class="btn" style="display:block;text-align:center" href="#/register">Register &amp; ${verb.toLowerCase()}</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in &amp; ${verb.toLowerCase()}</a>
        ${otherBankCta(kind, value, env.bank_url)}
      `)}</div>`;
    } else {
      app.innerHTML = header(verb) + `<div class="container" style="max-width:480px">${card(env.kind, body + `
        <label>Amount</label><input id="act-amount" type="number" value="${escapeHtml(String(side.max))}" min="${escapeHtml(String(side.min))}" max="${escapeHtml(String(side.max))}">
        <button class="btn" id="act-btn" style="width:100%;margin-top:0.5rem" onclick="actOnOrder('${env.kind}')">${verb} now</button>
        <p class="small" id="act-status"></p>
        <p class="small error" id="act-err"></p>
      `)}</div>`;
    }
    return;
  }

  if (env.kind === 'offer') {
    const offer = env.docs.find(d => d.type === 'offer') || env.docs[0];
    // Give the accept flow the same shape Discover produces.
    const o = offer ? { ...offer, bank: env.bank, bank_url: env.bank_url } : null;
    const known = await knownVouchers().catch(() => []);
    const nm = {}; known.forEach(v => { nm[v.hash] = v.name; });
    const name = (h) => h ? (nm[h] || h.slice(0, 8) + '…') : '';
    const give = o && o.debit ? `give ${escapeHtml(String(o.debit.max))} ${escapeHtml(name(o.debit.voucher))}` : '';
    const get = o && o.credit ? `get ${escapeHtml(String(o.credit.max))} ${escapeHtml(name(o.credit.voucher))}` : '';
    const summary = [give, get].filter(Boolean).join(' · ') || 'offer';
    const twoSided = o && o.debit && o.credit;
    const inner = `<h2>Trade offer</h2>${verified}
      <div class="card"><strong>${summary}</strong></div>`;
    if (!state.user) {
      sessionStorage.setItem('barter_pending', JSON.stringify({ action: 'view', kind: 'o', value }));
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card('offer', inner + `
        <a class="btn" style="display:block;text-align:center" href="#/register">Register to continue</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in to continue</a>
        ${otherBankCta('o', value, env.bank_url)}`)}</div>`;
    } else if (twoSided) {
      window.__landingOffer = o;
      app.innerHTML = header('Offer') + `<div class="container" style="max-width:480px">${card('offer', inner + `
        <button class="btn" style="width:100%" onclick="acceptSwap(window.__landingOffer, this)">Accept swap</button>`)}</div>`;
    } else {
      app.innerHTML = header('Offer') + `<div class="container" style="max-width:480px">${card('offer', inner + `
        <p class="small">This is a one-sided offer — open it as an invoice or cheque link to pay or claim.</p>`)}</div>`;
    }
    return;
  }

  if (env.kind === 'invite') {
    app.innerHTML = `<div class="container" style="max-width:420px;padding-top:6vh">${card('You\'re invited', `
      ${verified}
      <p class="small">Someone invited you to barter on ${escapeHtml(state.bankName || 'this bank')}.</p>
      ${state.user
        ? '<a class="btn" style="display:block;text-align:center" href="#/">Go to your dashboard</a>'
        : '<a class="btn" style="display:block;text-align:center" href="#/register">Create an account</a><a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in</a>'}`)}</div>`;
    return;
  }

  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Barter Link', `<p>Kind: ${escapeHtml(env.kind)}</p>${verified}<p><a href="#/">Home</a></p>`)}</div>`;
}

// Redirect a recipient who banks ELSEWHERE to the same landing on their own
// bank, carrying the source bank as the scan origin so the doc still resolves.
// (The cross-bank claim then works via actOnOrder, which addresses the voucher's
// issuing bank directly.) Same-origin sessionStorage carries the origin across
// the redirect in the current path-based federation.
window.useOtherBank = function(kind, value, sourceUrl) {
  const url = window.prompt('Enter your bank\'s URL (e.g. https://…/alice):', '');
  if (!url) return;
  const clean = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(clean)) { toast('Enter a full https:// bank URL', 'error'); return; }
  // Carry the source bank as a ?src= query param so it survives a cross-ORIGIN
  // redirect (sessionStorage is per-origin). Also set sessionStorage as a
  // same-origin fallback. boot seeds the scan origin from ?src=.
  try { if (sourceUrl) sessionStorage.setItem('barter_scan_origin', sourceUrl); } catch { /* ignore */ }
  const q = sourceUrl ? `?src=${encodeURIComponent(sourceUrl)}` : '';
  location.href = `${clean}/ui/app${q}#/land/${kind}/${value}`;
};
function otherBankCta(kind, value, sourceUrl) {
  return `<p class="small" style="text-align:center;margin-top:0.75rem">
    <a href="#" onclick="useOtherBank('${jsStr(kind)}','${jsStr(value)}','${jsStr(sourceUrl || '')}');return false">Use my account at another bank</a></p>`;
}

// Add an issuer to the trusted list (+ their bank to known banks). The pubkey,
// handle and bank ride on the button's data-* attributes so nothing scanned is
// interpolated into inline JS.
window.applyTrust = async function(btn) {
  const pubkey = btn.dataset.pk;
  const handle = btn.dataset.handle || '';
  const bank = btn.dataset.bank || '';
  const bankUrl = btn.dataset.bankurl || '';
  try {
    const noteEl = document.getElementById('trust-note');
    const note = noteEl ? noteEl.value.trim() : '';
    await uiPost('/trusted', { pubkey, note });
    if (bank && bankUrl && bank !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: bank, url: bankUrl }).catch(() => {});
    }
    sessionStorage.removeItem('barter_pending');
    toast(`You now trust ${handle || pubkey.slice(0, 12)}`);
    location.hash = '#/network';
    route();
  } catch (e) {
    toast(e.message, 'error');
  }
};

// Execute a scanned invoice (pay it) or cheque (claim it): build the matching
// one-sided Order, submit it, and propose the deal at this bank.
window.actOnOrder = async function(kind) {
  const err = document.getElementById('act-err');
  const btn = document.getElementById('act-btn');
  const statusEl = document.getElementById('act-status');
  const original = btn ? btn.textContent : '';
  const step = (t) => { if (statusEl) statusEl.textContent = t; };
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  if (err) err.textContent = '';
  try {
    step('Verifying the signed documents…');
    const pending = JSON.parse(sessionStorage.getItem('barter_pending') || '{}');
    const { env } = await fetchBarterEnvelope(pending.kind, pending.value);
    verifyEnvelope(env);
    const theirOrder = env.docs.find(d => d.type === 'order');
    const theirHash = hashDoc(theirOrder);
    const side = kind === 'invoice' ? theirOrder.credit : theirOrder.debit;
    // Validate against the order's min–max instead of silently coercing a blank
    // or out-of-range value to the max.
    const raw = document.getElementById('act-amount').value.trim();
    const amount = raw === '' ? side.max : Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a valid amount');
    if (amount < (side.min || 0) || amount > side.max) {
      throw new Error(`Amount must be between ${side.min || 0} and ${side.max}`);
    }

    // Everything about this action lives at the VOUCHER'S issuing bank (the
    // `bank` the signed Order pins for this side): the voucher doc, the
    // counterparty's Order, my account, the records. That bank may not be the
    // bank this SPA is logged into — resolve it and address it directly.
    step('Locating the voucher’s bank…');
    const vbank = await resolveVoucherBank(side, env);
    // Pin a foreign bank so its balances show up on the dashboard afterwards.
    if (vbank.pubkey !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: vbank.pubkey, url: vbank.url }).catch(() => {});
    }
    step('Preparing your account…');

    // My side mirrors theirs: pay an invoice with a debit-only (cheque) Order;
    // claim a cheque with a credit-only (receiving) Order.
    // Reuse an existing account on this voucher AT THAT BANK when possible —
    // paying MUST debit a funded account, and scattering balance across
    // per-deal accounts would strand it.
    let accountHash = null;
    const docs = [];
    try {
      const mine = await rpcCallAt(vbank.url, vbank.pubkey, 'list_accounts', {});
      const candidates = (mine.accounts || []).filter(a => a.voucher === side.voucher).map(a => hashDoc(a));
      if (kind === 'invoice') {
        for (const h of candidates) {
          const bal = await rpcCallAt(vbank.url, vbank.pubkey, 'get_account_balance', { account_hash: h }).catch(() => null);
          if (bal && (bal.current - bal.pending) >= amount) { accountHash = h; break; }
        }
        if (!accountHash) throw new Error(`insufficient balance: you need ${amount} of this voucher at its bank to pay`);
      } else if (candidates.length > 0) {
        accountHash = candidates[0];
      }
    } catch (e) {
      if (String(e.message).includes('insufficient balance')) throw e;
      /* account listing unavailable — fall through to a fresh account */
    }
    if (!accountHash) {
      const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: kind === 'invoice' ? 'paying' : 'receiving', voucher: side.voucher };
      account.sig = signDoc(account, state.user.privateKey);
      accountHash = hashDoc(account);
      docs.push(account);
    }
    const mySide = { account: accountHash, voucher: side.voucher, bank: side.bank, min: amount, max: amount };
    const order = kind === 'invoice'
      ? { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1, debit: mySide, lead: true }
      : { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1, credit: mySide, lead: false };
    order.sig = signDoc(order, state.user.privateKey);
    const myHash = hashDoc(order);
    docs.push(order);
    step('Submitting your signed order…');
    await rpcCallAt(vbank.url, vbank.pubkey, 'submit_docs', { docs });

    // giver = the debit-only order, receiver = the credit-only order. The deal
    // is proposed AT the voucher's bank, which holds both orders.
    const giver = kind === 'invoice' ? myHash : theirHash;
    const receiver = kind === 'invoice' ? theirHash : myHash;
    step('Proposing the deal — banks will settle it…');
    const res = await signedRequestAt(vbank.url, 'POST', '/propose_deal', {
      offer1: { hash: giver, debit_amount: amount, credit_amount: amount },
      offer2: { hash: receiver, debit_amount: amount, credit_amount: amount },
      banks: [{ pubkey: vbank.pubkey, url: vbank.url }],
    });
    sessionStorage.removeItem('barter_pending');
    rememberDealBank(res.deal_id, vbank);
    step('');
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    step('');
    if (btn) { btn.disabled = false; btn.textContent = original; }
    if (err) err.textContent = e.message; else toast(e.message, 'error');
  }
};

// After register/unlock, resume whatever the landing page wanted to do.
function resumePendingAction() {
  const raw = sessionStorage.getItem('barter_pending');
  if (!raw) return false;
  try {
    const pending = JSON.parse(raw);
    // 'view' (a profile) and invoice/cheque all resume by RETURNING to the
    // landing — where the explicit Trust / Pay / Claim button is shown. Nothing
    // executes automatically just because the user signed in.
    if (pending.action === 'view' || pending.action === 'invoice' || pending.action === 'cheque') {
      sessionStorage.removeItem('barter_pending');
      location.hash = `#/land/${pending.kind}/${pending.value}`;
      route();
      return true;
    }
  } catch { sessionStorage.removeItem('barter_pending'); }
  return false;
}

// ---------------- activity ----------------

async function renderActivity(app) {
  let history = { events: [] }, failed = false;
  try { history = await uiGet('/history?limit=100'); } catch { failed = true; }
  app.innerHTML = header('Activity') + `<div class="container">
    ${card('Transaction history', failed ? loadError('your activity') : (history.events.map(e => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0;align-items:center">
        <a class="mono small" href="#/deal/${escapeHtml(e.deal_id)}">${escapeHtml(e.deal_id.slice(0, 12))}…</a>
        <span>${e.direction === 'credit' ? '↓ received' : '↑ sent'} ${escapeHtml(String(e.amount))} ${escapeHtml(e.voucher_name || e.voucher.slice(0, 8))}</span>
        <span class="chip state-${escapeHtml(e.state)}">${escapeHtml(e.state)}</span>
      </div>
    `).join('') || '<p class="small">No activity yet</p>'))}
  </div>`;
}

// ---------------- network (banks + trusted issuers + contacts) --------------

async function renderNetwork(app) {
  // Track load failure so a bank outage doesn't masquerade as "nobody trusted /
  // no peers / no contacts".
  let failed = false;
  const onFail = () => { failed = true; return []; };
  const [banks, trusted, contacts, follows] = await Promise.all([
    uiGet('/banks').catch(onFail),
    uiGet('/trusted').catch(onFail),
    uiGet('/contacts').catch(onFail),
    uiGet('/follows').catch(onFail),
  ]);
  // Resolve handles/vouchers for trusted issuers across our bank + pinned banks
  // (a foreign issuer only resolves at their own bank). Entries are
  // {pubkey, note} (legacy bare strings still tolerated).
  const bases = [state.bankUrl || state.basePath];
  (banks || []).forEach(b => { if (b.url && !bases.includes(b.url)) bases.push(b.url); });
  const resolved = await Promise.all(trusted.map(async t => {
    const pk = typeof t === 'string' ? t : t.pubkey;
    const note = typeof t === 'string' ? '' : (t.note || '');
    const r = await resolveIssuerAt(bases, pk);
    return { ...r, pubkey: pk, note };
  }));

  // Following is a separate list from trusting: you can read someone without
  // vouching for their currency, and vice versa.
  const followed = await Promise.all((follows || []).map(async pk => {
    if (pk === state.bankPubkey) {
      return { pubkey: pk, handle: `${state.bankName} (your bank)`, isBank: true };
    }
    if (state.user && pk === state.user.pubkey) return { pubkey: pk, handle: 'you', isSelf: true };
    const r = await resolveIssuerAt(bases, pk).catch(() => null);
    return { pubkey: pk, handle: (r && r.handle) || '' };
  }));

  app.innerHTML = header('Network') + `<div class="container">
    ${card('Following', `
      <p class="small">Whose posts show up in your feed. Separate from trust — reading someone is not the same as accepting their currency. You follow your bank by default, which reposts everything its users publish.</p>
      ${followed.map(f => `
        <div class="flex" style="justify-content:space-between;align-items:center;margin:0.5rem 0;padding-bottom:0.5rem;border-bottom:1px solid var(--border)">
          <span>${escapeHtml(f.handle || '')} <span class="mono small">${escapeHtml(f.pubkey.slice(0, 16))}…</span></span>
          ${f.isSelf ? '<span class="small">always</span>'
            : `<button class="btn danger" onclick="unfollowAuthor('${jsStr(f.pubkey)}')">Unfollow</button>`}
        </div>`).join('') || (failed ? loadError('your follows') : '<p class="small">Following nobody. Your feed will be empty until you follow someone — start with <a href="#/registry">the registry</a>.</p>')}
      <label for="n-follow-pk">Follow a pubkey</label><input id="n-follow-pk" placeholder="base58 pubkey">
      <button class="btn" onclick="addFollow()">Follow</button>
    `)}
    ${card('Trusted issuers', resolved.map(r => `
      <div style="margin:0.5rem 0;padding-bottom:0.5rem;border-bottom:1px solid var(--border)">
        <div class="flex" style="justify-content:space-between;align-items:center">
          <span>${escapeHtml(r.handle || '')} <span class="mono small">${escapeHtml(r.pubkey.slice(0, 16))}…</span>
            <span class="small">${(r.vouchers || []).length} voucher(s)</span></span>
          <span>
            <button class="btn secondary" data-pk="${escapeHtml(r.pubkey)}" data-note="${escapeHtml(r.note || '')}" onclick="editTrustNote(this)">Note</button>
            <button class="btn secondary" onclick="showShare('i', '${jsStr(r.pubkey)}', 'Issuer profile', '${jsStr(r.bank_url || '')}')">QR</button>
            <button class="btn danger" onclick="untrust('${jsStr(r.pubkey)}')">Remove</button>
          </span>
        </div>
        ${r.note ? `<p class="small" style="margin:0.3rem 0 0;font-style:italic">&ldquo;${escapeHtml(r.note)}&rdquo;</p>` : ''}
      </div>
    `).join('') || (failed ? loadError('your network') : '<p class="small">Nobody trusted yet. Scan a friend&#39;s profile QR to start.</p>'))}
    ${card('Add trusted issuer', `
      <label for="n-trust-pk">Issuer pubkey</label><input id="n-trust-pk" placeholder="base58 pubkey">
      <label for="n-trust-note">Note <span class="small">(optional)</span></label>
      <textarea id="n-trust-note" rows="2" placeholder="e.g. met at the train station, seemed OK"></textarea>
      <button class="btn" onclick="addTrusted()">Trust</button>
    `)}
    ${card('Known banks', `
      <div class="small" style="margin-bottom:0.5rem">This bank: <span class="mono">${escapeHtml(state.bankPubkey.slice(0, 16))}…</span> ${escapeHtml(state.bankUrl)}</div>
      ${banks.map(b => `
        <div class="flex" style="justify-content:space-between;align-items:center;margin:0.4rem 0">
          <span class="mono small">${escapeHtml(b.pubkey.slice(0, 16))}… · ${escapeHtml(b.url)}</span>
          <button class="btn danger" onclick="removeBank('${jsStr(b.pubkey)}')">Remove</button>
        </div>
      `).join('') || (failed ? loadError('known banks') : '<p class="small">No peer banks pinned</p>')}
      <label for="n-bank-url">Bank URL</label><input id="n-bank-url" placeholder="https://…/bankname">
      <button class="btn" onclick="addBank()">Pin bank</button>
      <p class="small error" id="n-bank-err"></p>
    `)}
    ${card('Contacts', contacts.map(c => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
        <span>${escapeHtml(c.handle || '')} <span class="mono small">${escapeHtml((c.pubkey || '').slice(0, 16))}…</span></span>
        <button class="btn danger" onclick="removeContact('${jsStr(c.pubkey)}')">Remove</button>
      </div>
    `).join('') || (failed ? loadError('contacts') : '<p class="small">No contacts</p>'))}
  </div>`;
}

window.untrust = async function(pk) {
  try { await uiDelete(`/trusted/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.addTrusted = async function() {
  const pk = document.getElementById('n-trust-pk').value.trim();
  const noteEl = document.getElementById('n-trust-note');
  const note = noteEl ? noteEl.value.trim() : '';
  if (!pk) return;
  try { await uiPost('/trusted', { pubkey: pk, note }); toast('Trusted'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
// Edit (or clear) the note on an already-trusted issuer. The pubkey and current
// note ride on the button's data-* attributes (safely escaped at render time).
window.editTrustNote = async function(btn) {
  const pubkey = btn.dataset.pk;
  const cur = btn.dataset.note || '';
  const next = window.prompt('Note about this issuer (why do you trust them?)', cur);
  if (next === null) return; // cancelled
  try { await uiPost('/trusted', { pubkey, note: next }); toast('Note saved'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.removeBank = async function(pk) {
  try { await uiDelete(`/banks/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.addBank = async function() {
  const url = document.getElementById('n-bank-url').value.trim().replace(/\/$/, '');
  const err = document.getElementById('n-bank-err');
  try {
    // Pin pubkey+url together: fetch the bank's discovery doc first.
    const disc = await fetch(`${url}/barter-bank.json`).then(r => r.json());
    if (!disc.pubkey) throw new Error('not a barter bank');
    await uiPost('/banks', { pubkey: disc.pubkey, url });
    toast(`Pinned ${disc.name || 'bank'}`);
    route();
  } catch (e) { err.textContent = e.message; }
};
window.removeContact = async function(pk) {
  try { await uiDelete(`/contacts/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};

// ---------------- install (add to home screen) ----------------

// Chromium fires `beforeinstallprompt` when the app qualifies for installation,
// and that event object is the ONLY way to open the install dialog — so it is
// captured here and replayed when the user asks for it. WebKit never fires it:
// on iOS installing goes through the Share sheet, so there we show the steps.
let installEvent = null;
let installSlotShows = null; // which variant the live #install-slot is showing
const INSTALL_SNOOZE_KEY = 'barter.install_snoozed';
const INSTALL_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

function isInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      navigator.standalone === true;
  } catch { return navigator.standalone === true; }
}

function isIosDevice() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports a Mac user agent; touch points disambiguate it.
  return /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function installSnoozed() {
  try {
    const at = Number(localStorage.getItem(INSTALL_SNOOZE_KEY) || 0);
    return at > 0 && Date.now() - at < INSTALL_SNOOZE_MS;
  } catch { return false; }
}

// What we can actually offer: a real install dialog, hand-holding through the
// iOS Share sheet, or (Firefox, desktop Safari) nothing actionable — in which
// case the home-screen banner stays away rather than sending users hunting.
function installOffer() {
  if (isInstalled()) return 'installed';
  if (installEvent) return 'prompt';
  if (isIosDevice()) return 'ios';
  return 'none';
}

const IOS_SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M12 15V4"/><path d="m8.5 7.5 3.5-3.5 3.5 3.5"/><path d="M6 11.5H5.5A1.5 1.5 0 0 0 4 13v6.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V13a1.5 1.5 0 0 0-1.5-1.5H18"/></svg>';

const IOS_STEPS = `<ol class="install-steps">
  <li>Tap the Share button ${IOS_SHARE_ICON} in the browser toolbar.</li>
  <li>Scroll down and choose <b>Add to Home Screen</b>.</li>
</ol>`;

// `variant` is 'banner' (dashboard/welcome — dismissible, hidden when there is
// nothing to offer) or 'settings' (always states where you stand).
function installCardHtml(variant) {
  const offer = installOffer();
  const mark = '<div class="logo-mark"><span></span></div>';
  if (variant === 'banner') {
    if (installSnoozed() || (offer !== 'prompt' && offer !== 'ios')) return '';
    const action = offer === 'prompt'
      ? `<div class="flex" style="gap:0.5rem;flex-wrap:wrap">
           <button class="btn" onclick="installApp()">Install app</button>
           <button class="btn secondary" onclick="snoozeInstall()">Not now</button>
         </div>`
      : `${IOS_STEPS}
         <button class="btn secondary" onclick="snoozeInstall()">Got it</button>`;
    return `<div class="card install-card">${mark}
      <div class="install-body">
        <h3>Keep it on your home screen</h3>
        <p class="small">Install barter.game for a full-screen app with your
          scanner one tap away — same keys, same bank, no app store.</p>
        ${action}
      </div>
      <button class="install-close" onclick="snoozeInstall()"
        aria-label="Dismiss install suggestion" title="Dismiss">&times;</button>
    </div>`;
  }
  const body = offer === 'installed'
    ? '<p class="small">Running as an installed app. Your keys live in this app\'s browser storage — the encrypted keystore, never the key itself.</p>'
    : offer === 'prompt'
    ? `<p class="small">Add barter.game to your home screen: full-screen, launches from the lock screen, no app store.</p>
       <button class="btn secondary" onclick="installApp()">Install app</button>`
    : offer === 'ios'
    ? `<p class="small">Add barter.game to your home screen:</p>${IOS_STEPS}`
    : '<p class="small">This browser has no install prompt. Chrome, Edge or Safari on a phone can add barter.game to the home screen — or look for “Install app” in your browser menu.</p>';
  return `<div class="card">
    <h3>${offer === 'installed' ? 'Installed' : 'Install on your home screen'}</h3>
    ${body}
  </div>`;
}

// Rendered into a slot so a late `beforeinstallprompt` (it can arrive after the
// screen is painted) can fill it in without re-rendering the whole screen.
function installSlot(variant) {
  installSlotShows = variant;
  return `<div id="install-slot">${installCardHtml(variant)}</div>`;
}

function repaintInstallSlot() {
  const slot = document.getElementById('install-slot');
  if (slot && installSlotShows) slot.innerHTML = installCardHtml(installSlotShows);
}

window.addEventListener('beforeinstallprompt', (e) => {
  // Suppress Chrome's own mini-infobar; we offer the install in context.
  e.preventDefault();
  installEvent = e;
  repaintInstallSlot();
});

window.addEventListener('appinstalled', () => {
  installEvent = null;
  try { localStorage.removeItem(INSTALL_SNOOZE_KEY); } catch { /* ignore */ }
  repaintInstallSlot();
  toast('Installed — look for barter.game on your home screen');
});

window.installApp = async function() {
  if (!installEvent) {
    toast('Use your browser menu → Install app', 'error');
    return;
  }
  // prompt() is single-use: once shown, this event is spent whatever the user
  // chooses. Chromium fires a fresh one on a later visit if they declined.
  const ev = installEvent;
  installEvent = null;
  try {
    ev.prompt();
    await ev.userChoice;
  } catch (e) {
    toast(e.message || 'Install prompt unavailable', 'error');
  }
  repaintInstallSlot();
};

window.snoozeInstall = function() {
  try { localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now())); } catch { /* ignore */ }
  // Dismissing removes the button that was just activated, so a keyboard user
  // would be left on <body>. Send focus back to the screen heading, the same
  // landing spot the router uses.
  const hadFocus = document.getElementById('install-slot')?.contains(document.activeElement);
  repaintInstallSlot();
  if (hadFocus) moveFocusToMain();
};

// The service worker exists so the install prompt can appear at all (Chromium
// requires a controlled page); it caches nothing — see sw.js.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker
    .register(`${state.basePath}/ui/sw.js`, { scope: `${state.basePath}/ui/` })
    .catch(() => { /* installability is a nice-to-have; the app works without it */ });
}

// ---------------- auto-lock ----------------

let lastActivity = Date.now();
let lockWarned = false;
const AUTOLOCK_MS = 10 * 60 * 1000;
const LOCK_WARN_MS = AUTOLOCK_MS - 60 * 1000; // warn 1 min before locking
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { lastActivity = Date.now(); lockWarned = false; }, { passive: true }));
setInterval(() => {
  if (!state.user) return;
  const idle = Date.now() - lastActivity;
  if (idle > AUTOLOCK_MS) {
    toast('Signed out after inactivity');
    window.logout();
  } else if (idle > LOCK_WARN_MS && !lockWarned) {
    // Warn before wiping the key so an in-progress form isn't lost silently.
    lockWarned = true;
    toast('Signing out in 1 minute due to inactivity — move to stay signed in', 'error');
  }
}, 15000);

// ---------------- boot ----------------

// A cross-bank landing redirect carries the source bank as ?src= (see
// useOtherBank) — seed the scan origin from it so a foreign doc resolves even
// across origins, where sessionStorage wouldn't have carried over.
try {
  const src = new URLSearchParams(location.search).get('src');
  if (src && /^https?:\/\//.test(src)) sessionStorage.setItem('barter_scan_origin', src);
} catch { /* ignore */ }

registerServiceWorker();

fetchConfig().then(async () => {
  // A refresh keeps the session: the seed is mirrored in sessionStorage (see
  // saveSession). A missing/stale /state is tolerated exactly like doConnect.
  if (restoreSession()) {
    state.uiState = await uiGet('/state').catch(() => null);
  }
  route();
}).catch(e => {
  document.getElementById('app').innerHTML = `<div class="container"><p class="error">Failed to load bank config: ${e.message}</p></div>`;
});
