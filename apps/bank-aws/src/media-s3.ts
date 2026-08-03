import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaStore, MediaMeta } from '@barter.game/bank-core';

/**
 * MediaStore over S3 — one object per blob, keyed by bank + content hash.
 * Blobs are immutable and content-addressed, so a PutObject overwrite of an
 * existing key writes identical bytes and needs no guard.
 */
export class S3MediaStore implements MediaStore {
  constructor(
    private client: S3Client,
    private bucket: string,
    private prefix = 'media',
  ) {}

  private key(bankPubkey: string, hash: string): string {
    return `${this.prefix}/${bankPubkey}/${hash}`;
  }

  async has(bankPubkey: string, hash: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.key(bankPubkey, hash),
      }));
      return true;
    } catch (e) {
      if (e instanceof NotFound || isMissing(e)) return false;
      throw e;
    }
  }

  async put(
    bankPubkey: string,
    hash: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(bankPubkey, hash),
      Body: bytes,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  async get(
    bankPubkey: string,
    hash: string,
  ): Promise<{ bytes: Uint8Array; meta: MediaMeta } | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(bankPubkey, hash),
      }));
      const bytes = new Uint8Array(await res.Body!.transformToByteArray());
      return {
        bytes,
        meta: {
          size: bytes.length,
          content_type: res.ContentType ?? 'application/octet-stream',
        },
      };
    } catch (e) {
      if (e instanceof NoSuchKey || isMissing(e)) return null;
      throw e;
    }
  }
}

function isMissing(e: unknown): boolean {
  const meta = (e as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 404;
}
