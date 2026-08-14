import {
  canonicalizeWithoutSig,
  newUlid,
  signDoc,
  signBytes,
  verifyDoc,
  type Base58PubKey,
} from '@barter.game/protocol';
import type { Bank } from './types.ts';
import { getLocalBank } from './local.ts';
import { isRpcError } from './error.ts';

/**
 * Peer calls happen inside a request the client is waiting on, and a deal
 * can fan out to several banks in sequence. An unresponsive peer must fail
 * fast rather than hold the whole request open until the host's own deadline
 * (a Lambda timeout, or CloudFront's 60s origin read) turns it into an
 * opaque gateway error instead of the bank's own JSON.
 */
const PEER_TIMEOUT_MS = 15_000;

export async function fetchDiscovery(
  url: string,
  expectedPubkey?: Base58PubKey,
): Promise<{ pubkey: Base58PubKey; url: string; name: string; protocol_version: string } | null> {
  // Co-located bank: answer from memory. A serverless isolate may not be
  // able to fetch its own deployment URL (Deno Deploy answered 508 Loop
  // Detected), so HTTP discovery of a same-process bank is not reliable.
  if (expectedPubkey) {
    const local = getLocalBank(expectedPubkey);
    if (local) {
      return {
        pubkey: local.pubkey,
        url: local.url,
        name: local.name,
        protocol_version: 'barter.game/v1',
      };
    }
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/barter-bank.json`, {
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json() as Record<string, unknown>;
    if (
      typeof j.pubkey === 'string' &&
      typeof j.url === 'string' &&
      typeof j.name === 'string' &&
      typeof j.protocol_version === 'string'
    ) {
      return j as { pubkey: string; url: string; name: string; protocol_version: string };
    }
    return null;
  } catch {
    return null;
  }
}

export async function bankRpcCall(
  bank: Bank,
  targetUrl: string,
  targetPubkey: Base58PubKey,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // Co-located target: dispatch in-process — skips needless network/crypto
  // round-trips and any self-fetch restrictions of the host platform. The
  // sender identity matches the HTTP path (this bank's pubkey).
  const local = getLocalBank(targetPubkey);
  if (local) {
    const { registry } = await import('./registry.ts');
    const handler = registry[method];
    if (!handler) {
      return { jsonrpc: '2.0', id: newUlid(), error: { code: -32601, message: 'method not found' } };
    }
    try {
      const result = await handler(local, params, bank.pubkey);
      return { jsonrpc: '2.0', id: newUlid(), result };
    } catch (e) {
      if (isRpcError(e)) {
        return { jsonrpc: '2.0', id: newUlid(), error: { code: e.code, message: e.message, data: e.data } };
      }
      console.error('in-process RPC error', method, e);
      return { jsonrpc: '2.0', id: newUlid(), error: { code: -32603, message: 'internal error' } };
    }
  }
  const envelope = {
    jsonrpc: '2.0' as const,
    id: newUlid(),
    method,
    params,
    pubkey: bank.pubkey,
    to: targetPubkey,
    sig: '',
  };
  envelope.sig = signDoc(envelope, bank.privateKey);
  const res = await fetch(`${targetUrl.replace(/\/$/, '')}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: -32014, message: 'upstream non-json', raw: text } };
  }
}

export { signBytes, verifyDoc };
