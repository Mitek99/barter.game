// Registry of banks served by THIS process.
//
// Serverless platforms can block an isolate from fetching its own deployment
// URL (Deno Deploy answered with HTTP 508 "Loop Detected"), and even where
// self-fetch works it wastes a network round-trip. When several banks are
// co-located in one deployment, the coordinator and the advance engine
// therefore reach peer banks in-process instead of over HTTP. This registry
// lets the peer-call layer detect a co-located target by pubkey and dispatch
// the RPC directly against the in-memory Bank.
import type { Bank } from './types.ts';

const localBanks = new Map<string, Bank>();

export function registerLocalBank(bank: Bank): void {
  localBanks.set(bank.pubkey, bank);
}

export function getLocalBank(pubkey: string): Bank | undefined {
  return localBanks.get(pubkey);
}
