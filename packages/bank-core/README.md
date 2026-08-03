# @barter.game/bank-core — the shared bank engine

Everything a barter.game v1 bank does, independent of where it runs: HTTP
routing ([`src/router.ts`](./src/router.ts)), the signed JSON-RPC surface
([`src/rpc.ts`](./src/rpc.ts), [`src/registry.ts`](./src/registry.ts),
[`src/handlers/`](./src/handlers/)), the deal advance engine
([`src/advance.ts`](./src/advance.ts)), peer calls ([`src/peer.ts`](./src/peer.ts)),
the `/ui/*` custom API + Barter Links + media vault ([`src/ui.ts`](./src/ui.ts)),
and the storage layer ([`src/db.ts`](./src/db.ts)).

Like [`@barter.game/protocol`](../protocol/), this package is consumed as
TypeScript source — no build step. It is written against **web-standard APIs
only** (Request/Response, fetch, crypto.subtle, TextEncoder); no Deno, Node,
or DOM globals. That is what lets the same engine serve:

- [`apps/bank`](../../apps/bank/) — Deno Deploy / a single Deno process
- [`apps/bank-aws`](../../apps/bank-aws/) — AWS Lambda behind CloudFront

## The seams

A host wires three small interfaces into `createBank()` and forwards each
incoming `Request` to `route(request, banks)`:

| Interface | Contract | Deno host | AWS host |
|---|---|---|---|
| `KvStore` ([`src/kv.ts`](./src/kv.ts)) | The exact subset of Deno KV the bank uses: `get`/`set(expireIn?)`/`list(prefix, start?, limit?)`/`atomic().check().set().delete().commit()` with versionstamp optimistic concurrency | `Deno.openKv()` as-is | DynamoDB single table (conditional writes + `TransactWriteItems`, TTL attribute) |
| `MediaStore` ([`src/media.ts`](./src/media.ts)) | Content-addressed immutable blobs, namespaced by bank pubkey | `KvMediaStore` (48 KiB KV chunks) | S3 objects |
| `AssetReader` ([`src/types.ts`](./src/types.ts)) | Read-only access to the bundled [`apps/web`](../../apps/web/) client | `Deno.readFile` | bundled files / S3 |

`MemoryKv` (in [`src/kv.ts`](./src/kv.ts)) is a faithful in-memory `KvStore`
for tests and local runs; `apps/bank-aws/test/kv-contract.test.ts` holds the
contract suite every implementation must pass.

Storage-semantics rules an implementation must honor (the ledger depends on
them): versionstamp checks are the only concurrency control; all ops in one
`atomic()` commit together or not at all; an expired `expireIn` key must read
as absent; `list` iterates in ascending component order and excludes the
exact prefix key.

## Invariants

The regression net is the nine e2e suites in
[`apps/bank/e2e-*.ts`](../../apps/bank/README.md) — wire-protocol clients
that run unchanged against any host. Cross-runtime hash/signature parity is
pinned by [`../protocol`](../protocol/)'s golden vectors; both live
deployments must agree byte-for-byte on canonical JSON or they will
split-brain on the same deal.
