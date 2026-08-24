// Contract tests for the KvStore semantics the bank depends on. The contract
// itself lives in @barter.game/bank-core/testkit (packages/bank-core/src/
// testkit.ts) so any storage backend can be verified against the same suite.
// Always runs against MemoryKv; also runs against DynamoDbKv when DDB_ENDPOINT
// is set (DynamoDB Local), creating a throwaway table there.
import { test, describe } from 'node:test';
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { MemoryKv, type KvStore } from '@barter.game/bank-core';
import { kvContractTests } from '@barter.game/bank-core/testkit';
import { DynamoDbKv } from '../src/kv-dynamo.ts';

function contract(name: string, makeStore: () => Promise<KvStore>) {
  describe(name, () => {
    for (const t of kvContractTests(makeStore)) test(t.name, t.run);
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
