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
  // Stall timeout for the advance engine: a mandated deal with no visible
  // progress for this long is rejected and its holds released
  // (bank-schema.md §2 "Reject semantics"). Injected via createBank options
  // (BANK_STALL_TIMEOUT_MS on the AWS host); defaults to 1 hour in advance.ts.
  stallTimeoutMs?: number;
  // Optional PostHog project key, injected into the SPA page as
  // window.__POSTHOG_KEY__ (serveSpa). Unset means the web client stays
  // analytics-inert. From BANK_POSTHOG_KEY / BANK_<NAME>_POSTHOG_KEY env.
  posthogKey?: string;
  // Browser-visible mount prefix (e.g. "/bank" when a gateway serves
  // /bank/{name}/… and strips the prefix before route()). Router-visible
  // paths never carry it; it only rewrites what browsers see: <base href>,
  // manifest start_url/scope, Service-Worker-Allowed, the /ui → /ui/ 308.
  // Default '' (no prefix). From BANK_MOUNT_PREFIX env.
  mountPrefix?: string;
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
