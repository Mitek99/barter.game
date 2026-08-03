// Local Node host for the AWS bank build — the parity harness.
//
// Runs the exact code the Lambda runs (shared router + Node adapters) behind
// a plain node:http server so the Deno e2e suites can be pointed at it with
// E2E_BASE_URL. Storage is selected by env:
//
//   BANK_TABLE + (DDB_ENDPOINT?)        -> DynamoDbKv (DynamoDB Local or real)
//   otherwise                           -> MemoryKv
//   BANK_MEDIA_BUCKET + (S3_ENDPOINT?)  -> S3MediaStore
//   otherwise                           -> KvMediaStore over the same KV
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import {
  KvMediaStore,
  MemoryKv,
  route,
  type Bank,
  type KvStore,
  type MediaStore,
} from '@barter.game/bank-core';
import { bootBanks } from './boot.ts';
import { DynamoDbKv } from './kv-dynamo.ts';
import { S3MediaStore } from './media-s3.ts';
import { fsAssets } from './assets-fs.ts';

const env = process.env;

function makeKv(): KvStore {
  if (env.BANK_TABLE) {
    const client = new DynamoDBClient(
      env.DDB_ENDPOINT
        ? {
            endpoint: env.DDB_ENDPOINT,
            region: env.AWS_REGION ?? 'local',
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {},
    );
    console.log(`kv: DynamoDB table ${env.BANK_TABLE}` +
      (env.DDB_ENDPOINT ? ` @ ${env.DDB_ENDPOINT}` : ''));
    return new DynamoDbKv(client, env.BANK_TABLE);
  }
  console.log('kv: in-memory');
  return new MemoryKv();
}

function makeMedia(kv: KvStore): MediaStore {
  if (env.BANK_MEDIA_BUCKET) {
    const client = new S3Client(
      env.S3_ENDPOINT
        ? {
            endpoint: env.S3_ENDPOINT,
            region: env.AWS_REGION ?? 'local',
            forcePathStyle: true,
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {},
    );
    console.log(`media: S3 bucket ${env.BANK_MEDIA_BUCKET}`);
    return new S3MediaStore(client, env.BANK_MEDIA_BUCKET);
  }
  console.log('media: KV-chunked');
  return new KvMediaStore(kv);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const host = headers.get('host') ?? `localhost:${PORT}`;
  const url = `http://${host}${req.url ?? '/'}`;
  const method = (req.method ?? 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(url, {
    method,
    headers,
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

async function serve(banks: Map<string, Bank>, req: IncomingMessage, res: ServerResponse) {
  try {
    const request = await toRequest(req);
    const response = await route(request, banks);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(bytes.length > 0 ? Buffer.from(bytes) : undefined);
  } catch (e) {
    console.error('serve error', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -32603, message: 'internal error' }));
  }
}

const PORT = parseInt(env.PORT ?? '8100', 10);

async function main() {
  const kv = makeKv();
  const media = makeMedia(kv);
  const assetsDir = env.WEB_ASSETS_DIR ?? join(import.meta.dirname, '..', '..', 'web');
  const banks = await bootBanks(env, { kv, media, assets: fsAssets(assetsDir) });
  createServer((req, res) => void serve(banks, req, res)).listen(PORT, () => {
    console.log(`bank-aws local server on http://localhost:${PORT} (assets: ${assetsDir})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
