// AWS Lambda host for the shared bank engine (@barter.game/bank-core):
// DynamoDB single-table KV, S3 media vault, bundled web assets, behind a
// Lambda Function URL fronted by CloudFront.
import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { route, type Bank } from '@barter.game/bank-core';
import { bootBanks } from './boot.ts';
import { DynamoDbKv } from './kv-dynamo.ts';
import { S3MediaStore } from './media-s3.ts';
import { fsAssets } from './assets-fs.ts';
import {
  eventToRequest,
  responseToResult,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './adapter.ts';

/**
 * Bank private keys come from env vars (BANK_<NAME>_PRIV_KEY) or, when
 * BANK_KEYS_SSM_PATH is set, from SSM SecureString parameters under that
 * path — parameter "<path>/alice" becomes bank "alice". SSM keeps the keys
 * out of plaintext Lambda configuration.
 */
async function resolveEnv(): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...process.env };
  const ssmPath = env.BANK_KEYS_SSM_PATH;
  if (!ssmPath) return env;
  const ssm = new SSMClient({});
  let nextToken: string | undefined;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({
      Path: ssmPath,
      WithDecryption: true,
      NextToken: nextToken,
    }));
    for (const p of res.Parameters ?? []) {
      if (!p.Name || !p.Value) continue;
      const name = p.Name.slice(p.Name.lastIndexOf('/') + 1);
      env[`BANK_${name.toUpperCase().replace(/-/g, '_')}_PRIV_KEY`] = p.Value;
    }
    nextToken = res.NextToken;
  } while (nextToken);
  return env;
}

async function init(): Promise<Map<string, Bank>> {
  const env = await resolveEnv();
  const table = env.BANK_TABLE;
  const bucket = env.BANK_MEDIA_BUCKET;
  if (!table) throw new Error('BANK_TABLE env var is required');
  if (!bucket) throw new Error('BANK_MEDIA_BUCKET env var is required');
  const kv = new DynamoDbKv(new DynamoDBClient({}), table);
  const media = new S3MediaStore(new S3Client({}), bucket);
  const assets = fsAssets(join(import.meta.dirname, 'assets', 'web'));
  return bootBanks(env, { kv, media, assets });
}

// Cold-start init is cached; a failed init is retried on the next invocation
// instead of poisoning the container.
let banksPromise: Promise<Map<string, Bank>> | null = null;
function banks(): Promise<Map<string, Bank>> {
  banksPromise ??= init().catch((e) => {
    banksPromise = null;
    throw e;
  });
  return banksPromise;
}

/**
 * The Function URL is AuthType NONE (the protocol authenticates its own
 * writes, and OAC-signed POSTs would force every client to send
 * x-amz-content-sha256), so this header is what keeps the function reachable
 * only through CloudFront. It matters beyond defense in depth: the adapter
 * derives the request URL from x-forwarded-host, and an unpinned bank signs
 * and stores an Address doc for that host — so a caller who could reach the
 * Function URL directly could publish the bank's own signed Address at a
 * host they control. CloudFront sets the header from a template-side secret
 * and overwrites x-forwarded-host with the real viewer Host.
 */
const ORIGIN_SECRET_HEADER = 'x-origin-secret';

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const expected = process.env.ORIGIN_SECRET;
  if (expected) {
    const got = event.headers?.[ORIGIN_SECRET_HEADER]
      ?? event.headers?.[ORIGIN_SECRET_HEADER.toUpperCase()];
    if (got !== expected) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({ code: -32001, message: 'direct origin access refused' }),
        ).toString('base64'),
        isBase64Encoded: true,
      };
    }
  }
  const request = eventToRequest(event);
  const response = await route(request, await banks());
  return responseToResult(response);
}
