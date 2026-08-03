import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { assertValueSize } from '@barter.game/bank-core';
import type {
  KvAtomic,
  KvEntry,
  KvKey,
  KvKeyPart,
  KvListSelector,
  KvStore,
} from '@barter.game/bank-core';

/**
 * KvStore over one DynamoDB table — the single-table design.
 *
 * Every logical KV key is [bankPubkey, schemaVersion, kind, ...rest] (plus a
 * couple of [bankPubkey, kind, rest] utility keys), so the first three parts
 * become the partition key and the rest the sort key:
 *
 *   pk = pack(key[0..2])         e.g. "s:4RYn… s:v2 s:holder_account"
 *   sk = pack(key[3..])          e.g. "s:9W3v… s:Ff2a…"   ("~" when empty)
 *
 * Parts are type-tagged ("s:"/zero-padded "n:") and joined with a space,
 * which sorts below every character that appears in a part (base58,
 * Crockford base32, [a-z0-9-] handles) — so lexicographic order of the
 * packed sort key equals component-wise order of the logical key, and every
 * prefix scan the bank does stays a single Query.
 *
 * Item attributes:
 *   v   (S)  JSON-encoded value            (exactly one of v / vb)
 *   vb  (B)  raw bytes for Uint8Array values
 *   ver (S)  the KvStore versionstamp: a fresh random token per write. It
 *            must never repeat for a key, INCLUDING across delete/recreate —
 *            a per-item counter would restart at 1 and let a check() from
 *            before the delete pass against a newer generation (ABA), which
 *            is exactly how hold exclusivity is enforced.
 *   exp (N)  epoch-seconds TTL (DynamoDB TTL attribute). DynamoDB expiry is
 *            lazy, so every read ALSO filters expired items to match Deno
 *            KV's strict expireIn semantics.
 *
 * Atomicity: single-item writes use conditional UpdateItem; multi-item
 * commits use TransactWriteItems, folding a check on a written key into the
 * write's own ConditionExpression (DynamoDB forbids two operations on one
 * item in a transaction).
 */

const EMPTY_SK = '~';
// One packed character sorts above everything a key part can contain, making
// prefix + UPPER_BOUND an inclusive upper bound for BETWEEN range scans.
const UPPER_BOUND = ' ￿';

function packPart(p: KvKeyPart): string {
  return typeof p === 'number' ? `n:${String(p).padStart(15, '0')}` : `s:${p}`;
}

function unpackPart(s: string): KvKeyPart {
  return s.startsWith('n:') ? Number(s.slice(2)) : s.slice(2);
}

export function toPkSk(key: KvKey): { pk: string; sk: string } {
  if (key.length < 3) throw new Error(`kv key too short: ${JSON.stringify(key)}`);
  return {
    pk: key.slice(0, 3).map(packPart).join(' '),
    sk: key.length === 3 ? EMPTY_SK : key.slice(3).map(packPart).join(' '),
  };
}

export function fromPkSk(pk: string, sk: string): KvKeyPart[] {
  const parts = pk.split(' ').map(unpackPart);
  if (sk !== EMPTY_SK) parts.push(...sk.split(' ').map(unpackPart));
  return parts;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function expAttr(expireIn: number | undefined): AttributeValue | null {
  if (expireIn === undefined) return null;
  // Ceil so a short expireIn never rounds down to "already expired".
  return { N: String(nowSeconds() + Math.ceil(expireIn / 1000)) };
}

function isLive(item: Record<string, AttributeValue>): boolean {
  const exp = item.exp?.N;
  return exp === undefined || Number(exp) > nowSeconds();
}

// DynamoDB would take anything up to its ~400 KB item cap, but the shared
// contract caps values at Deno KV's 64 KiB so both deployments accept
// exactly the same writes.
function encodeValue(value: unknown): { v?: AttributeValue; vb?: AttributeValue } {
  assertValueSize(value);
  if (value instanceof Uint8Array) return { vb: { B: value } };
  return { v: { S: JSON.stringify(value) } };
}

function decodeValue(item: Record<string, AttributeValue>): unknown {
  if (item.vb?.B) return new Uint8Array(item.vb.B);
  return item.v?.S === undefined ? null : JSON.parse(item.v.S);
}

type PendingSet = { op: 'set'; key: KvKey; value: unknown; expireIn?: number };
type PendingDelete = { op: 'delete'; key: KvKey };
type PendingCheck = { key: KvKey; versionstamp: string | null };

export class DynamoDbKv implements KvStore {
  constructor(
    private client: DynamoDBClient,
    private table: string,
  ) {}

  async get<T>(key: KvKey): Promise<KvEntry<T>> {
    const { pk, sk } = toPkSk(key);
    const res = await this.client.send(new GetItemCommand({
      TableName: this.table,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    }));
    const item = res.Item;
    if (!item || !isLive(item)) {
      return { key: [...key], value: null, versionstamp: null };
    }
    return {
      key: [...key],
      value: decodeValue(item) as T,
      versionstamp: item.ver?.S ?? null,
    };
  }

  async set(key: KvKey, value: unknown, opts?: { expireIn?: number }): Promise<unknown> {
    await this.client.send(new UpdateItemCommand(
      this.updateSpec({ op: 'set', key, value, expireIn: opts?.expireIn }),
    ));
    return { ok: true };
  }

  private updateSpec(
    p: PendingSet,
    check?: PendingCheck,
  ) {
    const { pk, sk } = toPkSk(p.key);
    const enc = encodeValue(p.value);
    const exp = expAttr(p.expireIn);
    // Attribute names go through aliases so none can collide with DynamoDB's
    // reserved-word list.
    const names: Record<string, string> = {
      '#v': 'v', '#vb': 'vb', '#ver': 'ver', '#exp': 'exp',
    };
    const sets = ['#ver = :vernew'];
    const removes: string[] = [];
    const values: Record<string, AttributeValue> = {
      ':vernew': { S: randomUUID() },
    };
    if (enc.v) {
      sets.push('#v = :v');
      removes.push('#vb');
      values[':v'] = enc.v;
    } else {
      sets.push('#vb = :vb');
      removes.push('#v');
      values[':vb'] = enc.vb!;
    }
    if (exp) {
      sets.push('#exp = :exp');
      values[':exp'] = exp;
    } else {
      removes.push('#exp');
    }
    const spec: {
      TableName: string;
      Key: Record<string, AttributeValue>;
      UpdateExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, AttributeValue>;
      ConditionExpression?: string;
    } = {
      TableName: this.table,
      Key: { pk: { S: pk }, sk: { S: sk } },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
    if (check) {
      spec.ConditionExpression = this.checkCondition(check, values, names);
    }
    return spec;
  }

  /**
   * ConditionExpression for a versionstamp check. `null` means "absent when
   * read" — which a lazily-expired item also satisfies. Fills `values` and
   * `names` with exactly the placeholders the expression uses (DynamoDB
   * rejects unused entries in either map).
   */
  private checkCondition(
    check: PendingCheck,
    values: Record<string, AttributeValue>,
    names: Record<string, string>,
  ): string {
    if (check.versionstamp === null) {
      values[':now'] = { N: String(nowSeconds()) };
      names['#pk'] = 'pk';
      names['#exp'] = 'exp';
      return '(attribute_not_exists(#pk) OR (attribute_exists(#exp) AND #exp <= :now))';
    }
    values[':ver'] = { S: check.versionstamp };
    names['#ver'] = 'ver';
    return '#ver = :ver';
  }

  async *list<T>(
    selector: KvListSelector,
    opts?: { limit?: number },
  ): AsyncIterable<{ key: readonly unknown[]; value: T }> {
    const prefix = selector.prefix;
    if (prefix.length < 3) {
      throw new Error(`kv list prefix too short: ${JSON.stringify(prefix)}`);
    }
    const pk = prefix.slice(0, 3).map(packPart).join(' ');
    const prefixRest = prefix.slice(3).map(packPart).join(' ');
    const startRest = selector.start
      ? selector.start.slice(3).map(packPart).join(' ')
      : null;

    let keyCond = '#pk = :pk';
    const names: Record<string, string> = { '#pk': 'pk' };
    const values: Record<string, AttributeValue> = { ':pk': { S: pk } };
    if (startRest !== null && prefixRest) {
      keyCond += ' AND #sk BETWEEN :start AND :upper';
      names['#sk'] = 'sk';
      values[':start'] = { S: startRest };
      values[':upper'] = { S: prefixRest + UPPER_BOUND };
    } else if (startRest !== null) {
      keyCond += ' AND #sk >= :start';
      names['#sk'] = 'sk';
      values[':start'] = { S: startRest };
    } else if (prefixRest) {
      keyCond += ' AND begins_with(#sk, :pre)';
      names['#sk'] = 'sk';
      values[':pre'] = { S: prefixRest + ' ' };
    }

    const limit = opts?.limit ?? Infinity;
    let yielded = 0;
    let startKey: Record<string, AttributeValue> | undefined;
    while (yielded < limit) {
      const res = await this.client.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: keyCond,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
        ...(limit !== Infinity ? { Limit: limit - yielded + 8 } : {}),
      }));
      for (const item of res.Items ?? []) {
        if (!isLive(item)) continue;
        yield {
          key: fromPkSk(item.pk!.S!, item.sk!.S!),
          value: decodeValue(item) as T,
        };
        if (++yielded >= limit) return;
      }
      startKey = res.LastEvaluatedKey;
      if (!startKey) return;
    }
  }

  atomic(): KvAtomic {
    const checks: PendingCheck[] = [];
    const ops: (PendingSet | PendingDelete)[] = [];
    const store = this;
    const atomic: KvAtomic = {
      check(entry) {
        checks.push({
          key: entry.key as KvKey,
          versionstamp: entry.versionstamp,
        });
        return atomic;
      },
      set(key, value, opts) {
        ops.push({ op: 'set', key, value, expireIn: opts?.expireIn });
        return atomic;
      },
      delete(key) {
        ops.push({ op: 'delete', key });
        return atomic;
      },
      async commit() {
        return store.commit(checks, ops);
      },
    };
    return atomic;
  }

  private async commit(
    checks: PendingCheck[],
    ops: (PendingSet | PendingDelete)[],
  ): Promise<{ ok: boolean }> {
    const skOf = (key: KvKey) => {
      const { pk, sk } = toPkSk(key);
      return `${pk}\n${sk}`;
    };
    // Fold each check into the op that writes the same item, if any.
    const opByItem = new Map<string, PendingSet | PendingDelete>();
    for (const op of ops) opByItem.set(skOf(op.key), op);
    const folded = new Map<string, PendingCheck>();
    const standalone: PendingCheck[] = [];
    for (const c of checks) {
      const id = skOf(c.key);
      if (opByItem.has(id)) folded.set(id, c);
      else standalone.push(c);
    }

    try {
      // Fast path: one write, no standalone checks — a plain conditional call.
      if (ops.length === 1 && standalone.length === 0) {
        const op = ops[0]!;
        const check = folded.get(skOf(op.key));
        if (op.op === 'set') {
          await this.client.send(new UpdateItemCommand(this.updateSpec(op, check)));
        } else {
          await this.client.send(new DeleteItemCommand(this.deleteSpec(op, check)));
        }
        return { ok: true };
      }

      const items: TransactWriteItem[] = [];
      for (const c of standalone) {
        const { pk, sk } = toPkSk(c.key);
        const values: Record<string, AttributeValue> = {};
        const names: Record<string, string> = {};
        const cond = this.checkCondition(c, values, names);
        items.push({
          ConditionCheck: {
            TableName: this.table,
            Key: { pk: { S: pk }, sk: { S: sk } },
            ConditionExpression: cond,
            ExpressionAttributeNames: names,
            ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          },
        });
      }
      for (const op of ops) {
        const check = folded.get(skOf(op.key));
        if (op.op === 'set') {
          items.push({ Update: this.updateSpec(op, check) });
        } else {
          items.push({ Delete: this.deleteSpec(op, check) });
        }
      }
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return { ok: true };
    } catch (e) {
      // ok:false means "a check failed" and nothing else — callers act on it
      // as a definitive business outcome (releaseHold ignores it, acquireHold
      // reads it as "held by another deal"). DynamoDB also cancels
      // transactions for transient reasons (TransactionConflict, throttling),
      // and the SDK does not retry TransactWriteItems for them, so those must
      // surface as errors instead of being laundered into a verdict.
      if (e instanceof ConditionalCheckFailedException) return { ok: false };
      if (e instanceof TransactionCanceledException) {
        const reasons = e.CancellationReasons ?? [];
        const onlyChecks = reasons.length > 0 && reasons.every(
          (r) => r.Code === 'ConditionalCheckFailed' || r.Code === 'None',
        );
        if (onlyChecks) return { ok: false };
      }
      throw e;
    }
  }

  private deleteSpec(p: PendingDelete, check?: PendingCheck) {
    const { pk, sk } = toPkSk(p.key);
    const values: Record<string, AttributeValue> = {};
    const spec: {
      TableName: string;
      Key: Record<string, AttributeValue>;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, AttributeValue>;
    } = {
      TableName: this.table,
      Key: { pk: { S: pk }, sk: { S: sk } },
    };
    if (check) {
      const names: Record<string, string> = {};
      spec.ConditionExpression = this.checkCondition(check, values, names);
      spec.ExpressionAttributeNames = names;
      if (Object.keys(values).length) spec.ExpressionAttributeValues = values;
    }
    return spec;
  }
}
