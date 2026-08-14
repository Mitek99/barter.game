# barter.game Web UI — Workarounds & Known Limitations

This file documents the workarounds and deferrals **currently in effect** in the
web UI + bank implementation against `docs/ui/claude-ui.md` and the `protocol/`
contract. Resolved one-off issues (import wiring, a SPA syntax error, an auth-gated
bootstrap route, the localhost Address URL, the legacy `old/` tree, the cross-bank
Offer-vs-Order resolution, and the initial deployment setup) have been removed —
the git history holds that record.

## Source-of-truth documents

- UI spec: `docs/ui/claude-ui.md`
- Protocol contract: `protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`

---

## 1. Keystore uses PBKDF2 + AES-GCM, not Argon2id (deferred)

`docs/ui/claude-ui.md §4` and `§10.1` mandate Argon2id (`m=64 MiB, t=3, p=1`) with
XChaCha20-Poly1305 for the encrypted keystore, plus a PBKDF2 fallback. Shipping a
WASM Argon2id build inside the SPA, with strict CSP/SRI, adds significant build
complexity and bundle size.

**In effect:** the keystore blob uses **PBKDF2-HMAC-SHA-256 + AES-GCM via Web
Crypto**. This satisfies the hard invariant that the plaintext private key and
password never leave the browser, while keeping the frontend a plain HTML/JS app
with no WASM build step. Argon2id is listed as a future upgrade in
`docs/ui/claude-ui.md §12`, and the spec explicitly allows PBKDF2 as a fallback
(`docs/ui/claude-ui.md §4`).

---

## 2. ~~Not all UI screens are built yet~~ (resolved — kept for section numbering)

`docs/ui/claude-ui.md §8` enumerates dozens of screens; the first implementation
pass shipped only the minimal end-to-end flow, and this section tracked the gap.

**Resolved:** the SPA now routes real, built screens for Vouchers, Orders,
Invoices, Cheques, Discover, Registry, Posts, Deal, Activity, Network, Scan, and
Settings — no stub routes remain — plus additions beyond the original spec
inventory: a post feed with replies and reposts (`protocol/post-feed.md`), a
follows-based Discover voucher gallery with "Trade for this"
(`protocol/discovery.md`), follows management on Network, a mobile bottom bar,
and PWA install. The `/ui/*` backend grew the matching surfaces (`/ui/follows`,
the `/media` vault) — as anticipated, without protocol changes.

---

## 3. Barter Link inline payloads use native browser compression

`docs/ui/claude-ui.md §5` requires DEFLATE + base64url for inline Barter Link
payloads. A fully self-contained implementation would bundle a deflate library.

**In effect:** reference-mode Barter Links (a short URL resolved by the bank) are
used for QR/link sharing. Inline mode uses the browser's native
`CompressionStream`/`DecompressionStream` where available, falling back to
reference mode otherwise. This preserves the "same link, two readers"
architecture for the common case without bundling a deflate library.

---

## 4. Co-located banks dispatch in-process

The coordinator (`/ui/propose_deal`) and the advance engine reach participating
banks over HTTP via [`packages/bank-core/src/peer.ts`](packages/bank-core/src/peer.ts) (`fetchDiscovery` /
`bankRpcCall`). When several banks run in one deployment, those become
self-requests.

**Origin (historical):** this shortcut was built for Deno Deploy, which
hard-blocked an isolate from fetching its own deployment URL
(`508 Loop Detected`). The Deno host is gone — a Lambda Function URL may call
itself, so the constraint no longer applies — but the shortcut stays: it is
load-bearing for co-located banks, which settle in-process instead of paying
an HTTP round-trip to themselves.

**In effect:** [`packages/bank-core/src/local.ts`](packages/bank-core/src/local.ts) registers the banks
served by this process; when a target bank's pubkey is local, `bankRpcCall`
invokes the registry handler directly and `fetchDiscovery` answers from memory
instead of issuing an HTTP request. Any future change to bank fan-out must keep
this in-process path, or co-located banks take the slow path (and, on any
platform that blocks self-fetch, would break outright).

**Status:** the real HTTP bank-to-bank path is **verified cross-process**: a
bilateral swap settles between two isolated local bank processes (separate
ports and KV stores — topologically two deployments) via
`E2E_BANK_A_URL`/`E2E_BANK_B_URL` in
[`apps/bank-aws/e2e/e2e-crossbank.ts`](apps/bank-aws/e2e/e2e-crossbank.ts).

---

## Notes for future work

- Upgrade keystore encryption to Argon2id + XChaCha20-Poly1305 when a WASM build
  pipeline is added (§1).
