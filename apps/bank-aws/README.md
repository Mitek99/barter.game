# apps/bank-aws — the bank host

The barter.game bank: the shared engine
([`@barter.game/bank-core`](../../packages/bank-core/README.md)) hosted on
AWS — Lambda + DynamoDB + S3 behind CloudFront. This is the only bank host in
the repo; the live demo banks run on it:

```
viewer ──> CloudFront ──┬── */ui/app/*  ──> S3 (webapp/ prefix, OAC)
                        ├── */media/*   ──> Lambda (edge-cached: immutable blobs)
                        └── everything  ──> Lambda Function URL
                                             ├── DynamoDB single table  (ledger, docs, indexes)
                                             └── S3                     (media blobs, media/ prefix)
```

- **One Lambda serves every configured bank** (path-scoped by bank name), so
  co-located banks settle in-process.
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

Point the wire-level e2e suites (pure HTTP clients, run under Bun from the
repo root) at it. Ten suites in [`e2e/`](./e2e/): `local`, `cheque-local`,
`crossbank`, `sameswap`, `reject`, `replay`, `forged-sigs`, `account-privacy`,
`posts`, `federation`.

```bash
E2E_BASE_URL=http://localhost:8100 bun run apps/bank-aws/e2e/e2e-crossbank.ts
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
refused** (the `KvStore` contract caps every value at 64 KiB — DynamoDB would
take far more, and a doc that writes on one deployment but not another splits
the federation).

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

### Deploying as `app-deployer` (least privilege)

Deploys run as the `app-deployer` IAM user, not an admin. Its permissions are
defined in [`deployer-template.yaml`](./deployer-template.yaml) (stack
`barter-deployer`), which creates two managed policies:

- **`AppDeployerBoundary`** — a permissions boundary that caps any role the
  deployer creates to exactly what the bank's Lambda execution role needs
  (DynamoDB CRUD on `barter-*` tables, S3 on `barter-*` buckets, SSM reads
  under `/barter/*`, logs for `/aws/lambda/barter-*`).
- **`AppDeployerPolicy`** — the deploy policy: CloudFormation/Lambda/
  DynamoDB/S3/CloudFront scoped to `barter-*` resources, plus IAM role admin
  on `barter-*` roles **conditioned on the boundary**
  (`iam:PermissionsBoundary`), so every role the deployer creates — including
  the SAM-generated `BankFunctionRole` — must wear the boundary. No ec2, no
  bedrock, no user/policy authoring.

`template.yaml` sets the boundary on the function via the
`RolePermissionsBoundary` parameter (pinned in `samconfig.toml`); without it
the deploy fails at `iam:CreateRole`, which is the mechanism working as
intended.

One-time account setup (as an admin):

```bash
# create the two policies (and the user, on a fresh account)
aws cloudformation deploy --template-file deployer-template.yaml \
  --stack-name barter-deployer --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CreateDeployerUser=false   # 'true' creates the user too
# adopting an existing user: attach AppDeployerPolicy and detach whatever it
# replaces (this account: PowerUserAccess + the AppDeployerServerlessExtras
# inline policy were removed).
```

Bank keys in SSM stay an admin action — the deployer has no SSM write access.

