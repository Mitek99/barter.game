// Signer-authority attack: a party with NO bank key forges the peer bank's
// ready/hold/settle and tries to drive a follow bank through the whole cascade.
//
// The seen-chain proves a cascade is FRESH and bound to this deal. It does not,
// by itself, prove WHO asserted it. Record hashes and seen chains are public
// (get_record_signatures is unauthenticated), so an attacker can mint
// self-signed signatures anchored to the lead bank's record hashes, with
// correct seen containment, and — before the signer-authority filter — the
// follow bank counted them as the lead bank's own. It would then release the
// follower's goods with the lead bank never having settled.
//
// Setup: T1 issues VX at alice (lead), T2 issues VY at bob (follow). The
// attacker coordinates a real deal but mandates ONLY bob, so alice never
// advances a single record. Every "alice" signature bob sees is forged.
//
// PASS = bob refuses to settle and T2 keeps its VY.
//
//   bun run apps/bank-aws/e2e/e2e-forged-sigs.ts
import {
  base58Encode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '@barter.game/protocol';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_A_URL = process.env.E2E_BANK_A_URL ?? `${BASE_URL}/test1`;
const BANK_B_URL = process.env.E2E_BANK_B_URL ?? `${BASE_URL}/test2`;

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
  const env: Record<string, unknown> = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: user.pubkey, to: bank.pubkey, sig: '',
  };
  env.sig = signDoc(env, user.privateKey);
  const data = await fetch(`${bank.url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
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
  const data = await fetch(`${bank.url}/ui/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: user.pubkey, keystore, proof }),
  }).then((r) => r.json());
  if (data.code) throw new Error(`register@${bank.name}: ${data.code} ${data.message}`);
}
const sign = <T extends Record<string, unknown>>(d: T, u: User): T & { sig: string } =>
  ({ ...d, sig: signDoc(d, u.privateKey) });

const alice = await discover(BANK_A_URL);
const bob = await discover(BANK_B_URL);
console.log('bank alice', alice.pubkey.slice(0, 12), '| bank bob', bob.pubkey.slice(0, 12));

const t1 = makeUser();      // VX @ alice — the LEAD side, which will never actually run
const t2 = makeUser();      // VY @ bob   — the FOLLOW side we are trying to drain
const attacker = makeUser(); // holds NO bank key; coordinates the deal
const stamp = Date.now();
await register(t1, alice, 'fga' + stamp);
await register(t2, bob, 'fgb' + stamp);

const vx = sign({ type: 'voucher', pubkey: t1.pubkey, ulid: newUlid(), bank: alice.pubkey, name: 'FGX-' + stamp, integer: true }, t1);
const vy = sign({ type: 'voucher', pubkey: t2.pubkey, ulid: newUlid(), bank: bob.pubkey, name: 'FGY-' + stamp, integer: true }, t2);
const vxHash = hashDoc(vx), vyHash = hashDoc(vy);

const t1vx = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1-vx', voucher: vxHash }, t1);
const t1vy = sign({ type: 'account', pubkey: t1.pubkey, ulid: newUlid(), name: 't1-vy', voucher: vyHash }, t1);
const t2vy = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2-vy', voucher: vyHash }, t2);
const t2vx = sign({ type: 'account', pubkey: t2.pubkey, ulid: newUlid(), name: 't2-vx', voucher: vxHash }, t2);

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
const t1OrderHash = hashDoc(t1Order), t2OrderHash = hashDoc(t2Order);
for (const b of [alice, bob]) {
  await rpc(t1, b, 'submit_docs', { docs: [t1Order] });
  await rpc(t2, b, 'submit_docs', { docs: [t2Order] });
}

// ---- the attacker coordinates a real deal, but mandates ONLY bob ----
const dealId = newUlid();
const aliceRecs = await rpc(attacker, alice, 'create_records', {
  giver: t1OrderHash, receiver: t2OrderHash, amount: 10, counter_amount: 10, deal_id: dealId,
}) as { records: Array<Record<string, unknown>> };
const bobRecs = await rpc(attacker, bob, 'create_records', {
  giver: t2OrderHash, receiver: t1OrderHash, amount: 10, counter_amount: 10, deal_id: dealId,
}) as { records: Array<Record<string, unknown>> };

const aliceDebit = aliceRecs.records.find((r) => r.type === 'debit')!;   // t1's VX debit
const aliceCredit = aliceRecs.records.find((r) => r.type === 'credit')!; // t2's VX credit
const bobDebit = bobRecs.records.find((r) => r.type === 'debit')!;       // t2's VY debit  <-- the goods
const bobCredit = bobRecs.records.find((r) => r.type === 'credit')!;     // t1's VY credit

// Mandate ONLY bob. alice is never told to advance, so alice signs nothing.
function mandate(order: string, records: Array<Record<string, unknown>>) {
  return sign({
    type: 'mandate', pubkey: attacker.pubkey, ulid: newUlid(),
    deal_id: dealId, order, bank: bob.pubkey, records: records.map(hashDoc),
  }, attacker);
}
await rpc(attacker, bob, 'submit_mandate', {
  mandate: mandate(t2OrderHash, [bobDebit, aliceCredit]), records: [bobDebit, aliceCredit],
});
await rpc(attacker, bob, 'submit_mandate', {
  mandate: mandate(t1OrderHash, [bobCredit, aliceDebit]), records: [bobCredit, aliceDebit],
});

const foreign = [hashDoc(aliceDebit), hashDoc(aliceCredit)];   // alice's records
const ownBob = [hashDoc(bobDebit), hashDoc(bobCredit)];

// Everything the attacker needs is PUBLIC.
async function sigsAt(bank: BankRef, recordHash: string) {
  const r = await rpc(attacker, bank, 'get_record_signatures', { record_hash: recordHash });
  return (r.signatures ?? []) as Array<Record<string, unknown>>;
}
const forge = (recordHash: string, action: string, seen: string[]) =>
  sign({
    type: 'signature', pubkey: attacker.pubkey, ulid: newUlid(),
    hash: recordHash, action, ...(seen.length ? { seen } : {}),
  }, attacker);

// Step 1 — forge alice's `ready` so bob believes the whole record set is ready.
await rpc(attacker, bob, 'notify_signatures', {
  signatures: foreign.map((h) => forge(h, 'ready', [])),
});
await new Promise((r) => setTimeout(r, 600));

// Step 2 — forge alice's `hold`, citing bob's own ready hashes (public).
const bobReadyHashes: string[] = [];
for (const h of ownBob) {
  for (const s of await sigsAt(bob, h)) if (s.action === 'ready') bobReadyHashes.push(hashDoc(s));
}
const forgedReadyHashes: string[] = [];
for (const h of foreign) {
  for (const s of await sigsAt(bob, h)) if (s.action === 'ready') forgedReadyHashes.push(hashDoc(s));
}
await rpc(attacker, bob, 'notify_signatures', {
  signatures: foreign.map((h) => forge(h, 'hold', [...bobReadyHashes, ...forgedReadyHashes])),
});
await new Promise((r) => setTimeout(r, 600));

// Step 3 — forge alice's `settle`, citing bob's own hold hashes (public).
const bobHoldHashes: string[] = [];
for (const h of ownBob) {
  for (const s of await sigsAt(bob, h)) if (s.action === 'hold') bobHoldHashes.push(hashDoc(s));
}
await rpc(attacker, bob, 'notify_signatures', {
  signatures: foreign.map((h) => forge(h, 'settle', bobHoldHashes)),
});
await new Promise((r) => setTimeout(r, 1200));

// ---- did the forgery actually reach bob? (proves the GATE blocked it, not the network) ----
let storedForged = 0;
for (const h of foreign) {
  for (const s of await sigsAt(bob, h)) if (s.pubkey === attacker.pubkey) storedForged++;
}

// ---- verdict ----
const status = await uiAuth(t2, bob, 'GET', `/deal/${dealId}`, null).catch(() => ({ state: 'unknown', legs: [] }));
const t2Bal = await rpc(t2, bob, 'get_account_balance', { account_hash: hashDoc(t2vy) });
const t1Bal = await rpc(t1, bob, 'get_account_balance', { account_hash: hashDoc(t1vy) });

console.log(`forged sigs stored at bob : ${storedForged} (delivery worked — the gate is what must stop this)`);
console.log('bob deal state            :', status.state,
  '| legs', (status.legs || []).map((l: { state: string }) => l.state).join(','));
console.log('T2 VY issuer (the goods)  :', t2Bal.current, '| T1 VY', t1Bal.current);

const settled = status.state === 'settled' ||
  (status.legs || []).some((l: { settle?: boolean }) => l.settle);
const drained = t2Bal.current !== 0 || t1Bal.current !== 0;
const ok = storedForged > 0 && !settled && !drained;

if (!ok && storedForged === 0) {
  console.log('INCONCLUSIVE ❌ — forged signatures never reached bob; the test proved nothing');
} else {
  console.log(ok
    ? 'FORGERY REJECTED ✅ (bob ignored non-bank signatures; nothing settled, no balance moved)'
    : `FORGERY SUCCEEDED ❌ (settled=${settled} T2=${t2Bal.current} T1=${t1Bal.current} — a keyless attacker drove settlement)`);
}
if (!ok) process.exit(1);
