import {
  base58Encode,
  canonicalize,
  canonicalizeWithoutSig,
  extForContentType,
  hashDoc,
  isValidBase58,
  isValidUlid,
  MEDIA_EXT_TYPES,
  newUlid,
  parseMediaRef,
  signDoc,
  verifyDoc,
  type Base58PubKey,
} from '@barter.game/protocol';
import {
  emptyUiState,
  getAccountBalance,
  getAddress,
  getHandleByPubkey,
  getHandleInfo,
  getKeystore,
  getMedia,
  getOffer,
  getOffersForOrder,
  getOrder,
  getRecord,
  MEDIA_MAX_BYTES,
  storeMedia,
  getSignaturesForRecord,
  getUiState,
  getVoucher,
  listAccounts,
  listOrdersByHolder,
  listRecordHashesByAccount,
  listRecordsByDeal,
  listVouchers,
  listVouchersByIssuer,
  putUiState,
  registerHandle,
  resolveFollows,
  setKeystore,
  type KeystoreBlob,
  type UiState,
} from './db.ts';
import { claimReplayId } from './db.ts';
import { bankRpcCall, fetchDiscovery } from './peer.ts';
import type { Bank } from './types.ts';
import type { KvKey } from './kv.ts';
import { RpcError } from './error.ts';

class UiError extends RpcError {
  status: number;
  constructor(status: number, code: number, message: string) {
    super(code, message);
    this.status = status;
    this.name = 'UiError';
  }
}

const HANDLE_RE = /^[a-z0-9_-]{2,32}$/;
const HANDLE_RULE = 'handle must be 2-32 chars: lowercase letters, digits, _ or -';

type TrustedIssuer = { pubkey: Base58PubKey; note?: string; at?: number };

// Trusted-issuer entries may be legacy bare pubkey strings or {pubkey,note,at}
// objects. Normalize to objects so a user note can be added/edited uniformly.
function normTrustedIssuers(list: unknown): TrustedIssuer[] {
  if (!Array.isArray(list)) return [];
  const out: TrustedIssuer[] = [];
  for (const e of list) {
    if (typeof e === 'string') out.push({ pubkey: e });
    else if (e && typeof e === 'object' && typeof (e as TrustedIssuer).pubkey === 'string') {
      const t = e as TrustedIssuer;
      out.push({ pubkey: t.pubkey, note: t.note, at: t.at });
    }
  }
  return out;
}

export async function handleUiRequest(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const uiPath = url.pathname.slice(basePath.length);
    // Canonicalise /:bank/ui to /:bank/ui/ — a trailing slash is required for
    // installability, because both the service-worker and manifest scopes are
    // "/:bank/ui/" and scope matching is a plain string prefix: the slashless
    // URL is OUTSIDE its own app's scope, so the page loads uncontrolled and
    // Chromium never offers the install. The fragment (#/settings) is
    // reattached by the browser; the query string is carried over here.
    if (uiPath === '') {
      return new Response(null, {
        status: 308,
        headers: { Location: `${basePath}/${url.search}` },
      });
    }
    if (uiPath === '/' || uiPath.startsWith('/app/')) {
      return serveSpa(bank, basePath);
    }

    // Auth-required UI routes
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const authPubkey = await requireAuth(bank, request, basePath);

    if (uiPath === '/state') {
      if (request.method === 'GET') {
        const state = await getUiState(bank, authPubkey);
        return json(200, state);
      }
      if (request.method === 'PUT') {
        const body = await request.json() as UiState;
        if (body.pubkey !== authPubkey) throw new UiError(403, -32007, 'pubkey mismatch');
        const rev = await putUiState(bank, body, body.rev);
        return json(200, { rev });
      }
    }

    if (uiPath === '/trusted') {
      if (request.method === 'POST') {
        const body = await request.json() as { pubkey: string; note?: string };
        if (!isValidBase58(body.pubkey)) throw new UiError(422, -32012, 'invalid pubkey');
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : undefined;
        const state = await getUiState(bank, authPubkey);
        const trusted = normTrustedIssuers(state.trusted);
        const existing = trusted.find((t) => t.pubkey === body.pubkey);
        if (existing) {
          // Re-trusting an existing issuer updates its note (edit path).
          if (note !== undefined) existing.note = note || undefined;
        } else {
          trusted.push({ pubkey: body.pubkey, note: note || undefined, at: Date.now() });
        }
        state.trusted = trusted;
        const rev = await putUiState(bank, state);
        return json(200, { trusted, rev });
      }
      if (request.method === 'GET') {
        return json(200, normTrustedIssuers((await getUiState(bank, authPubkey)).trusted));
      }
    }
    const trustedDelete = uiPath.match(/^\/trusted\/([^/]+)$/);
    if (trustedDelete && request.method === 'DELETE') {
      const pk = trustedDelete[1]!;
      const state = await getUiState(bank, authPubkey);
      state.trusted = normTrustedIssuers(state.trusted).filter((t) => t.pubkey !== pk);
      const rev = await putUiState(bank, state);
      return json(200, { trusted: state.trusted, rev });
    }

    // --- follows (feed subscriptions) ---------------------------------
    // Separate from /trusted on purpose: following is editorial, trusting is
    // financial. GET applies the default-follow-your-bank migration.
    if (uiPath === '/follows') {
      if (request.method === 'GET') {
        return json(200, resolveFollows(bank, await getUiState(bank, authPubkey)));
      }
      if (request.method === 'POST') {
        const body = await request.json() as { pubkey: string };
        if (!isValidBase58(body.pubkey)) throw new UiError(422, -32012, 'invalid pubkey');
        const state = await getUiState(bank, authPubkey);
        const follows = resolveFollows(bank, state);
        if (!follows.includes(body.pubkey)) follows.push(body.pubkey);
        state.follows = follows;
        const rev = await putUiState(bank, state);
        return json(200, { follows, rev });
      }
    }
    const followDelete = uiPath.match(/^\/follows\/([^/]+)$/);
    if (followDelete && request.method === 'DELETE') {
      const pk = followDelete[1]!;
      const state = await getUiState(bank, authPubkey);
      // Write the array back even when it becomes empty: `follows: []` is what
      // records "this user unfollowed everyone", and resolveFollows() only
      // re-seeds when the field was never set at all.
      state.follows = resolveFollows(bank, state).filter((f) => f !== pk);
      const rev = await putUiState(bank, state);
      return json(200, { follows: state.follows, rev });
    }

    if (uiPath === '/contacts') {
      return crudList(bank, authPubkey, 'contacts', request);
    }
    const contactsPath = uiPath.match(/^\/contacts\/([^/]+)$/);
    if (contactsPath) {
      return crudItem(bank, authPubkey, 'contacts', contactsPath[1]!, request, (item) => ({
        pubkey: item.pubkey,
        handle: item.handle,
        note: item.note,
      }));
    }

    if (uiPath === '/banks') {
      return crudList(bank, authPubkey, 'banks', request);
    }
    const banksPath = uiPath.match(/^\/banks\/([^/]+)$/);
    if (banksPath) {
      return crudItem(bank, authPubkey, 'banks', banksPath[1]!, request, (item) => ({
        pubkey: item.pubkey,
        url: item.url,
      }));
    }

    if (uiPath === '/prefs') {
      if (request.method === 'GET') {
        return json(200, (await getUiState(bank, authPubkey)).prefs);
      }
      if (request.method === 'PUT') {
        const body = await request.json() as Record<string, unknown>;
        const state = await getUiState(bank, authPubkey);
        state.prefs = body;
        const rev = await putUiState(bank, state);
        return json(200, { prefs: state.prefs, rev });
      }
    }

    if (uiPath === '/portfolio') {
      return handlePortfolio(bank, authPubkey);
    }
    if (uiPath === '/history') {
      return handleHistory(bank, authPubkey, url);
    }
    if (uiPath === '/orders') {
      return handleOrders(bank, authPubkey, url);
    }

    if (uiPath === '/discover') {
      return handleDiscover(bank, authPubkey, await request.json() as Record<string, unknown>);
    }

    if (uiPath === '/relay') {
      return handleRelay(bank, await request.json() as Record<string, unknown>);
    }
    if (uiPath === '/relay_signatures') {
      return handleRelaySignatures(bank, await request.json() as Record<string, unknown>);
    }

    if (uiPath === '/propose_deal') {
      return handleProposeDeal(bank, authPubkey, await request.json() as Record<string, unknown>);
    }
    const dealMatch = uiPath.match(/^\/deal\/([^/]+)$/);
    if (dealMatch && request.method === 'GET') {
      return handleDealStatus(bank, authPubkey, dealMatch[1]!);
    }

    // keystore rotation
    if (uiPath === '/keystore' && request.method === 'PUT') {
      const body = await request.json() as { keystore: KeystoreBlob };
      const handle = await getHandleByPubkey(bank, authPubkey);
      if (!handle) throw new UiError(403, -32007, 'pubkey not registered');
      await setKeystore(bank, authPubkey, body.keystore);
      return json(200, { handle, rotated_at: Date.now() });
    }

    return notFound();
  } catch (e) {
    if (e instanceof UiError) {
      return json(e.status, { code: e.code, message: e.message });
    }
    if (e instanceof RpcError) {
      return json(400, { code: e.code, message: e.message });
    }
    console.error('UI error', e);
    return json(500, { code: -32603, message: 'internal error' });
  }
}

// Public auth & keystore routes (no outer auth required)
export async function handlePublicUiRoute(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const uiPath = url.pathname.slice(basePath.length);

  const handleMatch = uiPath.match(/^\/handle\/([^/]+)$/);
  if (handleMatch && request.method === 'GET') {
    const handle = handleMatch[1]!;
    if (!HANDLE_RE.test(handle)) {
      return json(400, { code: -32600, message: HANDLE_RULE });
    }
    const info = await getHandleInfo(bank, handle);
    if (info.available) {
      return json(200, { handle, available: true });
    }
    return json(200, { handle, available: false, pubkey: info.pubkey });
  }

  if (uiPath === '/register' && request.method === 'POST') {
    return handleRegister(bank, await request.json() as Record<string, unknown>);
  }

  const keystoreMatch = uiPath.match(/^\/keystore\/([^/]+)$/);
  if (keystoreMatch && request.method === 'GET') {
    return handleKeystoreGet(bank, keystoreMatch[1]!);
  }

  if (uiPath === '/challenge' && request.method === 'GET') {
    return json(200, { nonce: newUlid(), exp: Date.now() + 120000 });
  }

  // Public bank config — the SPA fetches this during bootstrap, before any
  // user is unlocked, to learn the bank's pubkey/url. Same data as
  // /barter-bank.json; no auth required.
  if (uiPath === '/config' && request.method === 'GET') {
    return json(200, {
      pubkey: bank.pubkey,
      url: bank.url,
      name: bank.name,
      protocol_version: 'barter.game/v1',
    });
  }

  // Web app manifest — makes the SPA installable ("add to home screen").
  // Generated per bank rather than shipped as a static file because
  // start_url/scope/id must carry this bank's path prefix: two banks served by
  // one process install as two distinct apps, each confined to its own UI.
  if (uiPath === '/manifest.webmanifest' && request.method === 'GET') {
    return new Response(JSON.stringify(webManifest(bank, basePath), null, 2), {
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  // Service worker, served from the UI root so its scope covers the whole SPA
  // (a worker under /app/ could not control start_url). Installability requires
  // it; it caches nothing — see apps/web/sw.js.
  if (uiPath === '/sw.js' && request.method === 'GET') {
    const read = await bank.assets.read('sw.js');
    if (!read) return notFound();
    return new Response(new Uint8Array(read), {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        // Never serve a stale worker: it is the one script that can outlive
        // a deploy and keep controlling clients.
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': `${basePath}/`,
      },
    });
  }

  // Public issuer resolution — everything this bank knows about a pubkey:
  // handle, newest Address doc, vouchers issued. Used by profile landing
  // pages, the Network screen, and webapp QR scans. Read-only public data.
  const resolveMatch = uiPath.match(/^\/resolve\/([^/]+)$/);
  if (resolveMatch && request.method === 'GET') {
    const pk = resolveMatch[1]!;
    if (!isValidBase58(pk)) {
      return json(400, { code: -32600, message: 'invalid pubkey' });
    }
    const [handle, address, vouchers] = await Promise.all([
      getHandleByPubkey(bank, pk),
      getAddress(bank, pk),
      listVouchersByIssuer(bank, pk),
    ]);
    return json(200, {
      pubkey: pk,
      handle: handle ?? null,
      address: address ?? null,
      vouchers,
      bank: bank.pubkey,
      bank_url: bank.url,
    });
  }

  return null;
}

// --- auth ------------------------------------------------------------------

async function requireAuth(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Base58PubKey> {
  const header = request.headers.get('X-Barter-Auth');
  if (!header) throw new UiError(401, -32001, 'missing X-Barter-Auth');
  const [docB64, sig] = header.split('.');
  if (!docB64 || !sig) throw new UiError(400, -32600, 'malformed auth header');
  let authdoc: Record<string, unknown>;
  try {
    const bytes = base64urlDecode(docB64);
    authdoc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UiError(400, -32600, 'authdoc decode failed');
  }
  if (
    typeof authdoc.pubkey !== 'string' ||
    typeof authdoc.method !== 'string' ||
    typeof authdoc.path !== 'string' ||
    typeof authdoc.id !== 'string' ||
    typeof authdoc.ts !== 'number'
  ) {
    throw new UiError(400, -32600, 'authdoc missing fields');
  }
  if (authdoc.method !== request.method) {
    throw new UiError(400, -32001, 'method mismatch');
  }
  // The client signs pathname + query so query params are tamper-proof too.
  const reqUrl = new URL(request.url);
  const expectedPath = reqUrl.pathname + reqUrl.search;
  if (authdoc.path !== expectedPath) {
    throw new UiError(400, -32001, 'path mismatch');
  }
  if (!verifyDoc(authdoc, sig, authdoc.pubkey)) {
    throw new UiError(401, -32001, 'invalid auth signature');
  }
  if (Math.abs(Date.now() - authdoc.ts) > 120000) {
    throw new UiError(408, -32006, 'timestamp skew');
  }
  // `request.body` being non-null does NOT mean a body was sent: some HTTP
  // clients (Deno's fetch among them) attach an empty stream to a bodyless
  // DELETE, where a browser attaches none. Hashing that empty string produced
  // a digest the client never signed — it signs `body_sha256: null` when there
  // is no body — so every DELETE route (trusted, contacts, banks, follows) was
  // unreachable from anything but a browser. An empty body binds nothing, so
  // treat "no bytes" as "no body" regardless of how the stream arrives.
  const bodyText = request.body ? await request.clone().text() : '';
  const bodyHash = bodyText.length > 0 ? await sha256Base58(bodyText) : undefined;
  if (bodyHash !== undefined && authdoc.body_sha256 !== bodyHash) {
    throw new UiError(400, -32600, 'body hash mismatch');
  }
  if (bodyHash === undefined && authdoc.body_sha256 !== undefined && authdoc.body_sha256 !== null) {
    throw new UiError(400, -32600, 'body hash mismatch');
  }
  const claimed = await claimReplayId(bank, authdoc.pubkey, authdoc.id, bank.pubkey);
  if (!claimed) throw new UiError(409, -32002, 'replay');
  return authdoc.pubkey;
}

// --- registration / keystore ----------------------------------------------

async function handleRegister(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const handle = body.handle;
  const pubkey = body.pubkey;
  const proof = body.proof;
  const keystore = body.keystore;
  if (
    typeof handle !== 'string' ||
    typeof pubkey !== 'string' ||
    typeof proof !== 'string' ||
    !keystore ||
    typeof keystore !== 'object' ||
    Array.isArray(keystore)
  ) {
    return json(400, { code: -32600, message: 'invalid register body' });
  }
  if (!HANDLE_RE.test(handle)) {
    return json(400, { code: -32600, message: HANDLE_RULE });
  }
  if (!isValidBase58(pubkey)) {
    return json(422, { code: -32012, message: 'invalid pubkey' });
  }
  const info = await getHandleInfo(bank, handle);
  if (!info.available) {
    return json(409, { code: -32008, message: 'handle taken' });
  }
  const existingHandle = await getHandleByPubkey(bank, pubkey);
  if (existingHandle) {
    return json(409, { code: -32009, message: 'pubkey already registered' });
  }
  const keystoreHash = hashDoc(keystore);
  const signed = canonicalize({ handle, pubkey, keystore_sha256: keystoreHash });
  if (!verifyDoc(JSON.parse(signed), proof, pubkey)) {
    return json(401, { code: -32001, message: 'proof signature invalid' });
  }
  await registerHandle(bank, handle, pubkey, keystore as KeystoreBlob);
  return json(201, { handle, pubkey });
}

async function handleKeystoreGet(bank: Bank, handle: string): Promise<Response> {
  if (!HANDLE_RE.test(handle)) {
    return json(400, { code: -32600, message: HANDLE_RULE });
  }
  // Simple rate limiter keyed by handle (5/min).
  const key: KvKey = [bank.pubkey, 'rl_keystore', handle];
  const now = Date.now();
  const bucket = await bank.kv.get<{ count: number; window: number }>(key);
  const current = bucket.value ?? { count: 0, window: now };
  if (now - current.window > 60000) {
    current.count = 0;
    current.window = now;
  }
  current.count += 1;
  if (current.count > 5) {
    return json(429, { code: -32010, message: 'rate limited', retry_after: 60 });
  }
  await bank.kv.set(key, current, { expireIn: 120000 });
  const ks = await getKeystore(bank, handle);
  if (!ks) return json(404, { code: -32005, message: 'unknown handle' });
  return json(200, { handle, pubkey: ks.pubkey, keystore: ks.keystore });
}

// --- sub-resource CRUD helpers --------------------------------------------

type SubResource = 'trusted' | 'contacts' | 'banks';

async function crudList(
  bank: Bank,
  pubkey: Base58PubKey,
  field: Exclude<SubResource, 'trusted'>,
  request: Request,
): Promise<Response> {
  const state = await getUiState(bank, pubkey);
  if (request.method === 'GET') {
    return json(200, state[field]);
  }
  if (request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const arr = state[field] as Array<Record<string, unknown>>;
    const existing = arr.findIndex((x) => x.pubkey === body.pubkey);
    if (existing >= 0) arr[existing] = { ...arr[existing], ...body };
    else arr.push(body);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: arr, rev });
  }
  return json(405, { code: -32600, message: 'method not allowed' });
}

async function crudItem(
  bank: Bank,
  pubkey: Base58PubKey,
  field: Exclude<SubResource, 'trusted'>,
  itemPubkey: string,
  request: Request,
  normalize: (item: Record<string, unknown>) => Record<string, unknown>,
): Promise<Response> {
  if (!isValidBase58(itemPubkey)) {
    return json(422, { code: -32012, message: 'invalid pubkey' });
  }
  const state = await getUiState(bank, pubkey);
  const arr = state[field] as Array<Record<string, unknown>>;
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await request.json() as Record<string, unknown>;
    const normalized = normalize({ ...body, pubkey: itemPubkey });
    const idx = arr.findIndex((x) => x.pubkey === itemPubkey);
    if (idx >= 0) arr[idx] = normalized;
    else arr.push(normalized);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: arr, rev });
  }
  if (request.method === 'DELETE') {
    (state[field] as unknown[]) = arr.filter((x) => x.pubkey !== itemPubkey);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: state[field], rev });
  }
  return json(405, { code: -32600, message: 'method not allowed' });
}

// --- aggregation ----------------------------------------------------------

async function handlePortfolio(bank: Bank, pubkey: Base58PubKey): Promise<Response> {
  const rows = await listAccounts(bank, pubkey);
  const holdings = rows.map((r) => ({
    bank: bank.pubkey,
    voucher: r.account.voucher,
    name: r.voucher?.name ?? 'Unknown',
    account: hashDoc(r.account),
    current: r.balance,
    pending: 0, // computed per account below
    issuer: r.voucher?.pubkey ?? '',
  }));
  for (const h of holdings) {
    const bal = await getAccountBalance(bank, h.account);
    if (bal) {
      h.current = bal.current;
      h.pending = bal.pending;
    }
  }
  return json(200, { as_of: Date.now(), holdings, unreachable: [] });
}

async function handleHistory(
  bank: Bank,
  pubkey: Base58PubKey,
  url: URL,
): Promise<Response> {
  const rows = await listAccounts(bank, pubkey);
  const events: {
    deal_id: string;
    record: string;
    pair: string;
    voucher: string;
    amount: number;
    direction: string;
    state: string;
    signatures: string[];
  }[] = [];
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 200);
  for (const { account } of rows) {
    const accountHash = hashDoc(account);
    // Via db.ts so the key carries the storage-schema component — the raw
    // prefix scan this replaced missed it and always came back empty. The
    // limit keeps an account with a long history from being read in full
    // just to fill one page.
    const remaining = limit - events.length;
    for (const hash of await listRecordHashesByAccount(bank, accountHash, remaining)) {
      const rec = await getRecord(bank, hash);
      if (!rec) continue;
      const sigs = await getSignaturesForRecord(bank, hash);
      const state = sigs.some((s) => s.action === 'settle')
        ? 'settled'
        : sigs.some((s) => s.action === 'hold')
        ? 'held'
        : sigs.some((s) => s.action === 'ready')
        ? 'approved'
        : sigs.some((s) => s.action === 'reject')
        ? 'rejected'
        : 'created';
      events.push({
        deal_id: rec.details.deal_id,
        record: hash,
        pair: rec.details.pair,
        voucher: account.voucher,
        amount: rec.doc.amount,
        direction: rec.doc.type,
        state,
        signatures: sigs.map((s) => hashDoc(s)),
      });
      if (events.length >= limit) break;
    }
    if (events.length >= limit) break;
  }
  return json(200, { events, next_cursor: null });
}

async function handleOrders(bank: Bank, pubkey: Base58PubKey, url: URL): Promise<Response> {
  const wantKind = url.searchParams.get('kind'); // 'invoice' | 'cheque' | 'two-sided' | null
  const orders = await listOrdersByHolder(bank, pubkey);
  const out = [];
  for (const o of orders) {
    const hash = hashDoc(o);
    const kind = o.debit ? (o.credit ? 'two-sided' : 'cheque') : 'invoice';
    if (wantKind && kind !== wantKind) continue;
    const offers = await getOffersForOrder(bank, hash);
    out.push({
      order: hash,
      ulid: o.ulid,
      rate: o.rate,
      lead: o.lead,
      debit: o.debit,
      credit: o.credit,
      kind,
      offers,
      state: 'open',
      matched_deals: [],
    });
  }
  return json(200, { orders: out });
}

// --- discovery ------------------------------------------------------------

async function handleDiscover(
  bank: Bank,
  pubkey: Base58PubKey,
  body: Record<string, unknown>,
): Promise<Response> {
  const state = await getUiState(bank, pubkey);
  const banks = (body.banks as Array<{ pubkey: string; url: string }> | undefined) ??
    state.banks;
  const vouchers = (body.vouchers as string[] | undefined) ??
    state.catalog.map((c: unknown) => (c as { voucher: string }).voucher);
  const intentions = (body.intentions as Array<'sell' | 'buy'> | undefined) ?? ['sell', 'buy'];
  const out: Array<Record<string, unknown>> = [];
  const unreachable = [];
  for (const b of banks) {
    for (const v of vouchers) {
      for (const intention of intentions) {
        try {
          const res = await bankRpcCall(bank, b.url, b.pubkey, 'list_offers', {
            voucher_hash: v,
            intention,
          }) as { result?: unknown[]; error?: { message: string } };
          if (res.error) throw new Error(res.error.message);
          const offers = (res.result ?? []) as Array<Record<string, unknown>>;
          for (const o of offers) {
            out.push({
              offer: hashDoc(o),
              bank: b.pubkey,
              bank_url: b.url,
              intention,
              ...(o as Record<string, unknown>),
              discovered_at: Date.now(),
            });
          }
        } catch (e) {
          unreachable.push({ bank: b.pubkey, error: String(e) });
        }
      }
    }
  }
  return json(200, { as_of: Date.now(), offers: out, polled: banks.map((b) => b.pubkey), unreachable });
}

// --- relay ----------------------------------------------------------------

async function handleRelay(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const bankUrl = body.bank_url;
  const envelope = body.envelope;
  if (typeof bankUrl !== 'string' || !envelope || typeof envelope !== 'object') {
    return json(400, { code: -32602, message: 'bank_url and envelope required' });
  }
  const env = envelope as Record<string, unknown>;
  const to = env.to;
  if (typeof to !== 'string') {
    return json(400, { code: -32602, message: 'envelope.to required' });
  }
  const disc = await fetchDiscovery(bankUrl, to);
  if (!disc || disc.pubkey !== to) {
    return json(409, { code: -32013, message: 'pubkey pinning mismatch' });
  }
  try {
    const res = await fetch(`${bankUrl.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const payload = await res.json();
    return json(200, { ok: true, status: res.status, result: payload });
  } catch {
    return json(502, { ok: false, code: -32014, message: 'upstream unreachable' });
  }
}

async function handleRelaySignatures(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const from = body.from as { pubkey: string; url: string } | undefined;
  const to = body.to as { pubkey: string; url: string } | undefined;
  const hashes = body.record_hashes as string[] | undefined;
  if (!from || !to || !Array.isArray(hashes)) {
    return json(400, { code: -32602, message: 'from, to, record_hashes required' });
  }
  for (const peer of [from, to]) {
    const disc = await fetchDiscovery(peer.url, peer.pubkey);
    if (!disc || disc.pubkey !== peer.pubkey) {
      return json(409, { code: -32013, message: `pinning mismatch for ${peer.pubkey}` });
    }
  }
  const signatures: Array<Record<string, unknown>> = [];
  for (const h of hashes) {
    const res = await bankRpcCall(bank, from.url, from.pubkey, 'get_record_signatures', {
      record_hash: h,
    }) as { result?: { signatures: Array<Record<string, unknown>> } };
    const sigs = res.result?.signatures ?? [];
    signatures.push(...sigs);
  }
  if (signatures.length === 0) {
    return json(200, { ok: true, relayed: 0, advanced: false });
  }
  const pushRes = await bankRpcCall(bank, to.url, to.pubkey, 'notify_signatures', {
    signatures,
  }) as { result?: { advanced: boolean } };
  return json(200, {
    ok: true,
    relayed: signatures.length,
    advanced: pushRes.result?.advanced ?? false,
  });
}

// --- propose_deal ---------------------------------------------------------

async function handleProposeDeal(
  bank: Bank,
  authPubkey: Base58PubKey,
  body: Record<string, unknown>,
): Promise<Response> {
  const offer1Raw = body.offer1;
  const offer2Raw = body.offer2;
  let banksRaw = body.banks;
  if (
    !offer1Raw ||
    typeof offer1Raw !== 'object' ||
    Array.isArray(offer1Raw) ||
    !offer2Raw ||
    typeof offer2Raw !== 'object' ||
    Array.isArray(offer2Raw)
  ) {
    return json(400, { code: -32602, message: 'offer1 and offer2 required' });
  }

  const dealId = newUlid();

  // Resolve participating banks. Explicit body.banks is preferred; otherwise
  // try to derive from the two offers using the authenticated user's known banks.
  let banks: Array<{ pubkey: string; url: string }>;
  if (Array.isArray(banksRaw) && banksRaw.length > 0) {
    banks = banksRaw as Array<{ pubkey: string; url: string }>;
  } else {
    const userState = await getUiState(bank, authPubkey);
    const known = new Map((userState.banks as Array<{ pubkey: string; url: string }>).map((b) => [b.pubkey, b.url]));
    const resolved = new Map<string, string>();
    const offerHashes = [
      (offer1Raw as Record<string, unknown>).hash as string,
      (offer2Raw as Record<string, unknown>).hash as string,
    ];
    for (const h of offerHashes) {
      if (typeof h !== 'string') continue;
      for (const [pubkey, url] of known) {
        try {
          const res = await bankRpcCall(bank, url, pubkey, 'get_offer', { offer_hash: h }) as {
            result?: Record<string, unknown>;
            error?: { message: string };
          };
          if (res.result) {
            resolved.set(pubkey, url);
            break;
          }
        } catch {
          // continue searching
        }
      }
    }
    if (resolved.size < 2) {
      return json(422, {
        code: -32013,
        message: 'could not derive both participating banks from offers; add banks to your UI state or pass banks explicitly',
      });
    }
    banks = Array.from(resolved.entries()).map(([pubkey, url]) => ({ pubkey, url }));
  }

  // Validate bank discovery / pinning.
  for (const b of banks) {
    const disc = await fetchDiscovery(b.url, b.pubkey);
    if (!disc || disc.pubkey !== b.pubkey) {
      return json(409, { code: -32013, message: `pinning mismatch for ${b.pubkey}` });
    }
  }

  // Share Address docs among participating banks.
  const addresses: Array<Record<string, unknown>> = [];
  for (const b of banks) {
    const addr = await bankRpcCall(bank, b.url, b.pubkey, 'get_address', {
      pubkey: b.pubkey,
    }) as { result?: Record<string, unknown> };
    if (addr.result) addresses.push(addr.result);
  }
  for (const target of banks) {
    for (const addr of addresses) {
      const author = addr.pubkey as string;
      if (author === target.pubkey) continue;
      await bankRpcCall(bank, target.url, target.pubkey, 'submit_docs', {
        docs: [addr],
      });
    }
  }

  // Resolve the two holder Orders. `offer1`/`offer2` carry Order hashes plus the
  // amount each order gives (its debit voucher). order1 gives V1 (amount1) and
  // receives V2; order2 gives V2 (amount2) and receives V1.
  const o1 = offer1Raw as Record<string, unknown>;
  const o2 = offer2Raw as Record<string, unknown>;
  const order1Hash = o1.hash;
  const order2Hash = o2.hash;
  const amount1 = o1.debit_amount;
  const amount2 = o2.debit_amount;
  if (
    typeof order1Hash !== 'string' || typeof order2Hash !== 'string' ||
    typeof amount1 !== 'number' || typeof amount2 !== 'number'
  ) {
    return json(400, { code: -32602, message: 'offer1/offer2 need { hash, debit_amount }' });
  }
  const order1 = await getOrder(bank, order1Hash);
  const order2 = await getOrder(bank, order2Hash);
  if (!order1 || !order2) {
    return json(422, { code: -32005, message: 'this bank does not hold both orders' });
  }

  // Mint one record pair per TRANSFER, then send one Mandate per Order (the
  // giver's Order clears the debit record, the receiver's Order clears the
  // credit record). All signed by this bank as coordinator.
  //
  // The unit of iteration is the transfer, NOT the participating bank. A
  // two-sided swap moves two vouchers, and when both are issued by the SAME
  // bank both pairs must be minted at that one bank. Looping over `banks`
  // (as this once did) produced a single pair for a same-bank swap, leaving
  // the counterparty Order's legs unmandated — which `aggregateRateCheck`
  // correctly reads as the permanent missing-leg case and rejects the deal.
  //
  // counter_amount is only meaningful when a counter leg exists (the giver
  // receives something back / the receiver gives something back); for
  // one-sided pairings (invoice/cheque) the bank requires 0.
  type Transfer = {
    giver: string;
    receiver: string;
    amount: number;
    counter: number;
    bank: Base58PubKey;
  };
  const transfers: Transfer[] = [];
  if (order1.debit) {
    transfers.push({
      giver: order1Hash,
      receiver: order2Hash,
      amount: amount1,
      counter: (order1.credit || order2.debit) ? amount2 : 0,
      bank: order1.debit.bank,
    });
  }
  if (order2.debit) {
    transfers.push({
      giver: order2Hash,
      receiver: order1Hash,
      amount: amount2,
      counter: (order2.credit || order1.debit) ? amount1 : 0,
      bank: order2.debit.bank,
    });
  }
  if (transfers.length === 0) {
    return json(422, { code: -32000, message: 'neither order has a debit side; nothing to transfer' });
  }

  const banksByPubkey = new Map(banks.map((b) => [b.pubkey, b]));
  // Every issuing bank a transfer lands on must be a listed (and pinned) participant.
  for (const t of transfers) {
    if (!banksByPubkey.has(t.bank)) {
      return json(422, {
        code: -32000,
        message: `bank ${t.bank} issues a voucher in this deal but was not listed in banks`,
      });
    }
  }
  // ...and every listed bank must actually issue one of the vouchers.
  for (const b of banks) {
    if (!transfers.some((t) => t.bank === b.pubkey)) {
      return json(422, { code: -32000, message: `bank ${b.pubkey} issues neither voucher` });
    }
  }

  const records: Record<string, string[]> = {};
  const allRecordBodies: Array<Record<string, unknown>> = [];
  for (const t of transfers) {
    const b = banksByPubkey.get(t.bank)!;
    const res = await bankRpcCall(bank, b.url, b.pubkey, 'create_records', {
      giver: t.giver,
      receiver: t.receiver,
      amount: t.amount,
      counter_amount: t.counter,
      deal_id: dealId,
    }) as { result?: { records: Array<Record<string, unknown>> }; error?: { code: number; message: string } };
    if (res.error) {
      return json(502, { ok: false, code: res.error.code, message: res.error.message, bank: b.pubkey });
    }
    const recs = (res.result?.records ?? []) as Array<Record<string, unknown>>;
    // Accumulate: a same-bank swap mints two pairs at the same bank.
    (records[b.pubkey] ??= []).push(...recs.map((r) => hashDoc(r)));
    allRecordBodies.push(...recs);
  }

  // One Mandate per (Order, bank), each listing EVERY record satisfying that
  // Order across ALL banks (bank-rpc.md §2.1). The record bodies travel with
  // the Mandate so the receiving bank can verify the foreign legs — bodies
  // are bank-signed and their details stay an opaque hash.
  for (const [orderHash, orderDoc] of [[order1Hash, order1], [order2Hash, order2]] as const) {
    const orderBodies = allRecordBodies.filter((r) => r.order === orderHash);
    const orderHashes = orderBodies.map((r) => hashDoc(r));
    if (orderHashes.length === 0) continue;
    // A Mandate goes to every bank the Order names a side at (only those banks
    // hold the Order and records for it).
    const orderBanks = banks.filter((b) =>
      orderDoc.debit?.bank === b.pubkey || orderDoc.credit?.bank === b.pubkey);
    for (const b of orderBanks) {
      const mandate = {
        type: 'mandate',
        pubkey: bank.pubkey,
        ulid: newUlid(),
        deal_id: dealId,
        order: orderHash,
        bank: b.pubkey,
        records: orderHashes,
        sig: '',
      };
      mandate.sig = signDoc(mandate, bank.privateKey);
      await bankRpcCall(bank, b.url, b.pubkey, 'submit_mandate', {
        mandate,
        records: orderBodies,
      });
    }
  }

  return json(200, {
    deal_id: dealId,
    participating_banks: banks.map((b) => b.pubkey),
    records,
    state: 'mandated',
  });
}

function recordState(sigs: Array<{ action?: string }>): string {
  if (sigs.some((s) => s.action === 'reject')) return 'rejected';
  if (sigs.some((s) => s.action === 'settle')) return 'settled';
  if (sigs.some((s) => s.action === 'hold')) return 'held';
  if (sigs.some((s) => s.action === 'ready')) return 'approved';
  return 'created';
}

async function handleDealStatus(
  bank: Bank,
  authPubkey: Base58PubKey,
  dealId: string,
): Promise<Response> {
  if (!isValidUlid(dealId)) return json(400, { code: -32602, message: 'invalid deal_id' });
  const records = await listRecordsByDeal(bank, dealId);
  if (records.length === 0) return json(404, { code: -32005, message: 'deal not found' });
  const legs = [];
  let overall = 'mandated';
  for (const r of records) {
    const h = hashDoc(r.doc);
    const sigs = await getSignaturesForRecord(bank, h);
    const state = recordState(sigs);
    // Describe what the leg actually MOVES — direction, amount, voucher, and
    // whether it is the caller's own leg. Every record here is minted by this
    // bank, so repeating `bank` per leg told the reader nothing.
    const order = await getOrder(bank, r.doc.order);
    const side = r.doc.type === 'debit' ? order?.debit : order?.credit;
    const voucher = side ? await getVoucher(bank, side.voucher) : null;
    legs.push({
      bank: bank.pubkey,
      records: [h],
      state,
      ready: sigs.some((s) => s.action === 'ready'),
      hold: sigs.some((s) => s.action === 'hold'),
      settle: sigs.some((s) => s.action === 'settle'),
      direction: r.doc.type,
      amount: r.doc.amount,
      voucher: side?.voucher ?? null,
      voucher_name: voucher?.name ?? null,
      holder: r.details.holder,
      mine: r.details.holder === authPubkey,
    });
  }
  if (legs.length > 0) {
    if (legs.every((l) => l.state === 'settled')) overall = 'settled';
    else if (legs.some((l) => l.state === 'rejected')) overall = 'rejected';
    else if (legs.every((l) => l.state === 'held' || l.state === 'settled')) overall = 'held';
    else if (legs.every((l) => ['approved', 'held', 'settled'].includes(l.state))) overall = 'approved';
    else overall = 'created';
  }
  return json(200, { deal_id: dealId, state: overall, legs, updated_at: Date.now() });
}

// --- Barter Link routes ---------------------------------------------------

type BarterMatch = { kind: string; value: string };

function matchBarterRoute(pathname: string, basePath: string): BarterMatch | null {
  const p = pathname.slice(basePath.length);
  const m = p.match(/^\/(i|v|q|o|x)\/([^/]+)$/);
  if (!m) return null;
  return { kind: m[1]!, value: m[2]! };
}

export async function handleBarterLink(
  bank: Bank,
  request: Request,
  match: BarterMatch,
  wantsJson: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  if (wantsJson || url.searchParams.get('format') === 'json' || pathnameJson(url.pathname)) {
    return barterJson(bank, match);
  }
  return barterHtml(bank, match);
}

function pathnameJson(pathname: string): boolean {
  return pathname.endsWith('.json');
}

// Assemble the machine payload for a Barter Link. Every landing kind resolves
// to an envelope { v, kind, pubkey?, bank, bank_url, docs[] } whose docs are
// standard signed protocol documents the receiver verifies locally.
async function barterEnvelope(
  bank: Bank,
  match: BarterMatch,
): Promise<Record<string, unknown> | null> {
  const base = { v: 1, bank: bank.pubkey, bank_url: bank.url };
  if (match.kind === 'i') {
    const [vouchers, address, handle] = await Promise.all([
      listVouchersByIssuer(bank, match.value),
      getAddress(bank, match.value),
      getHandleByPubkey(bank, match.value),
    ]);
    return {
      ...base,
      kind: 'profile',
      pubkey: match.value,
      handle: handle ?? null,
      docs: [...(address ? [address] : []), ...vouchers],
    };
  }
  if (match.kind === 'o') {
    const offer = await getOffer(bank, match.value);
    if (!offer) return null;
    return { ...base, kind: 'offer', docs: [offer] };
  }
  if (match.kind === 'v' || match.kind === 'q') {
    const order = await getOrder(bank, match.value);
    if (!order) return null;
    // Enforce the specialization: /v is an invoice (credit-only), /q a cheque
    // (debit-only). A two-sided Order is not addressable via these routes.
    if (match.kind === 'v' && order.debit) return null;
    if (match.kind === 'q' && order.credit) return null;
    const handle = await getHandleByPubkey(bank, order.pubkey);
    // Include the referenced Voucher doc so the recipient can see what they are
    // paying/claiming by name, not just a hash. It is a normal signed doc the
    // client verifies like any other; omitted when issued at another bank.
    const side = (match.kind === 'v' ? order.credit : order.debit) as
      | { voucher?: string }
      | undefined;
    const voucher = side?.voucher ? await getVoucher(bank, side.voucher) : null;
    return {
      ...base,
      kind: match.kind === 'v' ? 'invoice' : 'cheque',
      pubkey: order.pubkey,
      handle: handle ?? null,
      docs: [order, ...(voucher ? [voucher] : [])],
    };
  }
  return { ...base, kind: 'invite', token: match.value, docs: [] };
}

async function barterJson(bank: Bank, match: BarterMatch): Promise<Response> {
  const envelope = await barterEnvelope(bank, match);
  if (!envelope) return notFound();
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { 'Content-Type': 'application/barter+json;v=1' },
  });
}

// Human landing page. Serves a real page for camera-browser visitors (register
// & trust / pay / claim CTAs into the SPA) while remaining a doc carrier: the
// signed payload is embedded via <script type="application/barter+json">,
// <link rel="alternate">, and flat barter:* meta tags, per the extraction
// precedence in docs/ui/claude-ui.md §5.
async function barterHtml(bank: Bank, match: BarterMatch): Promise<Response> {
  const envelope = await barterEnvelope(bank, match);
  if (!envelope) {
    return new Response(landingShell(bank, 'Not found', '<p class="muted">This Barter Link does not resolve at this bank.</p>', '', ''), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const payload = canonicalize(envelope);
  const selfPath = `/${bank.name}/${match.kind}/${match.value}`;
  const jsonHref = `${bank.url.replace(/\/[^/]+$/, '')}${selfPath}?format=json`;
  const appBase = `${bank.url}/ui/app`;

  let title = 'barter.game';
  let body = '';
  let cta = '';
  const kind = envelope.kind as string;

  if (kind === 'profile') {
    const handle = (envelope.handle as string | null) ?? shorten(match.value);
    const docs = envelope.docs as Array<Record<string, unknown>>;
    const vouchers = docs.filter((d) => d.type === 'voucher');
    title = `${handle} on barter.game`;
    body = `
      <h2>${escapeHtml(handle)}</h2>
      <p class="mono muted">${escapeHtml(shorten(match.value))} @ ${escapeHtml(bank.name)}</p>
      <p>invites you to barter. Their vouchers:</p>
      ${vouchers.length === 0 ? '<p class="muted">No vouchers published yet.</p>' : ''}
      ${vouchers.map((v) => `<div class="card"><b>${escapeHtml(String(v.name ?? ''))}</b>${v.description_md ? `<p class="muted">${escapeHtml(String(v.description_md))}</p>` : ''}</div>`).join('')}
    `;
    cta = `
      <a class="btn primary" href="${appBase}#/land/i/${escapeHtml(match.value)}">Register &amp; trust ${escapeHtml(handle)}</a>
      <a class="btn" href="${appBase}#/land/i/${escapeHtml(match.value)}">I already have an account</a>
    `;
  } else if (kind === 'invoice' || kind === 'cheque') {
    const docs = envelope.docs as Array<Record<string, unknown>>;
    const order = docs[0]!;
    const side = (kind === 'invoice' ? order.credit : order.debit) as Record<string, unknown>;
    const voucherDoc = docs.find((d) => d.type === 'voucher');
    const voucherName = voucherDoc?.name ? String(voucherDoc.name) : null;
    const handle = (envelope.handle as string | null) ?? shorten(String(order.pubkey));
    const verb = kind === 'invoice' ? 'Pay' : 'Claim';
    title = `${verb} ${handle} · barter.game`;
    body = `
      <h2>${kind === 'invoice' ? `Pay ${escapeHtml(handle)}` : `A cheque from ${escapeHtml(handle)}`}</h2>
      <p class="muted">${kind === 'invoice' ? 'This is a request for payment.' : 'You can claim voucher funds from this cheque.'}</p>
      <div class="card">
        <div>Amount: <b>${side.min === side.max ? escapeHtml(String(side.max)) : `${escapeHtml(String(side.min))}–${escapeHtml(String(side.max))}`}</b>${voucherName ? ` ${escapeHtml(voucherName)}` : ''}</div>
        <div class="mono muted">voucher ${voucherName ? `${escapeHtml(voucherName)} · ` : ''}${escapeHtml(shorten(String(side.voucher)))}</div>
        <div class="mono muted">${kind === 'invoice' ? 'payee' : 'payer'} ${escapeHtml(shorten(String(order.pubkey)))}</div>
      </div>
    `;
    cta = `
      <a class="btn primary" href="${appBase}#/land/${match.kind}/${escapeHtml(match.value)}">${verb} with barter.game</a>
      <a class="btn" href="${appBase}">What is this?</a>
    `;
  } else if (kind === 'offer') {
    title = 'Offer · barter.game';
    body = `<h2>A trade offer</h2><p class="muted">Open it in the app to see terms and accept.</p>`;
    cta = `<a class="btn primary" href="${appBase}#/land/o/${escapeHtml(match.value)}">View offer</a>`;
  } else {
    title = 'Invite · barter.game';
    body = `<h2>You are invited to barter</h2>`;
    cta = `<a class="btn primary" href="${appBase}">Open barter.game</a>`;
  }

  const head = `
  <title>${escapeHtml(title)}</title>
  <link rel="alternate" type="application/barter+json;v=1" href="${escapeHtml(jsonHref)}">
  <meta name="barter:version" content="1">
  <meta name="barter:type" content="${escapeHtml(kind)}">
  <meta name="barter:bank" content="${bank.pubkey}">
  ${envelope.pubkey ? `<meta name="barter:pubkey" content="${escapeHtml(String(envelope.pubkey))}">` : ''}
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="Federated mutual-credit barter — verify, then trade.">
  <meta property="og:type" content="website">
  <script type="application/barter+json" id="barter-payload">${payload.replace(/</g, '\\u003c')}</script>`;

  return new Response(landingShell(bank, title, body, cta, head), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function landingShell(bank: Bank, title: string, body: string, cta: string, extraHead: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${extraHead || `<title>${escapeHtml(title)}</title>`}
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #131722; color: #e6e9f0; font: 16px/1.5 system-ui, sans-serif; }
    .wrap { max-width: 420px; margin: 0 auto; padding: 32px 20px; }
    .brand { font-weight: 700; letter-spacing: .02em; color: #7cb9f2; margin-bottom: 24px; }
    .card { background: #1b2130; border: 1px solid #2a3245; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
    .btn { display: block; text-align: center; margin: 10px 0; padding: 12px; border-radius: 10px; background: #232b3d; color: #e6e9f0; text-decoration: none; font-weight: 600; }
    .btn.primary { background: #4da3ff; color: #0b1020; }
    .muted { color: #8b93a7; }
    .mono { font-family: ui-monospace, monospace; font-size: .85em; }
    .foot { margin-top: 28px; font-size: .8em; color: #8b93a7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">barter.game</div>
    ${body}
    <div class="cta">${cta}</div>
    <p class="foot">Signatures are verified in your browser before anything is trusted. Bank: <span class="mono">${escapeHtml(shorten(bank.pubkey))}</span> · ${escapeHtml(bank.name)}</p>
  </div>
</body>
</html>`;
}

function shorten(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- SPA static ------------------------------------------------------------

/**
 * The installable-app description for this bank's SPA.
 *
 * `scope` confines the installed window to /:bank/ui/ — a Barter Link to
 * another bank then opens in the browser, where it belongs, instead of
 * appearing to be part of this installed app. `id` keeps the install identity
 * stable across start_url changes, and distinct per bank.
 */
function webManifest(bank: Bank, basePath: string): Record<string, unknown> {
  const root = `${basePath}/`;
  return {
    id: root,
    name: `barter.game — ${bank.name}`,
    short_name: 'barter.game',
    description: 'Federated mutual-credit ledger. Be your own bank.',
    start_url: root,
    scope: root,
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    // Matches <meta name="theme-color"> and the page background in
    // apps/web/styles.css, so the splash screen and status bar are seamless.
    theme_color: '#F3F1EC',
    background_color: '#F3F1EC',
    lang: 'en',
    dir: 'ltr',
    categories: ['finance'],
    icons: [
      { src: `${root}app/icon.svg`, sizes: 'any', type: 'image/svg+xml' },
      { src: `${root}app/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${root}app/icon-512.png`, sizes: '512x512', type: 'image/png' },
      // Full-bleed variant: Android crops icons to its own shape, and a
      // squircle-with-transparent-corners icon would get clipped twice.
      {
        src: `${root}app/icon-maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      { name: 'Scan a code', url: `${root}#/scan` },
      { name: 'New invoice', url: `${root}#/invoices/new` },
      { name: 'New cheque', url: `${root}#/cheques/new` },
    ],
  };
}

async function serveSpa(bank: Bank, basePath: string): Promise<Response> {
  // Inject a <base> so the SPA's relative `app/…` asset refs resolve correctly
  // whether the URL has a trailing slash or not: both `/alice/ui` and
  // `/alice/ui/` must load `/alice/ui/app/app.js`. app.js itself uses
  // root-absolute API paths, so it is unaffected by <base>.
  const baseTag = `<base href="${basePath}/">`;
  const file = await bank.assets.read('index.html');
  if (file) {
    const html = new TextDecoder().decode(file);
    return new Response(html.replace('<head>', `<head>\n  ${baseTag}`), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8">${baseTag}<title>barter</title></head><body><div id="app"></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// --- utilities -------------------------------------------------------------

/**
 * Media blobs for posts — `POST /:bank/media`, `GET /:bank/media/:hash`
 * (post-feed.md §5, bank-rpc.md §2.5).
 *
 * **Upload takes base64 in JSON, not raw bytes.** The spec suggests raw bytes
 * or multipart, but this bank's write auth binds the body with
 * `body_sha256 = sha256(await request.text())` — a TEXT read, which mangles any
 * non-UTF-8 byte and so cannot authenticate a binary upload. Wrapping the bytes
 * in base64 inside a JSON body keeps the existing authdoc contract exactly as
 * it is for every other write. §5 leaves the upload encoding to the bank
 * ("or multipart"), so this stays inside the spec; the 33% overhead is the cost.
 *
 * Download is unauthenticated and immutable-cacheable, per §5.
 */
export async function handleMedia(
  bank: Bank,
  request: Request,
  hash: string | undefined,
  basePath: string,
): Promise<Response> {
  // main.ts routes /media directly, so the UiError -> JSON mapping that
  // handleUiRequest performs does not apply here. Map it locally, otherwise
  // an honest 404 surfaces to the caller as a 500 from main.ts's catch-all.
  try {
    return await mediaRoute(bank, request, hash, basePath);
  } catch (e) {
    if (e instanceof UiError) return json(e.status, { code: e.code, message: e.message });
    if (e instanceof RpcError) return json(400, { code: e.code, message: e.message });
    console.error('media error', e);
    return json(500, { code: -32603, message: 'internal error' });
  }
}

async function mediaRoute(
  bank: Bank,
  request: Request,
  hash: string | undefined,
  basePath: string,
): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (request.method === 'GET') {
    if (!hash) throw new UiError(400, -32602, 'media hash required');
    // The path segment is a MediaRef "<hash>.<ext>" (canonical) or a bare
    // hash (legacy). The extension names the Content-Type, so the immutable
    // URL is statically servable through any caching CDN with no byte
    // sniffing (post-feed.md §5); a bare hash falls back to the type recorded
    // at upload.
    const ref = parseMediaRef(hash);
    const contentHash = ref ? ref.hash : hash;
    const blob = await getMedia(bank, contentHash);
    if (!blob) throw new UiError(404, -32005, 'unknown media');
    // Re-verify the bytes hash to the requested value before serving (§5).
    const verifyBuf = new Uint8Array(blob.bytes.length);
    verifyBuf.set(blob.bytes);
    const digest = await crypto.subtle.digest('SHA-256', verifyBuf);
    if (base58Encode(new Uint8Array(digest)) !== contentHash) {
      throw new UiError(500, -32603, 'stored media failed its content hash');
    }
    const outBuf = new Uint8Array(blob.bytes.length);
    outBuf.set(blob.bytes);
    // A legacy bare-hash blob serves the type recorded at upload — but only
    // if that type is one the vault knowingly stores. Anything else (e.g. a
    // text/html blob stored before uploads were gated) downgrades to
    // octet-stream rather than becoming a page on the bank's origin.
    const storedType = Object.values(MEDIA_EXT_TYPES).includes(blob.meta.content_type)
      ? blob.meta.content_type
      : 'application/octet-stream';
    return new Response(outBuf, {
      status: 200,
      headers: {
        'Content-Type': ref ? MEDIA_EXT_TYPES[ref.ext] : storedType,
        'Content-Length': String(blob.meta.size),
        // Content-addressed and immutable, so cache hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Belt and suspenders for a user-supplied-content origin: never let
        // the browser sniff a different type, and never let an SVG (or any
        // blob opened top-level) run script or touch this origin.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  }

  if (request.method === 'POST') {
    await requireAuth(bank, request, basePath);
    const body = await request.json() as Record<string, unknown>;
    const b64 = body.data_base64;
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new UiError(400, -32602, 'data_base64 required');
    }
    // The uploader names the format: an `ext` directly, or a content_type it
    // maps from. Either way it must resolve to a type the vault knowingly
    // stores — a caller-chosen Content-Type must never reach storage, or the
    // unauthenticated GET becomes a way to host arbitrary pages (text/html)
    // on the bank's origin. Own-key check: `in` would bless prototype keys
    // like "constructor".
    let ext = typeof body.ext === 'string' ? body.ext.toLowerCase() : '';
    const contentType = typeof body.content_type === 'string' ? body.content_type : '';
    if (!ext && contentType) ext = extForContentType(contentType) ?? '';
    if (!ext || !Object.hasOwn(MEDIA_EXT_TYPES, ext)) {
      throw new UiError(400, -32602,
        `unsupported media type — send ext or content_type for one of: ${Object.keys(MEDIA_EXT_TYPES).join(', ')}`);
    }
    let bytes: Uint8Array;
    try {
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      throw new UiError(400, -32600, 'data_base64 is not valid base64');
    }
    // Size cap is bank policy (§5/§6).
    if (bytes.length > MEDIA_MAX_BYTES) {
      throw new UiError(413, -32000, `media exceeds ${MEDIA_MAX_BYTES} bytes`);
    }
    const stored = await storeMedia(bank, bytes, MEDIA_EXT_TYPES[ext]);
    return json(201, {
      hash: stored,
      ref: `${stored}.${ext}`,
      size: bytes.length,
      content_type: MEDIA_EXT_TYPES[ext],
    });
  }

  throw new UiError(405, -32601, 'method not allowed');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function notFound(): Response {
  return json(404, { code: -32005, message: 'not found' });
}

export function cors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Barter-Auth');
  return response;
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Base58(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return base58Encode(new Uint8Array(hash));
}
