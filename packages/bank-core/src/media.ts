import { base58Encode } from '@barter.game/protocol';
import type { Base58SHA256 } from '@barter.game/protocol';
import type { KvKey, KvStore } from './kv.ts';

/**
 * Content-addressed media vault (post-feed.md §5). Blobs are immutable and
 * fetched by hash over plain unauthenticated HTTP, so storage is a flat
 * namespace with no owner. Both caps are BANK POLICY, not protocol — §5
 * leaves size/type/quota entirely to the carrying bank.
 *
 * The store is per-deployment; implementations namespace by bank pubkey so
 * several banks can share one backing store, mirroring the KV layout.
 */
export const MEDIA_MAX_BYTES = 1024 * 1024;

export type MediaMeta = {
  size: number;
  content_type: string;
};

export interface MediaStore {
  has(bankPubkey: string, hash: Base58SHA256): Promise<boolean>;
  /** Store a blob under its sha256 (base58). Re-storing the same bytes is a no-op. */
  put(
    bankPubkey: string,
    hash: Base58SHA256,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  get(
    bankPubkey: string,
    hash: Base58SHA256,
  ): Promise<{ bytes: Uint8Array; meta: MediaMeta } | null>;
}

export async function sha256Base58Bytes(bytes: Uint8Array): Promise<Base58SHA256> {
  const buf = new Uint8Array(bytes.length);
  buf.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return base58Encode(new Uint8Array(digest));
}

// --- KV-backed implementation ----------------------------------------------

/**
 * Deno KV caps a single value at 64 KiB, so a blob is split across numbered
 * chunk keys with a small metadata row. Used by the Deno deployment; the AWS
 * deployment stores blobs as S3 objects instead.
 */
const MEDIA_CHUNK_BYTES = 48 * 1024;

type KvMediaMeta = MediaMeta & { chunks: number };

export class KvMediaStore implements MediaStore {
  constructor(private kv: KvStore) {}

  private k(bankPubkey: string, ...parts: (string | number)[]): KvKey {
    // Same [bank, schema-version, kind, ...] layout db.ts uses, so existing
    // deployments keep their stored blobs across the refactor.
    return [bankPubkey, 'v2', ...parts];
  }

  async has(bankPubkey: string, hash: Base58SHA256): Promise<boolean> {
    const r = await this.kv.get<KvMediaMeta>(this.k(bankPubkey, 'media_meta', hash));
    return r.value !== null;
  }

  async put(
    bankPubkey: string,
    hash: Base58SHA256,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    if (await this.has(bankPubkey, hash)) return;
    const chunks = Math.max(1, Math.ceil(bytes.length / MEDIA_CHUNK_BYTES));
    for (let i = 0; i < chunks; i++) {
      const slice = bytes.slice(i * MEDIA_CHUNK_BYTES, (i + 1) * MEDIA_CHUNK_BYTES);
      await this.kv.set(this.k(bankPubkey, 'media_chunk', hash, i), slice);
    }
    // Metadata last: its presence is what marks the blob complete, so a
    // partial write can never be served as if it were whole.
    const meta: KvMediaMeta = { size: bytes.length, content_type: contentType, chunks };
    await this.kv.set(this.k(bankPubkey, 'media_meta', hash), meta);
  }

  async get(
    bankPubkey: string,
    hash: Base58SHA256,
  ): Promise<{ bytes: Uint8Array; meta: MediaMeta } | null> {
    const metaRow = await this.kv.get<KvMediaMeta>(this.k(bankPubkey, 'media_meta', hash));
    const meta = metaRow.value;
    if (!meta) return null;
    const bytes = new Uint8Array(meta.size);
    let offset = 0;
    for (let i = 0; i < meta.chunks; i++) {
      const c = await this.kv.get<Uint8Array>(this.k(bankPubkey, 'media_chunk', hash, i));
      if (!c.value) return null;
      bytes.set(c.value, offset);
      offset += c.value.length;
    }
    if (offset !== meta.size) return null;
    return { bytes, meta: { size: meta.size, content_type: meta.content_type } };
  }
}
