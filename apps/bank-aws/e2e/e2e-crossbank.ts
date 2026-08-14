// Cross-bank bilateral swap against a running deployment (local or AWS).
//
// Two banks served by the SAME process (alice, bob). Trader T1 issues voucher
// VX at bank alice; trader T2 issues voucher VY at bank bob. They swap 10 VX
// for 10 VY. This exercises the coordinator creating records on two banks, the
// per-bank Confirm, and the lead/follow advance cascade — all of which, when
// the banks are co-located, dispatch in-process (no self-fetch round-trip).
//
//   bun run apps/bank-aws/e2e/e2e-crossbank.ts
import {
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
  canonicalizeWithoutSig,
  base58Encode,
} from '@barter.game/protocol';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
// Federation mode: point the two banks at DIFFERENT deployments to exercise
// the real HTTP bank-to-bank path (defaults keep the same-deployment test).
const BANK_A_URL = process.env.E2E_BANK_A_URL ?? `${BASE_URL}/alice`;
const BANK_B_URL = process.env.E2E_BANK_B_URL ?? `${BASE_URL}/bob`;

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

const alice = await discover(BANK_A_URL);
const bob = await discover(BANK_B_URL);
console.log('bank alice', alice.pubkey.slice(0, 12), '| bank bob', bob.pubkey.slice(0, 12));

const t1 = makeUser(); // issues VX at bank alice, wants VY
const t2 = makeUser(); // issues VY at bank bob, wants VX
const stamp = Date.now();
await register(t1, alice, 't1x' + stamp);
await register(t2, bob, 't2y' + stamp);

// Vouchers
const vx = sign({ type: 'voucher', pubkey: t1.pubkey, ulid: newUlid(), bank: alice.pubkey, name: 'VX-' + stamp, integer: true }, t1);
const vy = sign({ type: 'voucher', pubkey: t2.pubkey, ulid: newUlid(), bank: bob.pubkey, name: 'VY-' + stamp, integer: true }, t2);
const vxHash = hashDoc(vx);
const vyHash = hashDoc(vy);

// Accounts: each trader needs an account in BOTH vouchers.
const t1vx = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1-vx', voucher: vxHash }, t1);
const t1vy = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1-vy', voucher: vyHash }, t1);
const t2vy = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2-vy', voucher: vyHash }, t2);
const t2vx = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2-vx', voucher: vxHash }, t2);

// Register vouchers + accounts at the bank that issues each voucher.
await rpc(t1, alice, 'submit_docs', { docs: [vx, t1vx] });   // VX lives at alice
await rpc(t2, alice, 'submit_docs', { docs: [t2vx] });        // T2's VX receiving account at alice
await rpc(t2, bob, 'submit_docs', { docs: [vy, t2vy] });      // VY lives at bob
await rpc(t1, bob, 'submit_docs', { docs: [t1vy] });          // T1's VY receiving account at bob

// Two-sided Orders. T1 leads.
const t1Order = sign({
  type: 'order', pubkey: t1.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(t1vx), voucher: vxHash, bank: alice.pubkey, min: 1, max: 10 },
  credit: { account: hashDoc(t1vy), voucher: vyHash, bank: bob.pubkey, min: 1, max: 10 },
  lead: true,
}, t1);
const t2Order = sign({
  type: 'order', pubkey: t2.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(t2vy), voucher: vyHash, bank: bob.pubkey, min: 1, max: 10 },
  credit: { account: hashDoc(t2vx), voucher: vxHash, bank: alice.pubkey, min: 1, max: 10 },
  lead: false,
}, t2);
const t1OrderHash = hashDoc(t1Order);
const t2OrderHash = hashDoc(t2Order);

// Each Order is submitted to BOTH banks (each validates only its own side).
await rpc(t1, alice, 'submit_docs', { docs: [t1Order], publish_offers: [t1OrderHash] });
await rpc(t1, bob, 'submit_docs', { docs: [t1Order], publish_offers: [t1OrderHash] });
await rpc(t2, alice, 'submit_docs', { docs: [t2Order], publish_offers: [t2OrderHash] });
await rpc(t2, bob, 'submit_docs', { docs: [t2Order], publish_offers: [t2OrderHash] });

// Coordinator discovers each Order hash from a published Offer (Offers are the
// discovery surface; the Offer's `order` field carries the canonical Order
// hash that every participating bank can resolve).
const aliceOffers = await rpc(t1, alice, 'list_offers', { voucher_hash: vxHash, intention: 'sell' }) as Array<Record<string, unknown>>;
const t1Offer = aliceOffers.find((o) => (o as { order?: string }).order === t1OrderHash);
const bobOffers = await rpc(t2, bob, 'list_offers', { voucher_hash: vyHash, intention: 'sell' }) as Array<Record<string, unknown>>;
const t2Offer = bobOffers.find((o) => (o as { order?: string }).order === t2OrderHash);
if (!t1Offer || !t2Offer) throw new Error('offers not published as expected');
const t1OrderRef = (t1Offer as { order: string }).order;
const t2OrderRef = (t2Offer as { order: string }).order;

// Coordinator = T1, proposes the deal touching both banks, referencing Orders.
const propose = await uiAuth(t1, alice, 'POST', '/propose_deal', {
  offer1: { hash: t1OrderRef, debit_amount: 10, credit_amount: 10 },
  offer2: { hash: t2OrderRef, debit_amount: 10, credit_amount: 10 },
  banks: [{ pubkey: alice.pubkey, url: alice.url }, { pubkey: bob.pubkey, url: bob.url }],
});
console.log('proposed deal', propose.deal_id, propose.state);

// Poll deal status on alice (coordinator bank).
const dealId: string = propose.deal_id;
let finalState = '';
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 600));
  const status = await uiAuth(t1, alice, 'GET', `/deal/${dealId}`, null);
  finalState = status.state;
  console.log('deal state', status.state, '| legs', (status.legs || []).map((l: { state: string }) => l.state).join(','));
  if (status.state === 'settled' || status.state === 'rejected') break;
}

// Verify balances at both banks.
const t1vxBal = await rpc(t1, alice, 'get_account_balance', { account_hash: hashDoc(t1vx) });
const t2vxBal = await rpc(t2, alice, 'get_account_balance', { account_hash: hashDoc(t2vx) });
const t2vyBal = await rpc(t2, bob, 'get_account_balance', { account_hash: hashDoc(t2vy) });
const t1vyBal = await rpc(t1, bob, 'get_account_balance', { account_hash: hashDoc(t1vy) });
console.log('VX @alice: issuer T1', t1vxBal, '| T2', t2vxBal);
console.log('VY @bob:   issuer T2', t2vyBal, '| T1', t1vyBal);

const ok = finalState === 'settled' &&
  t1vxBal.current === -10 && t2vxBal.current === 10 &&
  t2vyBal.current === -10 && t1vyBal.current === 10;
console.log(ok ? 'CROSS-BANK SWAP OK ✅' : 'CROSS-BANK SWAP FAILED ❌');
if (!ok) process.exit(1);
