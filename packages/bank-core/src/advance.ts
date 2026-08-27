import {
  applySettlement,
  acquireHold,
  getAccount,
  getAccountBalance,
  getAddress,
  getDoc,
  getMandate,
  getOffer,
  getOrder,
  getRecord,
  getSignaturesForRecord,
  getVoucher,
  listRecordsByDeal,
  releaseHold,
  storeSignature,
  type RecordRow,
} from './db.ts';
import {
  hashDoc,
  newUlid,
  signDoc,
  type Base58PubKey,
  type Base58SHA256,
  type Order,
  type BankRecord,
  type Signature,
  type ULID,
} from '@barter.game/protocol';
import { bankRpcCall } from './peer.ts';
import type { Bank } from './types.ts';

const EPS = 1e-9;

// Default stall timeout: a mandated deal with no visible progress for an hour
// is rejected and its holds released (bank-schema.md §2 "Reject semantics" —
// the threshold is bank policy, the protocol fixes none). Hosts override via
// createBank's options / BANK_STALL_TIMEOUT_MS.
const DEFAULT_STALL_TIMEOUT_MS = 1000 * 60 * 60;

// Milliseconds encoded in a ULID's first 10 Crockford-base32 characters.
// Returns 0 for malformed input, which simply doesn't count as activity.
function ulidTime(u: ULID): number {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = 0;
  for (let i = 0; i < 10; i++) {
    const v = ALPHABET.indexOf((u[i] ?? '').toUpperCase());
    if (v < 0) return 0;
    t = t * 32 + v;
  }
  return t;
}

// Per-record view: the record, its Order, whether the coordinator has mandated
// it, and this bank's OWN ready/hold/settle/reject signatures on it. Cross-bank
// gates are evaluated over the full record set R (below), not this struct.
type OwnState = {
  hash: Base58SHA256;
  row: RecordRow;
  order: Order;
  mandated: boolean;
  ownReady: Signature | null;
  ownHold: Signature | null;
  ownSettle: Signature | null;
  ready: boolean;
  held: boolean;
  settled: boolean;
  rejected: boolean; // reject on this record by ANYONE (ours or a peer's)
};

// `seen` containment: does `seen` include every hash in `needed`? Fail-closed —
// a missing or absent `seen` never satisfies the gate.
function seenContains(seen: Base58SHA256[] | undefined, needed: Base58SHA256[]): boolean {
  if (needed.length === 0) return true;
  const s = new Set(seen ?? []);
  return needed.every((n) => s.has(n));
}

// --- per-deal serialization -------------------------------------------------
// Concurrent advance passes over the SAME deal race on the account/hold rows
// (hold acquisition, settle CAS). Chain passes per deal_id so a deal is
// advanced by one pass at a time; a failed pass never wedges the chain.
const dealChains = new Map<string, Promise<void>>();

export async function advanceDeal(bank: Bank, dealId: string): Promise<void> {
  const prev = dealChains.get(dealId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => advanceDealInner(bank, dealId));
  dealChains.set(dealId, run);
  try {
    await run;
  } finally {
    if (dealChains.get(dealId) === run) dealChains.delete(dealId);
  }
}

async function advanceDealInner(bank: Bank, dealId: string): Promise<void> {
  const ownRows = await listRecordsByDeal(bank, dealId);
  if (ownRows.length === 0) return;

  // Resolve each own record's Order and mandate status, and load this bank's
  // own signatures on it.
  const own: OwnState[] = [];
  for (const row of ownRows) {
    const hash = hashDoc(row.doc);
    let order: Order;
    try {
      order = await resolveOrderForRecord(bank, row.doc);
    } catch {
      continue; // Order not yet bound; nothing to advance for this record
    }
    const sigs = await getSignaturesForRecord(bank, hash);
    const ownReady = sigs.find((s) => s.action === 'ready' && s.pubkey === bank.pubkey) ?? null;
    const ownHold = sigs.find((s) => s.action === 'hold' && s.pubkey === bank.pubkey) ?? null;
    const ownSettle = sigs.find((s) => s.action === 'settle' && s.pubkey === bank.pubkey) ?? null;
    own.push({
      hash,
      row,
      order,
      mandated: await isMandated(bank, dealId, row, hash),
      ownReady,
      ownHold,
      ownSettle,
      ready: !!ownReady,
      held: !!ownHold,
      settled: !!ownSettle,
      // Only THIS bank may reject its own records — it is the sole authority
      // over the voucher it issues. A peer's reject arrives on the peer's own
      // (foreign) record and cascades from there.
      rejected: sigs.some((s) => s.action === 'reject' && s.pubkey === bank.pubkey),
    });
  }
  if (own.length === 0 || !own.some((o) => o.mandated)) return; // awaiting coordinator

  const ownHashes = new Set(own.map((o) => o.hash));

  // Full record set R = own records ∪ every foreign record named by this deal's
  // Mandates (the union of a bank's Mandates' record lists is the deal footprint
  // that entangles its records). Gather signatures for every record in R by its
  // hash — own signatures plus peers' signatures delivered via notify_signatures
  // (record_sig index). Because R is the deal's own record set, every gathered
  // signature is deal-scoped: no by-signer, cross-deal reuse.
  const foreignHashes = new Set<Base58SHA256>();
  const orderSeen = new Set<string>();
  for (const o of own) {
    if (orderSeen.has(o.row.doc.order)) continue;
    orderSeen.add(o.row.doc.order);
    const m = await getMandate(bank, dealId, o.row.doc.order);
    if (!m) continue;
    for (const h of m.records) if (!ownHashes.has(h)) foreignHashes.add(h);
  }
  // SIGNER AUTHORITY. A foreign record's state may only be attested by the bank
  // that MINTED it — `Record.pubkey` on the body, which submit_mandate already
  // verified (signed by that bank, and that bank named by the Order). Without
  // this filter any keypair could self-sign a `ready`/`hold`/`settle` anchored
  // to a foreign record hash — both hashes and `seen` chains are public via
  // get_record_signatures — and drive this bank through the whole cascade with
  // no counterparty bank involved. `seen` proves the cascade is FRESH and bound
  // to this deal; this proves it came from the party entitled to assert it.
  // Fail closed: a record whose body we cannot resolve accepts no signatures.
  const foreignSigs = new Map<Base58SHA256, Signature[]>();
  for (const h of foreignHashes) {
    const body = await getDoc<BankRecord>(bank, h);
    const minter = body?.pubkey;
    const sigs = minter ? await getSignaturesForRecord(bank, h) : [];
    foreignSigs.set(h, sigs.filter((s) => s.pubkey === minter));
  }
  const foreignAction = (h: Base58SHA256, action: Signature['action']) =>
    (foreignSigs.get(h) ?? []).filter((s) => s.action === action);
  const allHashes = [...ownHashes, ...foreignHashes];

  const resolvedOwn = own.map((o) => o.order);
  const issued: Signature[] = [];

  // Reject cascade: a reject on ANY record in R (ours or a peer's, e.g. delivered
  // to a foreign record) aborts the whole deal here.
  const anyReject = own.some((o) => o.rejected) ||
    [...foreignHashes].some((h) => foreignAction(h, 'reject').length > 0);
  if (anyReject) {
    const sigs = await rejectDeal(bank, own, 'rejected counterpart record');
    if (sigs.length > 0) await fanOutSigs(bank, sigs, resolvedOwn);
    return;
  }

  // 0. STALL TIMEOUT — liveness recovery (bank-schema.md §2): a mandated deal
  //    that has shown no progress for stallTimeoutMs is rejected, freeing its
  //    holds so locked accounts can serve other deals. Progress = the newest
  //    record, mandate, or signature timestamp this bank can see; the check is
  //    lazy (evaluated when the deal is advanced, there is no cron). It MUST
  //    NOT fire once any settle signature for the deal has been observed — a
  //    partly-settled deal completes, it does not unwind; there is no
  //    rollback.
  const settleObserved = own.some((o) => o.settled) ||
    [...foreignHashes].some((h) => foreignAction(h, 'settle').length > 0);
  if (!settleObserved) {
    const stallMs = bank.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    let lastActivity = 0;
    for (const o of own) {
      lastActivity = Math.max(lastActivity, ulidTime(o.row.doc.ulid));
      for (const s of [o.ownReady, o.ownHold, o.ownSettle]) {
        if (s) lastActivity = Math.max(lastActivity, ulidTime(s.ulid));
      }
      const m = await getMandate(bank, dealId, o.row.doc.order);
      if (m) lastActivity = Math.max(lastActivity, m.at);
    }
    for (const sigs of foreignSigs.values()) {
      for (const s of sigs) lastActivity = Math.max(lastActivity, ulidTime(s.ulid));
    }
    if (lastActivity > 0 && Date.now() - lastActivity > stallMs) {
      const sigs = await rejectDeal(bank, own, 'stall timeout');
      if (sigs.length > 0) await fanOutSigs(bank, sigs, resolvedOwn);
      return;
    }
  }

  // The deal must be strictly bilateral for the v1 seen-handshake (one lead
  // transfer, one follow transfer). ≥3-bank DAGs need a predecessor graph
  // (docs/design/mandate-validation.md §5.4) — fail closed past `ready`.
  const bankSet = new Set<Base58PubKey>();
  for (const o of resolvedOwn) {
    for (const side of [o.debit, o.credit]) if (side) bankSet.add(side.bank);
  }

  // 1. READY — validate each own mandated record against its Order. A permanent
  //    precondition failure rejects the record and cascades; a transient one
  //    just waits.
  for (const st of own) {
    if (st.ready || st.held || st.settled || !st.mandated) continue;
    try {
      const verdict = await readyCheck(bank, st.row, st.order, own);
      if (verdict.ok) {
        const sig = await signAndStore(bank, st.hash, 'ready');
        st.ownReady = sig;
        st.ready = true;
        issued.push(sig);
      } else if (verdict.permanent) {
        const sigs = await rejectDeal(bank, own, verdict.reason);
        const all = [...sigs, ...issued];
        if (all.length > 0) await fanOutSigs(bank, all, resolvedOwn);
        return;
      }
    } catch (e) {
      // One record's failure must not abort the rest of the pass; the next
      // advance event re-drives this record.
      console.error(`advance deal ${dealId}: ready phase failed for record ${st.hash}:`, e);
    }
  }

  const proceed = bankSet.size <= 2;

  // Signature-hash sets, computed from FRESH state: own signatures from `own`
  // (may have just been issued this pass), foreign signatures from the map.
  const ownReadyHashes = own.filter((o) => o.ownReady).map((o) => hashDoc(o.ownReady!));
  const foreignReadyHashes = [...foreignHashes].flatMap((h) => foreignAction(h, 'ready')).map(hashDoc);
  const allReadyHashes = [...ownReadyHashes, ...foreignReadyHashes];

  const everyReady = proceed && allHashes.every((h) =>
    ownHashes.has(h) ? own.find((o) => o.hash === h)!.ready : foreignAction(h, 'ready').length > 0
  );

  // A transfer (debit/credit pair, both records local) is LEAD iff its debit
  // record's Order.lead is true.
  const transferIsLead = (st: OwnState): boolean => {
    if (st.row.doc.type === 'debit') return st.order.lead;
    const sib = own.find(
      (o) => o.row.details.pair === st.row.details.pair && o.hash !== st.hash && o.row.doc.type === 'debit',
    );
    return sib ? sib.order.lead : st.order.lead;
  };

  // 2. HOLD — LEAD holds once every record in R is `ready`, citing all `ready`
  //    sigs. FOLLOW holds only after the lead's holds arrive AND cite the
  //    follower's own `ready` sigs (proving the lead is holding THIS deal).
  if (everyReady) {
    const everyForeignHoldBound = (needed: Base58SHA256[]) =>
      [...foreignHashes].every((h) => foreignAction(h, 'hold').some((s) => seenContains(s.seen, needed)));

    const toHold: OwnState[] = [];
    for (const st of own) {
      if (st.held || st.settled || !st.mandated) continue;
      if (transferIsLead(st)) {
        toHold.push(st);
      } else if (foreignHashes.size === 0 || everyForeignHoldBound(ownReadyHashes)) {
        // Follow: wait for the lead's bound hold across banks; a single-bank
        // deal (no foreign records) has no cross-bank predecessor to wait for.
        toHold.push(st);
      }
    }
    if (toHold.length > 0) {
      try {
        const holdOk = await acquireHoldsForDeal(bank, dealId, toHold);
        if (holdOk) {
          const foreignHoldHashes = [...foreignHashes].flatMap((h) => foreignAction(h, 'hold')).map(hashDoc);
          for (const st of toHold) {
            const seen = transferIsLead(st)
              ? allReadyHashes
              : [...allReadyHashes, ...foreignHoldHashes];
            const sig = await signAndStore(bank, st.hash, 'hold', seen);
            st.ownHold = sig;
            st.held = true;
            issued.push(sig);
          }
        }
      } catch (e) {
        // A failed hold pass leaves no signatures; later events re-attempt.
        console.error(`advance deal ${dealId}: hold phase failed:`, e);
      }
    }
  }

  // 3. SETTLE — LEAD settles once every record in R is `held` AND each follow
  //    hold cites the lead's own `ready`+`hold` (proving the follow is bound to
  //    THIS deal). FOLLOW settles once the lead's settle arrives AND cites the
  //    follower's own `hold`. Each transfer settles atomically (both halves).
  const ownHoldHashes = own.filter((o) => o.ownHold).map((o) => hashDoc(o.ownHold!));
  const everyHeld = proceed && allHashes.every((h) =>
    ownHashes.has(h) ? own.find((o) => o.hash === h)!.held : foreignAction(h, 'hold').length > 0
  );

  if (everyHeld) {
    const everyForeignHoldBound = (needed: Base58SHA256[]) =>
      [...foreignHashes].every((h) => foreignAction(h, 'hold').some((s) => seenContains(s.seen, needed)));

    const toSettle: OwnState[] = [];
    for (const st of own) {
      if (!st.held || st.settled) continue;
      if (transferIsLead(st)) {
        // Lead: every follow (foreign) hold must cite our ready+hold. A
        // single-bank deal (no foreign records) settles directly once held —
        // the bank owns every leg, so there is no cross-bank replay surface.
        if (foreignHashes.size === 0 || everyForeignHoldBound([...ownReadyHashes, ...ownHoldHashes])) {
          toSettle.push(st);
        }
      } else {
        // Follow: a lead (foreign) settle must cite THIS record's own hold.
        const myHold = st.ownHold ? [hashDoc(st.ownHold)] : null;
        const bound = myHold !== null &&
          [...foreignHashes].every((h) => foreignAction(h, 'settle').some((s) => seenContains(s.seen, myHold)));
        if (bound) toSettle.push(st);
      }
    }

    if (toSettle.length > 0) {
      const allHoldHashes = [
        ...ownHoldHashes,
        ...[...foreignHashes].flatMap((h) => foreignAction(h, 'hold')).map(hashDoc),
      ];
      const foreignSettleHashes = [...foreignHashes].flatMap((h) => foreignAction(h, 'settle')).map(hashDoc);
      for (const st of toSettle) {
        try {
          const seen = transferIsLead(st)
            ? allHoldHashes
            : [...allHoldHashes, ...foreignSettleHashes];
          const sig = await applySettle(bank, st, seen);
          if (sig) issued.push(sig);
        } catch (e) {
          // One record's failed settle must not abort the rest of the pass;
          // the next advance event re-drives it.
          console.error(`advance deal ${dealId}: settle failed for record ${st.hash}:`, e);
        }
      }
    }
  }

  if (issued.length > 0) await fanOutSigs(bank, issued, resolvedOwn);
}

export async function advanceRecord(
  bank: Bank,
  recordHash: Base58SHA256,
): Promise<void> {
  const rec = await getRecord(bank, recordHash);
  if (!rec) return;
  await advanceDeal(bank, rec.details.deal_id);
}

async function isMandated(
  bank: Bank,
  dealId: string,
  row: RecordRow,
  hash: Base58SHA256,
): Promise<boolean> {
  const mandate = await getMandate(bank, dealId, row.doc.order);
  if (!mandate) return false;
  if (mandate.coordinator !== row.details.coordinator) return false;
  return mandate.records.includes(hash);
}

async function resolveOrderForRecord(
  bank: Bank,
  record: BankRecord,
): Promise<Order> {
  const doc = await getOrder(bank, record.order);
  if (doc) return doc;
  const offer = await getOffer(bank, record.order);
  if (offer) {
    const order = await getOrder(bank, offer.order);
    if (order) return order;
  }
  throw new Error('order/offer not found');
}

// Verdict of a ready-time precondition check. `permanent: true` means nothing
// within this deal can ever satisfy the precondition — the record MUST be
// rejected. `permanent: false` means a later event may still cover it, so the
// engine just waits.
type ReadyVerdict =
  | { ok: true }
  | { ok: false; permanent: boolean; reason: string };

const notReady = (permanent: boolean, reason: string): ReadyVerdict =>
  ({ ok: false, permanent, reason });

async function readyCheck(
  bank: Bank,
  row: RecordRow,
  order: Order,
  dealStates: { row: RecordRow; rejected: boolean }[],
): Promise<ReadyVerdict> {
  const account = await getAccount(bank, row.details.account);
  if (!account) return notReady(true, 'account unknown');

  // Verify order side matches record type & account.
  if (row.doc.type === 'debit') {
    if (!order.debit) return notReady(true, 'order has no debit side');
    if (order.debit.account !== row.details.account) return notReady(true, 'debit account mismatch');
  } else {
    if (!order.credit) return notReady(true, 'order has no credit side');
    if (order.credit.account !== row.details.account) return notReady(true, 'credit account mismatch');
  }

  const amount = row.doc.amount;
  if (amount < (row.doc.type === 'debit' ? order.debit!.min : order.credit!.min)) {
    return notReady(true, 'amount below order min');
  }
  if (amount > (row.doc.type === 'debit' ? order.debit!.max : order.credit!.max)) {
    return notReady(true, 'amount above order max');
  }

  // Free balance check for debits (non-issuers may not overdraw).
  if (row.doc.type === 'debit') {
    const voucher = await import('./db.ts').then((m) =>
      m.getVoucher(bank, order.debit!.voucher),
    );
    const isIssuer = voucher ? voucher.pubkey === row.details.holder : false;
    const bal = await getAccountBalance(bank, row.details.account);
    if (!bal) return notReady(true, 'no balance row for debit account');
    const free = bal.current - bal.pending;
    if (!isIssuer && free < amount) {
      // Uncovered debit. Coverage may still arrive from a credit record in
      // THIS deal targeting the same account; only when no such credit exists
      // is the shortfall unrecoverable.
      const inDealCredit = dealStates.some((s) =>
        s.row.doc.type === 'credit' &&
        s.row.details.account === row.details.account &&
        !s.rejected);
      return notReady(!inDealCredit, 'insufficient balance on debit account');
    }
    if (isIssuer && voucher?.limit !== undefined) {
      const issued = await totalIssuedForVoucher(bank, order.debit!.voucher);
      if (issued + amount > voucher.limit) return notReady(true, 'voucher limit exceeded');
    }
    if (order.debit_account_limit !== undefined) {
      if (!isIssuer && bal.current - amount < order.debit_account_limit) {
        const inDealCredit = dealStates.some((s) =>
          s.row.doc.type === 'credit' &&
          s.row.details.account === row.details.account &&
          !s.rejected);
        return notReady(!inDealCredit, 'debit account floor violated');
      }
    }
  }

  // Credit account ceiling check. Balance can drop through other deals, so
  // this is transient — the engine waits rather than aborting the deal.
  if (row.doc.type === 'credit' && order.credit_account_limit !== undefined) {
    const bal = await getAccountBalance(bank, row.details.account);
    if (bal && bal.current + amount > order.credit_account_limit) {
      return notReady(false, 'credit account ceiling exceeded');
    }
  }

  // Rate check for two-sided orders, computed over the Mandate's FULL record
  // set. A violating (immutable) set can never improve → permanent.
  const rate = await aggregateRateCheck(bank, row.details.deal_id, row.doc.order, order);
  if (rate === 'wait') return notReady(false, 'awaiting mandated record bodies');
  if (rate === 'violation') return notReady(true, 'order rate violated by mandated records');

  return { ok: true };
}

// Verify an Order's rate over the complete mandated record set (local records
// plus bank-signed foreign bodies). 'wait' = a listed body is not yet
// resolvable (transient); 'violation' = the immutable mandated set breaks the
// rate — including a two-sided Order whose credit leg was never mandated (the
// missing-leg attack) — which is permanent.
async function aggregateRateCheck(
  bank: Bank,
  dealId: string,
  orderHash: Base58SHA256,
  order: Order,
): Promise<'ok' | 'wait' | 'violation'> {
  if (!order.debit || !order.credit) return 'ok'; // one-sided: no rate gate
  const mandate = await getMandate(bank, dealId, orderHash);
  if (!mandate) return 'wait';
  let debitAmount = 0;
  let creditAmount = 0;
  for (const h of mandate.records) {
    const local = await getRecord(bank, h);
    const doc = local?.doc ?? (await getDoc<BankRecord>(bank, h));
    if (!doc) return 'wait';
    if (doc.type === 'debit') debitAmount += doc.amount;
    if (doc.type === 'credit') creditAmount += doc.amount;
  }
  if (creditAmount === 0) return 'violation';
  return debitAmount / creditAmount <= order.rate + EPS ? 'ok' : 'violation';
}

// Acquire the per-account aggregated holds for a deal's debit records. The
// solvency floor per account is the strictest over its records: issuer debits
// may go negative (-Infinity; the voucher limit gates them at ready time),
// non-issuer holder-authorized debits floor at max(0, debit_account_limit)
// (bank-schema.md §3.2). On any failed acquire the holds taken earlier in
// THIS pass are released again — a partial pass must not strand holds and
// lock accounts until the stall timeout.
async function acquireHoldsForDeal(
  bank: Bank,
  dealId: string,
  states: OwnState[],
): Promise<boolean> {
  const byAccount = new Map<Base58SHA256, { amount: number; floor: number }>();
  for (const st of states) {
    if (st.row.doc.type !== 'debit') continue;
    const voucher = await getVoucher(bank, st.order.debit!.voucher);
    const isIssuer = voucher ? voucher.pubkey === st.row.details.holder : false;
    const floor = isIssuer
      ? Number.NEGATIVE_INFINITY
      : Math.max(0, st.order.debit_account_limit ?? 0);
    const cur = byAccount.get(st.row.details.account);
    byAccount.set(st.row.details.account, {
      amount: (cur?.amount ?? 0) + st.row.doc.amount,
      floor: Math.max(cur?.floor ?? Number.NEGATIVE_INFINITY, floor),
    });
  }
  const acquired: Base58SHA256[] = [];
  for (const [account, { amount, floor }] of byAccount) {
    const ok = await acquireHold(bank, account, dealId, amount, floor);
    if (!ok) {
      for (const a of acquired) await releaseHold(bank, a, dealId);
      return false;
    }
    acquired.push(account);
  }
  return true;
}

// Apply a settled record's delta, release its hold, and commit the `settle`
// signature in ONE atomic batch (db.applySettlement) — the signature is the
// settled marker the engine reads, so committing it with the balance write
// makes a crash mid-settle unable to double-apply the delta. Both halves of a
// transfer are settled in the same advance pass (their gate is identical), so
// the per-bank sum invariant is preserved. Returns null when the record turns
// out to be settled already (no new signature to fan out).
async function applySettle(
  bank: Bank,
  st: OwnState,
  seen: Base58SHA256[],
): Promise<Signature | null> {
  const delta = st.row.doc.type === 'credit' ? st.row.doc.amount : -st.row.doc.amount;
  const sig: Signature = {
    type: 'signature',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    hash: st.hash,
    action: 'settle',
    seen,
    sig: '',
  };
  sig.sig = signDoc(sig, bank.privateKey);
  const ok = await applySettlement(
    bank,
    st.row.details.account,
    st.row.details.deal_id,
    delta,
    sig,
  );
  if (!ok) {
    // The CAS refused. If a settle signature for this record exists, the
    // balance was applied in the same batch as that signature — this is the
    // idempotent no-op path; never re-apply. Otherwise the account row kept
    // contending: throw so the pass logs it and a later event retries.
    const existing = (await getSignaturesForRecord(bank, st.hash)).find(
      (s) => s.action === 'settle' && s.pubkey === bank.pubkey,
    );
    if (existing) {
      st.ownSettle = existing;
      st.settled = true;
      return null;
    }
    throw new Error(`settle of record ${st.hash} lost the balance CAS`);
  }
  st.ownSettle = sig;
  st.settled = true;
  return sig;
}

async function signAndStore(
  bank: Bank,
  targetHash: Base58SHA256,
  action: Signature['action'],
  seen?: Base58SHA256[],
  reason?: string,
): Promise<Signature> {
  const sig: Signature = {
    type: 'signature',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    hash: targetHash,
    action,
    seen,
    reason,
    sig: '',
  };
  sig.sig = signDoc(sig, bank.privateKey);
  await storeSignature(bank, sig);
  return sig;
}

// Abort the deal at this bank: issue a reject Signature on every pre-settled
// record that doesn't have one, releasing any holds. Settled records stay
// settled — there is no rollback (a reject landing on a settled record is a
// no-op: settle-first wins per record). Returns the newly issued reject
// signatures.
async function rejectDeal(
  bank: Bank,
  states: OwnState[],
  reason: string,
): Promise<Signature[]> {
  const out: Signature[] = [];
  for (const st of states) {
    if (st.settled) continue;
    // Idempotent: skip if we already issued our own reject on this record.
    const existing = (await getSignaturesForRecord(bank, st.hash)).some(
      (s) => s.action === 'reject' && s.pubkey === bank.pubkey,
    );
    if (existing) continue;
    // Release by the hold INDEX, not by signature state: a hold acquired just
    // before a crash (no hold Signature ever stored, so `st.held` reads
    // false) still locks the account. releaseHold is a no-op when no hold
    // row exists for this deal.
    await releaseHold(bank, st.row.details.account, st.row.details.deal_id);
    const sig = await signAndStore(bank, st.hash, 'reject', undefined, reason);
    st.rejected = true;
    out.push(sig);
  }
  return out;
}

// Fan newly-issued signatures out to every counter-side bank named by the
// deal's Orders. `ready`, `hold`, `settle` and `reject` all fan out — the
// seen-handshake requires each side to see the others' records advance. Only
// sigs minted THIS pass are sent (no re-emission of already-delivered sigs).
async function fanOutSigs(
  bank: Bank,
  sigs: Signature[],
  resolved: Order[],
): Promise<void> {
  if (sigs.length === 0) return;
  const peers = new Set<Base58PubKey>();
  for (const order of resolved) {
    for (const side of [order.debit, order.credit]) {
      if (side && side.bank !== bank.pubkey) peers.add(side.bank);
    }
  }
  for (const target of peers) {
    const addr = await getAddress(bank, target);
    if (!addr) continue;
    // Fire-and-forget — do NOT await the delivery. The in-process dispatch
    // path for co-located banks (peer.ts, local.ts) re-enters advanceDeal for
    // this same deal from inside notify_signatures; awaiting that here would
    // deadlock against the per-deal serialization chain (the peer's pass
    // queues behind THIS still-running pass). Client relay
    // (get_record_signatures + notify_signatures) is the recovery path.
    void bankRpcCall(bank, addr.url, target, 'notify_signatures', {
      signatures: sigs,
    }).catch((e) => {
      // Logged so a silently unreachable peer no longer stalls deals
      // invisibly.
      console.error(`fan-out notify_signatures to ${target} failed:`, e);
    });
  }
}

async function totalIssuedForVoucher(
  bank: Bank,
  voucherHash: string,
): Promise<number> {
  const { listRecordsByVoucher } = await import('./db.ts');
  return (await listRecordsByVoucher(bank, voucherHash)).reduce(
    (sum, r) => sum + r.doc.amount,
    0,
  );
}
