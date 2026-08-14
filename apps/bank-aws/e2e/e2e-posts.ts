// Voucher post feeds end to end (protocol/post-feed.md).
//
// Covers the write path (`submit_docs` with a Post), the read path
// (`list_posts` / `get_post` / `get_post_signatures`), reply and repost
// embedding, pagination by `before`, media upload + unauthenticated fetch,
// and the rejections that make the whole thing safe: unknown voucher, a post
// signed by someone other than the sender, a forged embedded ancestor, and
// media that was never uploaded.
//
//   bun run apps/bank-aws/e2e/e2e-posts.ts
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

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_URL = process.env.E2E_BANK_URL ?? `${BASE_URL}/alice`;

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

async function authedReq(user: User, bank: BankRef, method: string, path: string, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const authdoc = {
    pubkey: user.pubkey, method, path: `/${bank.name}${path}`,
    id: newUlid(), ts: Date.now(),
    body_sha256: text ? await sha256Base58(text) : null,
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${bank.url}${path}`, {
    method,
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

// --- 8. follows: default, bank repost, unfollow ---------------------------
{
  // A brand-new account has never touched /follows.
  // No registration needed: /ui auth verifies a signature, not a handle.
  const fresh = makeUser();
  const f0 = await authedReq(fresh, alice, 'GET', '/ui/follows');
  check('new user follows their own bank by default',
    Array.isArray(f0.body) && f0.body.includes(alice.pubkey),
    JSON.stringify(f0.body));

  // The bank reposts what its users publish, so the bank feed carries p1 —
  // which is what makes a newcomer's feed non-empty on day one.
  const bankFeed = await rpc(fresh, alice, 'list_posts', {
    pubkey: alice.pubkey, voucher_hash: 'all',
  }) as { items: Array<Record<string, unknown>> };
  const carried = bankFeed.items.some((p) =>
    (p.repost as { body_md?: string } | undefined)?.body_md === p1.body_md);
  check('bank reposted a user post into its own feed', carried,
    `${bankFeed.items.length} post(s) in the bank feed`);
  check('bank reposts are signed by the bank and embed the original',
    bankFeed.items.every((p) => p.pubkey === alice.pubkey && !!p.repost),
    'all bank-authored with an embedded original');

  // Unfollowing must stick — resolveFollows only re-seeds when never set.
  await authedReq(fresh, alice, 'DELETE', `/ui/follows/${alice.pubkey}`);
  const f1 = await authedReq(fresh, alice, 'GET', '/ui/follows');
  check('unfollowing the bank sticks (empty list is not re-seeded)',
    Array.isArray(f1.body) && !f1.body.includes(alice.pubkey),
    JSON.stringify(f1.body));

  // ...and re-following works.
  await authedReq(fresh, alice, 'POST', '/ui/follows', { pubkey: issuer.pubkey });
  const f2 = await authedReq(fresh, alice, 'GET', '/ui/follows');
  check('following an author adds them', Array.isArray(f2.body) && f2.body.includes(issuer.pubkey),
    JSON.stringify(f2.body));
}

// --- 9. voucher meta releases ---------------------------------------------
{
  const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
  const SQUARE = '<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>';

  // The issuer restyles their own live currency.
  const release = mkPost(issuer, voucherHash, 'Now with a proper mark.', {
    voucher_meta: true, icon_svg: ICON, square_svg: SQUARE,
  });
  const r = await rpcRaw(issuer, alice, 'submit_docs', { docs: [release] });
  check('issuer may release voucher meta', !r.error, r.error ? r.error.message : 'stored');

  const m = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: voucherHash }) as
    Record<string, string>;
  check('meta cached server-side and readable by anyone',
    m?.icon_svg === ICON && m?.square_svg === SQUARE,
    m ? 'icon + square stored' : 'no meta');
  check('the post text becomes the voucher description',
    m?.description_md === 'Now with a proper mark.', m?.description_md ?? 'none');

  // A newer release wins.
  const ICON2 = '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
  await rpc(issuer, alice, 'submit_docs', {
    docs: [mkPost(issuer, voucherHash, 'Restyled again.', { voucher_meta: true, icon_svg: ICON2 })],
  });
  const m2 = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: voucherHash }) as
    Record<string, string>;
  check('a newer release overrides the older one',
    m2?.icon_svg === ICON2 && m2?.description_md === 'Restyled again.',
    m2?.description_md ?? 'none');

  // Anyone else must not be able to redefine someone's currency.
  const hijack = mkPost(holder, voucherHash, 'my branding now', {
    voucher_meta: true, icon_svg: ICON,
  });
  const rj = await rpcRaw(holder, alice, 'submit_docs', { docs: [hijack] });
  check('non-issuer refused a meta release', rj.error?.code === -32001,
    rj.error ? rj.error.message : 'ACCEPTED — anyone can restyle any voucher');

  const m3 = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: voucherHash }) as
    Record<string, string>;
  check('the refused release did not change the meta', m3?.icon_svg === ICON2,
    m3?.description_md ?? 'none');

  // Oversized artwork is refused before it can be amplified by reposts.
  const huge = mkPost(issuer, voucherHash, 'too big', {
    voucher_meta: true, icon_svg: '<svg ' + 'x'.repeat(9000) + '></svg>',
  });
  const rh = await rpcRaw(issuer, alice, 'submit_docs', { docs: [huge] });
  check('oversized SVG refused', !!rh.error, rh.error ? rh.error.message : 'ACCEPTED');

  // And a non-SVG string is not artwork.
  const bad = mkPost(issuer, voucherHash, 'not svg', {
    voucher_meta: true, icon_svg: '<script>alert(1)</script>',
  });
  const rb = await rpcRaw(issuer, alice, 'submit_docs', { docs: [bad] });
  check('non-SVG icon refused', !!rb.error, rb.error ? rb.error.message : 'ACCEPTED');
}

// --- 10. media refs "<hash>.<ext>": ext serving, voucher images, meta refs -
// Stamped so every run's bytes (and therefore hash) are fresh — the local
// KV persists across runs, and a stale identical blob at bob would make the
// "refused while bob lacks the blobs" check vacuous.
const artSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c33"/><!-- ${stamp} --></svg>`;
const artB64 = btoa(String.fromCharCode(...new TextEncoder().encode(artSvg)));
let artRef = '';
let imgVoucherHash = '';
let refPost: Record<string, unknown> = {};
{
  const up = await authedPost(issuer, alice, '/media', { ext: 'svg', data_base64: artB64 });
  check('upload with ext returns the full ref', up.status === 201 &&
    typeof up.body.ref === 'string' && (up.body.ref as string).endsWith('.svg'),
    `${up.status} ${JSON.stringify(up.body)}`);
  artRef = up.body.ref as string;

  // Re-uploading identical bytes lands on the same ref — content addressing
  // makes "overwrite" a no-op.
  const again = await authedPost(issuer, alice, '/media', { ext: 'svg', data_base64: artB64 });
  check('same bytes re-upload is idempotent', again.body.ref === artRef, String(again.body.ref));

  // The extension names the Content-Type, so the immutable URL can sit
  // behind a caching CDN with no byte sniffing.
  const res = await fetch(`${alice.url}/media/${artRef}`);
  const served = new TextDecoder().decode(await res.arrayBuffer());
  check('GET /media/<hash>.svg serves image/svg+xml, immutable',
    res.status === 200 && res.headers.get('Content-Type') === 'image/svg+xml' &&
    (res.headers.get('Cache-Control') ?? '').includes('immutable') && served === artSvg,
    `${res.status} ${res.headers.get('Content-Type')}`);

  // A voucher carries image REFS; the blobs must already be in the vault.
  const vBad = sign({
    type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(), bank: alice.pubkey,
    name: 'IMG-BAD-' + stamp, images: [`${hashDoc({ absent: 2 })}.png`],
  }, issuer);
  const rBad = await rpcRaw(issuer, alice, 'submit_docs', { docs: [vBad] });
  check('voucher with unstored images refused', rBad.error?.code === -32005,
    rBad.error ? rBad.error.message : 'ACCEPTED');

  const vImg = sign({
    type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(), bank: alice.pubkey,
    name: 'IMG-' + stamp, images: [artRef], description_md: 'has a face from birth',
  }, issuer);
  const vImgHash = imgVoucherHash = hashDoc(vImg);
  const rImg = await rpcRaw(issuer, alice, 'submit_docs', { docs: [vImg] });
  check('voucher with stored images accepted', !rImg.error, rImg.error ? rImg.error.message : 'stored');

  // No release yet — meta falls back to the voucher's own images.
  const m0 = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: vImgHash }) as
    Record<string, unknown>;
  check('meta falls back to the voucher images', m0?.icon === artRef,
    JSON.stringify(m0));

  // A meta release with refs overrides the fallback.
  const rel = mkPost(issuer, vImgHash, 'fresh coat of paint', {
    voucher_meta: true, icon: artRef, square: artRef,
  });
  await rpc(issuer, alice, 'submit_docs', { docs: [rel] });
  const m1 = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: vImgHash }) as
    Record<string, unknown>;
  check('meta release with refs wins over the fallback',
    m1?.icon === artRef && m1?.square === artRef && typeof m1?.post === 'string',
    JSON.stringify({ icon: m1?.icon, post: m1?.post }));

  // Ref-form media on a post: refused until the blob exists, accepted after.
  const missingRefPost = mkPost(issuer, voucherHash, 'see art', {
    media: [`${hashDoc({ absent: 3 })}.png`],
  });
  const rMiss = await rpcRaw(issuer, alice, 'submit_docs', { docs: [missingRefPost] });
  check('post with unstored ref media refused', rMiss.error?.code === -32005,
    rMiss.error ? rMiss.error.message : 'ACCEPTED');

  refPost = mkPost(issuer, voucherHash, 'the artwork, hash-addressed', { media: [artRef] });
  const rOk = await rpcRaw(issuer, alice, 'submit_docs', { docs: [refPost] });
  check('post with stored ref media accepted', !rOk.error, rOk.error ? rOk.error.message : 'stored');

  // A garbage extension is not a ref and not a legacy hash either.
  const junk = mkPost(issuer, voucherHash, 'bad ref', { media: [`${artRef.split('.')[0]}.exe`] });
  const rJunk = await rpcRaw(issuer, alice, 'submit_docs', { docs: [junk] });
  check('unknown media extension refused', !!rJunk.error,
    rJunk.error ? rJunk.error.message : 'ACCEPTED');
}

// --- 11. cross-bank repost requires copying the blobs over ----------------
{
  const bob = await discover(`${BASE_URL.replace(/\/$/, '')}/bob`);
  const reposter = makeUser();
  // The reposter anchors to a voucher of their own at bob (§4 allows a
  // different anchor); the embedded original still drags its media refs in.
  const anchor = sign({
    type: 'voucher', pubkey: reposter.pubkey, ulid: newUlid(), bank: bob.pubkey,
    name: 'ANCHOR-' + stamp, integer: true,
  }, reposter);
  await rpc(reposter, bob, 'submit_docs', { docs: [anchor] });

  const rp = sign({
    type: 'post', pubkey: reposter.pubkey, ulid: newUlid(), voucher: hashDoc(anchor),
    body_md: 'spotted at alice — copying the art over', repost: refPost,
  }, reposter);
  const r1 = await rpcRaw(reposter, bob, 'submit_docs', { docs: [rp] });
  check('cross-bank repost refused while bob lacks the blobs', r1.error?.code === -32005,
    r1.error ? r1.error.message : 'ACCEPTED');

  // The copy step the client performs: download from the origin bank,
  // upload to the bank being reposted to. Same bytes ⇒ same ref ⇒ the
  // embedded signature still verifies.
  const dl = await fetch(`${alice.url}/media/${artRef}`);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const copied = await authedPost(reposter, bob, '/media', {
    ext: 'svg', data_base64: btoa(String.fromCharCode(...bytes)),
  });
  check('blob copied to bob lands on the same ref', copied.body.ref === artRef,
    String(copied.body.ref));

  const r2 = await rpcRaw(reposter, bob, 'submit_docs', { docs: [rp] });
  check('repost accepted once the blobs are copied', !r2.error,
    r2.error ? r2.error.message : 'stored');

  const servedAtBob = await fetch(`${bob.url}/media/${artRef}`);
  check('the copied blob serves from bob too', servedAtBob.status === 200 &&
    servedAtBob.headers.get('Content-Type') === 'image/svg+xml',
    `${servedAtBob.status}`);
  await servedAtBob.arrayBuffer();
}

// --- 12. hardening: ext gate, sandboxed serving, meta merge, media cap -----
{
  // Prototype keys are not extensions — `in` on a plain object would say so.
  const proto = await authedPost(issuer, alice, '/media', { ext: 'constructor', data_base64: artB64 });
  check('prototype-key ext refused at upload', proto.status === 400, String(proto.status));

  // A caller-chosen Content-Type never reaches storage.
  const html = await authedPost(issuer, alice, '/media', {
    content_type: 'text/html',
    data_base64: btoa('<html><script>alert(1)</script></html>'),
  });
  check('non-image content_type refused at upload', html.status === 400, String(html.status));

  // Serving is sniff-proof and sandboxed — a blob can render, never run.
  const res = await fetch(`${alice.url}/media/${artRef}`);
  await res.arrayBuffer();
  check('media serves nosniff + sandboxing CSP',
    res.headers.get('X-Content-Type-Options') === 'nosniff' &&
    (res.headers.get('Content-Security-Policy') ?? '').includes('sandbox'),
    `${res.headers.get('X-Content-Type-Options')} / ${res.headers.get('Content-Security-Policy') ?? 'none'}`);

  // "<hash>.__proto__" is not a ref, and not a stored bare hash either.
  const weird = await fetch(`${alice.url}/media/${artRef.split('.')[0]}.__proto__`);
  await weird.body?.cancel();
  check('prototype-key GET is 404', weird.status === 404, String(weird.status));

  // A description-only release keeps the current artwork (merge, not wipe).
  const words = mkPost(issuer, imgVoucherHash, 'words only — the art must stay', {
    voucher_meta: true,
  });
  await rpc(issuer, alice, 'submit_docs', { docs: [words] });
  const m = await rpc(stranger, alice, 'get_voucher_meta', { voucher_hash: imgVoucherHash }) as
    Record<string, unknown>;
  check('description-only release keeps the artwork',
    m?.icon === artRef && m?.description_md === 'words only — the art must stay',
    JSON.stringify({ icon: m?.icon, description: m?.description_md }));

  // Media list is capped per post.
  const many = mkPost(issuer, voucherHash, 'too many', { media: Array(13).fill(artRef) });
  const rMany = await rpcRaw(issuer, alice, 'submit_docs', { docs: [many] });
  check('post with more than 12 media entries refused', !!rMany.error,
    rMany.error ? rMany.error.message : 'ACCEPTED');
}

console.log(pass ? 'POST FEEDS OK ✅' : 'POST FEEDS FAILED ❌');
if (!pass) process.exit(1);
