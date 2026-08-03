import {
  canonicalizeWithoutSig,
  verifyBytes,
  type Base58PubKey,
  type ULID,
  ValidationError,
} from '@barter.game/protocol';
import { claimReplayId } from './db.ts';
import { registry } from './registry.ts';
import { isRpcError, RpcError } from './error.ts';
import type { Bank } from './types.ts';

export type Envelope = {
  jsonrpc: '2.0';
  id: ULID;
  method: string;
  params: Record<string, unknown>;
  pubkey: Base58PubKey;
  to: Base58PubKey;
  sig: string;
};

export async function handleRpc(
  bank: Bank,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'parse error');
  }

  const env = validateEnvelope(body);
  if (env instanceof Response) return env;

  if (env.to !== bank.pubkey) {
    return jsonRpcError(env.id, -32001, 'to mismatch');
  }

  // Verify signature over envelope minus sig.
  const signedBytes = new TextEncoder().encode(
    canonicalizeWithoutSig(body),
  );
  const hash = await crypto.subtle.digest('SHA-256', signedBytes);
  const hashBytes = new Uint8Array(hash);
  if (!verifyBytes(hashBytes, env.sig, env.pubkey)) {
    return jsonRpcError(env.id, -32001, 'invalid envelope signature');
  }

  // Replay window
  const claimed = await claimReplayId(bank, env.pubkey, env.id, env.to);
  if (!claimed) {
    return jsonRpcError(env.id, -32002, 'replay');
  }

  const handler = registry[env.method];
  if (!handler) {
    return jsonRpcError(env.id, -32601, 'method not found');
  }

  try {
    const result = await handler(bank, env.params ?? {}, env.pubkey);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: env.id, result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    if (isRpcError(e)) {
      return jsonRpcError(env.id, e.code, e.message, e.data);
    }
    // A ValidationError is the caller's fault and already carries a precise,
    // safe message ("voucher name required", "icon_svg exceeds 8192
    // characters"). Collapsing it into -32603 threw that away and told the
    // caller their well-formed-but-invalid doc was a server fault, leaving
    // them nothing to act on.
    if (e instanceof ValidationError) {
      return jsonRpcError(env.id, -32600, e.message);
    }
    console.error('RPC handler error', e);
    return jsonRpcError(env.id, -32603, 'internal error');
  }
}

function validateEnvelope(body: unknown): Envelope | Response {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcError(null, -32600, 'invalid request');
  }
  const o = body as Record<string, unknown>;
  const required = ['jsonrpc', 'id', 'method', 'params', 'pubkey', 'to', 'sig'];
  for (const f of required) {
    if (!(f in o)) {
      return jsonRpcError((o.id as string | null) ?? null, -32600, `missing ${f}`);
    }
  }
  if (o.jsonrpc !== '2.0') {
    return jsonRpcError((o.id as string | null) ?? null, -32600, 'jsonrpc must be 2.0');
  }
  if (typeof o.method !== 'string') {
    return jsonRpcError((o.id as string | null) ?? null, -32600, 'method must be string');
  }
  if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
    return jsonRpcError((o.id as string | null) ?? null, -32600, 'params must be object');
  }
  for (const f of ['id', 'pubkey', 'to', 'sig']) {
    if (typeof o[f] !== 'string') {
      return jsonRpcError((o.id as string | null) ?? null, -32600, `${f} must be string`);
    }
  }
  return o as Envelope;
}

function jsonRpcError(
  id: string | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
