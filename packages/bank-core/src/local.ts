// Registry of banks served by THIS process.
//
// Deno Deploy blocks an isolate from fetching its own deployment URL
// (HTTP 508 "Loop Detected"). When several banks are co-located in one
// deployment, the coordinator and the advance engine must therefore reach
// peer banks in-process instead of over HTTP. This registry lets the
// peer-call layer detect a co-located target by pubkey and dispatch the
// RPC directly against the in-memory Bank.
import type { Bank } from './types.ts';

const localBanks = new Map<string, Bank>();

export function registerLocalBank(bank: Bank): void {
  localBanks.set(bank.pubkey, bank);
}

export function getLocalBank(pubkey: string): Bank | undefined {
  return localBanks.get(pubkey);
}
