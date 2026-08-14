// End-to-end smoke test against a local bank server.
// Run with: bun run apps/bank-aws/e2e/e2e-local.ts
import {
  base58Encode,
  base58Decode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  publicKeyOf,
  signDoc,
  verifyBytes,
  verifyDoc,
  type Base58PubKey,
} from '@barter.game/protocol';
import { sha256 } from '@noble/hashes/sha2.js';

const BANK_NAME = process.env.E2E_BANK ?? 'alice';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8100';
const BANK_URL = `${BASE_URL}/${BANK_NAME}`;

const bankInfo = await fetch(`${BANK_URL}/barter-bank.json`).then((r) => r.json());
const bankPubkey: Base58PubKey = bankInfo.pubkey;
console.log('Bank', BANK_NAME, bankPubkey);

function makeUser() {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  return { privateKey, pubkey: pubkeyBase58 };
}

async function rpcCall(user: { privateKey: Uint8Array; pubkey: string }, method: string, params: Record<string, unknown>) {
  const id = newUlid();
  const envelope: Record<string, unknown> = {
    jsonrpc: '2.0', id, method, params,
    pubkey: user.pubkey,
    to: bankPubkey,
    sig: '',
  };
  envelope.sig = signDoc(envelope, user.privateKey);
  const localCanon = canonicalizeWithoutSig(envelope);
  const localHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(localCanon));
  const localHash = base58Encode(new Uint8Array(localHashBuf));
  console.log('local canonical', localCanon);
  console.log('local hash', localHash);
  console.log('env verifyDoc', verifyDoc(envelope, envelope.sig as string, user.pubkey));
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(localCanon)));
  const nobleHash = sha256(new TextEncoder().encode(localCanon));
  console.log('web hash', base58Encode(hashBytes));
  console.log('noble hash', base58Encode(nobleHash));
  console.log('env verifyBytes(web)', verifyBytes(hashBytes, envelope.sig as string, user.pubkey));
  console.log('env verifyBytes(noble)', verifyBytes(nobleHash, envelope.sig as string, user.pubkey));
  const res = await fetch(`${BANK_URL}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const data = await res.json();
  if (data.error) throw new Error(`${method}: ${data.error.code} ${data.error.message}`);
  return data.result;
}

async function sha256Base58(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return base58Encode(new Uint8Array(hash));
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function uiAuth(user: { privateKey: Uint8Array; pubkey: string }, method: string, path: string, body: unknown) {
  const authdoc = {
    pubkey: user.pubkey,
    method,
    path: `/${BANK_NAME}/ui${path}`,
    id: newUlid(),
    ts: Date.now(),
    body_sha256: body ? await sha256Base58(JSON.stringify(body)) : null,
  };
  const sig = signDoc(authdoc, user.privateKey);
  const token = `${base64urlEncode(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${BANK_URL}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`${path}: ${data.code} ${data.message}`);
  return data;
}

async function register(user: { privateKey: Uint8Array; pubkey: string }, handle: string) {
  const keystore = { kdf: 'none', ciphertext: base58Encode(user.privateKey) };
  const proof = signDoc({ handle, pubkey: user.pubkey, keystore_sha256: hashDoc(keystore) }, user.privateKey);
  const res = await fetch(`${BANK_URL}/ui/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, pubkey: user.pubkey, keystore, proof }),
  });
  const data = await res.json();
  if (data.code) throw new Error(`register: ${data.code} ${data.message}`);
  console.log('Registered', handle, user.pubkey.slice(0, 12));
}

function createVoucher(user: { privateKey: Uint8Array; pubkey: string }, name: string) {
  const v = { type: 'voucher', pubkey: user.pubkey, ulid: newUlid(), bank: bankPubkey, name, integer: true };
  (v as { sig?: string }).sig = signDoc(v, user.privateKey);
  return v;
}

function createAccount(user: { privateKey: Uint8Array; pubkey: string }, name: string, voucherHash: string) {
  const a = { type: 'account', pubkey: user.pubkey, ulid: newUlid(), name, voucher: voucherHash };
  (a as { sig?: string }).sig = signDoc(a, user.privateKey);
  return a;
}

function createInvoice(user: { privateKey: Uint8Array; pubkey: string }, accountHash: string, voucherHash: string, max: number) {
  const o = {
    type: 'order', pubkey: user.pubkey, ulid: newUlid(), rate: 1,
    credit: { account: accountHash, voucher: voucherHash, bank: bankPubkey, min: 0, max },
    lead: false,
  };
  (o as { sig?: string }).sig = signDoc(o, user.privateKey);
  return o;
}

function createCheque(user: { privateKey: Uint8Array; pubkey: string }, accountHash: string, voucherHash: string, max: number) {
  const o = {
    type: 'order', pubkey: user.pubkey, ulid: newUlid(), rate: 1,
    debit: { account: accountHash, voucher: voucherHash, bank: bankPubkey, min: 0, max },
    lead: true,
  };
  (o as { sig?: string }).sig = signDoc(o, user.privateKey);
  return o;
}

const alice = makeUser();
const bob = makeUser();

await register(alice, 'alice-' + Date.now());
await register(bob, 'bob-' + Date.now());

// Alice issues the voucher.
const voucher = createVoucher(alice, 'AliceCoin');
const voucherHash = hashDoc(voucher);
const aliceAccount = createAccount(alice, 'main', voucherHash);
const aliceAccountHash = hashDoc(aliceAccount);
await rpcCall(alice, 'submit_docs', { docs: [voucher, aliceAccount] });
console.log('Voucher', voucherHash.slice(0, 16), 'account', aliceAccountHash.slice(0, 16));

// Bob opens an account in Alice's voucher.
const bobAccount = createAccount(bob, 'bob-main', voucherHash);
const bobAccountHash = hashDoc(bobAccount);
await rpcCall(bob, 'submit_docs', { docs: [bobAccount] });

// Alice creates a cheque (issuer debit) to pay Bob.
const aliceCheque = createCheque(alice, aliceAccountHash, voucherHash, 50);
const aliceChequeHash = hashDoc(aliceCheque);
await rpcCall(alice, 'submit_docs', { docs: [aliceCheque], publish_offers: [aliceChequeHash] });

// Bob creates an invoice to receive AliceCoin.
const bobInvoice = createInvoice(bob, bobAccountHash, voucherHash, 50);
const bobInvoiceHash = hashDoc(bobInvoice);
await rpcCall(bob, 'submit_docs', { docs: [bobInvoice], publish_offers: [bobInvoiceHash] });

// Bob acts as coordinator: discover the two offers and read the canonical
// Order hash from each offer's `order` field.
const aliceOffers = (await rpcCall(alice, 'list_offers', { voucher_hash: voucherHash, intention: 'sell' })) as Array<Record<string, unknown>>;
const bobOffers = (await rpcCall(bob, 'list_offers', { voucher_hash: voucherHash, intention: 'buy' })) as Array<Record<string, unknown>>;
const chequeOffer = aliceOffers.find((o) => (o as { debit?: { voucher: string } }).debit?.voucher === voucherHash);
const invoiceOffer = bobOffers.find((o) => (o as { credit?: { voucher: string } }).credit?.voucher === voucherHash);
if (!chequeOffer || !invoiceOffer) throw new Error('offers not found');
const chequeOrderHash = (chequeOffer as { order: string }).order;
const invoiceOrderHash = (invoiceOffer as { order: string }).order;
console.log('Match order', chequeOrderHash.slice(0, 16), 'with', invoiceOrderHash.slice(0, 16));

const propose = await uiAuth(bob, 'POST', '/propose_deal', {
  offer1: { hash: chequeOrderHash, debit_amount: 50, credit_amount: 50 },
  offer2: { hash: invoiceOrderHash, debit_amount: 50, credit_amount: 50 },
  banks: [{ pubkey: bankPubkey, url: BANK_URL }],
});
console.log('Proposed deal', propose.deal_id, propose.state);

// Poll deal status until settled or timeout.
const dealId: string = propose.deal_id;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const status = await uiAuth(bob, 'GET', `/deal/${dealId}`, null);
  console.log('deal state', status.state, 'legs', status.legs.map((l: { state: string }) => l.state).join(','));
  if (status.state === 'settled' || status.state === 'rejected') break;
}

const bobBal = await rpcCall(bob, 'get_account_balance', { account_hash: bobAccountHash });
console.log('Bob balance', bobBal);

const aliceBal = await rpcCall(alice, 'get_account_balance', { account_hash: aliceAccountHash });
console.log('Alice balance', aliceBal);

console.log('Smoke test complete');
