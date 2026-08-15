import { publicKeyOf, base58Decode, type Base58PubKey } from '@barter.game/protocol';
import type { AssetReader, Bank } from './types.ts';
import type { KvStore } from './kv.ts';
import type { MediaStore } from './media.ts';

export type LoadedBank = {
  name: string;
  pubkey: Base58PubKey;
  privateKey: Uint8Array;
  admins: Base58PubKey[];
};

const BANK_ENV_RE = /^BANK_([A-Z0-9_]+)_PRIV_KEY$/;
// Per-bank admin list; the global BANK_ADMINS does not match (nothing before
// the "_ADMINS" suffix).
const BANK_ADMINS_RE = /^BANK_([A-Z0-9_]+)_ADMINS$/;

/** Comma/space-separated base58 ed25519 pubkeys; invalid entries are skipped. */
function parseAdminPubkeys(raw: string | undefined): Base58PubKey[] {
  if (!raw) return [];
  const out: Base58PubKey[] = [];
  for (const s of raw.split(/[,\s]+/)) {
    if (!s) continue;
    try {
      if (base58Decode(s).length !== 32) throw new Error('bad length');
      out.push(s as Base58PubKey);
    } catch {
      console.error(`Ignoring invalid admin pubkey: ${s}`);
    }
  }
  return out;
}

export function loadBankKeys(
  env: Record<string, string | undefined>,
): LoadedBank[] {
  const globalAdmins = parseAdminPubkeys(env.BANK_ADMINS);
  const perBankAdmins = new Map<string, Base58PubKey[]>();
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(BANK_ADMINS_RE);
    if (m && value) {
      perBankAdmins.set(m[1]!.toLowerCase().replace(/_/g, '-'), parseAdminPubkeys(value));
    }
  }
  const banks: LoadedBank[] = [];
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(BANK_ENV_RE);
    if (!m || !value) continue;
    const name = m[1]!.toLowerCase().replace(/_/g, '-');
    try {
      const privateKey = base58Decode(value);
      if (privateKey.length !== 32) {
        console.error(`Bank ${name}: private key must decode to 32 bytes`);
        continue;
      }
      const { pubkeyBase58 } = publicKeyOf(privateKey);
      const admins = [...new Set([...globalAdmins, ...(perBankAdmins.get(name) ?? [])])];
      banks.push({ name, pubkey: pubkeyBase58, privateKey, admins });
    } catch (e) {
      console.error(`Bank ${name}: failed to load key: ${e}`);
    }
  }
  return banks;
}

export type BankDeps = {
  kv: KvStore;
  media: MediaStore;
  assets: AssetReader;
};

export function createBank(
  loaded: LoadedBank,
  deps: BankDeps,
  url: string,
): Bank {
  return { ...loaded, ...deps, url };
}
