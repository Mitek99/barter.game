// Runtime-agnostic bank engine, shared by the Deno Deploy deployment
// (apps/bank) and the AWS Lambda deployment (apps/bank-aws). Hosts wire in a
// KvStore, a MediaStore, and an AssetReader, then forward Requests to route().
export { route, ensureBankAddress } from './router.ts';
export { loadBankKeys, createBank, type LoadedBank, type BankDeps } from './env.ts';
export { registerLocalBank, getLocalBank } from './local.ts';
export { handleRpc, type Envelope } from './rpc.ts';
export { registry, type Handler } from './registry.ts';
export { RpcError, isRpcError } from './error.ts';
export type { Bank, RpcContext, JsonRpcError, AssetReader } from './types.ts';
export {
  MemoryKv,
  packKey,
  assertValueSize,
  MAX_KV_VALUE_BYTES,
  type KvStore,
  type KvKey,
  type KvKeyPart,
  type KvEntry,
  type KvListSelector,
  type KvAtomic,
} from './kv.ts';
export {
  KvMediaStore,
  sha256Base58Bytes,
  MEDIA_MAX_BYTES,
  type MediaStore,
  type MediaMeta,
} from './media.ts';
