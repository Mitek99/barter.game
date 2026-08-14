// Single-bank cheque settlement — the whole deal lives at ONE bank (the
// voucher's issuer). This is the "scan a cheque, claim it" path when giver and
// receiver share the coin's bank. The seen-chain settle gates must NOT require
// a foreign follow leg here: with no foreign records the bank owns every leg
// and settles directly. Regression guard for the "stuck at held" bug.
//
//   bun run apps/bank-aws/e2e/e2e-cheque-local.ts
import {
  base58Encode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '@barter.game/protocol';

const BANK_NAME = process.env.E2E_BANK ?? 'alice';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_URL = `${BASE_URL}/${BANK_NAME}`;

const info = await fetch(`${BANK_URL}/barter-bank.json`).then((r) => r.json());
const bankPubkey: string = info.pubkey;

type User = { privateKey: Uint8Array; pubkey: string };
const makeUser = (): User => {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  return { privateKey, pubkey: pubkeyBase58 };
};

async function rpc(user: User, method: string, params: Record<string, unknown>) {
  const env: Record<string, unknown> = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: user.pubkey, to: bankPubkey, sig: '',
  };
  env.sig = signDoc(env, user.privateKey);
  const r = await fetch(`${BANK_URL}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  }).then((r) => r.json());
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result;
}
function b64url(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256Base58(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return base58Encode(new Uint8Array(h));
}
async function uiAuth(user: User, method: string, path: string, body: unknown) {
  const authdoc = {
    pubkey: user.pubkey, method, path: `/${BANK_NAME}/ui${path}`,
    id: newUlid(), ts: Date.now(),
    body_sha256: body ? await sha256Base58(JSON.stringify(body)) : null,
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${b64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${BANK_URL}/ui${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`${path}: ${data.code} ${data.message}`);
  return data;
}
async function register(user: User, handle: string) {
  const keystore = { kdf: 'none', ciphertext: base58Encode(user.privateKey) };
  const proof = signDoc({ handle, pubkey: user.pubkey, keystore_sha256: hashDoc(keystore) }, user.privateKey);
  const res = await fetch(`${BANK_URL}/ui/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: user.pubkey, keystore, proof }),
  });
  const data = await res.json();
  if (data.code) throw new Error(`register: ${data.code} ${data.message}`);
}
const sign = <T extends Record<string, unknown>>(d: T, u: User): T & { sig: string } =>
  ({ ...d, sig: signDoc(d, u.privateKey) });

const issuer = makeUser();   // issues the coin, GIVES via a cheque (may go negative)
const claimant = makeUser(); // RECEIVES the coin
const stamp = Date.now();
await register(issuer, 'lci' + stamp);
await register(claimant, 'lcc' + stamp);

// Issuer's voucher + a cheque: debit-only Order (issuer gives), lead=true.
const voucher = sign({ type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(), bank: bankPubkey, name: 'LC-' + stamp, integer: true }, issuer);
const vHash = hashDoc(voucher);
const issAcc = sign({ type: 'account', pubkey: issuer.pubkey, ulid: newUlid(), name: 'iss', voucher: vHash }, issuer);
const cheque = sign({
  type: 'order', pubkey: issuer.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(issAcc), voucher: vHash, bank: bankPubkey, min: 1, max: 10 },
  lead: true,
}, issuer);
await rpc(issuer, 'submit_docs', { docs: [voucher, issAcc, cheque] });

// Claimant's receiving Order: credit-only, lead=false.
const claimAcc = sign({ type: 'account', pubkey: claimant.pubkey, ulid: newUlid(), name: 'recv', voucher: vHash }, claimant);
const receive = sign({
  type: 'order', pubkey: claimant.pubkey, ulid: newUlid(), rate: 1,
  credit: { account: hashDoc(claimAcc), voucher: vHash, bank: bankPubkey, min: 1, max: 10 },
  lead: false,
}, claimant);
await rpc(claimant, 'submit_docs', { docs: [claimAcc, receive] });

// Claimant coordinates: giver = the cheque (debit), receiver = the receive order.
const propose = await uiAuth(claimant, 'POST', '/propose_deal', {
  offer1: { hash: hashDoc(cheque), debit_amount: 10, credit_amount: 10 },
  offer2: { hash: hashDoc(receive), debit_amount: 10, credit_amount: 10 },
  banks: [{ pubkey: bankPubkey, url: BANK_URL }],
});
const dealId: string = propose.deal_id;
console.log('proposed single-bank cheque deal', dealId);

let state = '';
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const status = await uiAuth(claimant, 'GET', `/deal/${dealId}`, null);
  state = status.state;
  console.log('deal state:', state, '| legs', (status.legs || []).map((l: { state: string }) => l.state).join(','));
  if (state === 'settled' || state === 'rejected') break;
}

const issBal = await rpc(issuer, 'get_account_balance', { account_hash: hashDoc(issAcc) });
const claimBal = await rpc(claimant, 'get_account_balance', { account_hash: hashDoc(claimAcc) });
console.log('issuer', issBal, '| claimant', claimBal);

const ok = state === 'settled' && issBal.current === -10 && claimBal.current === 10;
console.log(ok ? 'SINGLE-BANK CHEQUE OK ✅' : `SINGLE-BANK CHEQUE FAILED ❌ (state=${state})`);
if (!ok) process.exit(1);
