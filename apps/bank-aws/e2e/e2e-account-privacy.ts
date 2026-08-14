// Account balances are private by default (bank-schema.md §1.2).
//
// `get_account_balance` takes only an account hash, and account hashes travel
// widely — they sit inside every Order side a counterparty signs, and any deal
// participant sees them. So the handler MUST authorize the caller, not just
// resolve the hash. Only two callers may read a balance in v1 (there is no
// `Account.public` opt-in yet):
//
//   - the account's holder
//   - the issuer of the voucher the account is denominated in
//
// Anyone else — including a user of a completely different bank — must be
// refused.
//
//   bun run apps/bank-aws/e2e/e2e-account-privacy.ts
import {
  base58Encode,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '@barter.game/protocol';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_URL = process.env.E2E_BANK_URL ?? `${BASE_URL}/alice`;

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
function sign<T extends Record<string, unknown>>(doc: T, user: User): T & { sig: string } {
  return { ...doc, sig: signDoc(doc, user.privateKey) };
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

const alice = await discover(BANK_URL);
const stamp = Date.now();

const issuer = makeUser();
const holder = makeUser();
const stranger = makeUser();
await register(issuer, alice, 'pvi' + stamp);
await register(holder, alice, 'pvh' + stamp);
await register(stranger, alice, 'pvs' + stamp);

const voucher = sign({
  type: 'voucher', pubkey: issuer.pubkey, ulid: newUlid(),
  bank: alice.pubkey, name: 'PV-' + stamp, integer: true,
}, issuer);
const voucherHash = hashDoc(voucher);
const issuerAcc = sign({ type: 'account', pubkey: issuer.pubkey, ulid: newUlid(), name: 'iss', voucher: voucherHash }, issuer);
const holderAcc = sign({ type: 'account', pubkey: holder.pubkey, ulid: newUlid(), name: 'hold', voucher: voucherHash }, holder);

await rpc(issuer, alice, 'submit_docs', { docs: [voucher, issuerAcc] });
await rpc(holder, alice, 'submit_docs', { docs: [holderAcc] });

const holderAccHash = hashDoc(holderAcc);
const issuerAccHash = hashDoc(issuerAcc);

let pass = true;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) pass = false;
};

// 1. The holder reads their own account.
{
  const r = await rpcRaw(holder, alice, 'get_account_balance', { account_hash: holderAccHash });
  check('holder reads own account', !r.error, r.error ? `${r.error.code} ${r.error.message}` : JSON.stringify(r.result));
}

// 2. The voucher issuer reads a holder's account in their own currency.
{
  const r = await rpcRaw(issuer, alice, 'get_account_balance', { account_hash: holderAccHash });
  check('issuer reads a holding of their own voucher', !r.error, r.error ? `${r.error.code} ${r.error.message}` : JSON.stringify(r.result));
}

// 3. A third party must NOT read the holder's account.
{
  const r = await rpcRaw(stranger, alice, 'get_account_balance', { account_hash: holderAccHash });
  check('stranger refused on holder account', !!r.error && r.error.code === -32001, r.error ? `${r.error.code} ${r.error.message}` : `LEAKED ${JSON.stringify(r.result)}`);
}

// 4. ...nor the issuer's account.
{
  const r = await rpcRaw(stranger, alice, 'get_account_balance', { account_hash: issuerAccHash });
  check('stranger refused on issuer account', !!r.error && r.error.code === -32001, r.error ? `${r.error.code} ${r.error.message}` : `LEAKED ${JSON.stringify(r.result)}`);
}

// 5. A holder of the same voucher is still a third party to another holder.
{
  const r = await rpcRaw(holder, alice, 'get_account_balance', { account_hash: issuerAccHash });
  check('holder refused on issuer account', !!r.error && r.error.code === -32001, r.error ? `${r.error.code} ${r.error.message}` : `LEAKED ${JSON.stringify(r.result)}`);
}

console.log(pass ? 'ACCOUNT PRIVACY OK ✅' : 'ACCOUNT PRIVACY FAILED ❌');
if (!pass) process.exit(1);
