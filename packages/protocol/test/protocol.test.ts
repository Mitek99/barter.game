import { describe, expect, test } from 'bun:test';
import {
  base58Decode,
  base58Encode,
  canonicalize,
  canonicalizeWithoutSig,
  canonicalBytes,
  genKeyPair,
  hashDoc,
  publicKeyOf,
  signBytes,
  signDoc,
  verifyBytes,
  verifyDoc,
  newUlid,
  isValidBase58,
  isValidUlid,
  validateAccount,
  validateAddress,
  validateBaseDoc,
  validateMandate,
  validateOffer,
  validateOrder,
  validateRecord,
  validateSignature,
  validateVoucher,
  ValidationError,
} from '../src/index.ts';
import vectors from './fixtures/canonical/vectors.json' with { type: 'json' };

const PUBKEY = 'CqPmMncin5kkUJpLgUmy78mfp1GQiaxvDpjwihgnmiza';
const ULID = '01J84XCEPZ8B7K3NJ60ZBQX4K3';
const HASH = '8QGcXKZj7w9N6yj2HCkXyJZj7w9N6yj2HCkXyJZj7w9N';

// --- canonical JSON ---------------------------------------------------------

type Vector = { name: string; input: unknown; canonical: string };

describe('canonical JSON — golden vectors', () => {
  for (const v of vectors as Vector[]) {
    test(v.name, () => {
      expect(canonicalize(v.input)).toBe(v.canonical);
    });
  }
});

describe('canonicalizeWithoutSig', () => {
  test('removes top-level sig field', () => {
    const doc = { type: 'voucher', name: '1 logo', sig: 'abc123' };
    expect(canonicalizeWithoutSig(doc)).toBe(
      '{"name":"1 logo","type":"voucher"}',
    );
  });

  test('does not remove nested sig fields', () => {
    const doc = { type: 'tx', inner: { sig: 'kept' } };
    expect(canonicalizeWithoutSig(doc)).toBe(
      '{"inner":{"sig":"kept"},"type":"tx"}',
    );
  });

  test('returns canonical form when input is not an object', () => {
    expect(canonicalizeWithoutSig(null)).toBe('null');
    expect(canonicalizeWithoutSig(42)).toBe('42');
  });
});

describe('canonical — error cases', () => {
  test('throws on non-finite numbers', () => {
    expect(() => canonicalize({ n: Infinity })).toThrow();
    expect(() => canonicalize({ n: NaN })).toThrow();
  });
});

// --- crypto -----------------------------------------------------------------

describe('ed25519 primitives', () => {
  test('genKeyPair produces distinct keypairs', () => {
    const a = genKeyPair();
    const b = genKeyPair();
    expect(a.pubkeyBase58).not.toBe(b.pubkeyBase58);
    expect(a.publicKey).not.toEqual(b.publicKey);
    expect(a.privateKey).not.toEqual(b.privateKey);
  });

  test('publicKeyOf derives the same pubkey', () => {
    const kp = genKeyPair();
    const derived = publicKeyOf(kp.privateKey);
    expect(derived.pubkeyBase58).toBe(kp.pubkeyBase58);
    expect(derived.publicKey).toEqual(kp.publicKey);
  });

  test('signBytes / verifyBytes roundtrip', () => {
    const kp = genKeyPair();
    const msg = new TextEncoder().encode('hello ledger');
    const sig = signBytes(msg, kp.privateKey);
    expect(verifyBytes(msg, sig, kp.pubkeyBase58)).toBe(true);
  });

  test('verifyBytes fails on tampered message', () => {
    const kp = genKeyPair();
    const msg = new TextEncoder().encode('hello ledger');
    const sig = signBytes(msg, kp.privateKey);
    const tampered = new TextEncoder().encode('hello lenger');
    expect(verifyBytes(tampered, sig, kp.pubkeyBase58)).toBe(false);
  });

  test('verifyBytes fails on wrong pubkey', () => {
    const kp = genKeyPair();
    const other = genKeyPair();
    const msg = new TextEncoder().encode('hello ledger');
    const sig = signBytes(msg, kp.privateKey);
    expect(verifyBytes(msg, sig, other.pubkeyBase58)).toBe(false);
  });

  test('verifyBytes fails gracefully on malformed inputs', () => {
    expect(verifyBytes(new Uint8Array(0), 'not-base58!!', PUBKEY)).toBe(false);
    expect(verifyBytes(new Uint8Array(0), 'abc', 'not-base58!!')).toBe(false);
  });
});

describe('doc signing and hashing', () => {
  test('signDoc / verifyDoc roundtrip', () => {
    const kp = genKeyPair();
    const doc = {
      type: 'address' as const,
      pubkey: kp.pubkeyBase58,
      ulid: newUlid(),
      url: 'https://example.com',
    };
    const sig = signDoc(doc, kp.privateKey);
    expect(verifyDoc(doc, sig, kp.pubkeyBase58)).toBe(true);
  });

  test('tampering with any field invalidates the signature', () => {
    const kp = genKeyPair();
    const doc = {
      type: 'address' as const,
      pubkey: kp.pubkeyBase58,
      ulid: newUlid(),
      url: 'https://example.com',
    };
    const sig = signDoc(doc, kp.privateKey);
    expect(verifyDoc({ ...doc, url: 'https://evil.com' }, sig, kp.pubkeyBase58)).toBe(false);
  });

  test('signDoc ignores an existing sig field', () => {
    const kp = genKeyPair();
    const doc = {
      type: 'address' as const,
      pubkey: kp.pubkeyBase58,
      ulid: newUlid(),
      url: 'https://example.com',
    };
    const sig1 = signDoc(doc, kp.privateKey);
    const sig2 = signDoc({ ...doc, sig: sig1 }, kp.privateKey);
    expect(sig1).toBe(sig2);
  });

  test('hashDoc is deterministic and order-independent', () => {
    const a = hashDoc({ b: 2, a: 1 });
    const b = hashDoc({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(isValidBase58(a)).toBe(true);
  });

  test('hashDoc changes when content changes', () => {
    const a = hashDoc({ a: 1 });
    const b = hashDoc({ a: 2 });
    expect(a).not.toBe(b);
  });

  // The content hash is taken over the SAME preimage the signature commits to:
  // canonical(doc minus top-level sig). Without this a doc has two identities —
  // the one its signature signs and the one it is stored under (base.md §2).
  test('hashDoc ignores the top-level sig: identity is stable across signing', () => {
    const kp = genKeyPair();
    const doc = { type: 'voucher', pubkey: kp.pubkeyBase58, ulid: ULID, name: 'x' };
    const unsigned = hashDoc(doc);
    const signed = { ...doc, sig: signDoc(doc, kp.privateKey) };
    expect(hashDoc(signed)).toBe(unsigned);
  });

  test('hashDoc is unchanged by a different sig value', () => {
    const doc = { type: 'voucher', pubkey: PUBKEY, ulid: ULID, name: 'x' };
    expect(hashDoc({ ...doc, sig: 'AAAA' })).toBe(hashDoc({ ...doc, sig: 'BBBB' }));
  });

  test('hashDoc binds an EMBEDDED doc sig — only the top-level sig is stripped', () => {
    const kp = genKeyPair();
    const child = { type: 'post', pubkey: kp.pubkeyBase58, ulid: ULID, body_md: 'hi' };
    const signedChild = { ...child, sig: signDoc(child, kp.privateKey) };
    const parent = { type: 'post', pubkey: kp.pubkeyBase58, ulid: ULID, body_md: 're', reply_to: signedChild };
    const tampered = { ...parent, reply_to: { ...signedChild, sig: 'TAMPERED' } };
    expect(hashDoc(parent)).not.toBe(hashDoc(tampered));
  });

  test('the signed preimage and the content hash are the same bytes', () => {
    const kp = genKeyPair();
    const doc = { type: 'order', pubkey: kp.pubkeyBase58, ulid: ULID, rate: 1 };
    const signed = { ...doc, sig: signDoc(doc, kp.privateKey) };
    // verifyDoc strips the top-level sig; hashDoc must strip exactly the same,
    // so a signature verifies against the very hash the doc is addressed by.
    expect(verifyDoc(signed, signed.sig, kp.pubkeyBase58)).toBe(true);
    expect(hashDoc(signed)).toBe(hashDoc(doc));
  });
});

// --- ULID + base58 helpers --------------------------------------------------

describe('ULID + base58 helpers', () => {
  test('newUlid returns a 26-char Crockford-base32 string', () => {
    const u = newUlid();
    expect(u.length).toBe(26);
    expect(/^[0-9A-Z]{26}$/i.test(u)).toBe(true);
  });

  test('base58 roundtrip', () => {
    const bytes = new Uint8Array([0, 1, 255, 128, 64]);
    const encoded = base58Encode(bytes);
    expect(isValidBase58(encoded)).toBe(true);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  test('isValidUlid', () => {
    expect(isValidUlid('01J84XCEPZ8B7K3NJ60ZBQX4K3')).toBe(true);
    expect(isValidUlid('lowercase1234567890123456')).toBe(false);
    expect(isValidUlid('short')).toBe(false);
  });
});

// --- validators -------------------------------------------------------------

describe('validateBaseDoc', () => {
  test('accepts a minimal valid base doc', () => {
    expect(() =>
      validateBaseDoc({ type: 'address', pubkey: PUBKEY, ulid: ULID }),
    ).not.toThrow();
  });

  test('rejects missing fields', () => {
    expect(() => validateBaseDoc({ type: 'address', pubkey: PUBKEY })).toThrow(
      ValidationError,
    );
    expect(() => validateBaseDoc({ type: 'address', ulid: ULID })).toThrow(
      ValidationError,
    );
  });

  test('rejects bad pubkey or ulid encoding', () => {
    expect(() =>
      validateBaseDoc({ type: 'address', pubkey: '!!!', ulid: ULID }),
    ).toThrow(ValidationError);
    expect(() =>
      validateBaseDoc({ type: 'address', pubkey: PUBKEY, ulid: 'notaulid' }),
    ).toThrow(ValidationError);
  });
});

describe('validateVoucher', () => {
  const voucher = {
    type: 'voucher' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    bank: PUBKEY,
    name: '1 logo',
  };

  test('accepts a minimal valid voucher', () => {
    expect(() => validateVoucher(voucher, PUBKEY)).not.toThrow();
  });

  test('rejects wrong bank', () => {
    expect(() => validateVoucher(voucher, HASH)).toThrow(ValidationError);
  });

  test('rejects missing name', () => {
    expect(() =>
      validateVoucher({ ...voucher, name: '' }, PUBKEY),
    ).toThrow(ValidationError);
  });

  test('rejects negative limit', () => {
    expect(() =>
      validateVoucher({ ...voucher, limit: -1 }, PUBKEY),
    ).toThrow(ValidationError);
  });

  test('rejects non-boolean integer', () => {
    expect(() =>
      validateVoucher({ ...voucher, integer: 'yes' as unknown as boolean }, PUBKEY),
    ).toThrow(ValidationError);
  });
});

describe('validateAccount', () => {
  const account = {
    type: 'account' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    name: 'default',
    voucher: HASH,
  };

  test('accepts a minimal valid account', () => {
    expect(() => validateAccount(account)).not.toThrow();
  });

  test('rejects missing name', () => {
    expect(() => validateAccount({ ...account, name: '' })).toThrow(
      ValidationError,
    );
  });

  test('rejects bad voucher hash', () => {
    expect(() => validateAccount({ ...account, voucher: '!!!' })).toThrow(
      ValidationError,
    );
  });
});

describe('validateOrder', () => {
  const side = {
    account: HASH,
    voucher: HASH,
    bank: PUBKEY,
    min: 0,
    max: 100,
  };

  test('accepts a minimal valid order', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 1.5,
        lead: true,
        debit: side,
      }),
    ).not.toThrow();
  });

  test('accepts credit-only order', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 1,
        lead: false,
        credit: side,
      }),
    ).not.toThrow();
  });

  test('rejects order with neither side', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 1,
        lead: true,
      }),
    ).toThrow(ValidationError);
  });

  test('rejects non-positive rate', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 0,
        lead: true,
        debit: side,
      }),
    ).toThrow(ValidationError);
  });

  test('rejects min > max', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 1,
        lead: true,
        debit: { ...side, min: 10, max: 5 },
      }),
    ).toThrow(ValidationError);
  });

  test('rejects non-boolean lead', () => {
    expect(() =>
      validateOrder({
        type: 'order',
        pubkey: PUBKEY,
        ulid: ULID,
        rate: 1,
        lead: 'yes' as unknown as boolean,
        debit: side,
      }),
    ).toThrow(ValidationError);
  });
});

describe('validateOffer', () => {
  const offer = {
    type: 'offer' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    order: HASH,
    rate: 1,
    lead: false,
    debit: { voucher: HASH, bank: PUBKEY, min: 0, max: 10 },
  };

  test('accepts a minimal valid offer', () => {
    expect(() => validateOffer(offer)).not.toThrow();
  });

  test('rejects missing order hash', () => {
    expect(() => validateOffer({ ...offer, order: 'bad!' })).toThrow(
      ValidationError,
    );
  });

  test('rejects non-positive rate', () => {
    expect(() => validateOffer({ ...offer, rate: 0 })).toThrow(ValidationError);
  });

  test('rejects offer with neither side', () => {
    expect(() =>
      validateOffer({
        type: 'offer',
        pubkey: PUBKEY,
        ulid: ULID,
        order: HASH,
        rate: 1,
        lead: true,
      }),
    ).toThrow(ValidationError);
  });

  test('rejects min > max', () => {
    expect(() =>
      validateOffer({
        ...offer,
        debit: { voucher: HASH, bank: PUBKEY, min: 5, max: 1 },
      }),
    ).toThrow(ValidationError);
  });
});

describe('validateRecord', () => {
  const record = {
    type: 'credit' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    amount: 10,
    order: HASH,
    details: HASH,
  };

  test('accepts a valid record', () => {
    expect(() => validateRecord(record)).not.toThrow();
  });

  test('rejects missing details hash', () => {
    expect(() =>
      validateRecord({ ...record, details: '!!!' }),
    ).toThrow(ValidationError);
  });

  test('rejects non-positive amount', () => {
    expect(() => validateRecord({ ...record, amount: 0 })).toThrow(
      ValidationError,
    );
    expect(() => validateRecord({ ...record, amount: -1 })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateRecord({ ...record, amount: Infinity }),
    ).toThrow(ValidationError);
  });
});

describe('validateMandate', () => {
  const mandate = {
    type: 'mandate' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    deal_id: ULID,
    order: HASH,
    bank: PUBKEY,
    records: [HASH],
  };

  test('accepts a minimal valid mandate', () => {
    expect(() => validateMandate(mandate)).not.toThrow();
  });

  test('rejects missing order', () => {
    const { order: _order, ...noOrder } = mandate;
    expect(() => validateMandate(noOrder)).toThrow(ValidationError);
  });

  test('rejects empty records', () => {
    expect(() => validateMandate({ ...mandate, records: [] })).toThrow(
      ValidationError,
    );
  });

  test('rejects bad deal_id', () => {
    expect(() => validateMandate({ ...mandate, deal_id: 'nope' })).toThrow(
      ValidationError,
    );
  });

  test('rejects non-base58 record hash', () => {
    expect(() =>
      validateMandate({ ...mandate, records: ['!!!'] }),
    ).toThrow(ValidationError);
  });
});

describe('validateSignature', () => {
  const sig = {
    type: 'signature' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    hash: HASH,
    action: 'ready' as const,
  };

  test('accepts a minimal valid signature', () => {
    expect(() => validateSignature(sig)).not.toThrow();
  });

  test('rejects invalid action', () => {
    expect(() =>
      validateSignature({ ...sig, action: 'nope' as 'ready' }),
    ).toThrow(ValidationError);
  });

  test('rejects non-array seen', () => {
    expect(() =>
      validateSignature({ ...sig, seen: 'bad' as unknown as string[] }),
    ).toThrow(ValidationError);
  });

  test('rejects bad seen hash', () => {
    expect(() => validateSignature({ ...sig, seen: ['!!!'] })).toThrow(
      ValidationError,
    );
  });
});

describe('validateAddress', () => {
  const addr = {
    type: 'address' as const,
    pubkey: PUBKEY,
    ulid: ULID,
    url: 'https://example.com',
  };

  test('accepts a minimal valid address', () => {
    expect(() => validateAddress(addr)).not.toThrow();
  });

  test('rejects non-http url', () => {
    expect(() =>
      validateAddress({ ...addr, url: 'mailto:a@b.com' }),
    ).toThrow(ValidationError);
  });
});
