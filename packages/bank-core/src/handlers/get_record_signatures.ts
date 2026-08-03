import { getRecord, getSignaturesForRecord } from '../db.ts';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

export async function getRecordSignatures(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.record_hash;
  if (typeof hash !== 'string') {
    throw new RpcError(-32602, 'record_hash required');
  }
  const rec = await getRecord(bank, hash);
  const signatures = await getSignaturesForRecord(bank, hash);
  return { record: rec?.doc ?? null, signatures };
}
