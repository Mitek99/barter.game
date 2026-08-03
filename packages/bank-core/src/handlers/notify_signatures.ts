import {
  getForeignRecordDeal,
  getRecord,
  storeSignature,
} from '../db.ts';
import { validateSignature, verifyDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';
import { advanceDeal } from '../advance.ts';

// Peers push their `ready`/`hold`/`settle`/`reject` signatures here. Each is
// stored under its anchored record hash (record_sig index); the advance engine
// then gathers a deal's signatures by that index. We route the re-advance to
// the ONE deal the signature's record belongs to — a local record via its deal,
// a foreign record via the foreign_record_deal index written at submit_mandate.
// A signature whose record we don't know is stored but not acted on (no
// cross-deal, advance-everything amplification).
export async function notifySignatures(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const sigsRaw = params.signatures;
  if (!Array.isArray(sigsRaw)) {
    throw new RpcError(-32602, 'signatures array required');
  }
  const stored: string[] = [];
  const touchedDeals = new Set<string>();
  for (const raw of sigsRaw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    try {
      const sig = validateSignature(raw);
      if (!sig.sig || !verifyDoc(raw, sig.sig, sig.pubkey)) {
        continue;
      }
      const h = await storeSignature(bank, sig);
      stored.push(h);
      if (!sig.hash) continue;
      const rec = await getRecord(bank, sig.hash);
      if (rec) {
        touchedDeals.add(rec.details.deal_id);
      } else {
        const dealId = await getForeignRecordDeal(bank, sig.hash);
        if (dealId) touchedDeals.add(dealId);
      }
    } catch {
      // skip invalid entries
    }
  }

  const advanced: string[] = [];
  for (const dealId of touchedDeals) {
    try {
      await advanceDeal(bank, dealId);
      advanced.push(dealId);
    } catch {
      // continue
    }
  }
  return { stored, advanced };
}
