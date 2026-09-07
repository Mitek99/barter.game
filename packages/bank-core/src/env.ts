import { publicKeyOf, base58Decode, type Base58PubKey } from '@barter.game/protocol';
import type { AssetReader, Bank } from './types.ts';
import type { KvStore } from './kv.ts';
import type { MediaStore } from './media.ts';

export type LoadedBank = {
  name: string;
  pubkey: Base58PubKey;
  privateKey: Uint8Array;
  admins: Base58PubKey[];
  posthogKey?: string;
  mountPrefix?: string;
};

// Normalize a mount prefix to "/bank" shape: leading slash, no trailing
// slash, '' (absent) for the root mount.
function normMountPrefix(raw: string | undefined): string | undefined {
  const p = (raw ?? '').trim().replace(/\/+$/, '');
  if (!p) return undefined;
  return p.startsWith('/') ? p : `/${p}`;
}

const BANK_ENV_RE = /^BANK_([A-Z0-9_]+)_PRIV_KEY$/;
// Per-bank admin list; the global BANK_ADMINS does not match (nothing before
// the "_ADMINS" suffix).
const BANK_ADMINS_RE = /^BANK_([A-Z0-9_]+)_ADMINS$/;
// Per-bank PostHog key; the global BANK_POSTHOG_KEY does not match.
const BANK_POSTHOG_RE = /^BANK_([A-Z0-9_]+)_POSTHOG_KEY$/;

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
  const perBankPosthog = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(BANK_ADMINS_RE);
    if (m && value) {
      perBankAdmins.set(m[1]!.toLowerCase().replace(/_/g, '-'), parseAdminPubkeys(value));
    }
    const p = key.match(BANK_POSTHOG_RE);
    if (p && value) {
      perBankPosthog.set(p[1]!.toLowerCase().replace(/_/g, '-'), value.trim());
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
      const posthogKey = perBankPosthog.get(name) ?? env.BANK_POSTHOG_KEY?.trim();
      const mountPrefix = normMountPrefix(env.BANK_MOUNT_PREFIX);
      banks.push({
        name, pubkey: pubkeyBase58, privateKey, admins,
        ...(posthogKey ? { posthogKey } : {}),
        ...(mountPrefix ? { mountPrefix } : {}),
      });
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
  opts?: { stallTimeoutMs?: number },
): Bank {
  return { ...loaded, ...deps, url, stallTimeoutMs: opts?.stallTimeoutMs };
}
