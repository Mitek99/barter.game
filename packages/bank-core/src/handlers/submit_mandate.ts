import { getMandate, getRecord, listRecordsByDeal, storeDoc, storeForeignRecordDeal, storeMandate } from '../db.ts';
import {
  hashDoc,
  validateMandate,
  validateRecord,
  verifyDoc,
  type BankRecord,
  type Order,
} from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';
import { advanceDeal } from '../advance.ts';
import { getOrder } from '../db.ts';

// submit_mandate validates and executes one per-(deal, order) Mandate — the
// coordinator's unit of work. `mandate.records` lists EVERY record satisfying
// the Order in this deal, across ALL participating banks; the coordinator
// passes the record bodies alongside. This bank verifies its own slice
// against its ledger and each foreign record against its minting bank's
// signature — so both sides of the Order (and its rate) are checkable here
// even when one voucher lives at another bank. The coordinator binding
// (details.coordinator == mandate.pubkey on local records) means only the
// coordinator that created the records can advance them.
export async function submitMandate(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const raw = params.mandate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(-32602, 'mandate doc required');
  }
  const mandate = validateMandate(raw);
  if (mandate.bank !== bank.pubkey) {
    throw new RpcError(-32000, 'mandate bank mismatch');
  }
  if (!mandate.sig || !verifyDoc(raw, mandate.sig, mandate.pubkey)) {
    throw new RpcError(-32001, 'invalid mandate signature');
  }

  // Reject a duplicate Mandate for the same (deal, order); idempotent reply.
  const existing = await getMandate(bank, mandate.deal_id, mandate.order);
  if (existing) {
    return {
      mandated: true,
      deal_id: mandate.deal_id,
      order: mandate.order,
      records: mandate.records,
    };
  }

  const order = await getOrder(bank, mandate.order);
  if (!order) throw new RpcError(-32005, 'mandate order unknown at this bank');

  // Index the record bodies the coordinator sent alongside.
  const bodiesRaw = Array.isArray(params.records) ? params.records : [];
  const bodies = new Map<string, Record<string, unknown>>();
  for (const b of bodiesRaw) {
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      bodies.set(hashDoc(b), b as Record<string, unknown>);
    }
  }

  for (const h of mandate.records) {
    const rec = await getRecord(bank, h);
    if (rec) {
      // Local record: must be ours, for this deal, sealed to this coordinator,
      // and authorized by this order.
      if (rec.details.deal_id !== mandate.deal_id) {
        throw new RpcError(-32000, `record ${h} not in deal ${mandate.deal_id}`);
      }
      if (rec.details.coordinator !== mandate.pubkey) {
        throw new RpcError(-32001, `record ${h} not bound to this coordinator`);
      }
      if (rec.doc.order !== mandate.order) {
        throw new RpcError(-32000, `record ${h} not authorized by order ${mandate.order}`);
      }
      continue;
    }
    // Foreign record: the body must be supplied, signed by its minting bank,
    // reference this order, and that bank must be one the Order names.
    const body = bodies.get(h);
    if (!body) throw new RpcError(-32005, `record body missing for ${h}`);
    const doc = validateRecord(body) as BankRecord;
    if (doc.order !== mandate.order) {
      throw new RpcError(-32000, `foreign record ${h} not authorized by order ${mandate.order}`);
    }
    if (!doc.sig || !verifyDoc(body, doc.sig, doc.pubkey)) {
      throw new RpcError(-32001, `foreign record ${h} signature invalid`);
    }
    if (!recordBankNamedByOrder(order, doc.pubkey) || doc.pubkey === bank.pubkey) {
      throw new RpcError(-32000, `foreign record ${h} minted by a bank the order does not name`);
    }
    await storeDoc(bank, body);
    // Remember this foreign record's deal so notify_signatures can route a
    // peer's signature on it to the right deal (and only that deal).
    await storeForeignRecordDeal(bank, h, mandate.deal_id);
  }

  // Completeness of the local slice: every record this bank minted for
  // (deal, order) must be listed — a Mandate cannot silently drop legs.
  const localForOrder = (await listRecordsByDeal(bank, mandate.deal_id))
    .filter((r) => r.doc.order === mandate.order);
  for (const r of localForOrder) {
    const h = hashDoc(r.doc);
    if (!mandate.records.includes(h)) {
      throw new RpcError(-32000, `mandate omits local record ${h}`);
    }
  }

  await storeMandate(bank, mandate);
  await advanceDeal(bank, mandate.deal_id);

  return {
    mandated: true,
    deal_id: mandate.deal_id,
    order: mandate.order,
    records: mandate.records,
  };
}

// A foreign record for an Order must be minted by a bank one of the Order's
// sides names — the same pinned pubkeys the holder signed.
function recordBankNamedByOrder(order: Order, bankPubkey: string): boolean {
  return order.debit?.bank === bankPubkey || order.credit?.bank === bankPubkey;
}
