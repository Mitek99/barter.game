import { expect, test } from 'bun:test';
import {
  canonicalize,
  genKeyPair,
  hashDoc,
  newUlid,
  signDoc,
} from '../src/index.ts';

test('canonicalize drops undefined keys', () => {
  expect(canonicalize({ a: 1, b: undefined, c: 'x' })).toBe('{"a":1,"c":"x"}');
});

// apps/web/protocol.js is a COMPILED mirror of src/index.ts that runs in the
// browser (regenerated per apps/web/README.md). The bank and the browser must
// agree on every content hash or the client mints docs the bank cannot
// resolve, so drift here is a live bug — and the two files have forked before.
// Pin the security-critical primitives.
test('web mirror agrees with the source on hashing and signing', async () => {
  const web = await import('../../../apps/web/protocol.js');
  const kp = genKeyPair();
  const docs: unknown[] = [
    {},
    { b: 2, a: 1 },
    { type: 'voucher', pubkey: kp.pubkeyBase58, ulid: newUlid(), name: 'x ünicode "q"' },
    { type: 'order', pubkey: kp.pubkeyBase58, ulid: newUlid(), rate: 1.5, nested: { sig: 'kept', n: -0 } },
  ];
  for (const d of docs) {
    expect(web.canonicalize(d)).toBe(canonicalize(d));
    expect(web.hashDoc(d)).toBe(hashDoc(d));
  }
  // A signature made by one implementation must verify under the other, and
  // both must address the doc by the same hash.
  const doc = { type: 'account', pubkey: kp.pubkeyBase58, ulid: newUlid(), name: 'a', voucher: 'V' };
  const signed = { ...doc, sig: signDoc(doc, kp.privateKey) };
  expect(web.verifyDoc(signed, signed.sig, kp.pubkeyBase58)).toBe(true);
  expect(web.hashDoc(signed)).toBe(hashDoc(signed));
  expect(web.hashDoc(signed)).toBe(hashDoc(doc));
});
