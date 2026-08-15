// Operator admin UI API end to end (/ui/admin/*).
//
// Admin access is env-config: the server must be booted with the well-known
// TEST admin keypair below in BANK_ADMINS (or BANK_ALICE_ADMINS). The key is
// committed on purpose — it grants admin only on banks whose operator lists
// it, which should only ever be a throwaway local one:
//
//   BANK_ADMINS=EWp6umhXgrkk4Jmmdo3x3muHTRQmTJJc7wsmNMskB82P
//
// Covers: non-admin refused on every admin route, overview counts track real
// activity, user/account/post listings show the docs created, and the manual
// bank-repost endpoint (idempotent on already-carried posts, 404 on unknown).
//
//   bun run apps/bank-aws/e2e/e2e-admin.ts
import {
  base58Decode,
  base58Encode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  publicKeyOf,
  signDoc,
} from '@barter.game/protocol';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_URL = process.env.E2E_BANK_URL ?? `${BASE_URL}/alice`;

// Well-known TEST admin identity (see header). Never use on a real bank.
const ADMIN_PRIV = base58Decode('5181kdeaJKNyDitNk25GB1sN5MAsbonzhpcU2fyorkS8');

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

async function rpc(user: User, bank: BankRef, method: string, params: Record<string, unknown>) {
  const envelope: Record<string, unknown> = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: user.pubkey, to: bank.pubkey, sig: '',
  };
  envelope.sig = signDoc(envelope, user.privateKey);
  const data = await fetch(`${bank.url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  }).then((r) => r.json());
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

async function register(user: User, bank: BankRef, handle: string) {
  const keystore = { kdf: 'none', ciphertext: base58Encode(user.privateKey) };
  const proof = signDoc({ handle, pubkey: user.pubkey, keystore_sha256: hashDoc(keystore) }, user.privateKey);
  const res = await fetch(`${bank.url}/ui/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: user.pubkey, keystore, proof }),
  });
  const data = await res.json();
  // The fixed admin key survives a warm server: already-registered is fine,
  // admin checks key off the pubkey, not the handle.
  if (data.code && data.code !== -32009) {
    throw new Error(`register@${bank.name}: ${data.code} ${data.message}`);
  }
}

let pass = true;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) pass = false;
};

const alice = await discover(BANK_URL);
const stamp = Date.now();

const admin: User = { privateKey: ADMIN_PRIV, pubkey: publicKeyOf(ADMIN_PRIV).pubkeyBase58 };
const member = makeUser();
await register(admin, alice, 'adm' + stamp.toString(36));
await register(member, alice, 'usr' + stamp.toString(36));

// --- 1. a non-admin is refused everywhere ----------------------------------
for (const [method, path] of [
  ['GET', '/ui/admin/overview'],
  ['GET', '/ui/admin/users'],
  ['GET', '/ui/admin/accounts'],
  ['GET', '/ui/admin/records'],
  ['GET', '/ui/admin/posts'],
  ['POST', '/ui/admin/repost'],
] as const) {
  const r = await authedReq(member, alice, method, path, method === 'POST' ? { hash: 'x' } : undefined);
  check(`non-admin refused ${method} ${path}`, r.status === 403, `${r.status} ${JSON.stringify(r.body)}`);
}

// --- 2. overview counts track real activity --------------------------------
const before = (await authedReq(admin, alice, 'GET', '/ui/admin/overview'));
check('admin reads overview', before.status === 200, JSON.stringify(before.body));

const voucher = sign({
  type: 'voucher', pubkey: admin.pubkey, ulid: newUlid(),
  bank: alice.pubkey, name: 'ADM-' + stamp, integer: true,
}, admin);
const voucherHash = hashDoc(voucher);
const account = sign({
  type: 'account', pubkey: admin.pubkey, ulid: newUlid(), name: 'adm issuer', voucher: voucherHash,
}, admin);
const accountHash = hashDoc(account);
await rpc(admin, alice, 'submit_docs', { docs: [voucher, account] });

const post = sign({
  type: 'post', pubkey: admin.pubkey, ulid: newUlid(),
  voucher: voucherHash, body_md: 'admin suite post ' + stamp,
}, admin);
const postHash = hashDoc(post);
await rpc(admin, alice, 'submit_docs', { docs: [post] });

const after = (await authedReq(admin, alice, 'GET', '/ui/admin/overview')).body;
check('overview: +1 voucher', after.vouchers === before.body.vouchers + 1, `${before.body.vouchers} -> ${after.vouchers}`);
check('overview: +1 account', after.accounts === before.body.accounts + 1, `${before.body.accounts} -> ${after.accounts}`);
check('overview: +2 posts (post + bank auto-repost)', after.posts === before.body.posts + 2, `${before.body.posts} -> ${after.posts}`);
check('overview: both registrations counted', after.users >= 2 && after.users === before.body.users, `${before.body.users} -> ${after.users}`);

// --- 3. listings ------------------------------------------------------------
// On a warm server the fixed admin key keeps its FIRST run's handle, so the
// handle-dependent checks below read it back from the users listing.
let adminHandle = 'adm' + stamp.toString(36);
{
  const r = await authedReq(admin, alice, 'GET', '/ui/admin/users');
  const users = r.body.users ?? [];
  const admRow = users.find((u: { pubkey: string }) => u.pubkey === admin.pubkey);
  const usrRow = users.find((u: { pubkey: string }) => u.pubkey === member.pubkey);
  check('users: admin row flagged admin', !!admRow && admRow.admin === true, JSON.stringify(admRow));
  check('users: member row not admin', !!usrRow && usrRow.admin === false, JSON.stringify(usrRow));
  if (admRow) adminHandle = admRow.handle;
}
{
  const r = await authedReq(admin, alice, 'GET', '/ui/admin/accounts');
  const row = (r.body.accounts ?? []).find((a: { hash: string }) => a.hash === accountHash);
  check('accounts: issuer account with balance + names',
    !!row && row.voucher_name === 'ADM-' + stamp && row.holder_handle === adminHandle
      && row.balance.current === 0,
    JSON.stringify(row));
}
{
  const r = await authedReq(admin, alice, 'GET', '/ui/admin/records');
  check('records: array response', r.status === 200 && Array.isArray(r.body.records), `${r.status}`);
}
{
  const r = await authedReq(admin, alice, 'GET', '/ui/admin/posts');
  const row = (r.body.posts ?? []).find((p: { hash: string }) => p.hash === postHash);
  check('posts: user post visible, already bank-reposted',
    !!row && row.bank_reposted === true && row.author_handle === adminHandle,
    JSON.stringify(row));
  check('posts: voucher names bundled', r.body.vouchers?.[voucherHash] === 'ADM-' + stamp, JSON.stringify(r.body.vouchers));
}

// --- 4. manual repost --------------------------------------------------------
{
  const r = await authedReq(admin, alice, 'POST', '/ui/admin/repost', { hash: postHash });
  check('repost of carried post is a no-op', r.status === 200 && r.body.already === true, JSON.stringify(r.body));
}
{
  const r = await authedReq(admin, alice, 'POST', '/ui/admin/repost', { hash: voucherHash });
  check('repost of a non-post doc 404s', r.status === 404, `${r.status} ${JSON.stringify(r.body)}`);
}

console.log(pass ? 'ADMIN OK ✅' : 'ADMIN FAILED ❌');
if (!pass) process.exit(1);
