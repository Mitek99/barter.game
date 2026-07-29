# barter.game — Agent Guide

> This file is for AI coding agents. If you are reading this, you are about to modify code in a federated mutual-credit ledger. Read the section headers that match your task before touching files.

## Project overview

barter.game is a **federated mutual-credit ledger**. Every user and every bank is an ed25519 keypair. Users mint personal currencies ("1 logo", "1 hour of consulting"), trade them across banks, and settle via a signed, content-addressed protocol. There is no central authority; trust is local and socially enforced.

This repo contains:

- The **protocol spec** (`protocol/`) — the invariant contract every implementation must follow: overview, base types, document schemas, bank RPC, discovery, and post feeds.
- The **protocol library** (`packages/protocol/`) — canonical JSON, crypto, doc types, validators. Runs identically under Bun, Deno, and browser.
- The **bank server** (`apps/bank/`) — Deno process serving one or more federated banks (RPC + custom UI API + the SPA).
- The **web UI** (`apps/web/`) — build-less browser SPA the bank serves at `/:bank/ui`.
- The **scenarios** (`scenarios/`) — step-by-step protocol interaction traces.
- The **website** (`website/`) — Hugo/Hextra static site.

## Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Package manager | Bun | `bun.lock` is the lockfile. Use `bun install`, not `npm install`. |
| Server runtime | Deno | Deno Deploy in production — **auto-deploys on push to `main`** via the GitHub integration; `deploy` block in `deno.json`. Stateless, uses Deno KV. |
| Protocol lib | TypeScript (ES modules) | Single source file `packages/protocol/src/index.ts`. Must run identically under Bun, Deno, and browser. |
| Database | Deno KV | Single store, every key prefixed `[bank_pubkey, ...]`; atomic check-and-set operations. |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `@scure/base` | Pure-JS, auditable, runs in all targets. |
| Website | Hugo + Hextra theme | Built with `hugo`; deployed via Netlify. |
| Key storage (user) | Browser-encrypted keystore on the bank | PBKDF2-SHA256 (250k iterations) + AES-256-GCM, encrypted client-side; the bank stores ciphertext only. See `apps/web/README.md`. |
| Key storage (bank) | Env vars (`BANK_<NAME>_PRIV_KEY`) | One or more bank keys per process. |

## Monorepo structure

```
barter.game/
├── package.json              # Root workspace manifest (workspaces: packages/*, apps/web)
├── tsconfig.json             # Shared TypeScript config (strict, ES2022, bundler resolution)
├── deno.json                 # Deno config: import map, test includes, Deno Deploy app
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
│   └── protocol/             # @barter.game/protocol — shared protocol library (see its README.md)
│       ├── src/index.ts      #   canonical JSON (JCS), ed25519 signing, doc types, validators
│       ├── test/             #   bun tests + golden canonical vectors
│       └── test-deno/        #   cross-runtime parity tests
├── apps/
│   ├── bank/                 # Deno bank server (see its README.md)
│   │   ├── main.ts           #   HTTP router: RPC + UI API + SPA + Barter Links + media vault (/:bank/media)
│   │   ├── rpc.ts            #   JSON-RPC envelope verification + replay
│   │   ├── registry.ts       #   method → handler map
│   │   ├── advance.ts        #   self-advance engine (ready → hold → settle)
│   │   ├── db.ts env.ts peer.ts local.ts ui.ts genkey.ts
│   │   ├── handlers/         #   submit_docs, submit_mandate, create_records, notify_signatures,
│   │   │                     #   get_record_signatures, and get.ts (get_voucher, list_vouchers, list_accounts,
│   │   │                     #   list_offers, get_offer, get_invoice, get_cheque, get_address, get_account_balance,
│   │   │                     #   list_posts, get_post, get_post_signatures, get_voucher_meta)
│   │   └── e2e-*.ts          #   nine end-to-end checks (local, cheque-local, crossbank, sameswap, reject,
│   │                         #   replay, forged-sigs, account-privacy, posts)
│   └── web/                  # Browser SPA served by the bank (see its README.md)
│       ├── index.html app.js protocol.js qr.js styles.css vendor/
│       └── sw.js icon.svg favicon.ico icon-*.png apple-touch-icon.png
│                             #   installable PWA (home-screen install offer);
│                             #   the manifest is generated per bank by ui.ts
├── scenarios/                # Step-by-step interaction traces (cheque, invoice, swaps, builder event)
├── scripts/                  # emulate.ts + emu (emulated-user CLI, see EMULATED.md), genkey.ts (bun),
│                             #   genkey-deno.ts, emulated-svg/ — NOTE: demo-*.sh are stale (invoke the removed CLI)
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
| `bun run test` | Bun | Protocol library: canonical JSON golden vectors, crypto, all doc validators |
| `bun run test:deno` | Deno | The SAME golden vectors under Deno (**cross-runtime parity**) |
| `deno test` | Deno | Parity vectors + bank tests per `deno.json` `test.include` |
| `deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv apps/bank/e2e-<name>.ts` | Deno | Nine end-to-end suites: `local` (single-bank lifecycle), `cheque-local` (single-bank cheque settlement), `crossbank` (bilateral swap, lead/follow cascade), `sameswap` (same-bank two-voucher swap minting two record pairs), `reject` (uncoverable debit rejects the deal), `replay` (settle-replay resistance), `forged-sigs` (peer signature-authority checks), `account-privacy` (balance-read authorization), `posts` (posts/feeds/follows, bank auto-repost, media vault) |

The **cross-runtime parity suite is load-bearing**. If Bun and Deno disagree on a canonical hash, every signature in the protocol becomes unverifiable across implementations. Run it before every release.

> `scripts/demo-local.sh` and `scripts/demo-deploy.sh` are currently **broken** — they invoke the removed CLI (`apps/cli/`). Rebuilding them is tracked in `TODOS.md`. Do not cite them as working. The working command-line client is `scripts/emu` (`scripts/emulate.ts`) — see `EMULATED.md`.

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
- **Runtime parity**: Any code in `packages/protocol/` must run under Bun, Deno, and browser. Avoid:
  - Node-only APIs (`fs`, `path`, `crypto` module).
  - `Buffer` — use `Uint8Array`.
  - `process.env` — use runtime-specific injection outside the protocol package.
- **Canonical JSON**: The hand-rolled canonicalizer in `packages/protocol/src/index.ts` is the single source of truth. Do not swap it for an npm package. Any change to it must be accompanied by new golden vectors and a passing Deno test.
- **Terminology**: the deal-assembling role is the **coordinator** (never "matchmaker"); the party creating a voucher is the **issuer** (never "emitter").

## Testing instructions

### Adding a test to the protocol package

1. Add a Bun test in `packages/protocol/test/<name>.test.ts` using `bun:test`.
2. If the test covers canonical JSON, crypto, or anything runtime-sensitive, add an equivalent Deno test in `packages/protocol/test-deno/<name>.deno-test.ts` using `Deno.test`.
3. Keep golden vectors in `packages/protocol/test/fixtures/` as JSON.
4. Run `bun run test:all` before committing.

### Adding a handler to the bank server

1. Create `apps/bank/handlers/<method_name>.ts`.
2. Export a handler function and register it in `apps/bank/registry.ts`.
3. The handler must:
   - Rely on `rpc.ts` for envelope signature verification and replay claim.
   - Scope every KV operation to this bank's pubkey.
   - Return typed JSON-RPC responses.
4. Add a Deno test (`apps/bank/*.test.ts` / `*.deno-test.ts`) or extend an e2e script if the handler changes the state machine.

## Security considerations

- **Private keys (user)**: generated in the browser; only the PBKDF2+AES-GCM ciphertext reaches the bank. There is no password recovery — lost password means lost account.
- **Bank keys**: loaded from `BANK_<NAME>_PRIV_KEY` env vars. Never log them, never return them in RPC responses.
- **Signing model**: Users sign Voucher, Account, Order, Address, and Post docs. The coordinator signs Mandates. Banks sign Offer and Balance docs plus every ledger `Signature` (`ready`/`hold`/`settle`/`reject`) — and banks also sign Post docs: on every accepted user post the bank mints a bank-signed auto-repost embedding the original into its own feed (`apps/bank/handlers/submit_docs.ts` `bankRepost`; carriage per `protocol/post-feed.md`). Records are bank-minted (bank-assigned ULIDs) and referenced by content hash; only the `pair`/`deal_id` grouping uses ULIDs.
- **Replay protection / idempotency**: Every RPC envelope carries a ULID `id` bound to `(sender_pubkey, recipient_pubkey)`. The bank stores seen triples in KV with a 24h TTL and rejects duplicates with `-32002`. `create_records` is idempotent on `(deal_id, giver, receiver)` and rejects the same key with different amounts.
- **Signature verification**: Every inbound request is verified against its `pubkey` before any handler runs. The `to` field must match the recipient bank's pubkey.
- **Account privacy**: Accounts are private; the reference bank discloses a balance only to the account holder and the voucher's issuer (`apps/bank/handlers/get.ts`, verified by `e2e-account-privacy.ts`). The spec's `public: true` opt-in (`protocol/bank-schema.md` §1.2) is specified but not yet implemented in the reference bank. Account names never leave the holder's control.
- **Media vault**: content-addressed blobs served at `/:bank/media` by ref `<hash>.<ext>` (`apps/bank/ui.ts` `handleMedia`). Upload sits behind write auth and refuses anything outside the svg/png/jpg/jpeg/webp/gif extension allowlist (plus a size cap), so a caller-chosen Content-Type can never make the unauthenticated GET host arbitrary pages on the bank origin; GET re-verifies the content hash and serves immutable responses with `X-Content-Type-Options: nosniff` and a sandboxing CSP. `submit_docs` accepts a post only if every media ref in its whole embedded tree is already stored at this bank — cross-bank reposts copy the blobs first. Details in `protocol/post-feed.md`.
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
| `apps/bank/README.md` | Bank server: routes, KV key-space, config, deploy | Modifying server code |
| `apps/web/README.md` | Web SPA: screens, keystore model, transports | Modifying the web UI |
| `packages/protocol/README.md` | Library API, parity tests, porting guide | Touching protocol primitives |
| `EMULATED.md` | Emulated-user playbook: driving the deployed demo banks / reproducing demo state with `scripts/emu` (`scripts/emulate.ts`) | Scripting flows against live or local banks from the command line |
| `WORKAROUNDS.md` | In-effect implementation compromises (keystore KDF, in-process peer dispatch on Deno Deploy, ...) | Changing fan-out, auth, or deploy behavior |
| `TODOS.md` | Roadmap and deferred work | Planning new features |

## Deployment notes

### Deno Deploy

**Pushes to `main` deploy automatically.** Deno Deploy's GitHub integration builds this repo on push — there is no GitHub Actions workflow, and none is needed. The absence of `.github/workflows/` does *not* mean deployment is manual; the integration lives in the Deno Deploy dashboard, not in the repo. The `deploy` block in `deno.json` pins the target (org `ai-1st`, app `barter-game-banks`).

Treat a merge to `main` as a production release of the bank. `deno deploy --prod` from the repo root is the manual escape hatch for out-of-band deploys. Set `BANK_<NAME>_PRIV_KEY` env vars in the Deno Deploy dashboard for each bank the process serves.

### Running a bank locally

```bash
# 1. Generate a keypair
deno run apps/bank/genkey.ts          # prints BANK_ALICE_PRIV_KEY=<base58>
# 2. Run (see .claude/launch.json for the known-good invocation)
BANK_ALICE_PRIV_KEY=<base58> \
deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv apps/bank/main.ts
# 3. Web UI at http://localhost:8000/alice/ui
```

### Syncing protocol changes

`apps/bank/` imports `@barter.game/protocol` via the `deno.json` import map — no sync step. `apps/web/protocol.js` is a **vendored compiled copy** of the library and must be regenerated manually when `packages/protocol/src/index.ts` changes: run `npx tsc -p tsconfig.web.json` from `packages/protocol/` (it emits `apps/web/index.js`), then rename `apps/web/index.js` to `protocol.js` and review the diff (see `apps/web/README.md`).

### Website

The Hugo site deploys via Netlify (`bun run deploy:website`, or automatically per `netlify.toml`).

## Development conventions

- **Doc signing model**: see Security considerations above. Account docs ARE holder-signed; Records are bank-minted and carry no holder signature.
- **Content-addressed docs**: every doc except Records is canonicalized, SHA-256-hashed, and addressed by its base58 hash. References between docs use hashes, not surrogate IDs. Records and their `pair`/`deal_id` grouping use bank-minted ULIDs.
- **Bank scoping**: every KV key is prefixed with the bank pubkey so one Deno KV database can serve multiple banks. Every query must include the prefix. Missing it is a bug.
- **Base58 everywhere**: hashes, pubkeys, and signatures travel as base58 strings.
- **Banks self-advance**: clients submit docs (`submit_docs`); the coordinator creates records (`create_records`) and clears them (`submit_mandate`); from there each bank advances its own records `created → approved → held → settled` event-driven — re-evaluating on every `submit_docs`/`submit_mandate`/`notify_signatures`, with no cron. Signatures travel bank-to-bank directly (Address registry), with `get_record_signatures` + `notify_signatures` as the manual relay floor. `reject` is bank-issued only and cascades per deal.
- **Visibility boundary**: no bank sees another bank's records. A bank sees only records of the vouchers it issues, the Orders and Mandates that touch them, and deal-level signatures from its peers.
- **Migration policy (v1)**: no in-place migrations. If the KV schema changes, wipe demo banks.
- **Comments**: load-bearing invariants are commented with `//` or `/* */` blocks. JSDoc for exported public APIs.
- **Keep this file current**: when you move, add, or remove docs or commands referenced here, update AGENTS.md in the same change.
