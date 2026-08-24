# Phase 0 Status — Groundwork & Audit

> Completed alongside the parallel agent's work. This document records what already existed, what was added/fixed in Phase 0, and the known gaps that later phases must close.

## What was already built (parallel agent)

### `apps/bank/` — Deno bank server
A nearly complete v1 bank implementation exists:

| File | Responsibility |
|---|---|
| `protocol.ts` | Canonical JSON (JCS), ed25519 signing, base58, doc types & validators |
| `db.ts` | Deno KV storage for docs, accounts, records, offers, UI state, keystore |
| `rpc.ts` | JSON-RPC envelope verification & replay protection |
| `handlers/*.ts` | Standard RPC methods: `submit_docs`, `create_records`, `submit_confirm`, `notify_signatures`, `get_record_signatures`, `subscribe`, `get_*` |
| `advance.ts` | Bank self-advance engine (`ready` → `hold` → `settle`) |
| `peer.ts` | Cross-bank relay helpers |
| `ui.ts` | Custom `/ui/*` backend: auth, keystore, state, aggregation, discovery, relay, matchmaker trigger, Barter Link routes |
| `main.ts` | HTTP router, serves bank RPC + UI API + SPA static assets + Barter Link landing routes |

### `apps/web/` — Browser SPA
A working vanilla-JS single-page app exists as three files:

| File | Responsibility |
|---|---|
| `index.html` | SPA shell |
| `app.js` | All client logic: keystore crypto, signed requests, RPC, screens, routing |
| `styles.css` | Dark theme styling |

Screens already implemented: Welcome, Register, Connect, Unlock, Dashboard, Vouchers, Create Voucher, Orders, Create Order, Invoices, Create Invoice, Cheques, Create Cheque, Discover, Deal watch, Settings.

## What Phase 0 added / fixed

1. **Workspace integration**
   - Created `apps/web/package.json` so the web app is a first-class workspace.
   - Added `apps/web` to root `package.json` workspaces.
   - Updated `deno.json` test include to cover `apps/bank/**/*.test.ts` and `apps/bank/**/*.deno-test.ts`.

2. **Build/test tooling validation**
   - `bun install` passes.
   - `bun --filter '@barter.game/web-client' typecheck` and `build` pass (placeholder scripts until TS migration).
   - `deno check apps/bank/main.ts` passes.
   - `deno check apps/bank/**/*.ts` passes for all backend files.
   - `deno test apps/bank/` runs and passes.

3. **Bug fixes found during audit**
   - `apps/bank/registry.ts` was missing the `getOffer` import, causing a type/runtime error.
   - `apps/bank/ui.ts` `recordState()` type signature did not allow optional `action`, causing a type error.

4. **Smoke tests**
   - Added `apps/bank/protocol.test.ts` with 5 Deno tests covering key generation, pubkey derivation, sign/verify, hash determinism, and canonical JSON undefined-key dropping.

5. **Runtime smoke test**
   - Bank server boots on a fresh port and serves `barter-bank.json` correctly.
   - Web app serves its static HTML shell correctly.

## Current module boundaries

```
apps/
  bank/          # Deno server — protocol, storage, RPC, custom UI API, landing routes
  web/           # Browser SPA — currently one monolithic app.js
protocol/        # Markdown specification only
old/             # Archived previous implementation
```

There is **no shared `packages/protocol` library yet**. `apps/bank/protocol.ts` duplicates the protocol primitives. A later phase should extract a shared package so the web frontend can import the same canonical JSON + signing code instead of re-implementing it.

## Known gaps to be closed in later phases

### Architecture / code quality
- `apps/web/app.js` is a single 717-line file. It needs to be split into typed modules (`crypto`, `auth`, `rpc`, `uiapi`, `barterlink`, `state`, `screens`, `router`) per the implementation plan.
- No shared `packages/protocol` library exists. `scripts/genkey.ts` currently references the non-existent `packages/protocol/src/index.ts` and is broken.
- Cross-bank order fan-out in `app.js` is incomplete (see comment around line 617).

### Security (Phase 17)
- CORS is currently `Access-Control-Allow-Origin: *`. The spec requires same-origin permissive, strict-to-others.
- No CSP headers are served.
- No Subresource Integrity (SRI) hashes on the SPA bundle.
- `apps/web/app.js` loads crypto libs from `https://esm.sh` CDN, violating the "vendored first-party scripts" requirement.
- No input-scrubbing telemetry policy implemented.

### Crypto / keystore (Phase 2)
- Current keystore uses **PBKDF2 250k iterations + AES-256-GCM**. The spec requires **Argon2id (`m=64MiB, t=3, p=1`) primary + PBKDF2 600k fallback**, with **XChaCha20-Poly1305** (or AES-256-GCM alternate) and pubkey-bound AAD.
- No Argon2id WASM bundle is vendored.
- No BIP39 mnemonic recovery kit support.
- Memory zeroization is present but should be audited once modules are extracted.

### UI backend gaps
- `/ui/resolve/:pubkey` is not implemented.
- `/ui/feed` is not implemented.
- `/ui/catalog`, `/ui/drafts` endpoints are not exposed (fields exist in state but no dedicated routes).
- Barter Link landing HTML is minimal — missing rich OpenGraph meta, proper `<script id="barter-payload">`, `barter:*` meta tags, and app-link association files.
- Barter Link inline fragment encoding (`#b=`, `#s=`) is not implemented.

### Frontend screens
- Many screens are functional but basic: no QR/share modal, no detailed record drawer, no network/contacts management, no auto-lock timer, no recovery kit modal, no landing-page journeys for anonymous visitors.

## Phase 0 validation checklist

- [x] Existing protocol primitives type-check under Deno.
- [x] `bun install` succeeds with the new workspace.
- [x] `deno check apps/bank/main.ts` passes.
- [x] `deno test apps/bank/` passes.
- [x] Bank server boots and serves `barter-bank.json`.
- [x] Web app serves its static shell.
- [x] Phase 0 status documented.

## Recommended next step

**Phase 1 — Protocol Primitives** should focus on extracting or duplicating the canonical crypto code so the browser and server share identical hashing/signing behavior. Because `apps/bank/protocol.ts` already exists, the fastest path is either:

1. **Promote `apps/bank/protocol.ts` to a shared Deno-compatible module** that can also run in the browser (it already uses only `@noble`/`@scure`/`ulid`), or
2. **Create a fresh `packages/protocol` workspace** and migrate `protocol.ts` there, updating `apps/bank` to import it.

Option 2 is cleaner long-term and aligns with the original `scripts/genkey.ts` assumption, but it touches more files. Decide before starting Phase 1.
