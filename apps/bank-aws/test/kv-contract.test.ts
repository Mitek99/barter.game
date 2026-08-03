// Contract tests for the KvStore semantics the bank depends on (see
// packages/bank-core/src/kv.ts). Always runs against MemoryKv; also runs
// against DynamoDbKv when DDB_ENDPOINT is set (DynamoDB Local), creating a
// throwaway table there.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { MemoryKv, type KvStore } from '@barter.game/bank-core';
import { DynamoDbKv } from '../src/kv-dynamo.ts';

const B = 'BankPubkeyForTests';
const V = 'v2';

function contract(name: string, makeStore: () => Promise<KvStore>) {
  describe(name, () => {
    let kv: KvStore;
    let n = 0;
    // Namespace every test's keys so runs are isolated on a shared table.
    const ns = () => `k${Date.now().toString(36)}${(n++).toString(36)}`;

    before(async () => {
      kv = await makeStore();
    });

    test('get of a missing key', async () => {
      const r = await kv.get([B, V, ns(), 'nope']);
      assert.equal(r.value, null);
      assert.equal(r.versionstamp, null);
    });

    test('set/get roundtrip for JSON values', async () => {
      const kind = ns();
      await kv.set([B, V, kind, 'a'], { x: 1, s: 'str', arr: [1, 2] });
      await kv.set([B, V, kind, 'b'], true);
      await kv.set([B, V, kind, 'c'], 42);
      assert.deepEqual((await kv.get([B, V, kind, 'a'])).value, { x: 1, s: 'str', arr: [1, 2] });
      assert.equal((await kv.get([B, V, kind, 'b'])).value, true);
      assert.equal((await kv.get([B, V, kind, 'c'])).value, 42);
    });

    test('set/get roundtrip for Uint8Array values with number key parts', async () => {
      const kind = ns();
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await kv.set([B, V, kind, 'hash', 0], bytes);
      const r = await kv.get<Uint8Array>([B, V, kind, 'hash', 0]);
      assert.ok(r.value instanceof Uint8Array);
      assert.deepEqual([...r.value!], [...bytes]);
    });

    test('versionstamp changes on every write', async () => {
      const kind = ns();
      await kv.set([B, V, kind, 'k'], 1);
      const v1 = (await kv.get([B, V, kind, 'k'])).versionstamp;
      await kv.set([B, V, kind, 'k'], 2);
      const v2 = (await kv.get([B, V, kind, 'k'])).versionstamp;
      assert.ok(v1 !== null && v2 !== null && v1 !== v2);
    });

    test('atomic claim of an absent key succeeds once', async () => {
      const kind = ns();
      const key = [B, V, kind, 'claim'];
      const first = await kv.get(key);
      assert.equal(
        (await kv.atomic().check(first).set(key, 'mine').commit()).ok,
        true,
      );
      // Same stale check again: must fail now.
      assert.equal(
        (await kv.atomic().check(first).set(key, 'stolen').commit()).ok,
        false,
      );
      assert.equal((await kv.get(key)).value, 'mine');
    });

    test('atomic with a matching versionstamp commits, stale fails', async () => {
      const kind = ns();
      const key = [B, V, kind, 'cas'];
      await kv.set(key, { n: 1 });
      const read = await kv.get(key);
      assert.equal(
        (await kv.atomic().check(read).set(key, { n: 2 }).commit()).ok,
        true,
      );
      assert.equal(
        (await kv.atomic().check(read).set(key, { n: 99 }).commit()).ok,
        false,
      );
      assert.deepEqual((await kv.get(key)).value, { n: 2 });
    });

    test('multi-key atomic commits all or nothing', async () => {
      const kind = ns();
      const active = [B, V, kind, 'active'];
      const hold = [B, V, kind, 'hold', 'deal1'];
      const read = await kv.get(active);
      assert.equal(
        (await kv.atomic().check(read).set(active, 'deal1').set(hold, 5).commit()).ok,
        true,
      );
      // Stale check: neither write may land.
      assert.equal(
        (await kv.atomic().check(read).set(active, 'deal2').set([B, V, kind, 'hold', 'deal2'], 7).commit()).ok,
        false,
      );
      assert.equal((await kv.get(active)).value, 'deal1');
      assert.equal((await kv.get([B, V, kind, 'hold', 'deal2'])).value, null);
    });

    // The hold protocol reads active_hold, and commits a check against what
    // it read. If a versionstamp can repeat after the row is deleted and
    // recreated, that stale check passes against a DIFFERENT deal's hold and
    // silently steals an account that is already spoken for.
    test('a versionstamp is never reissued after delete + recreate (ABA)', async () => {
      const kind = ns();
      const key = [B, V, kind, 'active_hold'];
      await kv.set(key, { deal_id: 'A' });
      const stale = await kv.get(key);
      assert.notEqual(stale.versionstamp, null);

      await kv.atomic().delete(key).commit();
      await kv.set(key, { deal_id: 'B' });

      const fresh = await kv.get(key);
      assert.notEqual(fresh.versionstamp, stale.versionstamp);
      assert.equal(
        (await kv.atomic().check(stale).set(key, { deal_id: 'A' }).commit()).ok,
        false,
      );
      assert.deepEqual((await kv.get(key)).value, { deal_id: 'B' });
    });

    test('values over 64 KiB are refused (Deno KV parity)', async () => {
      const kind = ns();
      const big = 'x'.repeat(70 * 1024);
      await assert.rejects(() => kv.set([B, V, kind, 'big'], { big }));
      await assert.rejects(() =>
        kv.set([B, V, kind, 'bigbytes'], new Uint8Array(70 * 1024)));
      // Just under the cap still stores.
      await kv.set([B, V, kind, 'ok'], { s: 'y'.repeat(60 * 1024) });
      assert.equal(((await kv.get([B, V, kind, 'ok'])).value as { s: string }).s.length, 60 * 1024);
    });

    test('atomic delete removes both keys', async () => {
      const kind = ns();
      const a = [B, V, kind, 'a'];
      const b = [B, V, kind, 'b'];
      await kv.set(a, 1);
      await kv.set(b, 2);
      assert.equal((await kv.atomic().delete(a).delete(b).commit()).ok, true);
      assert.equal((await kv.get(a)).value, null);
      assert.equal((await kv.get(b)).value, null);
    });

    test('expireIn hides the key after expiry and frees the claim', async () => {
      const kind = ns();
      const key = [B, V, kind, 'ttl'];
      await kv.set(key, 'soon gone', { expireIn: 1000 });
      assert.equal((await kv.get(key)).value, 'soon gone');
      await new Promise((r) => setTimeout(r, 1100));
      const after = await kv.get(key);
      assert.equal(after.value, null);
      assert.equal(after.versionstamp, null);
      // A null-versionstamp check must succeed against the expired key.
      assert.equal(
        (await kv.atomic().check(after).set(key, 'reclaimed').commit()).ok,
        true,
      );
      assert.equal((await kv.get(key)).value, 'reclaimed');
    });

    test('list returns keys under a prefix in ascending order', async () => {
      const kind = ns();
      for (const s of ['delta', 'alpha', 'charlie', 'bravo']) {
        await kv.set([B, V, kind, s], s);
      }
      const got: unknown[] = [];
      for await (const e of kv.list({ prefix: [B, V, kind] })) {
        got.push(e.value);
      }
      assert.deepEqual(got, ['alpha', 'bravo', 'charlie', 'delta']);
    });

    test('list scopes to deeper prefixes and exposes key parts', async () => {
      const kind = ns();
      await kv.set([B, V, kind, 'holderA', 'v1', 'h1'], true);
      await kv.set([B, V, kind, 'holderA', 'v2', 'h2'], true);
      await kv.set([B, V, kind, 'holderB', 'v1', 'h3'], true);
      const got: string[] = [];
      for await (const e of kv.list({ prefix: [B, V, kind, 'holderA'] })) {
        got.push(e.key[e.key.length - 1] as string);
      }
      assert.deepEqual(got, ['h1', 'h2']);
    });

    test('list start is an inclusive lower bound within the prefix', async () => {
      const kind = ns();
      for (const s of ['a', 'b', 'c', 'd']) await kv.set([B, V, kind, 'auth', s], s);
      const got: unknown[] = [];
      for await (const e of kv.list(
        { prefix: [B, V, kind, 'auth'], start: [B, V, kind, 'auth', 'b'] },
        { limit: 2 },
      )) {
        got.push(e.value);
      }
      assert.deepEqual(got, ['b', 'c']);
    });

    test('list limit caps results', async () => {
      const kind = ns();
      for (let i = 0; i < 5; i++) await kv.set([B, V, kind, `k${i}`], i);
      const got: unknown[] = [];
      for await (const e of kv.list({ prefix: [B, V, kind] }, { limit: 3 })) {
        got.push(e.value);
      }
      assert.equal(got.length, 3);
    });

    test('three-part keys work for get/set (rate-limiter shape)', async () => {
      const handle = ns();
      const key = [B, 'rl_keystore', handle];
      await kv.set(key, { count: 1, window: 123 }, { expireIn: 60000 });
      assert.deepEqual((await kv.get(key)).value, { count: 1, window: 123 });
    });

    test('number key parts order numerically in lists', async () => {
      const kind = ns();
      for (const i of [10, 2, 0, 1]) await kv.set([B, V, kind, 'h', i], i);
      const got: unknown[] = [];
      for await (const e of kv.list({ prefix: [B, V, kind, 'h'] })) got.push(e.value);
      assert.deepEqual(got, [0, 1, 2, 10]);
    });
  });
}

contract('MemoryKv', async () => new MemoryKv());

if (process.env.DDB_ENDPOINT) {
  contract('DynamoDbKv (DynamoDB Local)', async () => {
    const client = new DynamoDBClient({
      endpoint: process.env.DDB_ENDPOINT,
      region: 'local',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    const table = process.env.BANK_TABLE ?? 'barter-kv-contract-test';
    try {
      await client.send(new CreateTableCommand({
        TableName: table,
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }));
    } catch (e) {
      if (!(e instanceof ResourceInUseException)) throw e;
    }
    return new DynamoDbKv(client, table);
  });
} else {
  test('DynamoDbKv contract (skipped — set DDB_ENDPOINT to run against DynamoDB Local)', { skip: true }, () => {});
}
