import type { Base58PubKey } from '@barter.game/protocol';
import type { KvStore } from './kv.ts';
import type { MediaStore } from './media.ts';

/**
 * Read-only access to the bundled web client (apps/web). Paths are relative
 * ("index.html", "app.js", "icon.svg"); implementations must confine reads
 * to the asset directory and return null for anything missing.
 */
export interface AssetReader {
  read(path: string): Promise<Uint8Array | null>;
}

export type Bank = {
  name: string;
  pubkey: Base58PubKey;
  privateKey: Uint8Array;
  kv: KvStore;
  media: MediaStore;
  assets: AssetReader;
  url: string;
  // Pubkeys allowed to use the operator-only /ui/admin/* routes. Comes from
  // BANK_ADMINS / BANK_<NAME>_ADMINS env config — pubkeys only, no secrets.
  admins: Base58PubKey[];
  // True when url came from a BANK_<NAME>_URL env override and must not be
  // overwritten by request-host derivation.
  urlPinned?: boolean;
  // True once url has been resolved from an incoming request origin.
  urlResolved?: boolean;
};

export type RpcContext = {
  bank: Bank;
  senderPubkey: Base58PubKey;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};
