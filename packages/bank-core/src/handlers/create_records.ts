import {
  addOrderUsage,
  getDealPair,
  getOffer,
  getOrder,
  getRecord,
  getVoucher,
  storeDealPair,
  storeRecord,
} from '../db.ts';
import {
  hashDoc,
  newUlid,
  signDoc,
  verifyDoc,
  type Order,
  type BankRecord,
  type RecordDetails,
} from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

// Tolerance for float rounding in the rate comparison.
const RATE_EPS = 1e-9;

// create_records mints the single debit/credit record pair that moves THIS
// bank's voucher from the `giver` Order to the `receiver` Order.
//
// - `giver` / `receiver` are holder **Order hashes** (an Offer hash is resolved
//   to its underlying Order). The giver's `debit` side and the receiver's
//   `credit` side both reference the voucher this bank issues.
// - `amount` is the units of this bank's voucher moved giver → receiver.
// - `counter_amount` is the units of the counterparty voucher (at the other
//   bank) — used only for the two-sided rate check.
// - `sender` is the coordinator; it is sealed into each RecordDetails so only a
//   Mandate signed by the same coordinator can advance these records.
export async function createRecords(
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  const giverHash = params.giver;
  const receiverHash = params.receiver;
  const amount = params.amount;
  const counterAmount = params.counter_amount;
  const dealId = params.deal_id;
  if (
    typeof giverHash !== 'string' ||
    typeof receiverHash !== 'string' ||
    typeof amount !== 'number' ||
    typeof counterAmount !== 'number' ||
    typeof dealId !== 'string'
  ) {
    throw new RpcError(
      -32602,
      'giver, receiver, amount, counter_amount, deal_id required',
    );
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RpcError(-32000, 'amount must be a positive number');
  }
  if (!Number.isFinite(counterAmount) || counterAmount < 0) {
    throw new RpcError(-32000, 'counter_amount must be non-negative');
  }

  // Idempotency: one record pair per (deal_id, giver, receiver). A repeated
  // call with the same terms returns the original pair instead of minting a
  // new one; a repeat with DIFFERENT terms is an error, never a second pair.
  const existing = await getDealPair(bank, dealId, giverHash, receiverHash);
  if (existing) {
    if (existing.amount !== amount || existing.counter_amount !== counterAmount) {
      throw new RpcError(-32000, 'create_records repeated with different terms for this (deal, giver, receiver)');
    }
    const records = [];
    for (const h of existing.records) {
      const row = await getRecord(bank, h);
      if (row) records.push(row.doc);
    }
    return { records };
  }

  const giver = await resolveAuth(bank, giverHash);
  const receiver = await resolveAuth(bank, receiverHash);

  // The giver debits this bank's voucher; the receiver credits the same one.
  if (!giver.order.debit || giver.order.debit.bank !== bank.pubkey) {
    throw new RpcError(-32000, 'giver does not debit a voucher of this bank');
  }
  if (!receiver.order.credit || receiver.order.credit.bank !== bank.pubkey) {
    throw new RpcError(-32000, 'receiver does not credit a voucher of this bank');
  }
  const voucherHash = giver.order.debit.voucher;
  if (receiver.order.credit.voucher !== voucherHash) {
    throw new RpcError(-32000, 'giver and receiver reference different vouchers');
  }

  // Per-side min/max.
  if (amount < giver.order.debit.min || amount > giver.order.debit.max) {
    throw new RpcError(-32000, 'amount outside giver debit min/max');
  }
  if (amount < receiver.order.credit.min || amount > receiver.order.credit.max) {
    throw new RpcError(-32000, 'amount outside receiver credit min/max');
  }

  // Counter-amount validation is BANK-ASSERTED: this bank holds BOTH Orders
  // (each holder submits their Order to every bank a side touches), so the
  // counterparty leg is validated against the signed Orders themselves —
  // never trusted from the caller.
  //
  // amount is this bank's voucher (giver's debit / receiver's credit);
  // counter_amount is the opposite voucher (giver's credit / receiver's
  // debit), transacted at the counterparty bank. When either Order carries
  // that opposite side, the coordinator's counter_amount must (a) reference
  // the SAME foreign voucher on both Orders, (b) sit inside BOTH Orders'
  // min/max windows for that side, and (c) satisfy both rates. One-sided
  // pairings (invoice/cheque) have no opposite side; counter_amount must be 0.
  const giverCounter = giver.order.credit ?? null;
  const receiverCounter = receiver.order.debit ?? null;
  if (giverCounter && receiverCounter) {
    if (giverCounter.voucher !== receiverCounter.voucher || giverCounter.bank !== receiverCounter.bank) {
      throw new RpcError(-32000, 'giver credit and receiver debit reference different counter vouchers');
    }
  }
  if (giverCounter || receiverCounter) {
    if (!(counterAmount > 0)) {
      throw new RpcError(-32000, 'counter_amount required for two-sided orders');
    }
    if (giverCounter && (counterAmount < giverCounter.min || counterAmount > giverCounter.max)) {
      throw new RpcError(-32000, 'counter_amount outside giver credit min/max');
    }
    if (receiverCounter && (counterAmount < receiverCounter.min || counterAmount > receiverCounter.max)) {
      throw new RpcError(-32000, 'counter_amount outside receiver debit min/max');
    }
    if (giverCounter && amount / counterAmount > giver.order.rate + RATE_EPS) {
      throw new RpcError(-32000, 'giver rate exceeded');
    }
    if (receiverCounter && counterAmount / amount > receiver.order.rate + RATE_EPS) {
      throw new RpcError(-32000, 'receiver rate exceeded');
    }
  } else if (counterAmount !== 0) {
    throw new RpcError(-32000, 'counter_amount must be 0 for one-sided pairings');
  }

  const voucher = await getVoucher(bank, voucherHash);
  if (!voucher) throw new RpcError(-32005, 'voucher unknown');
  if (voucher.integer && !Number.isInteger(amount)) {
    throw new RpcError(-32000, 'integer voucher requires integer amount');
  }
  if (voucher.limit !== undefined) {
    const existing = await totalIssuedForVoucher(bank, voucherHash);
    if (existing + amount > voucher.limit) {
      throw new RpcError(-32000, 'voucher limit exceeded');
    }
  }

  await checkOrderLimit(bank, giver.order, 'debit', amount);
  await checkOrderLimit(bank, receiver.order, 'credit', amount);

  const pair = newUlid();

  const debitDetails: RecordDetails = {
    pair,
    deal_id: dealId,
    coordinator: sender,
    holder: giver.order.pubkey,
    account: giver.order.debit.account,
  };
  const creditDetails: RecordDetails = {
    pair,
    deal_id: dealId,
    coordinator: sender,
    holder: receiver.order.pubkey,
    account: receiver.order.credit.account,
  };

  const debitRecord: BankRecord = {
    type: 'debit',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    amount,
    order: giver.orderHash,
    details: hashDoc(debitDetails),
    sig: '',
  };
  debitRecord.sig = signDoc(debitRecord, bank.privateKey);

  const creditRecord: BankRecord = {
    type: 'credit',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    amount,
    order: receiver.orderHash,
    details: hashDoc(creditDetails),
    sig: '',
  };
  creditRecord.sig = signDoc(creditRecord, bank.privateKey);

  const debitHash = await storeRecord(bank, debitRecord, debitDetails);
  const creditHash = await storeRecord(bank, creditRecord, creditDetails);
  await storeDealPair(bank, dealId, giverHash, receiverHash, {
    records: [debitHash, creditHash],
    amount,
    counter_amount: counterAmount,
  });

  await addOrderUsage(bank, giver.orderHash, amount, 0);
  await addOrderUsage(bank, receiver.orderHash, 0, amount);

  return { records: [debitRecord, creditRecord] };
}

// Resolve an authorization reference to its underlying holder Order. The hash
// is normally an Order hash (canonical across banks); an Offer hash is accepted
// and resolved to its underlying Order for convenience.
async function resolveAuth(
  bank: Bank,
  hash: string,
): Promise<{ order: Order; orderHash: string }> {
  const order = await getOrder(bank, hash);
  if (order) {
    if (!order.sig || !verifyDoc(order, order.sig, order.pubkey)) {
      throw new RpcError(-32001, 'order signature invalid');
    }
    return { order, orderHash: hash };
  }
  const offer = await getOffer(bank, hash);
  if (offer) {
    if (!offer.sig || !verifyDoc(offer, offer.sig, bank.pubkey)) {
      throw new RpcError(-32001, 'offer signature invalid');
    }
    const underlying = await getOrder(bank, offer.order);
    if (!underlying) throw new RpcError(-32005, 'underlying order not found');
    return { order: underlying, orderHash: offer.order };
  }
  throw new RpcError(-32005, 'order or offer unknown');
}

async function totalIssuedForVoucher(
  bank: Bank,
  voucherHash: string,
): Promise<number> {
  const { listRecordsByVoucher } = await import('../db.ts');
  return (await listRecordsByVoucher(bank, voucherHash)).reduce(
    (sum, r) => sum + r.doc.amount,
    0,
  );
}

async function checkOrderLimit(
  bank: Bank,
  order: Order,
  side: 'debit' | 'credit',
  amount: number,
): Promise<void> {
  const usage = await import('../db.ts').then((m) => m.getOrderUsage(bank, hashDoc(order)));
  const limit = side === 'debit' ? order.debit_order_limit : order.credit_order_limit;
  const used = side === 'debit' ? usage.debit : usage.credit;
  if (limit !== undefined && used + amount > limit) {
    throw new RpcError(-32000, 'order limit exceeded');
  }
}
