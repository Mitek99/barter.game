// Settlement-replay attack test — the seen-chain must reject it.
//
// A malicious coordinator runs one genuine cross-bank swap (Deal-A: T1 gives VX
// via bank alice = LEAD, T2 gives VY via bank bob = FOLLOW), then tries to make
// bob give its VY a SECOND time (Deal-B) WITHOUT alice genuinely participating —
// by reusing alice's Deal-A records as Deal-B's foreign legs and replaying
// alice's Deal-A `settle` signatures to bob.
//
// Under the old by-signer settle gate, bob would settle Deal-B off any alice
// settle it had ever seen, draining bob's VY to -20. Under the seen-chain, bob's
// FOLLOW-hold gate requires alice's hold to cite bob's *Deal-B* ready sigs — a
// stale Deal-A hold does not — so bob never holds, never settles, stays at -10.
//
//   bun run apps/bank-aws/e2e/e2e-replay.ts
import {
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
  base58Encode,
} from '@barter.game/protocol';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
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
  const { canonicalizeWithoutSig } = await import('@barter.game/protocol');
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

const t1 = makeUser(); // VX @ alice, LEAD
const t2 = makeUser(); // VY @ bob, FOLLOW (the give we protect)
const stamp = Date.now();
await register(t1, alice, 'r1x' + stamp);
await register(t2, bob, 'r2y' + stamp);

const vx = sign({ type: 'voucher', pubkey: t1.pubkey, ulid: newUlid(), bank: alice.pubkey, name: 'RVX-' + stamp, integer: true }, t1);
const vy = sign({ type: 'voucher', pubkey: t2.pubkey, ulid: newUlid(), bank: bob.pubkey, name: 'RVY-' + stamp, integer: true }, t2);
const vxHash = hashDoc(vx);
const vyHash = hashDoc(vy);

const t1vx = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 'r1-vx', voucher: vxHash }, t1);
const t1vy = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 'r1-vy', voucher: vyHash }, t1);
const t2vy = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 'r2-vy', voucher: vyHash }, t2);
const t2vx = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 'r2-vx', voucher: vxHash }, t2);

await rpc(t1, alice, 'submit_docs', { docs: [vx, t1vx] });
await rpc(t2, alice, 'submit_docs', { docs: [t2vx] });
await rpc(t2, bob, 'submit_docs', { docs: [vy, t2vy] });
await rpc(t1, bob, 'submit_docs', { docs: [t1vy] });

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

for (const b of [alice, bob]) {
  await rpc(t1, b, 'submit_docs', { docs: [t1Order], publish_offers: [t1OrderHash] });
  await rpc(t2, b, 'submit_docs', { docs: [t2Order], publish_offers: [t2OrderHash] });
}

// ---- Deal-A: genuine swap, settles ----
const proposeA = await uiAuth(t1, alice, 'POST', '/propose_deal', {
  offer1: { hash: t1OrderHash, debit_amount: 10, credit_amount: 10 },
  offer2: { hash: t2OrderHash, debit_amount: 10, credit_amount: 10 },
  banks: [{ pubkey: alice.pubkey, url: alice.url }, { pubkey: bob.pubkey, url: bob.url }],
});
const dealA: string = proposeA.deal_id;
let stateA = '';
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const s = await uiAuth(t1, alice, 'GET', `/deal/${dealA}`, null);
  stateA = s.state;
  if (stateA === 'settled' || stateA === 'rejected') break;
}
const bobVyAfterA = await rpc(t2, bob, 'get_account_balance', { account_hash: hashDoc(t2vy) });
console.log('Deal-A', stateA, '| bob VY issuer', bobVyAfterA.current);
if (stateA !== 'settled' || bobVyAfterA.current !== -10) {
  console.log('SETUP FAILED ❌ (Deal-A did not settle as expected)');
  process.exit(1);
}

// ---- Capture alice's Deal-A records + her stale settle sigs ----
const dealAStatus = await uiAuth(t1, alice, 'GET', `/deal/${dealA}`, null);
const aliceHashes: string[] = dealAStatus.legs.flatMap((l: { records: string[] }) => l.records);
let aliceVxDebit: Record<string, unknown> | null = null;   // T1's VX debit (order t1) — foreign leg for t1Order
let aliceVxCredit: Record<string, unknown> | null = null;  // T2's VX credit (order t2) — foreign leg for t2Order
const staleSettles: unknown[] = [];
for (const h of aliceHashes) {
  const rs = await rpc(t1, alice, 'get_record_signatures', { record_hash: h });
  const body = rs.record as Record<string, unknown> | null;
  if (!body) continue;
  if (body.type === 'debit' && body.order === t1OrderHash) aliceVxDebit = body;
  if (body.type === 'credit' && body.order === t2OrderHash) aliceVxCredit = body;
  for (const s of rs.signatures as Array<Record<string, unknown>>) {
    if (s.action === 'settle') staleSettles.push(s);
  }
}
if (!aliceVxDebit || !aliceVxCredit) {
  console.log('SETUP FAILED ❌ (could not capture alice Deal-A records)');
  process.exit(1);
}
console.log('captured alice Deal-A legs + stale settles:', staleSettles.length);

// ---- Deal-B: attacker drives ONLY bob, reusing alice's Deal-A records ----
const dealB = newUlid();
// Mint bob's fresh VY pair for Deal-B (bob gives VY again).
const bobRecs = await rpc(t1, bob, 'create_records', {
  giver: t2OrderHash, receiver: t1OrderHash,
  amount: 10, counter_amount: 10, deal_id: dealB,
}) as { records: Array<Record<string, unknown>> };
const bobVyDebit = bobRecs.records.find((r) => r.type === 'debit')!;   // order t2
const bobVyCredit = bobRecs.records.find((r) => r.type === 'credit')!; // order t1

// Coordinator (T1) signs Mandates for bob, listing bob's fresh records + alice's
// REUSED Deal-A records as the foreign legs.
function mandate(order: string, records: string[]) {
  return sign({
    type: 'mandate', pubkey: t1.pubkey, ulid: newUlid(),
    deal_id: dealB, order, bank: bob.pubkey, records,
  }, t1);
}
const m2 = mandate(t2OrderHash, [hashDoc(bobVyDebit), hashDoc(aliceVxCredit)]);
const m1 = mandate(t1OrderHash, [hashDoc(bobVyCredit), hashDoc(aliceVxDebit)]);
await rpc(t1, bob, 'submit_mandate', { mandate: m2, records: [bobVyDebit, aliceVxCredit] });
await rpc(t1, bob, 'submit_mandate', { mandate: m1, records: [bobVyCredit, aliceVxDebit] });

// Replay alice's stale Deal-A settle signatures to bob.
await rpc(t1, bob, 'notify_signatures', { signatures: staleSettles });

// Give the engine time; poll bob's VY issuer balance. It MUST stay at -10.
let bobVyFinal = bobVyAfterA.current;
let dealBState = '';
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 500));
  await rpc(t1, bob, 'notify_signatures', { signatures: staleSettles }); // keep nudging
  const bal = await rpc(t2, bob, 'get_account_balance', { account_hash: hashDoc(t2vy) });
  bobVyFinal = bal.current;
  try {
    const s = await uiAuth(t2, bob, 'GET', `/deal/${dealB}`, null);
    dealBState = s.state;
  } catch { /* deal may 404 until mandated */ }
  if (bobVyFinal !== -10) break;
}

console.log('Deal-B bob state:', dealBState || '(none)', '| bob VY issuer:', bobVyFinal);
const ok = bobVyFinal === -10 && dealBState !== 'settled';
console.log(ok
  ? 'REPLAY REJECTED ✅ (bob never re-settled; seen-chain held the follow gate)'
  : `REPLAY SUCCEEDED ❌ (bob drained to ${bobVyFinal} — settle gate bypassed)`);
if (!ok) process.exit(1);
