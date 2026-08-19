# barter.game — Agent Guide

> This file is for AI coding agents. If you are reading this, you are about to modify code in a federated mutual-credit ledger. Read the section headers that match your task before touching files.

## Project overview

barter.game is a **federated mutual-credit ledger**. Every user and every bank is an ed25519 keypair. Users mint personal currencies ("1 logo", "1 hour of consulting"), trade them across banks, and settle via a signed, content-addressed protocol. There is no central authority; trust is local and socially enforced.

This repo contains:

- The **protocol spec** (`protocol/`) — the invariant contract every implementation must follow: overview, base types, document schemas, bank RPC, discovery, and post feeds.
- The **protocol library** (`packages/protocol/`) — canonical JSON, crypto, doc types, validators. Runs identically under Bun, Node.js, and browser.
- The **bank engine** (`packages/bank-core/`) — the whole bank (routing, RPC, advance engine, storage layer), written against web-standard APIs only. The host injects storage.
- The **AWS bank host** (`apps/bank-aws/`) — the only bank host: the engine on Node.js Lambda + DynamoDB + S3 behind CloudFront, deployed with SAM, plus a local Node dev server and the eleven e2e suites.
- The **web UI** (`apps/web/`) — build-less browser SPA the bank serves at `/:bank/ui`.
- The **scenarios** (`scenarios/`) — step-by-step protocol interaction traces.
- The **website** (`website/`) — Hugo/Hextra static site.

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Package manager | Bun | `bun.lock` is the lockfile. Use `bun install`, not `npm install`. |
| Server runtime | Node.js on AWS Lambda | Deployed on demand with SAM (`apps/bank-aws`) — there is no auto-deploy on push. The host is stateless and runs the `packages/bank-core` engine. Locally, the same host runs as a plain Node server (`bun run local`). |
| Protocol lib | TypeScript (ES modules) | Single source file `packages/protocol/src/index.ts`. Must run identically under Bun, Node.js, and browser. |
| Database | DynamoDB single-table | Behind the `KvStore` seam (`packages/bank-core/src/kv.ts`). Every key is prefixed `[bank_pubkey, schema, kind, ...]`; atomic check-and-set operations. Values are capped at 64 KiB on every storage backend — the federation-compat rule so any bank accepts the same writes (the cap originated as Deno KV's limit). |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all targets. |
| Website | Hugo + Hextra theme | Built with `hugo`; deployed to the bank stack's S3/CloudFront via `apps/bank-aws/deploy-website.sh` (no Netlify). |
| Key storage (user) | Browser-encrypted keystore on the bank | PBKDF2-SHA256 (250k iterations) + AES-256-GCM, encrypted client-side; the bank stores ciphertext only. See `apps/web/README.md`. |
| Key storage (bank) | Env vars (`BANK_<NAME>_PRIV_KEY`) locally; SSM SecureStrings under `/barter/banks/<name>` on AWS | One or more bank keys per process. |

## Monorepo structure

```
barter.game/
├── package.json              # Root workspace manifest (workspaces: packages/*, apps/web, apps/bank-aws)
├── tsconfig.json             # Shared TypeScript config (strict, ES2022, bundler resolution)
├── bun.lock                  # Bun lockfile
├── README.md TODOS.md WORKAROUNDS.md EMULATED.md
├── protocol/                 # THE CONTRACT — invariant protocol spec
│   ├── README.md             #   overview, trust model, settlement model
│   ├── base.md               #   BaseDoc, Signature, Address, envelope, replay, discovery doc
│   ├── bank-schema.md        #   Voucher/Account/Record/Order/Offer/Mandate/Balance + ledger semantics (Post lives in post-feed.md)
│   ├── bank-rpc.md           #   bank RPC methods, pagination, orchestration recipe
│   ├── discovery.md          #   registries, offers, QR profile bundles, public holdings
│   └── post-feed.md          #   Post doc, voucher-anchored feeds, moderation
├── packages/
│   ├── protocol/             # @barter.game/protocol — shared protocol library (see its README.md)
│   │   ├── src/index.ts      #   canonical JSON (JCS), ed25519 signing, doc types, validators
│   │   └── test/             #   bun tests + golden canonical vectors + web-mirror parity
│   │                         #   (web-mirror.test.ts guards apps/web/protocol.js against src/index.ts)
│   └── bank-core/            # @barter.game/bank-core — the bank engine, host-agnostic (see its README.md)
│       └── src/
│           ├── router.ts     #   HTTP routing: RPC + UI API + SPA + Barter Links + media vault (/:bank/media)
│           ├── rpc.ts        #   JSON-RPC envelope verification + replay
│           ├── registry.ts   #   method → handler map
│           ├── advance.ts    #   self-advance engine (ready → hold → settle)
│           ├── kv.ts         #   KvStore interface (the storage seam) + MemoryKv
│           ├── media.ts      #   MediaStore interface + KV-chunked implementation
│           ├── db.ts env.ts peer.ts local.ts ui.ts types.ts error.ts
│           └── handlers/     #   submit_docs, submit_mandate, create_records, notify_signatures,
│                             #   get_record_signatures, and get.ts (get_voucher, list_vouchers, list_accounts,
│                             #   list_offers, get_offer, get_invoice, get_cheque, get_address, get_account_balance,
│                             #   list_posts, get_post, get_post_signatures, get_voucher_meta)
├── apps/
│   ├── bank-aws/             # AWS host — the only bank host: Lambda + DynamoDB + S3 + CloudFront
│   │                         #   (see its README.md)
│   │   ├── src/              #   kv-dynamo.ts, media-s3.ts, adapter.ts (Function URL), local-server.ts
│   │   ├── e2e/              #   eleven end-to-end suites (local, cheque-local, crossbank, sameswap, reject,
│   │   │                     #   replay, forged-sigs, account-privacy, posts, federation, admin) — pure HTTP
│   │   │                     #   clients, runnable against any host via E2E_BASE_URL
│   │   ├── template.yaml     #   SAM stack (deploys as the app-deployer IAM user)
│   │   ├── deployer-template.yaml # the app-deployer user's IAM: least-privilege deploy
│   │   │                      #   policy + permissions boundary it must set on every role it creates
│   │   ├── deploy.sh         #   build + sam deploy + web client sync + CloudFront invalidation
│   │   └── test/             #   KvStore contract suite (MemoryKv + DynamoDB Local)
│   └── web/                  # Browser SPA served by the bank (see its README.md)
│       ├── index.html app.js protocol.js qr.js styles.css vendor/
│       └── sw.js icon.svg favicon.ico icon-*.png apple-touch-icon.png
│                             #   installable PWA (home-screen install offer);
│                             #   the manifest is generated per bank by ui.ts
├── scenarios/                # Step-by-step interaction traces (cheque, invoice, swaps, builder event)
├── scripts/                  # emulate.ts + emu (emulated-user CLI, see EMULATED.md), genkey.ts (bun),
│                             #   emulated-svg/
├── docs/                     # Design notes, reviews, UI specs, legacy material
└── website/                  # Hugo site (Hextra theme)
```

## Build and test commands

```bash
# Install dependencies
bun install

# Type-check all workspaces
bun run typecheck

# Run the full test matrix (this is the gate before any commit)
bun run test:all
```

### Test breakdown

| Command | Runtime | What it tests |
|---|---|---|
| `bun run test` | Bun | Protocol library: canonical JSON golden vectors, crypto, all doc validators, plus the web-mirror parity test |
| `bun run test:bank-aws` | Node (via tsx) | `KvStore` contract suite — MemoryKv always, plus DynamoDB Local when `DDB_ENDPOINT` is set. This is what keeps a storage backend from quietly breaking hold exclusivity or the 64 KiB value cap. |
| `E2E_BASE_URL=http://localhost:8100 bun run apps/bank-aws/e2e/e2e-<name>.ts` | Bun | Eleven end-to-end suites: `local` (single-bank lifecycle), `cheque-local` (single-bank cheque settlement), `crossbank` (bilateral swap, lead/follow cascade), `sameswap` (same-bank two-voucher swap minting two record pairs), `reject` (uncoverable debit rejects the deal), `replay` (settle-replay resistance), `forged-sigs` (peer signature-authority checks), `account-privacy` (balance-read authorization), `posts` (posts/feeds/follows, bank auto-repost, media vault), `federation` (multi-host wiring), `admin` (operator `/ui/admin/*` routes; needs `BANK_ADMINS` set on the server) |

The **web-mirror parity test is load-bearing**. `packages/protocol/test/web-mirror.test.ts` guards the vendored browser copy `apps/web/protocol.js` against `packages/protocol/src/index.ts` — if the two diverge on a canonical hash, browser-signed docs stop verifying at the bank. Run it before every release (it runs as part of `bun run test`).

The e2e suites are wire-protocol HTTP clients with no import from the bank, so
point `E2E_BASE_URL` at whatever you are testing — the local Node server
(`bun run local` in `apps/bank-aws`) or the deployed AWS banks.

The working command-line client is `scripts/emu` (`scripts/emulate.ts`), run under Bun — see `EMULATED.md`.

### Website

```bash
# Build (requires Hugo + Go)
cd website && hugo mod get && hugo --gc --minify
```

## Code style guidelines

- **Language**: TypeScript, ES modules (`"type": "module"`), `.ts` extension on all imports.
- **Strictness**: `strict: true` in tsconfig. `noUncheckedIndexedAccess: true` at root. No `any` without comment.
- **Formatting**: No enforced formatter yet. Match the existing style:
  - 2-space indent.
  - Single quotes for strings unless interpolating.
  - Explicit return types on exported functions.
  - JSDoc-style block comments for load-bearing invariants.
- **Runtime parity**: Any code in `packages/protocol/` must run under Bun, Node.js, and browser. Avoid:
  - Node-only APIs (`fs`, `path`, `crypto` module).
  - `Buffer` — use `Uint8Array`.
  - `process.env` — use runtime-specific injection outside the protocol package.
- **Canonical JSON**: The hand-rolled canonicalizer in `packages/protocol/src/index.ts` is the single source of truth. Do not swap it for an npm package. Any change to it must be accompanied by new golden vectors and a passing web-mirror parity test (`packages/protocol/test/web-mirror.test.ts`).
- **Terminology**: the deal-assembling role is the **coordinator** (never "matchmaker"); the party creating a voucher is the **issuer** (never "emitter").

## Testing instructions

### Adding a test to the protocol package

1. Add a Bun test in `packages/protocol/test/<name>.test.ts` using `bun:test`.
2. If the change touches canonical JSON or signing, confirm `web-mirror.test.ts` still passes — and regenerate `apps/web/protocol.js` if `src/index.ts` changed (see "Syncing protocol changes" below).
3. Keep golden vectors in `packages/protocol/test/fixtures/` as JSON.
4. Run `bun run test:all` before committing.

### Adding a handler to the bank server

1. Create `packages/bank-core/src/handlers/<method_name>.ts`.
2. Export a handler function and register it in `packages/bank-core/src/registry.ts`.
3. The handler must:
   - Rely on `rpc.ts` for envelope signature verification and replay claim.
   - Scope every KV operation to this bank's pubkey.
   - Use only web-standard APIs and the injected stores (`bank.kv`, `bank.media`,
     `bank.assets`) — no `node:*`. The engine stays host-agnostic: the host
     injects the stores, and `apps/bank-aws` is currently the one host.
   - Return typed JSON-RPC responses.
4. Extend an e2e suite (`apps/bank-aws/e2e/e2e-*.ts`) if the handler changes the state machine.

## Security considerations

- **Private keys (user)**: generated in the browser; only the PBKDF2+AES-GCM ciphertext reaches the bank. There is no password recovery — lost password means lost account.
- **Bank keys**: loaded from `BANK_<NAME>_PRIV_KEY` env vars. Never log them, never return them in RPC responses.
- **Bank admin routes**: `/ui/admin/*` (overview, users, accounts, records, posts, repost) is operator tooling, not protocol. Access is by registered-user pubkey listed in `BANK_ADMINS` / `BANK_<NAME>_ADMINS` env config (`packages/bank-core/src/env.ts`; on AWS, the `BankAdmins` SAM parameter) — everyone else gets 403 (`requireAdmin` in `ui.ts`). The routes are read-only except `POST /ui/admin/repost`, which mints the same bank-signed repost the auto-repost already produces. Admin reads deliberately bypass the account-privacy gate: the operator sees every balance their bank settles.
- **Signing model**: Users sign Voucher, Account, Order, Address, and Post docs. The coordinator signs Mandates. Banks sign Offer and Balance docs plus every ledger `Signature` (`ready`/`hold`/`settle`/`reject`) — and banks also sign Post docs: on every accepted user post the bank mints a bank-signed auto-repost embedding the original into its own feed (`packages/bank-core/src/handlers/submit_docs.ts` `bankRepost`; carriage per `protocol/post-feed.md`). Records are bank-minted (bank-assigned ULIDs) and referenced by content hash; only the `pair`/`deal_id` grouping uses ULIDs.
- **Replay protection / idempotency**: Every RPC envelope carries a ULID `id` bound to `(sender_pubkey, recipient_pubkey)`. The bank stores seen triples in KV with a 24h TTL and rejects duplicates with `-32002`. `create_records` is idempotent on `(deal_id, giver, receiver)` and rejects the same key with different amounts.
- **Signature verification**: Every inbound request is verified against its `pubkey` before any handler runs. The `to` field must match the recipient bank's pubkey.
- **Account privacy**: Accounts are private; the reference bank discloses a balance only to the account holder and the voucher's issuer (`packages/bank-core/src/handlers/get.ts`, verified by `e2e-account-privacy.ts`). The spec's `public: true` opt-in (`protocol/bank-schema.md` §1.2) is specified but not yet implemented in the reference bank. Account names never leave the holder's control.
- **Media vault**: content-addressed blobs served at `/:bank/media` by ref `<hash>.<ext>` (`packages/bank-core/src/ui.ts` `handleMedia`). Upload sits behind write auth and refuses anything outside the svg/png/jpg/jpeg/webp/gif extension allowlist (plus a size cap), so a caller-chosen Content-Type can never make the unauthenticated GET host arbitrary pages on the bank origin; GET re-verifies the content hash and serves immutable responses with `X-Content-Type-Options: nosniff` and a sandboxing CSP. `submit_docs` accepts a post only if every media ref in its whole embedded tree is already stored at this bank — cross-bank reposts copy the blobs first. Details in `protocol/post-feed.md`.
- **Double-spend gate**: an atomic KV check-and-set on the active-hold key enforces at most one active hold per account per external deal. Conflicts never error outward: the advance engine quietly issues no hold signatures that pass and re-attempts on later events (a stalled deal is eventually rejected by the bank's stall timeout).
- **Sum invariant**: on every settle, balances across all accounts for a Voucher must sum to zero (or the agreed limit).
- **Pubkey pinning**: clients pin `pubkey + url`; `<bank-url>/barter-bank.json` is compared against the pin and divergence fails closed.

## Key documentation (read before making changes)

| File | Purpose | Read this if you are... |
|---|---|---|
| `protocol/` directory | **The invariant contract**: `README.md` (overview), `base.md`, `bank-schema.md`, `bank-rpc.md`, `discovery.md`, `post-feed.md`. Every implementation must follow these. | Building or changing a bank, client, or alternative implementation |
| `scenarios/*.md` | Step-by-step user/coordinator/bank interaction traces, including the builder-event journey | Implementing or debugging specific flows |
| `README.md` | Project intro, live demo, quickstarts, repo navigation | New to the repo |
| [`website/content/docs/ethos.md`](./website/content/docs/ethos.md) | Design beliefs and priors (published at https://barter.game/docs/ethos/) | Changing protocol semantics |
| `apps/bank-aws/README.md` | Bank host: routes, KV key-space, config, deploy | Modifying server code |
| `apps/web/README.md` | Web SPA: screens, keystore model, transports | Modifying the web UI |
| `packages/protocol/README.md` | Library API, parity tests, porting guide | Touching protocol primitives |
| `EMULATED.md` | Emulated-user playbook: driving the deployed demo banks / reproducing demo state with `scripts/emu` (`scripts/emulate.ts`) | Scripting flows against live or local banks from the command line |
| `WORKAROUNDS.md` | In-effect implementation compromises (keystore KDF, in-process peer dispatch for co-located banks, ...) | Changing fan-out, auth, or deploy behavior |
| `TODOS.md` | Roadmap and deferred work | Planning new features |

## Deployment notes

### AWS (the only bank deployment)

Deploys are **manual** — nothing ships on push to `main`. From `apps/bank-aws/`:

```bash
AWS_PROFILE=app-deployer ./deploy.sh   # build + sam deploy + web client sync + CloudFront invalidation
```

The `app-deployer` IAM user and its least-privilege policy + permissions boundary are defined in `apps/bank-aws/deployer-template.yaml` — see the "Deploying as app-deployer" section of `apps/bank-aws/README.md`. On AWS, bank keys live in SSM SecureString parameters under `/barter/banks/<name>`.

The live demo banks are `https://barter.game/test1/ui` and `https://barter.game/test2/ui`.

### Running a bank locally

```bash
# 1. Generate a keypair
bun run scripts/genkey.ts           # prints BANK_PRIV_KEY= / BANK_PUB_KEY=
# 2. Run the local Node server (in-memory KV, KV-chunked media, port 8100)
cd apps/bank-aws && bun install
BANK_TEST1_PRIV_KEY=<base58> bun run local
# 3. Web UI at http://localhost:8100/test1/ui
```

### Syncing protocol changes

`apps/web/protocol.js` is a **vendored compiled copy** of the library and must be regenerated manually when `packages/protocol/src/index.ts` changes: run `npx tsc -p tsconfig.web.json` from `packages/protocol/` (it emits `apps/web/index.js`), then rename `apps/web/index.js` to `protocol.js` and review the diff (see `apps/web/README.md`). `packages/protocol/test/web-mirror.test.ts` fails if the vendored copy drifts from the source.

### Website

The Hugo site deploys to the bank stack's S3/CloudFront (`bun run deploy:website` → `apps/bank-aws/deploy-website.sh`: hugo build, sync to `s3://<assets>/site/`, CloudFront invalidation). The same distribution serves site and banks: default behavior → `site/`, `/test1/*` + `/test2/*` → the bank Lambda. Netlify is retired.

## Development conventions

- **Doc signing model**: see Security considerations above. Account docs ARE holder-signed; Records are bank-minted and carry no holder signature.
- **Content-addressed docs**: every doc except Records is canonicalized, SHA-256-hashed, and addressed by its base58 hash. References between docs use hashes, not surrogate IDs. Records and their `pair`/`deal_id` grouping use bank-minted ULIDs.
- **Bank scoping**: every KV key is prefixed with the bank pubkey so one storage table can serve multiple banks. Every query must include the prefix. Missing it is a bug.
- **Base58 everywhere**: hashes, pubkeys, and signatures travel as base58 strings.
- **Banks self-advance**: clients submit docs (`submit_docs`); the coordinator creates records (`create_records`) and clears them (`submit_mandate`); from there each bank advances its own records `created → approved → held → settled` event-driven — re-evaluating on every `submit_docs`/`submit_mandate`/`notify_signatures`, with no cron. Signatures travel bank-to-bank directly (Address registry), with `get_record_signatures` + `notify_signatures` as the manual relay floor. `reject` is bank-issued only and cascades per deal.
- **Visibility boundary**: no bank sees another bank's records. A bank sees only records of the vouchers it issues, the Orders and Mandates that touch them, and deal-level signatures from its peers.
- **Migration policy (v1)**: no in-place migrations. If the KV schema changes, wipe demo banks.
- **Comments**: load-bearing invariants are commented with `//` or `/* */` blocks. JSDoc for exported public APIs.
- **Keep this file current**: when you move, add, or remove docs or commands referenced here, update AGENTS.md in the same change.
