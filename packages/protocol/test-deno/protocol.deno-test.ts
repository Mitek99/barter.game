import { assertEquals } from 'jsr:@std/assert';
import {
  canonicalize,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '../src/index.ts';
import vectors from '../test/fixtures/canonical/vectors.json' with { type: 'json' };

type Vector = { name: string; input: unknown; canonical: string };

for (const v of vectors as Vector[]) {
  Deno.test(`canonical vector: ${v.name}`, () => {
    assertEquals(canonicalize(v.input), v.canonical);
  });
}

Deno.test('canonicalizeWithoutSig removes top-level sig', () => {
  const doc = { type: 'voucher', name: '1 logo', sig: 'abc123' };
  assertEquals(
    canonicalizeWithoutSig(doc),
    '{"name":"1 logo","type":"voucher"}',
  );
});

Deno.test('canonicalizeWithoutSig keeps nested sig', () => {
  const doc = { type: 'tx', inner: { sig: 'kept' } };
  assertEquals(
    canonicalizeWithoutSig(doc),
    '{"inner":{"sig":"kept"},"type":"tx"}',
  );
});

// apps/web/protocol.js is a HAND-MAINTAINED mirror of src/index.ts that runs in
// the browser. The bank and the browser must agree on every content hash or the
// client mints docs the bank cannot resolve, so drift here is a live bug — and
// the two files have forked before. Pin the security-critical primitives.
Deno.test('web mirror agrees with the source on hashing and signing', async () => {
  const web = await import('../../../apps/web/protocol.js');
  const kp = genKeyPair();
  const docs: unknown[] = [
    {},
    { b: 2, a: 1 },
    { type: 'voucher', pubkey: kp.pubkeyBase58, ulid: newUlid(), name: 'x ünicode "q"' },
    { type: 'order', pubkey: kp.pubkeyBase58, ulid: newUlid(), rate: 1.5, nested: { sig: 'kept', n: -0 } },
  ];
  for (const d of docs) {
    assertEquals(web.canonicalize(d), canonicalize(d), 'canonicalize');
    assertEquals(web.hashDoc(d), hashDoc(d), 'hashDoc');
  }
  // A signature made by one implementation must verify under the other, and
  // both must address the doc by the same hash.
  const doc = { type: 'account', pubkey: kp.pubkeyBase58, ulid: newUlid(), name: 'a', voucher: 'V' };
  const signed = { ...doc, sig: signDoc(doc, kp.privateKey) };
  assertEquals(web.verifyDoc(signed, signed.sig, kp.pubkeyBase58), true, 'cross-verify');
  assertEquals(web.hashDoc(signed), hashDoc(signed), 'hash of signed doc');
  assertEquals(web.hashDoc(signed), hashDoc(doc), 'hash ignores the top-level sig');
});
