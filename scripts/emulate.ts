/**
 * emulate.ts — a small CLI for driving emulated barter.game users.
 *
 * The repo's original CLI (`apps/cli/`) was removed and `scripts/demo-*.sh`
 * still invoke it, so there is currently no command-line client. This script
 * fills that hole for the emulated-user scenario in EMULATED.md.
 *
 * It speaks exactly what the browser SPA speaks:
 *   - signed JSON-RPC envelopes to `/:bank/rpc`
 *   - `X-Barter-Auth` signed authdocs to `/:bank/ui/*`
 *   - the SAME PBKDF2-SHA256(250k) + AES-256-GCM keystore blob the web app
 *     writes, so a user created here can log into `/:bank/ui` with their
 *     handle + password, and a user created in the browser can be driven here.
 *
 * Run from the repo root (the `@barter.game/protocol` specifier resolves via
 * the root deno.json import map):
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/emulate.ts <command> [args]
 *
 * Target base URL comes from BARTER_BASE (default: the deployed demo banks).
 */

import {
  base58Decode,
  base58Encode,
  canonicalizeWithoutSig,
  collectMediaRefs,
  extForContentType,
  genKeyPair,
  hashDoc,
  MEDIA_EXT_TYPES,
  newUlid,
  publicKeyOf,
  signDoc,
  verifyPostTree,
  type Post,
} from '@barter.game/protocol';

const BASE = Deno.env.get('BARTER_BASE') ?? 'https://barter-game-banks.ai-1st.deno.net';
const STATE_PATH = new URL('../.emulated-state.json', import.meta.url).pathname;
const DEFAULT_PASSWORD = Deno.env.get('BARTER_PASSWORD') ?? '12345678';

/* ------------------------------------------------------------------ types */

type BankRef = { name: string; url: string; pubkey: string };
type User = { handle: string; bank: string; pubkey: string; privateKey: Uint8Array };

type StoredUser = { handle: string; bank: string; pubkey: string; priv: string };
type StoredVoucher = {
  hash: string;
  name: string;
  bank: string;
  issuer: string;
  issuerHandle: string;
  account?: string;
};
type StoredOrder = {
  hash: string;
  kind: 'invoice' | 'cheque' | 'swap';
  owner: string;
  bank: string;
  voucher: string;
  note: string;
};
type State = {
  users: Record<string, StoredUser>;
  vouchers: Record<string, StoredVoucher>;
  orders: Record<string, StoredOrder>;
  deals: Record<string, unknown>;
  /** `<handle@bank>:<voucherHash>` → account hash */
  accounts?: Record<string, string>;
};

/* ------------------------------------------------------------------ state */

function loadState(): State {
  try {
    return JSON.parse(Deno.readTextFileSync(STATE_PATH)) as State;
  } catch {
    return { users: {}, vouchers: {}, orders: {}, deals: {} };
  }
}
function saveState(s: State): void {
  Deno.writeTextFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

/* --------------------------------------------------------------- keystore */
/* Byte-identical to apps/web/app.js deriveKey/encryptSeed/decryptSeed. */

function b64url(buf: Uint8Array): string {
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/* Returns a Uint8Array backed by a plain ArrayBuffer so it satisfies BufferSource. */
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Same reason: WebCrypto's BufferSource needs an ArrayBuffer-backed view. */
function toBufferSource(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(b.length));
  out.set(b);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = 250000,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptSeed(seed: Uint8Array, password: string): Promise<Record<string, unknown>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, toBufferSource(seed)));
  return {
    kdf: 'pbkdf2-sha256',
    iterations: 250000,
    salt: b64url(salt),
    nonce: b64url(iv),
    ciphertext: b64url(ct),
    aead: 'aes-256-gcm',
  };
}

async function decryptSeed(blob: Record<string, string | number>, password: string): Promise<Uint8Array> {
  const key = await deriveKey(password, unb64url(String(blob.salt)), Number(blob.iterations) || 250000);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64url(String(blob.nonce)) },
    key,
    unb64url(String(blob.ciphertext)),
  );
  return new Uint8Array(plain);
}

/* --------------------------------------------------------------- transport */

const bankCache = new Map<string, BankRef>();
async function bank(name: string): Promise<BankRef> {
  const hit = bankCache.get(name);
  if (hit) return hit;
  const url = `${BASE}/${name}`;
  const info = await fetch(`${url}/barter-bank.json`).then((r) => r.json());
  if (!info?.pubkey) throw new Error(`bank ${name}: no pubkey at ${url}/barter-bank.json`);
  const ref: BankRef = { name: info.name, url, pubkey: info.pubkey };
  bankCache.set(name, ref);
  return ref;
}

async function rpc(
  user: User,
  b: BankRef,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const env: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: newUlid(),
    method,
    params,
    pubkey: user.pubkey,
    to: b.pubkey,
    sig: '',
  };
  env.sig = signDoc(env, user.privateKey);
  const res = await fetch(`${b.url}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}@${b.name}: ${data.error.code} ${data.error.message}`);
  return data.result;
}

async function sha256Base58Str(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return base58Encode(new Uint8Array(h));
}

/**
 * `path` MUST include any query string — the bank compares the signed `path`
 * against `url.pathname + url.search`.
 */
async function uiAuth(
  user: User,
  b: BankRef,
  method: string,
  path: string,
  body: unknown,
): Promise<// deno-lint-ignore no-explicit-any
any> {
  const text = body === null || body === undefined ? undefined : JSON.stringify(body);
  const authdoc = {
    pubkey: user.pubkey,
    method,
    path: `/${b.name}/ui${path}`,
    id: newUlid(),
    ts: Date.now(),
    body_sha256: text ? await sha256Base58Str(text) : null,
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${b.url}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: text,
  });
  const data = await res.json();
  if (data && typeof data.code === 'number' && data.code < 0) {
    throw new Error(`${method} ${path}@${b.name}: ${data.code} ${data.message}`);
  }
  return data;
}

/* ------------------------------------------------------- media vault (§5) */

/** Upload bytes to a bank's vault; returns the "<hash>.<ext>" ref. */
async function uploadMedia(
  user: User,
  b: BankRef,
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const body = { data_base64: btoa(bin), ext };
  const text = JSON.stringify(body);
  const authdoc = {
    pubkey: user.pubkey,
    method: 'POST',
    path: `/${b.name}/media`,
    id: newUlid(),
    ts: Date.now(),
    body_sha256: await sha256Base58Str(text),
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${b.url}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: text,
  });
  const data = await res.json();
  if (data && typeof data.code === 'number' && data.code < 0) {
    throw new Error(`media upload@${b.name}: ${data.code} ${data.message}`);
  }
  return data.ref as string;
}

async function uploadMediaFile(user: User, b: BankRef, path: string): Promise<string> {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  // Own-key check: `in` would bless prototype keys like "constructor".
  if (!Object.hasOwn(MEDIA_EXT_TYPES, ext)) {
    throw new Error(`unsupported media extension: .${ext}`);
  }
  return uploadMedia(user, b, Deno.readFileSync(path), ext);
}

/**
 * Make bank `to` hold every media ref `tree` commits to, copying missing
 * blobs from bank `from`. The accepting bank refuses a post whose blobs it
 * does not hold (post-feed.md §5), so a cross-bank repost/reply starts here.
 */
async function copyTreeMedia(user: User, tree: Post, from: BankRef, to: BankRef): Promise<void> {
  const refs = collectMediaRefs(tree);
  if (refs.length > 64) throw new Error('tree references too many media blobs to copy');
  for (const ref of refs) {
    const have = await fetch(`${to.url}/media/${ref}`);
    await have.body?.cancel();
    if (have.ok) continue;
    const dl = await fetch(`${from.url}/media/${ref}`);
    if (!dl.ok) throw new Error(`cannot copy ${ref} from ${from.name}`);
    const bytes = new Uint8Array(await dl.arrayBuffer());
    const dot = ref.lastIndexOf('.');
    // A legacy bare-hash ref carries no extension — derive it from the type
    // the source served, never a guess.
    const ext = dot > 0
      ? ref.slice(dot + 1)
      : extForContentType((dl.headers.get('Content-Type') ?? '').split(';')[0]);
    if (!ext) throw new Error(`${ref} is not an image type the vault stores`);
    await uploadMedia(user, to, bytes, ext);
    console.log(`  copied ${ref.slice(0, 16)}… ${from.name} → ${to.name}`);
  }
}

/* ------------------------------------------------------------------ users */

/** `mira@alice` → { handle: 'mira', bank: 'alice' } */
function parseRef(ref: string): { handle: string; bank: string } {
  const [handle, bankName] = ref.split('@');
  if (!handle || !bankName) throw new Error(`bad user ref '${ref}' — expected handle@bank`);
  return { handle, bank: bankName };
}

/**
 * Load a user. Prefers the local state cache; otherwise pulls the encrypted
 * keystore from the bank and decrypts it with the password — which is how a
 * browser-created identity becomes drivable from here.
 */
async function loadUser(ref: string, password = DEFAULT_PASSWORD): Promise<User> {
  const { handle, bank: bankName } = parseRef(ref);
  const st = loadState();
  const cached = st.users[ref];
  if (cached) {
    return { handle, bank: bankName, pubkey: cached.pubkey, privateKey: base58Decode(cached.priv) };
  }
  const b = await bank(bankName);
  const res = await fetch(`${b.url}/ui/keystore/${handle}`);
  const data = await res.json();
  if (data.code) throw new Error(`keystore ${ref}: ${data.code} ${data.message}`);
  const seed = await decryptSeed(data.keystore, password);
  const { pubkeyBase58 } = publicKeyOf(seed);
  if (pubkeyBase58 !== data.pubkey) throw new Error(`keystore ${ref}: decrypted key does not match registered pubkey`);
  st.users[ref] = { handle, bank: bankName, pubkey: pubkeyBase58, priv: base58Encode(seed) };
  saveState(st);
  return { handle, bank: bankName, pubkey: pubkeyBase58, privateKey: seed };
}

/* --------------------------------------------------------------- commands */

async function cmdRegister(ref: string, password = DEFAULT_PASSWORD): Promise<void> {
  const { handle, bank: bankName } = parseRef(ref);
  const b = await bank(bankName);
  const { privateKey, pubkeyBase58 } = genKeyPair();
  const keystore = await encryptSeed(privateKey, password);
  const proof = signDoc({ handle, pubkey: pubkeyBase58, keystore_sha256: hashDoc(keystore) }, privateKey);
  const res = await fetch(`${b.url}/ui/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: pubkeyBase58, keystore, proof }),
  });
  const data = await res.json();
  if (data.code) throw new Error(`register ${ref}: ${data.code} ${data.message}`);
  const st = loadState();
  st.users[ref] = { handle, bank: bankName, pubkey: pubkeyBase58, priv: base58Encode(privateKey) };
  saveState(st);
  console.log(`registered ${ref} → ${pubkeyBase58}`);
}

/** Mint a voucher and open the issuer's own account on it, in one submit_docs. */
async function cmdMint(ref: string, name: string, opts: Record<string, string>): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const voucher: Record<string, unknown> = {
    type: 'voucher',
    pubkey: user.pubkey,
    ulid: newUlid(),
    bank: b.pubkey,
    name,
    integer: true,
  };
  if (opts.desc) voucher.description_md = opts.desc;
  if (opts.limit) voucher.limit = Number(opts.limit);
  if (opts.expires) voucher.expires = opts.expires;
  voucher.sig = signDoc(voucher, user.privateKey);
  const vHash = hashDoc(voucher);

  const account: Record<string, unknown> = {
    type: 'account',
    pubkey: user.pubkey,
    ulid: newUlid(),
    name: `${user.handle} issuer`,
    voucher: vHash,
  };
  account.sig = signDoc(account, user.privateKey);
  const aHash = hashDoc(account);

  await rpc(user, b, 'submit_docs', { docs: [voucher, account] });

  const st = loadState();
  st.vouchers[`${name}@${user.bank}`] = {
    hash: vHash,
    name,
    bank: user.bank,
    issuer: user.pubkey,
    issuerHandle: user.handle,
    account: aHash,
  };
  saveState(st);
  console.log(`minted "${name}" by ${ref}\n  voucher ${vHash}\n  issuer account ${aHash}`);
}

/** Open an account on someone else's voucher, at the voucher's issuing bank. */
async function cmdOpen(ref: string, voucherHash: string, bankName: string): Promise<string> {
  const user = await loadUser(ref);
  const b = await bank(bankName);
  const account: Record<string, unknown> = {
    type: 'account',
    pubkey: user.pubkey,
    ulid: newUlid(),
    name: `${user.handle} holdings`,
    voucher: voucherHash,
  };
  account.sig = signDoc(account, user.privateKey);
  await rpc(user, b, 'submit_docs', { docs: [account] });
  const aHash = hashDoc(account);
  const st = loadState();
  st.accounts ??= {};
  st.accounts[`${ref}:${voucherHash}`] = aHash;
  saveState(st);
  console.log(`${ref} opened account ${aHash} on voucher ${voucherHash} @${bankName}`);
  return aHash;
}

/** Credit-only Order — "I will receive N of this voucher". Published as a 'buy' offer. */
async function cmdInvoice(
  ref: string,
  voucherHash: string,
  bankName: string,
  accountHash: string,
  max: number,
): Promise<string> {
  const user = await loadUser(ref);
  const b = await bank(bankName);
  const order: Record<string, unknown> = {
    type: 'order',
    pubkey: user.pubkey,
    ulid: newUlid(),
    rate: 1,
    credit: { account: accountHash, voucher: voucherHash, bank: b.pubkey, min: 0, max },
    lead: false,
  };
  order.sig = signDoc(order, user.privateKey);
  const oHash = hashDoc(order);
  await rpc(user, b, 'submit_docs', { docs: [order], publish_offers: [oHash] });
  console.log(`invoice by ${ref}: order ${oHash} (credit ≤ ${max})`);
  return oHash;
}

/** Debit-only Order — "I will give N of this voucher". Published as a 'sell' offer. */
async function cmdCheque(
  ref: string,
  voucherHash: string,
  bankName: string,
  accountHash: string,
  max: number,
): Promise<string> {
  const user = await loadUser(ref);
  const b = await bank(bankName);
  const order: Record<string, unknown> = {
    type: 'order',
    pubkey: user.pubkey,
    ulid: newUlid(),
    rate: 1,
    debit: { account: accountHash, voucher: voucherHash, bank: b.pubkey, min: 0, max },
    lead: true,
  };
  order.sig = signDoc(order, user.privateKey);
  const oHash = hashDoc(order);
  await rpc(user, b, 'submit_docs', { docs: [order], publish_offers: [oHash] });
  console.log(`cheque by ${ref}: order ${oHash} (debit ≤ ${max})`);
  return oHash;
}

/**
 * Two-sided Order: give `giveVoucher`@`giveBank`, receive `getVoucher`@`getBank`.
 * Submitted to BOTH banks — propose_deal requires one bank to hold both orders.
 */
async function cmdSwap(
  ref: string,
  give: { voucher: string; bankName: string; account: string },
  get: { voucher: string; bankName: string; account: string },
  min: number,
  max: number,
  lead: boolean,
): Promise<string> {
  const user = await loadUser(ref);
  const gb = await bank(give.bankName);
  const cb = await bank(get.bankName);
  const order: Record<string, unknown> = {
    type: 'order',
    pubkey: user.pubkey,
    ulid: newUlid(),
    rate: 1,
    debit: { account: give.account, voucher: give.voucher, bank: gb.pubkey, min, max },
    credit: { account: get.account, voucher: get.voucher, bank: cb.pubkey, min, max },
    lead,
  };
  order.sig = signDoc(order, user.privateKey);
  const oHash = hashDoc(order);
  const banks = gb.pubkey === cb.pubkey ? [gb] : [gb, cb];
  for (const b of banks) {
    await rpc(user, b, 'submit_docs', { docs: [order], publish_offers: [oHash] });
  }
  console.log(`swap by ${ref}: order ${oHash} (give ${give.voucher.slice(0, 8)}… get ${get.voucher.slice(0, 8)}…)`);
  return oHash;
}

async function cmdPropose(
  ref: string,
  order1: string,
  order2: string,
  amount: number,
  bankNames: string[],
): Promise<string> {
  const user = await loadUser(ref);
  const coordBank = await bank(user.bank);
  const banks = await Promise.all(bankNames.map((n) => bank(n)));
  const body = {
    offer1: { hash: order1, debit_amount: amount, credit_amount: amount },
    offer2: { hash: order2, debit_amount: amount, credit_amount: amount },
    banks: banks.map((b) => ({ pubkey: b.pubkey, url: b.url })),
  };
  const res = await uiAuth(user, coordBank, 'POST', '/propose_deal', body);
  console.log(`deal ${res.deal_id} proposed by ${ref} — state ${res.state}`);
  return res.deal_id;
}

async function cmdDeal(ref: string, dealId: string, poll = 20): Promise<string> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  let state = '';
  for (let i = 0; i < poll; i++) {
    const status = await uiAuth(user, b, 'GET', `/deal/${dealId}`, null);
    state = status.state;
    const legs = (status.legs ?? []).map((l: { state: string; direction: string; amount: number }) =>
      `${l.direction}:${l.amount}:${l.state}`
    ).join(' ');
    console.log(`  [${i}] ${state}  ${legs}`);
    if (state === 'settled' || state === 'rejected') break;
    await new Promise((r) => setTimeout(r, 700));
  }
  return state;
}

async function cmdTrust(ref: string, pubkey: string, note: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  await uiAuth(user, b, 'POST', '/trusted', { pubkey, note });
  console.log(`${ref} trusts ${pubkey}${note ? ` — "${note}"` : ''}`);
}

async function cmdContact(ref: string, pubkey: string, handle: string, note: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  await uiAuth(user, b, 'POST', '/contacts', { pubkey, handle, note });
  console.log(`${ref} added contact ${handle} (${pubkey.slice(0, 10)}…)`);
}

async function cmdAddBank(ref: string, bankName: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const target = await bank(bankName);
  await uiAuth(user, b, 'POST', '/banks', { pubkey: target.pubkey, url: target.url });
  console.log(`${ref} pinned bank ${bankName} (${target.pubkey.slice(0, 10)}…)`);
}

async function cmdRegistry(ref: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const vouchers = await rpc(user, b, 'list_vouchers', {}) as Array<Record<string, unknown>>;
  const st = loadState();
  console.log(`registry @${user.bank} — ${vouchers.length} vouchers`);
  for (const v of vouchers) {
    const h = hashDoc(v);
    const issuerHandle = Object.values(st.users).find((u) => u.pubkey === v.pubkey)?.handle ?? '?';
    console.log(`  ${h}  "${v.name}"  issuer=${issuerHandle} (${String(v.pubkey).slice(0, 10)}…)`);
    // Cache so later commands can refer to vouchers by "<name>@<bank>".
    st.vouchers[`${v.name}@${user.bank}`] = {
      hash: h,
      name: String(v.name),
      bank: user.bank,
      issuer: String(v.pubkey),
      issuerHandle,
      account: st.vouchers[`${v.name}@${user.bank}`]?.account,
    };
  }
  saveState(st);
}

/** List the caller's accounts at a bank, with content hashes (which list_accounts omits). */
async function cmdAccounts(ref: string, bankName?: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(bankName ?? user.bank);
  const res = await rpc(user, b, 'list_accounts', {}) as {
    accounts: Array<Record<string, unknown>>;
    vouchers: Array<Record<string, unknown>>;
  };
  const st = loadState();
  st.accounts ??= {};
  console.log(`accounts for ${ref} @${b.name}:`);
  for (const a of res.accounts ?? []) {
    const h = hashDoc(a);
    const v = (res.vouchers ?? []).find((x) => hashDoc(x) === a.voucher);
    console.log(`  ${h}  "${a.name}"  voucher="${v?.name ?? a.voucher}"`);
    st.accounts[`${ref}:${a.voucher}`] = h;
  }
  if (!(res.accounts ?? []).length) console.log('  (none)');
  saveState(st);
}

async function cmdOffers(ref: string, voucherHash: string, intention: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const offers = await rpc(user, b, 'list_offers', { voucher_hash: voucherHash, intention }) as unknown[];
  console.log(`offers @${user.bank} voucher ${voucherHash.slice(0, 12)}… intention=${intention}: ${offers.length}`);
  console.log(JSON.stringify(offers, null, 2));
}

async function cmdDiscover(ref: string, voucherHashes: string[], bankNames: string[]): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const banks = await Promise.all(bankNames.map((n) => bank(n)));
  const res = await uiAuth(user, b, 'POST', '/discover', {
    banks: banks.map((x) => ({ pubkey: x.pubkey, url: x.url })),
    vouchers: voucherHashes,
    intentions: ['sell', 'buy'],
  });
  console.log(`discover for ${ref}: ${res.offers?.length ?? 0} offers, polled ${res.polled?.length ?? 0}, unreachable ${res.unreachable?.length ?? 0}`);
  console.log(JSON.stringify(res, null, 2));
}

async function cmdPortfolio(ref: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(user.bank);
  const res = await uiAuth(user, b, 'GET', '/portfolio', null);
  console.log(`portfolio ${ref}:`);
  for (const h of res.holdings ?? []) {
    console.log(`  ${h.name}: current=${h.current} pending=${h.pending}`);
  }
  if (!(res.holdings ?? []).length) console.log('  (empty)');
}

async function cmdBalance(ref: string, bankName: string, accountHash: string): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(bankName);
  const bal = await rpc(user, b, 'get_account_balance', { account_hash: accountHash });
  console.log(`balance ${accountHash.slice(0, 12)}… @${bankName}: ${JSON.stringify(bal)}`);
}

async function cmdResolve(ref: string, pubkey: string): Promise<void> {
  const { bank: bankName } = parseRef(ref);
  const b = await bank(bankName);
  const res = await fetch(`${b.url}/ui/resolve/${pubkey}`).then((r) => r.json());
  console.log(JSON.stringify(res, null, 2));
}

/**
 * Attempt to publish a voucher-anchored Post (protocol/post-feed.md).
 * Expected to fail: no Post doc type exists in the protocol library and
 * `submit_docs` rejects unknown types. Kept as an executable probe so
 * EMULATED.md can cite the real error rather than an assumption.
 */
/**
 * Publish a voucher-anchored Post (post-feed.md). `--reply <hash>` and
 * `--repost <hash>` embed the FULL parent post, fetched from the bank so the
 * embedded bytes are exactly what its author signed. `--at <bank>` posts into
 * a feed carried by another bank — §2 lets any bank that knows the voucher
 * carry its feed, so a user of one bank can join a conversation on another.
 */
async function cmdPost(
  ref: string,
  voucherHash: string,
  text: string,
  opts: Record<string, string> = {},
): Promise<string> {
  const user = await loadUser(ref);
  const b = await bank(opts.at ?? user.bank);
  const post: Record<string, unknown> = {
    type: 'post',
    pubkey: user.pubkey,
    ulid: newUlid(),
    voucher: voucherHash,
    body_md: text,
  };
  // --icon / --square release new artwork for the voucher; the files upload
  // to the target bank's vault and the post carries their refs. The post text
  // becomes the description. Issuer-only, enforced by the bank.
  if (opts.icon || opts.square) {
    post.voucher_meta = true;
    if (opts.icon) post.icon = await uploadMediaFile(user, b, opts.icon);
    if (opts.square) post.square = await uploadMediaFile(user, b, opts.square);
  }
  // --attach adds feed images (comma-separated files), stored by hash.
  if (opts.attach) {
    const media: string[] = [];
    for (const f of opts.attach.split(',')) media.push(await uploadMediaFile(user, b, f.trim()));
    post.media = media;
  }
  const parentHash = opts.reply ?? opts.repost;
  if (parentHash) {
    // --from names the bank the parent lives at (defaults to the bank being
    // posted to). A cross-bank embed drags its media refs along, so the
    // blobs are copied to the target bank first — same rule the web app
    // follows (post-feed.md §5).
    const src = opts.from ? await bank(opts.from) : b;
    const parent = await rpc(user, src, 'get_post', { post_hash: parentHash });
    if (src.url !== b.url) {
      await copyTreeMedia(user, parent as unknown as Post, src, b);
    }
    post[opts.reply ? 'reply_to' : 'repost'] = parent;
  }
  post.sig = signDoc(post, user.privateKey);
  const res = await rpc(user, b, 'submit_docs', { docs: [post] }) as { stored: string[] };
  const hash = res.stored[0]!;
  const kind = opts.reply ? 'reply' : opts.repost ? 'repost' : 'post';
  console.log(`${kind} by ${ref} @${b.name}: ${hash}\n  "${text}"`);
  return hash;
}

/** Raw single-author feed: list_posts(author, voucher|'all') at one bank. */
async function cmdPosts(
  ref: string,
  author: string,
  voucherHash = 'all',
  bankName?: string,
): Promise<void> {
  const user = await loadUser(ref);
  const b = await bank(bankName ?? user.bank);
  const r = await rpc(user, b, 'list_posts', {
    pubkey: author,
    voucher_hash: voucherHash,
  }) as { items: Array<Record<string, unknown>>; next_before?: string };
  console.log(`${r.items.length} post(s) by ${author.slice(0, 10)}… @${b.name}` +
    (r.next_before ? ` (more before ${r.next_before})` : ''));
  for (const p of r.items) console.log(`  ${hashDoc(p)}  "${p.body_md}"`);
}

/**
 * The reader's own feed — the client-side merge post-feed.md §7 describes:
 * list_posts for every trusted author x every known bank, newest-first,
 * de-duplicated by content hash, each post's signature tree verified locally.
 * There is no global timeline; what you see is your own trust graph.
 */
async function cmdFeed(ref: string, voucherHash = 'all'): Promise<void> {
  const user = await loadUser(ref);
  const home = await bank(user.bank);

  // Follows, not trusted issuers — reading someone and vouching for their
  // currency are separate decisions. The bank defaults a new user to following
  // their own bank, which reposts everything its users publish.
  const follows = await uiAuth(user, home, 'GET', '/follows', null) as string[];
  const authors = [user.pubkey, ...follows.filter((f) => f !== user.pubkey)];

  const pinned = await uiAuth(user, home, 'GET', '/banks', null) as
    Array<{ pubkey: string; url: string }>;
  const banks: BankRef[] = [home];
  for (const p of pinned) {
    if (!banks.some((x) => x.pubkey === p.pubkey)) {
      banks.push({ name: p.url.split('/').pop() ?? '?', url: p.url, pubkey: p.pubkey });
    }
  }

  const st = loadState();
  const handleOf = (pk: string) =>
    Object.values(st.users).find((u) => u.pubkey === pk)?.handle ?? pk.slice(0, 10) + '…';

  const seen = new Map<string, Record<string, unknown>>();
  for (const bk of banks) {
    for (const author of authors) {
      try {
        const r = await rpc(user, bk, 'list_posts', {
          pubkey: author,
          voucher_hash: voucherHash,
        }) as { items: Array<Record<string, unknown>> };
        for (const p of r.items) {
          const h = hashDoc(p);
          if (!seen.has(h) && verifyPostTree(p as never)) seen.set(h, p);
        }
      } catch { /* this bank does not carry that author's feed */ }
    }
  }

  const posts = [...seen.values()].sort((a, b) =>
    String(a.ulid) < String(b.ulid) ? 1 : String(a.ulid) > String(b.ulid) ? -1 : 0);

  console.log(`feed for ${ref} — ${posts.length} post(s) from ${authors.length} author(s) across ${banks.length} bank(s)`);
  for (const p of posts) {
    console.log(`\n  ${handleOf(String(p.pubkey))}: ${p.body_md}`);
    const parent = (p.reply_to ?? p.repost) as Record<string, unknown> | undefined;
    if (parent) {
      const verb = p.reply_to ? 'in reply to' : 'reposting';
      console.log(`    ${verb} ${handleOf(String(parent.pubkey))}: "${parent.body_md}"`);
    }
  }
}

async function cmdState(): Promise<void> {
  console.log(JSON.stringify(loadState(), null, 2));
}

/* ------------------------------------------------------------------- main */

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a?.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

const [cmd, ...rest] = Deno.args;

try {
  switch (cmd) {
    case 'register':
      await cmdRegister(rest[0]!, rest[1]);
      break;
    case 'mint':
      await cmdMint(rest[0]!, rest[1]!, flags(rest.slice(2)));
      break;
    case 'open':
      await cmdOpen(rest[0]!, rest[1]!, rest[2]!);
      break;
    case 'invoice':
      await cmdInvoice(rest[0]!, rest[1]!, rest[2]!, rest[3]!, Number(rest[4]));
      break;
    case 'cheque':
      await cmdCheque(rest[0]!, rest[1]!, rest[2]!, rest[3]!, Number(rest[4]));
      break;
    case 'swap': {
      const f = flags(rest.slice(1));
      await cmdSwap(
        rest[0]!,
        { voucher: f['give-voucher']!, bankName: f['give-bank']!, account: f['give-account']! },
        { voucher: f['get-voucher']!, bankName: f['get-bank']!, account: f['get-account']! },
        Number(f.min ?? 1),
        Number(f.max ?? 1),
        f.lead !== 'false',
      );
      break;
    }
    case 'propose':
      await cmdPropose(rest[0]!, rest[1]!, rest[2]!, Number(rest[3]), rest[4]!.split(','));
      break;
    case 'deal':
      await cmdDeal(rest[0]!, rest[1]!);
      break;
    case 'trust':
      await cmdTrust(rest[0]!, rest[1]!, rest.slice(2).join(' '));
      break;
    case 'contact':
      await cmdContact(rest[0]!, rest[1]!, rest[2]!, rest.slice(3).join(' '));
      break;
    case 'addbank':
      await cmdAddBank(rest[0]!, rest[1]!);
      break;
    case 'registry':
      await cmdRegistry(rest[0]!);
      break;
    case 'accounts':
      await cmdAccounts(rest[0]!, rest[1]);
      break;
    case 'offers':
      await cmdOffers(rest[0]!, rest[1]!, rest[2]!);
      break;
    case 'discover':
      await cmdDiscover(rest[0]!, rest[1]!.split(','), rest[2]!.split(','));
      break;
    case 'portfolio':
      await cmdPortfolio(rest[0]!);
      break;
    case 'balance':
      await cmdBalance(rest[0]!, rest[1]!, rest[2]!);
      break;
    case 'resolve':
      await cmdResolve(rest[0]!, rest[1]!);
      break;
    case 'post': {
      const f = flags(rest.slice(3));
      const words = rest.slice(2).filter((w, i, a) =>
        !w.startsWith('--') && !(a[i - 1] ?? '').startsWith('--'));
      await cmdPost(rest[0]!, rest[1]!, words.join(' '), f);
      break;
    }
    case 'posts':
      await cmdPosts(rest[0]!, rest[1]!, rest[2], rest[3]);
      break;
    case 'feed':
      await cmdFeed(rest[0]!, rest[1]);
      break;
    case 'follow': {
      const u = await loadUser(rest[0]!);
      await uiAuth(u, await bank(u.bank), 'POST', '/follows', { pubkey: rest[1]! });
      console.log(`${rest[0]} now follows ${rest[1]}`);
      break;
    }
    case 'unfollow': {
      const u = await loadUser(rest[0]!);
      await uiAuth(u, await bank(u.bank), 'DELETE', `/follows/${rest[1]!}`, null);
      console.log(`${rest[0]} unfollowed ${rest[1]}`);
      break;
    }
    case 'meta': {
      const u = await loadUser(rest[0]!);
      const m = await rpc(u, await bank(u.bank), 'get_voucher_meta', { voucher_hash: rest[1]! });
      console.log(JSON.stringify(m, null, 2));
      break;
    }
    case 'follows': {
      const u = await loadUser(rest[0]!);
      const f = await uiAuth(u, await bank(u.bank), 'GET', '/follows', null);
      console.log(JSON.stringify(f, null, 2));
      break;
    }
    case 'state':
      await cmdState();
      break;
    default:
      console.log(`emulate.ts — drive emulated barter.game users (BASE=${BASE})

  register <handle@bank> [password]
  mint     <handle@bank> "<voucher name>" [--desc "..."] [--limit N] [--expires ISO]
  open     <handle@bank> <voucherHash> <bankName>            -> prints account hash
  invoice  <handle@bank> <voucherHash> <bankName> <accountHash> <max>
  cheque   <handle@bank> <voucherHash> <bankName> <accountHash> <max>
  swap     <handle@bank> --give-voucher H --give-bank B --give-account A
                         --get-voucher H --get-bank B --get-account A [--min N] [--max N] [--lead false]
  propose  <handle@bank> <orderHash1> <orderHash2> <amount> <bank1,bank2>
  deal     <handle@bank> <dealId>
  trust    <handle@bank> <pubkey> [note]
  contact  <handle@bank> <pubkey> <handle> [note]
  addbank  <handle@bank> <bankName>
  registry <handle@bank>
  accounts <handle@bank> [bankName]
  offers   <handle@bank> <voucherHash> <sell|buy>
  discover <handle@bank> <voucherHash,...> <bank,...>
  portfolio <handle@bank>
  balance  <handle@bank> <bankName> <accountHash>
  resolve  <handle@bank> <pubkey>
  post     <handle@bank> <voucherHash> "<text>" [--reply <hash>] [--repost <hash>] [--at <bank>]
                                                 [--from <bank>] [--attach <files,comma-sep>]
                                                 [--icon <file>] [--square <file>]
           icon/square/attach upload to the vault and post refs "<hash>.<ext>";
           --from names the parent's bank for cross-bank reply/repost (blobs are copied over)
  meta     <handle@bank> <voucherHash>            (show the voucher's current meta)
  posts    <handle@bank> <authorPubkey> [voucherHash|all] [bankName]
  feed     <handle@bank> [voucherHash|all]
  follow   <handle@bank> <pubkey>
  unfollow <handle@bank> <pubkey>
  follows  <handle@bank>
  state`);
  }
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  Deno.exit(1);
}
