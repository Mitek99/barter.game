// Voucher post feeds end to end (protocol/post-feed.md).
//
// Covers the write path (`submit_docs` with a Post), the read path
// (`list_posts` / `get_post` / `get_post_signatures`), reply and repost
// embedding, pagination by `before`, media upload + unauthenticated fetch,
// and the rejections that make the whole thing safe: unknown voucher, a post
// signed by someone other than the sender, a forged embedded ancestor, and
// media that was never uploaded.
//
//   deno run --allow-net --allow-env apps/bank/e2e-posts.ts
import {
  base58Encode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
  verifyPostTree,
  type Post,
} from '@barter.game/protocol';

const BASE_URL = Deno.env.get('E2E_BASE_URL') ?? 'http://localhost:8000';
const BANK_URL = Deno.env.get('E2E_BANK_URL') ?? `${BASE_URL}/alice`;

type User = { privateKey: Uint8Array; pubkey: string };
type BankRef = { name: string; url: string; pubkey: string };

const makeUser = (): User => {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  return { privateKey, pubkey: pubkeyBase58 };
};

async function discover(url: string): Promise<BankRef> {
  const info = await fetch(`${url}/barter-bank.json`).then((r) => r.json());
  return { name: info.name, url, pubkey: info.pubkey };
}

async function rpcRaw(user: User, bank: BankRef, method: string, params: Record<string, unknown>) {
  const envelope: Record<string, unknown> = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: user.pubkey, to: bank.pubkey, sig: '',
  };
  envelope.sig = signDoc(envelope, user.privateKey);
  const res = await fetch(`${bank.url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return await res.json();
}
async function rpc(user: User, bank: BankRef, method: string, params: Record<string, unknown>) {
  const data = await rpcRaw(user, bank, method, params);
  if (data.error) throw new Error(`${method}@${bank.name}: ${data.error.code} ${data.error.message}`);
  return data.result;
}

function b64url(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Base58(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return base58Encode(new Uint8Array(h));
}
/** Signed request to a non-/ui path (media lives at /:bank/media). */
async function authedPost(user: User, bank: BankRef, path: string, body: unknown) {
  const text = JSON.stringify(body);
  const authdoc = {
    pubkey: user.pubkey, method: 'POST', path: `/${bank.name}${path}`,
    id: newUlid(), ts: Date.now(), body_sha256: await sha256Base58(text),
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${bank.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: text,
  });
  return { status: res.status, body: await res.json() };
}

const sign = <T extends Record<string, unknown>>(d: T, u: User): T & { sig: string } =>
  ({ ...d, sig: signDoc(d, u.privateKey) });

let pass = true;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) pass = false;
};

const alice = await discover(BANK_URL);
const stamp = Date.now();
const issuer = makeUser();   // mints the voucher, authors most posts
const holder = makeUser();   // a second author on the same voucher
const stranger = makeUser();

// --- setup: a voucher to anchor the feed to -------------------------------
const voucher = sign({
  type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(),
  bank: alice.pubkey, name: 'FEED-' + stamp, integer: true,
}, issuer);
const voucherHash = hashDoc(voucher);
await rpc(issuer, alice, 'submit_docs', { docs: [voucher] });

const other = sign({
  type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(),
  bank: alice.pubkey, name: 'FEED2-' + stamp, integer: true,
}, issuer);
const otherHash = hashDoc(other);
await rpc(issuer, alice, 'submit_docs', { docs: [other] });

const mkPost = (u: User, v: string, body: string, extra: Record<string, unknown> = {}) =>
  sign({ type: 'post', pubkey: u.pubkey, ulid: newUlid(), voucher: v, body_md: body, ...extra }, u);

// --- 1. write + read ------------------------------------------------------
const p1 = mkPost(issuer, voucherHash, 'Booth 12 all Saturday. Redeem there.');
const p1Hash = hashDoc(p1);
await rpc(issuer, alice, 'submit_docs', { docs: [p1] });
{
  const r = await rpc(issuer, alice, 'list_posts', { pubkey: issuer.pubkey, voucher_hash: voucherHash });
  check('post appears in the voucher feed', r.items.length === 1 && hashDoc(r.items[0]) === p1Hash,
    `${r.items.length} item(s)`);
}
{
  const r = await rpc(issuer, alice, 'get_post', { post_hash: p1Hash });
  check('get_post returns the body', r.body_md === p1.body_md, r.body_md ?? 'missing');
}

// --- 2. "all" spans vouchers, the filtered feed does not -------------------
const p2 = mkPost(issuer, otherHash, 'Second currency, same stall.');
await rpc(issuer, alice, 'submit_docs', { docs: [p2] });
{
  const all = await rpc(issuer, alice, 'list_posts', { pubkey: issuer.pubkey, voucher_hash: 'all' });
  const one = await rpc(issuer, alice, 'list_posts', { pubkey: issuer.pubkey, voucher_hash: voucherHash });
  check('"all" returns both vouchers', all.items.length === 2, `${all.items.length}`);
  check('voucher filter isolates one feed', one.items.length === 1, `${one.items.length}`);
}

// --- 3. newest-first + `before` pagination --------------------------------
const bulk: Post[] = [];
for (let i = 0; i < 5; i++) {
  const p = mkPost(issuer, voucherHash, `bulk ${i}`);
  bulk.push(p as unknown as Post);
  await rpc(issuer, alice, 'submit_docs', { docs: [p] });
}
{
  const page1 = await rpc(issuer, alice, 'list_posts', {
    pubkey: issuer.pubkey, voucher_hash: voucherHash, limit: 3,
  });
  const newestFirst = page1.items.every((p: Post, i: number) =>
    i === 0 || page1.items[i - 1].ulid > p.ulid);
  check('page is newest-first', newestFirst, page1.items.map((p: Post) => p.body_md).join(' | '));
  check('limit is honoured and next_before set', page1.items.length === 3 && !!page1.next_before,
    `${page1.items.length} items, next_before=${page1.next_before ?? 'none'}`);

  const page2 = await rpc(issuer, alice, 'list_posts', {
    pubkey: issuer.pubkey, voucher_hash: voucherHash, limit: 3, before: page1.next_before,
  });
  const overlap = page2.items.some((b: Post) =>
    page1.items.some((a: Post) => a.ulid === b.ulid));
  check('second page does not repeat the first', !overlap, `${page2.items.length} more`);
  check('pages cover the whole feed', page1.items.length + page2.items.length === 6,
    `${page1.items.length} + ${page2.items.length} of 6`);
}

// --- 4. reply and repost embed the FULL parent ----------------------------
const reply = mkPost(holder, voucherHash, 'Traded mine for a great t-shirt.', { reply_to: p1 });
await rpc(holder, alice, 'submit_docs', { docs: [reply] });
{
  const r = await rpc(holder, alice, 'list_posts', { pubkey: holder.pubkey, voucher_hash: voucherHash });
  const got = r.items[0];
  check('reply stored under its own author', r.items.length === 1, `${r.items.length}`);
  check('reply embeds the full parent, signature intact',
    !!got?.reply_to && got.reply_to.body_md === p1.body_md && verifyPostTree(got),
    got?.reply_to ? 'parent embedded + verifies' : 'no parent');
}

const repost = mkPost(issuer, voucherHash, 'Worth reading:', { repost: reply });
await rpc(issuer, alice, 'submit_docs', { docs: [repost] });
{
  const r = await rpc(issuer, alice, 'list_posts', {
    pubkey: issuer.pubkey, voucher_hash: voucherHash, limit: 1,
  });
  const got = r.items[0];
  // The repost embeds the reply, which itself embeds p1 — a two-deep thread
  // that must verify from the returned bytes alone.
  check('repost embeds the reply, which still embeds ITS parent',
    !!got?.repost?.reply_to && got.repost.reply_to.body_md === p1.body_md && verifyPostTree(got),
    'nested thread verifies');
}

// --- 5. rejections --------------------------------------------------------
{
  const bogus = mkPost(issuer, hashDoc({ not: 'a voucher' }), 'anchored to nothing');
  const r = await rpcRaw(issuer, alice, 'submit_docs', { docs: [bogus] });
  check('unknown voucher refused', r.error?.code === -32005, r.error ? r.error.message : 'ACCEPTED');
}
{
  // Correctly signed by `holder`, but submitted by `stranger`.
  const p = mkPost(holder, voucherHash, 'not my envelope');
  const r = await rpcRaw(stranger, alice, 'submit_docs', { docs: [p] });
  check('post not signed by the sender refused', r.error?.code === -32001,
    r.error ? r.error.message : 'ACCEPTED');
}
{
  // A valid outer post whose embedded ancestor has been tampered with after
  // signing — the whole point of embedding signatures.
  const forgedParent = { ...(p1 as Record<string, unknown>), body_md: 'I never wrote this' };
  const p = mkPost(issuer, voucherHash, 'quoting you', { reply_to: forgedParent });
  const r = await rpcRaw(issuer, alice, 'submit_docs', { docs: [p] });
  check('forged embedded ancestor refused', r.error?.code === -32001,
    r.error ? r.error.message : 'ACCEPTED');
}
{
  const p = mkPost(issuer, voucherHash, 'see photo', { media: [hashDoc({ nope: 1 })] });
  const r = await rpcRaw(issuer, alice, 'submit_docs', { docs: [p] });
  check('post referencing unstored media refused', r.error?.code === -32005,
    r.error ? r.error.message : 'ACCEPTED');
}

// --- 6. media: upload, reference, fetch unauthenticated -------------------
{
  // A 1x1 GIF — small, but real bytes with non-UTF-8 content.
  const gifB64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const up = await authedPost(issuer, alice, '/media', {
    content_type: 'image/gif', data_base64: gifB64,
  });
  check('media upload accepted', up.status === 201 && typeof up.body.hash === 'string',
    `${up.status} ${JSON.stringify(up.body)}`);
  const mediaHash = up.body.hash as string;

  const withMedia = mkPost(issuer, voucherHash, 'the stall, this morning', { media: [mediaHash] });
  const r = await rpcRaw(issuer, alice, 'submit_docs', { docs: [withMedia] });
  check('post referencing stored media accepted', !r.error, r.error ? r.error.message : 'stored');

  // Download is deliberately unauthenticated.
  const res = await fetch(`${alice.url}/media/${mediaHash}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = base58Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  check('media fetched unauthenticated and hashes to its address',
    res.status === 200 && digest === mediaHash,
    `${res.status} ${res.headers.get('Content-Type')} ${bytes.length}B`);
  check('media is cached as immutable',
    (res.headers.get('Cache-Control') ?? '').includes('immutable'),
    res.headers.get('Cache-Control') ?? 'none');

  const missing = await fetch(`${alice.url}/media/${hashDoc({ absent: true })}`);
  check('unknown media is 404', missing.status === 404, String(missing.status));
}

// --- 7. endorsement signatures accrue separately --------------------------
{
  const endorsement = sign({
    type: 'signature', pubkey: holder.pubkey, ulid: newUlid(), hash: p1Hash, reason: 'can confirm',
  }, holder);
  await rpc(holder, alice, 'submit_docs', { docs: [endorsement] });
  const r = await rpc(stranger, alice, 'get_post_signatures', { post_hash: p1Hash });
  check('get_post_signatures returns the endorsement',
    r.signatures.length === 1 && r.signatures[0].reason === 'can confirm',
    `${r.signatures.length} signature(s)`);
}

console.log(pass ? 'POST FEEDS OK ✅' : 'POST FEEDS FAILED ❌');
if (!pass) Deno.exit(1);
