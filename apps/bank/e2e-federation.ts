// Two users, two clouds, one federation.
//
// Ada registers at bank A, Ben at bank B — deliberately on SEPARATE
// deployments (e.g. Deno Deploy and AWS). They discover each other across the
// boundary, Ben copies Ada's artwork into his own bank's vault and reposts
// her, then they settle a bilateral swap. Nothing is co-located, so every
// bank-to-bank hop is a real HTTPS call between two clouds running two
// different storage engines — the in-process shortcut cannot mask anything.
//
// Either bank may coordinate; run it both ways to prove the roles are not
// baked into a runtime.
//
//   E2E_BANK_A_URL=https://…/alice E2E_BANK_B_URL=https://…/bob \
//     bankA run --allow-net --allow-env apps/bank/e2e-federation.ts
import {
  base58Encode, canonicalizeWithoutSig, collectMediaRefs, genKeyPair,
  hashDoc, newUlid, signDoc, verifyPostTree, type Post,
} from '@barter.game/protocol';

const BANK_A_URL = Deno.env.get('E2E_BANK_A_URL')!;
const BANK_B_URL = Deno.env.get('E2E_BANK_B_URL')!;
/** Label a bank by its host, so output reads right whichever way it is run. */
const where = (url: string) => new URL(url).hostname.split('.').slice(0, 2).join('.');

type User = { privateKey: Uint8Array; pubkey: string; handle?: string };
type BankRef = { name: string; url: string; pubkey: string };

const makeUser = (): User => {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  return { privateKey, pubkey: pubkeyBase58 };
};
const sign = <T extends Record<string, unknown>>(d: T, u: User): T & { sig: string } =>
  ({ ...d, sig: signDoc(d, u.privateKey) });

let pass = true;
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) pass = false;
};

async function discover(url: string): Promise<BankRef> {
  const i = await fetch(`${url}/barter-bank.json`).then((r) => r.json());
  return { name: i.name, url, pubkey: i.pubkey };
}

async function rpcRaw(u: User, b: BankRef, method: string, params: Record<string, unknown>) {
  const env: Record<string, unknown> = {
    jsonrpc: '2.0', id: newUlid(), method, params, pubkey: u.pubkey, to: b.pubkey, sig: '',
  };
  env.sig = signDoc(env, u.privateKey);
  return await fetch(`${b.url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env),
  }).then((r) => r.json());
}
async function rpc(u: User, b: BankRef, method: string, params: Record<string, unknown>) {
  const d = await rpcRaw(u, b, method, params);
  if (d.error) throw new Error(`${method}@${b.name}: ${d.error.code} ${d.error.message}`);
  return d.result;
}

const b64url = (bytes: Uint8Array) => {
  let s = ''; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function sha256Base58(s: string) {
  return base58Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
async function authed(u: User, b: BankRef, method: string, path: string, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const doc = {
    pubkey: u.pubkey, method, path: `/${b.name}${path}`, id: newUlid(), ts: Date.now(),
    body_sha256: text ? await sha256Base58(text) : null,
  };
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(doc)))}.${signDoc(doc, u.privateKey)}`;
  const res = await fetch(`${b.url}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token }, body: text,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Real handle+keystore registration, exactly as the web client does it. */
async function register(u: User, b: BankRef, handle: string) {
  const keystore = { kdf: 'none', ciphertext: base58Encode(u.privateKey) };
  const proof = signDoc({ handle, pubkey: u.pubkey, keystore_sha256: hashDoc(keystore) }, u.privateKey);
  const r = await fetch(`${b.url}/ui/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: u.pubkey, keystore, proof }),
  }).then((x) => x.json());
  if (r.code) throw new Error(`register ${handle}@${b.name}: ${r.code} ${r.message}`);
  u.handle = handle;
}

async function uploadMedia(u: User, b: BankRef, svg: string) {
  const r = await authed(u, b, 'POST', '/media', { data_base64: btoa(svg), ext: 'svg' });
  if (r.status !== 201) throw new Error(`media upload@${b.name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.ref as string;
}

const stamp = Date.now();
const bankA = await discover(BANK_A_URL);
const bankB = await discover(BANK_B_URL);
const A = where(BANK_A_URL);
const B = where(BANK_B_URL);
console.log(`\nbank A (coordinator) : ${bankA.name} ${bankA.pubkey.slice(0, 12)}… @ ${A}`);
console.log(`bank B               : ${bankB.name} ${bankB.pubkey.slice(0, 12)}… @ ${B}\n`);

// --- 1. two users register, one on each cloud -----------------------------
console.log('1. registration on both deployments');
const ada = makeUser();
const ben = makeUser();
await register(ada, bankA, `ada-${stamp}`);
await register(ben, bankB, `ben-${stamp}`);
check(`Ada registered at ${bankA.name} (${A})`, !!ada.handle, ada.handle!);
check(`Ben registered at ${bankB.name} (${B})`, !!ben.handle, ben.handle!);

// Each bank must resolve its own user by handle, and the keystore must come
// back — that is what lets the user log in again from any browser.
{
  const h = await fetch(`${bankA.url}/ui/handle/${ada.handle}`).then((r) => r.json());
  check(`Ada's handle is taken at ${A}`, h.available === false && h.pubkey === ada.pubkey);
  const k = await fetch(`${bankB.url}/ui/keystore/${ben.handle}`).then((r) => r.json());
  check(`Ben's keystore is retrievable from ${B}`, k.pubkey === ben.pubkey);
}

// --- 2. each mints a currency at their own bank ---------------------------
console.log('\n2. minting currencies');
const adaVoucher = sign({
  type: 'voucher', pubkey: ada.pubkey, ulid: newUlid(), bank: bankA.pubkey,
  name: `ada-illustration-${stamp}`, integer: true,
}, ada);
const adaV = hashDoc(adaVoucher);
await rpc(ada, bankA, 'submit_docs', { docs: [adaVoucher] });

const benVoucher = sign({
  type: 'voucher', pubkey: ben.pubkey, ulid: newUlid(), bank: bankB.pubkey,
  name: `ben-code-review-${stamp}`, integer: true,
}, ben);
const benV = hashDoc(benVoucher);
await rpc(ben, bankB, 'submit_docs', { docs: [benVoucher] });
check(`Ada minted at ${A}`, !!adaV, adaVoucher.name);
check(`Ben minted at ${B}`, !!benV, benVoucher.name);

// --- 3. Ada posts with artwork; Ben reads it from the other cloud ---------
console.log('\n3. media + feeds across the boundary');
const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7c6cf0"/><text x="8" y="11" font-size="7" text-anchor="middle" fill="#fff">${stamp % 100}</text></svg>`;
const adaRef = await uploadMedia(ada, bankA, art);
const adaPost = sign({
  type: 'post', pubkey: ada.pubkey, ulid: newUlid(), voucher: adaV,
  body_md: 'One illustration, redeemable from me. Art rides along.',
  media: [adaRef], icon: adaRef, voucher_meta: true,
}, ada) as unknown as Post;
const adaPostHash = hashDoc(adaPost);
await rpc(ada, bankA, 'submit_docs', { docs: [adaPost] });

// Ben, whose account lives at bank B, reads Ada's feed at bank A directly.
const feed = await rpc(ben, bankA, 'list_posts', { pubkey: ada.pubkey, voucher_hash: 'all', limit: 10 });
const seen = feed.items.find((p: Post) => hashDoc(p) === adaPostHash);
check('Ben reads Ada\'s post from the other cloud', !!seen);
check('the post tree verifies under Ben\'s own keys', !!seen && verifyPostTree(seen));

// The voucher's presentation (meta release) must have been cached at intake.
const meta = await rpc(ben, bankA, 'get_voucher_meta', { voucher_hash: adaV });
check('Ada\'s voucher artwork is published', meta?.icon === adaRef, String(meta?.icon).slice(0, 20) + '…');

// Ben fetches the blob itself, unauthenticated, from the Deno bank.
const blob = await fetch(`${bankA.url}/media/${adaRef}`);
const blobBytes = new Uint8Array(await blob.arrayBuffer());
check(`Ben downloads the artwork from ${A}'s vault`, blob.status === 200 && blobBytes.length > 0,
  `${blobBytes.length}B ${blob.headers.get('content-type')}`);

// --- 4. cross-cloud repost: copy the blob, then repost -------------------
console.log('\n4. cross-cloud repost (blob copy + embedded post)');
// A bank only accepts a doc whose whole media tree it already holds, so Ben
// must copy Ada's bytes into the AWS vault first. Content addressing means
// the ref is identical on both sides and Ada's signature stays valid.
const refs = collectMediaRefs(seen!);
for (const ref of refs) {
  const bytes = new Uint8Array(await (await fetch(`${bankA.url}/media/${ref}`)).arrayBuffer());
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  const up = await authed(ben, bankB, 'POST', '/media', { data_base64: btoa(bin), ext: ref.split('.').pop() });
  check(`copied ${ref.slice(0, 10)}… into ${B}'s vault`, up.status === 201 && up.body.ref === ref);
}
const repost = sign({
  type: 'post', pubkey: ben.pubkey, ulid: newUlid(), voucher: benV,
  body_md: 'Spotted on the other side of the federation — worth a trade.',
  repost: seen,
}, ben) as unknown as Post;
const repostRes = await rpcRaw(ben, bankB, 'submit_docs', { docs: [repost] });
check(`${B} accepts the repost carrying Ada's signed post`, !repostRes.error,
  repostRes.error ? `${repostRes.error.code} ${repostRes.error.message}` : 'stored');
{
  const benFeed = await rpc(ada, bankB, 'list_posts', { pubkey: ben.pubkey, voucher_hash: 'all', limit: 10 });
  const rp = benFeed.items.find((p: Post) => hashDoc(p) === hashDoc(repost));
  check(`Ada reads Ben's repost of her own post, from ${B}`, !!rp && verifyPostTree(rp));
  check('the embedded original is still Ada\'s, byte-for-byte',
    !!rp && hashDoc((rp as Post).repost!) === adaPostHash);
}

// --- 5. they trade: one illustration for one code review ------------------
console.log('\n5. bilateral swap across the two clouds');
// Accounts: each user holds an account for each voucher, at that voucher's
// issuing bank. Ada is the issuer of hers (goes negative), Ben the holder.
const acct = async (u: User, b: BankRef, voucher: string, name: string) => {
  const a = sign({ type: 'account', pubkey: u.pubkey, ulid: newUlid(), name, voucher }, u);
  await rpc(u, b, 'submit_docs', { docs: [a] });
  return hashDoc(a);
};
const adaAtA = await acct(ada, bankA, adaV, 'ada-issuer');
const benAtA = await acct(ben, bankA, adaV, 'ben-holds-ada');
const benAtB = await acct(ben, bankB, benV, 'ben-issuer');
const adaAtB = await acct(ada, bankB, benV, 'ada-holds-ben');

// Orders: Ada gives 1 of hers, wants 1 of Ben's — and the mirror. Exactly one
// side must lead: the seen-chained ready→hold→settle handshake is asymmetric,
// and with two followers (or two leads) the deal correctly parks at approved.
const mkOrder = (u: User, debit: unknown, credit: unknown, lead: boolean) =>
  sign({ type: 'order', pubkey: u.pubkey, ulid: newUlid(), rate: 1, debit, credit, lead }, u);

const adaOrder = mkOrder(ada,
  { account: adaAtA, voucher: adaV, bank: bankA.pubkey, min: 1, max: 1 },
  { account: adaAtB, voucher: benV, bank: bankB.pubkey, min: 1, max: 1 }, true);
const benOrder = mkOrder(ben,
  { account: benAtB, voucher: benV, bank: bankB.pubkey, min: 1, max: 1 },
  { account: benAtA, voucher: adaV, bank: bankA.pubkey, min: 1, max: 1 }, false);

// Each Order goes to BOTH banks — each validates only its own side, and the
// coordinating bank must hold both to mint the record pair.
const adaOrderHash = hashDoc(adaOrder);
const benOrderHash = hashDoc(benOrder);
for (const [u, o, h] of [[ada, adaOrder, adaOrderHash], [ben, benOrder, benOrderHash]] as const) {
  for (const b of [bankA, bankB]) {
    await rpc(u as User, b, 'submit_docs', { docs: [o], publish_offers: [h] });
  }
}
// Offers are the discovery surface; the deal references the Order hash the
// Offer points at, which every participating bank can resolve.
const adaSell = (await rpc(ada, bankA, 'list_offers', { voucher_hash: adaV, intention: 'sell' }))
  .find((o: { order?: string }) => o.order === adaOrderHash);
const benSell = (await rpc(ben, bankB, 'list_offers', { voucher_hash: benV, intention: 'sell' }))
  .find((o: { order?: string }) => o.order === benOrderHash);
check(`Ada's offer is discoverable at ${A}`, !!adaSell);
check(`Ben's offer is discoverable at ${B}`, !!benSell);

// Ada coordinates the deal from her own bank, naming both banks.
const proposal = await authed(ada, bankA, 'POST', '/ui/propose_deal', {
  offer1: { hash: adaOrderHash, debit_amount: 1, credit_amount: 1 },
  offer2: { hash: benOrderHash, debit_amount: 1, credit_amount: 1 },
  banks: [{ pubkey: bankA.pubkey, url: bankA.url }, { pubkey: bankB.pubkey, url: bankB.url }],
});
check(`deal proposed from ${A}`, proposal.status === 200,
  proposal.status === 200 ? proposal.body.deal_id : JSON.stringify(proposal.body).slice(0, 160));

let state = 'unknown';
if (proposal.status === 200) {
  for (let i = 0; i < 30; i++) {
    const s = await authed(ada, bankA, 'GET', `/ui/deal/${proposal.body.deal_id}`);
    state = s.body?.state ?? 'unknown';
    if (state === 'settled' || state === 'rejected') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
check('deal reached settled', state === 'settled', state);

// --- 6. the ledger, read from both clouds --------------------------------
console.log('\n6. balances (each voucher must sum to zero)');
const bal = async (u: User, b: BankRef, account: string) =>
  (await rpc(u, b, 'get_account_balance', { account_hash: account })).current;
const adaIssuer = await bal(ada, bankA, adaAtA);
const benHolder = await bal(ben, bankA, benAtA);
const benIssuer = await bal(ben, bankB, benAtB);
const adaHolder = await bal(ada, bankB, adaAtB);
console.log(`  ada-illustration @${A} : issuer ${adaIssuer}  holder ${benHolder}`);
console.log(`  ben-code-review  @${B} : issuer ${benIssuer}  holder ${adaHolder}`);
check('Ada\'s currency sums to zero', adaIssuer + benHolder === 0, `${adaIssuer} + ${benHolder}`);
check('Ben\'s currency sums to zero', benIssuer + adaHolder === 0, `${benIssuer} + ${adaHolder}`);
check('Ada went negative issuing her own currency', adaIssuer === -1);
check('Ben holds what Ada owes him', benHolder === 1);

console.log(pass
  ? `\nFEDERATION ${A} <-> ${B} OK ✅`
  : '\nFEDERATION TEST FAILED ❌');
if (!pass) Deno.exit(1);
