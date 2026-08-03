# apps/bank-aws — AWS serverless bank host

The same bank engine as [`apps/bank`](../bank/README.md)
([`@barter.game/bank-core`](../../packages/bank-core/README.md)), hosted on
AWS instead of Deno Deploy:

```
viewer ──> CloudFront ──┬── */ui/app/*  ──> S3 (webapp/ prefix, OAC)
                        ├── */media/*   ──> Lambda (edge-cached: immutable blobs)
                        └── everything  ──> Lambda Function URL
                                             ├── DynamoDB single table  (ledger, docs, indexes)
                                             └── S3                     (media blobs, media/ prefix)
```

- **One Lambda serves every configured bank** (path-scoped, exactly like the
  Deno host), so co-located banks still settle in-process.
- **DynamoDB single-table**: logical KV key `[bankPubkey, v2, kind, ...rest]`
  → `pk` = first three parts, `sk` = the rest; conditional writes /
  `TransactWriteItems` implement the optimistic-concurrency contract;
  the `exp` TTL attribute implements the 24 h replay window. See
  [`src/kv-dynamo.ts`](./src/kv-dynamo.ts).
- **S3** holds media blobs (`media/<bankPubkey>/<hash>`, written by the
  Lambda) and the static web client (`webapp/*`, synced by
  [`deploy.sh`](./deploy.sh), served via CloudFront OAC).
- Bank keys come from **SSM SecureString** parameters under
  `/barter/banks/<name>` (or plain `BANK_<NAME>_PRIV_KEY` env vars).
- The Function URL uses `AuthType: NONE` because the protocol authenticates
  every write itself (signed envelopes / `X-Barter-Auth`) and CloudFront
  OAC-signed POSTs would force clients to send `x-amz-content-sha256`.
  CloudFront injects `x-forwarded-host` so the bank self-describes under its
  public domain.

## Local development

```bash
bun install
bun run local          # Node server on :8100, in-memory KV, KV-chunked media
```

Point the wire-level e2e suites (pure HTTP clients) at it:

```bash
E2E_BASE_URL=http://localhost:8100 deno run --allow-net --allow-env apps/bank/e2e-crossbank.ts
```

Against DynamoDB Local (`docker run -p 8200:8000 amazon/dynamodb-local`):

```bash
aws dynamodb create-table --endpoint-url http://localhost:8200 \
  --table-name barter-local --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE
BANK_TABLE=barter-local DDB_ENDPOINT=http://localhost:8200 bun run local
```

## Tests

```bash
bun run test                                  # KvStore contract vs MemoryKv
DDB_ENDPOINT=http://localhost:8200 bun run test   # + contract vs DynamoDB Local
```

Two contract cases exist because the storage swap can break them silently and
nothing else would notice: **a versionstamp must never repeat after a key is
deleted and recreated** (hold exclusivity is a compare-and-set against a
value read earlier; a counter that restarts at 1 lets a stale check steal an
account that another deal already holds), and **values above 64 KiB must be
refused** (Deno KV's limit — DynamoDB would take far more, and a doc that
writes on one deployment but not the other splits the federation).

To prove the two hosts really are interchangeable, run one bank per runtime
and settle between them over HTTP — single-bank processes, so the co-located
in-process shortcut cannot hide a wire bug:

```bash
BANK_ALICE_PRIV_KEY=<key> BANK_ALICE_URL=http://localhost:8400/alice PORT=8400 \
  deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv apps/bank/main.ts &
BANK_BOB_PRIV_KEY=<key> BANK_BOB_URL=http://localhost:8500/bob \
  BANK_TABLE=barter-local DDB_ENDPOINT=http://localhost:8200 PORT=8500 bun run local &

E2E_BANK_A_URL=http://localhost:8400/alice E2E_BANK_B_URL=http://localhost:8500/bob \
  deno run --allow-net --allow-env apps/bank/e2e-crossbank.ts
```

## Deploy

```bash
# once per account: bank keys into SSM
aws ssm put-parameter --type SecureString --name /barter/banks/alice --value <base58-priv-key>

bun run build          # esbuild bundle -> dist/ (+ web client into dist/assets)
sam deploy --guided    # first time; afterwards: ./deploy.sh
```

[`deploy.sh`](./deploy.sh) = build + `sam deploy` + `aws s3 sync` of the web
client into `webapp/` + CloudFront invalidation. The stack outputs the
CloudFront domain; banks live at `https://<domain>/<bank>/…` with the UI at
`/​<bank>/ui`.

The Deno Deploy deployment stays alive alongside this one; both run the same
engine and the same e2e suites, and they federate with each other like any
two banks.
