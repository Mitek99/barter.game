/**
 * KvStore contract testkit — the storage semantics the bank ledger depends on
 * (hold exclusivity, versionstamp CAS, the 64 KiB value cap, list ordering).
 *
 * Runner-agnostic by design: bank-core is consumed as TypeScript source under
 * web-standard APIs only, so this module imports no test runner and no Node
 * globals. It returns named async tests that throw on failure; the host wraps
 * them in whatever runner it uses:
 *
 *   import { test, describe } from 'node:test';
 *   import { kvContractTests } from '@barter.game/bank-core/testkit';
 *
 *   describe('MyKv', () => {
 *     for (const t of kvContractTests(() => new MyKv())) test(t.name, t.run);
 *   });
 *
 * The store factory is called once per kvContractTests() invocation and the
 * instance is shared across that invocation's tests, mirroring a before()
 * hook. Keys are namespaced per test so runs are isolated on a shared table.
 */
import type { KvStore } from './kv.ts';

export interface KvContractTest {
  name: string;
  run: () => Promise<void>;
}

function fail(message: string): never {
  throw new Error(`KvStore contract violation: ${message}`);
}

function assertOk(value: unknown, message: string): void {
  if (!value) fail(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    fail(`${message} (expected ${fmt(expected)}, got ${fmt(actual)})`);
  }
}

function assertNotEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) fail(`${message} (both ${fmt(actual)})`);
}

function fmt(value: unknown): string {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((v, i) => v === b[i])
    );
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEq(v, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return a === b;
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEq(actual, expected)) {
    fail(`${message} (expected ${fmt(expected)}, got ${fmt(actual)})`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  fail(`${message} (expected the write to be refused)`);
}

/**
 * The full KvStore contract as an ordered list of named tests. Keep the test
 * bodies in sync with the semantics documented in kv.ts — a store that passes
 * this suite is safe to run a bank on.
 */
export function kvContractTests(
  makeStore: () => Promise<KvStore> | KvStore,
): KvContractTest[] {
  let storePromise: Promise<KvStore> | undefined;
  const store = (): Promise<KvStore> => (storePromise ??= Promise.resolve(makeStore()));

  const B = 'BankPubkeyForTests';
  const V = 'v2';
  let n = 0;
  // Namespace every test's keys so runs are isolated on a shared table.
  const ns = (): string => `k${Date.now().toString(36)}${(n++).toString(36)}`;

  return [
    {
      name: 'get of a missing key',
      run: async () => {
        const kv = await store();
        const r = await kv.get([B, V, ns(), 'nope']);
        assertEqual(r.value, null, 'missing key must read as null value');
        assertEqual(r.versionstamp, null, 'missing key must read as null versionstamp');
      },
    },
    {
      name: 'set/get roundtrip for JSON values',
      run: async () => {
        const kv = await store();
        const kind = ns();
        await kv.set([B, V, kind, 'a'], { x: 1, s: 'str', arr: [1, 2] });
        await kv.set([B, V, kind, 'b'], true);
        await kv.set([B, V, kind, 'c'], 42);
        assertDeepEqual(
          (await kv.get([B, V, kind, 'a'])).value,
          { x: 1, s: 'str', arr: [1, 2] },
          'object roundtrip',
        );
        assertEqual((await kv.get([B, V, kind, 'b'])).value, true, 'boolean roundtrip');
        assertEqual((await kv.get([B, V, kind, 'c'])).value, 42, 'number roundtrip');
      },
    },
    {
      name: 'set/get roundtrip for Uint8Array values with number key parts',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const bytes = new Uint8Array([0, 1, 2, 250, 255]);
        await kv.set([B, V, kind, 'hash', 0], bytes);
        const r = await kv.get<Uint8Array>([B, V, kind, 'hash', 0]);
        assertOk(r.value instanceof Uint8Array, 'value must come back as Uint8Array');
        assertDeepEqual(r.value, bytes, 'bytes must survive the roundtrip');
      },
    },
    {
      name: 'versionstamp changes on every write',
      run: async () => {
        const kv = await store();
        const kind = ns();
        await kv.set([B, V, kind, 'k'], 1);
        const v1 = (await kv.get([B, V, kind, 'k'])).versionstamp;
        await kv.set([B, V, kind, 'k'], 2);
        const v2 = (await kv.get([B, V, kind, 'k'])).versionstamp;
        assertOk(v1 !== null && v2 !== null && v1 !== v2, 'each write must mint a fresh versionstamp');
      },
    },
    {
      name: 'atomic claim of an absent key succeeds once',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const key = [B, V, kind, 'claim'];
        const first = await kv.get(key);
        assertEqual(
          (await kv.atomic().check(first).set(key, 'mine').commit()).ok,
          true,
          'first claim must commit',
        );
        // Same stale check again: must fail now.
        assertEqual(
          (await kv.atomic().check(first).set(key, 'stolen').commit()).ok,
          false,
          'replayed stale claim must be refused',
        );
        assertEqual((await kv.get(key)).value, 'mine', 'the winning claim must stand');
      },
    },
    {
      name: 'atomic with a matching versionstamp commits, stale fails',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const key = [B, V, kind, 'cas'];
        await kv.set(key, { n: 1 });
        const read = await kv.get(key);
        assertEqual(
          (await kv.atomic().check(read).set(key, { n: 2 }).commit()).ok,
          true,
          'check against the current versionstamp must commit',
        );
        assertEqual(
          (await kv.atomic().check(read).set(key, { n: 99 }).commit()).ok,
          false,
          'check against a superseded versionstamp must be refused',
        );
        assertDeepEqual((await kv.get(key)).value, { n: 2 }, 'only the winning write may land');
      },
    },
    {
      name: 'multi-key atomic commits all or nothing',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const active = [B, V, kind, 'active'];
        const hold = [B, V, kind, 'hold', 'deal1'];
        const read = await kv.get(active);
        assertEqual(
          (await kv.atomic().check(read).set(active, 'deal1').set(hold, 5).commit()).ok,
          true,
          'multi-key commit with a valid check must land',
        );
        // Stale check: neither write may land.
        assertEqual(
          (await kv.atomic().check(read).set(active, 'deal2').set([B, V, kind, 'hold', 'deal2'], 7).commit()).ok,
          false,
          'multi-key commit with a stale check must be refused',
        );
        assertEqual((await kv.get(active)).value, 'deal1', 'active key must keep the winning value');
        assertEqual((await kv.get([B, V, kind, 'hold', 'deal2'])).value, null, 'the losing deal must leave no trace');
      },
    },
    {
      // The hold protocol reads active_hold, and commits a check against what
      // it read. If a versionstamp can repeat after the row is deleted and
      // recreated, that stale check passes against a DIFFERENT deal's hold and
      // silently steals an account that is already spoken for.
      name: 'a versionstamp is never reissued after delete + recreate (ABA)',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const key = [B, V, kind, 'active_hold'];
        await kv.set(key, { deal_id: 'A' });
        const stale = await kv.get(key);
        assertNotEqual(stale.versionstamp, null, 'written key must carry a versionstamp');

        await kv.atomic().delete(key).commit();
        await kv.set(key, { deal_id: 'B' });

        const fresh = await kv.get(key);
        assertNotEqual(fresh.versionstamp, stale.versionstamp, 'delete + recreate must not reissue a versionstamp');
        assertEqual(
          (await kv.atomic().check(stale).set(key, { deal_id: 'A' }).commit()).ok,
          false,
          'a pre-delete versionstamp must never validate again',
        );
        assertDeepEqual((await kv.get(key)).value, { deal_id: 'B' }, 'the recreated value must stand');
      },
    },
    {
      name: 'values over 64 KiB are refused (Deno KV parity)',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const big = 'x'.repeat(70 * 1024);
        await assertRejects(() => kv.set([B, V, kind, 'big'], { big }), 'oversize JSON value');
        await assertRejects(
          () => kv.set([B, V, kind, 'bigbytes'], new Uint8Array(70 * 1024)),
          'oversize binary value',
        );
        // Just under the cap still stores.
        await kv.set([B, V, kind, 'ok'], { s: 'y'.repeat(60 * 1024) });
        const got = (await kv.get([B, V, kind, 'ok'])).value as { s: string } | null;
        assertEqual(got?.s.length, 60 * 1024, 'under-cap value must store in full');
      },
    },
    {
      name: 'atomic delete removes both keys',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const a = [B, V, kind, 'a'];
        const b = [B, V, kind, 'b'];
        await kv.set(a, 1);
        await kv.set(b, 2);
        assertEqual((await kv.atomic().delete(a).delete(b).commit()).ok, true, 'delete commit must succeed');
        assertEqual((await kv.get(a)).value, null, 'first key must be gone');
        assertEqual((await kv.get(b)).value, null, 'second key must be gone');
      },
    },
    {
      name: 'expireIn hides the key after expiry and frees the claim',
      run: async () => {
        const kv = await store();
        const kind = ns();
        const key = [B, V, kind, 'ttl'];
        await kv.set(key, 'soon gone', { expireIn: 1000 });
        assertEqual((await kv.get(key)).value, 'soon gone', 'key must be visible before expiry');
        await new Promise((r) => setTimeout(r, 1100));
        const after = await kv.get(key);
        assertEqual(after.value, null, 'expired key must read as absent');
        assertEqual(after.versionstamp, null, 'expired key must carry no versionstamp');
        // A null-versionstamp check must succeed against the expired key.
        assertEqual(
          (await kv.atomic().check(after).set(key, 'reclaimed').commit()).ok,
          true,
          'an expired key must be reclaimable',
        );
        assertEqual((await kv.get(key)).value, 'reclaimed', 'the reclaim write must land');
      },
    },
    {
      name: 'list returns keys under a prefix in ascending order',
      run: async () => {
        const kv = await store();
        const kind = ns();
        for (const s of ['delta', 'alpha', 'charlie', 'bravo']) {
          await kv.set([B, V, kind, s], s);
        }
        const got: unknown[] = [];
        for await (const e of kv.list({ prefix: [B, V, kind] })) {
          got.push(e.value);
        }
        assertDeepEqual(got, ['alpha', 'bravo', 'charlie', 'delta'], 'list must be ascending');
      },
    },
    {
      name: 'list scopes to deeper prefixes and exposes key parts',
      run: async () => {
        const kv = await store();
        const kind = ns();
        await kv.set([B, V, kind, 'holderA', 'v1', 'h1'], true);
        await kv.set([B, V, kind, 'holderA', 'v2', 'h2'], true);
        await kv.set([B, V, kind, 'holderB', 'v1', 'h3'], true);
        const got: unknown[] = [];
        for await (const e of kv.list({ prefix: [B, V, kind, 'holderA'] })) {
          got.push(e.key[e.key.length - 1]);
        }
        assertDeepEqual(got, ['h1', 'h2'], 'list must stay within the deeper prefix');
      },
    },
    {
      name: 'list start is an inclusive lower bound within the prefix',
      run: async () => {
        const kv = await store();
        const kind = ns();
        for (const s of ['a', 'b', 'c', 'd']) await kv.set([B, V, kind, 'auth', s], s);
        const got: unknown[] = [];
        for await (const e of kv.list(
          { prefix: [B, V, kind, 'auth'], start: [B, V, kind, 'auth', 'b'] },
          { limit: 2 },
        )) {
          got.push(e.value);
        }
        assertDeepEqual(got, ['b', 'c'], 'start must bound the scan inclusively');
      },
    },
    {
      name: 'list limit caps results',
      run: async () => {
        const kv = await store();
        const kind = ns();
        for (let i = 0; i < 5; i++) await kv.set([B, V, kind, `k${i}`], i);
        const got: unknown[] = [];
        for await (const e of kv.list({ prefix: [B, V, kind] }, { limit: 3 })) {
          got.push(e.value);
        }
        assertEqual(got.length, 3, 'limit must cap the result count');
      },
    },
    {
      name: 'three-part keys work for get/set (rate-limiter shape)',
      run: async () => {
        const kv = await store();
        const handle = ns();
        const key = [B, 'rl_keystore', handle];
        await kv.set(key, { count: 1, window: 123 }, { expireIn: 60000 });
        assertDeepEqual((await kv.get(key)).value, { count: 1, window: 123 }, 'three-part key roundtrip');
      },
    },
    {
      name: 'number key parts order numerically in lists',
      run: async () => {
        const kv = await store();
        const kind = ns();
        for (const i of [10, 2, 0, 1]) await kv.set([B, V, kind, 'h', i], i);
        const got: unknown[] = [];
        for await (const e of kv.list({ prefix: [B, V, kind, 'h'] })) got.push(e.value);
        assertDeepEqual(got, [0, 1, 2, 10], 'number key parts must order numerically, not lexically');
      },
    },
  ];
}
