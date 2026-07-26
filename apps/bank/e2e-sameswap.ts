// Same-bank bilateral swap against a running deployment (local or Deno Deploy).
//
// Two traders of the SAME bank swap two vouchers that the SAME bank issues:
// T1 issues VX, T2 issues VY, both at bank alice, and they trade 10 VX for
// 10 VY with two-sided Orders.
//
// This is the case `e2e-crossbank.ts` does NOT cover. A two-sided swap moves
// two vouchers, so the coordinator must mint TWO record pairs; when both
// vouchers are issued by one bank, both pairs belong to that one bank. A
// coordinator that iterates participating banks instead of transfers mints
// only one pair, leaving the counterparty Order's legs unmandated — which the
// advance engine reads as the permanent missing-leg case and rejects the deal.
//
//   deno run --allow-net --allow-env apps/bank/e2e-sameswap.ts
import {
  base58Encode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '@barter.game/protocol';

const BASE_URL = Deno.env.get('E2E_BASE_URL') ?? 'http://localhost:8000';
const BANK_URL = Deno.env.get('E2E_BANK_URL') ?? `${BASE_URL}/alice`;

type User = { privateKey: Uint8Array; pubkey: string };
type BankRef = { name: string; url: string; pubkey: string };

function makeUser(): User {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  return { privateKey, pubkey: pubkeyBase58 };
}

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
  const res = await fetch(`${bank.url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}@${bank.name}: ${data.error.code} ${data.error.message}`);
  return data.result;
}

async function sha256Base58(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return base58Encode(new Uint8Array(h));
}
function b64url(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function uiAuth(user: User, bank: BankRef, method: string, path: string, body: unknown) {
  const authdoc = {
    pubkey: user.pubkey, method, path: `/${bank.name}/ui${path}`,
    id: newUlid(), ts: Date.now(),
    body_sha256: body ? await sha256Base58(JSON.stringify(body)) : null,
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${bank.url}/ui${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`${path}@${bank.name}: ${data.code} ${data.message}`);
  return data;
}
async function register(user: User, bank: BankRef, handle: string) {
  const keystore = { kdf: 'none', ciphertext: base58Encode(user.privateKey) };
  const proof = signDoc({ handle, pubkey: user.pubkey, keystore_sha256: hashDoc(keystore) }, user.privateKey);
  const res = await fetch(`${bank.url}/ui/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: user.pubkey, keystore, proof }),
  });
  const data = await res.json();
  if (data.code) throw new Error(`register@${bank.name}: ${data.code} ${data.message}`);
}
function sign<T extends Record<string, unknown>>(doc: T, user: User): T & { sig: string } {
  return { ...doc, sig: signDoc(doc, user.privateKey) };
}

const alice = await discover(BANK_URL);
console.log('bank', alice.name, alice.pubkey.slice(0, 12));

const t1 = makeUser(); // issues VX, wants VY
const t2 = makeUser(); // issues VY, wants VX
const stamp = Date.now();
await register(t1, alice, 's1x' + stamp);
await register(t2, alice, 's2y' + stamp);

// Both vouchers are issued by the SAME bank.
const vx = sign({ type: 'voucher', pubkey: t1.pubkey, ulid: newUlid(), bank: alice.pubkey, name: 'SX-' + stamp, integer: true }, t1);
const vy = sign({ type: 'voucher', pubkey: t2.pubkey, ulid: newUlid(), bank: alice.pubkey, name: 'SY-' + stamp, integer: true }, t2);
const vxHash = hashDoc(vx);
const vyHash = hashDoc(vy);

// Four accounts: each trader holds an issuer account in their own voucher and
// a receiving account in the other's.
const t1vx = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1 issuer', voucher: vxHash }, t1);
const t1vy = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1 recv', voucher: vyHash }, t1);
const t2vy = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2 issuer', voucher: vyHash }, t2);
const t2vx = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2 recv', voucher: vxHash }, t2);

await rpc(t1, alice, 'submit_docs', { docs: [vx, t1vx] });
await rpc(t2, alice, 'submit_docs', { docs: [vy, t2vy] });
await rpc(t1, alice, 'submit_docs', { docs: [t1vy] });
await rpc(t2, alice, 'submit_docs', { docs: [t2vx] });

// Two-sided Orders, both sides naming the SAME bank. T1 leads.
const t1Order = sign({
  type: 'order', pubkey: t1.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(t1vx), voucher: vxHash, bank: alice.pubkey, min: 1, max: 10 },
  credit: { account: hashDoc(t1vy), voucher: vyHash, bank: alice.pubkey, min: 1, max: 10 },
  lead: true,
}, t1);
const t2Order = sign({
  type: 'order', pubkey: t2.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(t2vy), voucher: vyHash, bank: alice.pubkey, min: 1, max: 10 },
  credit: { account: hashDoc(t2vx), voucher: vxHash, bank: alice.pubkey, min: 1, max: 10 },
  lead: false,
}, t2);
const t1OrderHash = hashDoc(t1Order);
const t2OrderHash = hashDoc(t2Order);

await rpc(t1, alice, 'submit_docs', { docs: [t1Order], publish_offers: [t1OrderHash] });
await rpc(t2, alice, 'submit_docs', { docs: [t2Order], publish_offers: [t2OrderHash] });

// One participating bank, but TWO transfers.
const propose = await uiAuth(t1, alice, 'POST', '/propose_deal', {
  offer1: { hash: t1OrderHash, debit_amount: 10, credit_amount: 10 },
  offer2: { hash: t2OrderHash, debit_amount: 10, credit_amount: 10 },
  banks: [{ pubkey: alice.pubkey, url: alice.url }],
});
const dealId: string = propose.deal_id;
const minted = (propose.records?.[alice.pubkey] ?? []) as string[];
console.log('deal', dealId, '| records at bank:', minted.length);

let state = '';
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const status = await uiAuth(t1, alice, 'GET', `/deal/${dealId}`, null);
  state = status.state;
  console.log('  deal state:', state, '| legs', (status.legs || []).map((l: { direction: string; state: string }) => `${l.direction}:${l.state}`).join(','));
  if (state === 'settled' || state === 'rejected') break;
}

const t1vxBal = await rpc(t1, alice, 'get_account_balance', { account_hash: hashDoc(t1vx) });
const t2vxBal = await rpc(t2, alice, 'get_account_balance', { account_hash: hashDoc(t2vx) });
const t2vyBal = await rpc(t2, alice, 'get_account_balance', { account_hash: hashDoc(t2vy) });
const t1vyBal = await rpc(t1, alice, 'get_account_balance', { account_hash: hashDoc(t1vy) });
console.log('VX: issuer(t1)', t1vxBal.current, '| holder(t2)', t2vxBal.current);
console.log('VY: issuer(t2)', t2vyBal.current, '| holder(t1)', t1vyBal.current);

// Four records: a debit/credit pair for EACH voucher, both at this one bank.
const ok = state === 'settled' &&
  minted.length === 4 &&
  t1vxBal.current === -10 && t2vxBal.current === 10 &&
  t2vyBal.current === -10 && t1vyBal.current === 10;
console.log(ok ? 'PASS same-bank swap settled' : 'FAIL same-bank swap');
if (!ok) Deno.exit(1);
