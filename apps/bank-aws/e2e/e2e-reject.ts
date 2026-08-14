// Reject-path e2e: an uncoverable debit MUST reject the whole deal (not
// silently stall), releasing it for both parties. Runs against a live bank:
//
//   bun run apps/bank-aws/e2e/e2e-reject.ts
//
// Flow: issuer publishes a voucher + invoice; a payer with ZERO balance signs
// a cheque Order for it and the coordinator mandates the deal. The payer's
// debit has no in-deal credit that could cover it, so the bank must issue
// reject Signatures on both records and the deal must surface as `rejected`.
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

const issuer = makeUser();
const broke = makeUser(); // holds ZERO balance of the voucher
const stamp = Date.now();
await register(issuer, 'rji' + stamp);
await register(broke, 'rjb' + stamp);

// Issuer voucher + receiving invoice.
const voucher = sign({ type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(), bank: bankPubkey, name: 'RJ-' + stamp }, issuer);
const vHash = hashDoc(voucher);
const issAcc = sign({ type: 'account', pubkey: issuer.pubkey, ulid: newUlid(), name: 'iss', voucher: vHash }, issuer);
const invoice = sign({
  type: 'order', pubkey: issuer.pubkey, ulid: newUlid(), rate: 1,
  credit: { account: hashDoc(issAcc), voucher: vHash, bank: bankPubkey, min: 1, max: 10 },
  lead: false,
}, issuer);
await rpc(issuer, 'submit_docs', { docs: [voucher, issAcc, invoice] });

// Broke payer signs a cheque Order against a zero-balance account.
const brokeAcc = sign({ type: 'account', pubkey: broke.pubkey, ulid: newUlid(), name: 'empty', voucher: vHash }, broke);
const cheque = sign({
  type: 'order', pubkey: broke.pubkey, ulid: newUlid(), rate: 1,
  debit: { account: hashDoc(brokeAcc), voucher: vHash, bank: bankPubkey, min: 1, max: 10 },
  lead: true,
}, broke);
await rpc(broke, 'submit_docs', { docs: [brokeAcc, cheque] });

// Coordinator (the broke payer) mandates the doomed deal.
const propose = await uiAuth(broke, 'POST', '/propose_deal', {
  offer1: { hash: hashDoc(cheque), debit_amount: 5, credit_amount: 5 },
  offer2: { hash: hashDoc(invoice), debit_amount: 5, credit_amount: 5 },
  banks: [{ pubkey: bankPubkey, url: BANK_URL }],
});
const dealId: string = propose.deal_id;
console.log('proposed doomed deal', dealId);

let state = '';
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const status = await uiAuth(broke, 'GET', `/deal/${dealId}`, null);
  state = status.state;
  console.log('deal state:', state, '| legs', (status.legs || []).map((l: { state: string }) => l.state).join(','));
  if (state === 'rejected') break;
}

// Balances must be untouched.
const issBal = await rpc(issuer, 'get_account_balance', { account_hash: hashDoc(issAcc) });
const brokeBal = await rpc(broke, 'get_account_balance', { account_hash: hashDoc(brokeAcc) });
console.log('issuer', issBal, '| broke payer', brokeBal);

const ok = state === 'rejected' && issBal.current === 0 && brokeBal.current === 0;
console.log(ok ? 'REJECT CASCADE OK ✅' : `REJECT CASCADE FAILED ❌ (state=${state})`);
if (!ok) process.exit(1);
