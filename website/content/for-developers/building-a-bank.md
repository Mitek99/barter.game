---
title: Building a Bank
---

This page is a practical companion to the protocol contract. It walks through the decisions you need to make when building a barter.game bank from scratch.

## 1. Choose your stack

The protocol only requires:
- ed25519 sign/verify
- SHA-256
- RFC 8785 canonical JSON
- An HTTP server that can hold a private key
- Storage that enforces two invariants: sum-to-zero and one-active-hold-per-account

Everything else is up to you.

## 2. Implement canonical JSON first

This is the most dangerous piece to get wrong. If your canonicalizer produces different bytes than the reference implementation, every signature becomes unverifiable across implementations.

**Golden rule:** Sort object keys by Unicode code-unit order. Serialize numbers via ECMAScript `ToString(Number)`. Escape `"`, `\`, and control characters. Drop `undefined` keys.

**Test:** Canonicalize the same document under your runtime and under Bun/Deno. Assert the hashes match. The reference repo has golden vectors you can copy.

## 3. Set up your key model

A bank is an ed25519 keypair. The private key must be:
- Loaded at startup.
- Never exposed to clients.
- Used to sign all RPC responses and `/<name>/barter-bank.json`.

The pubkey is the bank's identity. Every RPC envelope has a `to` field that must match this pubkey; reject if it doesn't.

## 4. Build the RPC envelope

All requests are `POST /<name>/rpc` with this shape:

```json
{
  "jsonrpc": "2.0",
  "id": "<ulid>",
  "method": "<name>",
  "params": { ... },
  "pubkey": "<sender>",
  "to": "<your-bank-pubkey>",
  "sig": "<base58-sig>"
}
```

Before dispatching to a method handler:
1. Verify the envelope is well-formed.
2. Verify `to` matches your bank pubkey.
3. Verify `sig` is a valid ed25519 signature over `canonical(envelope minus sig)`.
4. Verify `id` has not been seen before (replay window).
5. Only then, call the method handler.

## 5. Implement the method handlers

Start with read-only methods (`get_voucher`, `get_account_balance`, `list_accounts`, `get_record_signatures`) — they're simple and let you test your envelope.

One rule that applies everywhere: there is no `open_account`. Accounts arrive as signed docs through `submit_docs`, and the bank stores each one by hash on first sight after verifying the holder's signature (a Voucher must reference this bank; an Account's voucher must be issued here). Account `name`s stay private to the holder, and balances are private by default.

Then implement the trade path in order:

### `submit_docs`
- One intake method for every holder-signed doc. Route by `type`: Vouchers must have `pubkey == bank`; Accounts must reference a known Voucher and be signed by the holder; Orders must reference known Accounts owned by the same holder and carry a valid, positive `rate`; Addresses update the address directory if newer by ULID; Posts are validated against their embedded tree and media refs (see §9).
- Optionally derive and publish a discovery **Offer** for any Order hash listed in `publish_offers` — the Offer copies the Order's terms while hiding the holder's identity and account hashes.
- Return the hashes of stored docs and any derived Offers.
- There is no `mint`. Issuers begin trading by submitting an Order that debits their own issuer account — the issuer is the one holder allowed to go negative.

### `create_records`
- Coordinator-only: this is the sole way records come into existence.
- Params: `giver` and `receiver` — hashes of holder-signed **Orders** already stored via `submit_docs` — plus `amount`, `counter_amount`, and a `deal_id`.
- Mint exactly one debit/credit record pair for **this bank's voucher**, with your own ULIDs; `pair` links the two halves. Seal `deal_id` and the sender's pubkey (the coordinator) into each record's `RecordDetails` — only that coordinator's Mandate can advance them later.
- Validate: both Orders resolve and name this bank's voucher on the right sides; `amount` sits inside both Orders' `min`/`max`; the caller's `counter_amount` is bank-asserted against both Orders' foreign-side windows and rates — never trusted.
- Idempotent on `(deal_id, giver, receiver)`; same key with different amounts is rejected. State: `created`. Return the bodies.

### `submit_mandate`
- Params: one coordinator-signed `Mandate` — the unit of work for one (Order, bank) — plus all the record bodies it lists (every record satisfying that Order across **all** banks).
- Verify the coordinator's signature and `mandate.bank == you`. Resolve `mandate.order` to a stored Order.
- Local records must have been created for `mandate.deal_id` with `details.coordinator == mandate.pubkey` and `Record.order == mandate.order`. Foreign bodies must hash to their listed values and be signed by their minting banks.
- Verify local completeness (every record you minted for this deal+order is listed), then validate the Order's conditions — per-record bounds, cumulative and account limits, and the rate over the full local+foreign set.
- Reject duplicate `(deal_id, order)` Mandates. Only after a valid Mandate may records leave `created`.

### `notify_signatures`
- Verify each pushed signature (known pubkey, valid sig), store the valid ones, then run the advance engine for every deal they touch. Invalid entries are skipped, not fatal.
- This single method serves both topologies: direct bank-to-bank delivery (the reference default — banks find each other via `Order.bank` and the Address registry) and manual relay by any party.

### The advance engine (not an RPC)
Banks self-advance — there is no client hold or settle call. After every `submit_docs`, `submit_mandate`, and `notify_signatures`, re-evaluate the affected records:
- `created` → `approved` once every owned record has a valid Order bound **and** the Mandate for its Order has arrived. Issue a `ready` signature per record after checking free balance (issuers may go negative on their own Orders); fan out.
- `approved` → `held`. **Lead** (the authorizing Order has `lead: true`): hold once every record in the deal is `ready`. **Follow:** hold only after verifying the lead's `hold` signature, whose `seen` must contain your `ready` hashes. Acquire holds on owned debit accounts, sign `hold`, fan out. On hold conflict, leave state unchanged; the next event retries.
- `held` → `settled`. **Lead:** settle once every record in the deal is held and the follow holds cite your hashes. **Follow:** settle once the lead's `settle` signature arrives, citing your `hold` hashes in `Signature.seen`.
- Settle = apply deltas (enforcing sum-to-zero), release holds, sign `settle`, fan out. Idempotent.
- **Reject:** banks — never holders or coordinators — issue a `reject` signature on a record whose precondition failure is permanent (side/account mismatch, amount out of bounds, uncovered debit, limit violation). A reject cascades through the deal's pre-settled records, releases holds, and fans out. Settled records stay settled. A bank MAY also reject a stalled deal on its own timeout to free locked accounts.

## 6. Enforce the invariants

### Sum-to-zero
On every settle, after applying deltas, the sum of `balance` across all accounts for the settled Voucher must equal zero. If it doesn't, your implementation has a bug.

### One active hold per account
When the advance engine acquires holds, check for another active hold on the same account by a different deal. On conflict, leave the record state unchanged — the next incoming signature retries. Release holds on `settle`, `reject`, and sweeper cleanup.

## 7. Expose discovery

Implement `GET /<name>/barter-bank.json`:

```json
{
  "pubkey": "<base58>",
  "url": "<canonical-rpc-url>",
  "name": "my-bank",
  "protocol_version": "barter.game/v1"
}
```

Sign this response with your bank key so clients can verify it.

## 8. Add an address directory (optional but recommended)

The reference server exposes one plain REST endpoint for reads:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/<name>/address/<pubkey>` | Look up the newest stored Address doc |

Address docs map a pubkey to a human-readable name and a callable URL; peer banks use them to call each other directly. Writes go through the standard `submit_docs` RPC — an Address is just another signed doc, updated when a newer ULID arrives. Address reads and media blobs (§9) are the only surfaces outside RPC, so anyone can resolve a pubkey or fetch a blob with a bare GET.

## 9. Serve the media vault and carry posts

Voucher artwork and post media travel as content-addressed refs of the form `<hash>.<ext>`, stored in a per-bank media vault ([`protocol/bank-rpc.md`](https://github.com/ai-1st/barter.game/blob/main/protocol/bank-rpc.md), [`protocol/post-feed.md`](https://github.com/ai-1st/barter.game/blob/main/protocol/post-feed.md)). Two REST endpoints carry it:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/<name>/media/<hash>.<ext>` | Serve a vault blob. Unauthenticated — whoever knows the ref may fetch. Verify the bytes hash to `<hash>` before serving; derive Content-Type from the extension; respond with immutable caching, `X-Content-Type-Options: nosniff`, and a sandboxing `Content-Security-Policy` so a served SVG renders as an image but can never run script on your origin. |
| `POST` | `/<name>/media` | Authenticated upload. The upload must resolve to a known image extension (`svg`, `png`, `jpg`, `jpeg`, `webp`, `gif`) — a caller-chosen Content-Type never reaches storage. |

On intake (`submit_docs`), a Post is a first-class doc: verify the signatures of embedded `reply_to`/`repost` docs, enforce that only a voucher's issuer may attach `voucher_meta` releases, and refuse any post whose embedded tree references a blob you don't store — cross-bank reposts must copy their blobs into your vault first. The protocol validators cap a post at 12 media refs and a voucher at 8 images. Serve the feed reads: `list_posts`, `get_post`, `get_post_signatures`, `get_voucher_meta`. The reference bank additionally rebroadcasts every accepted user post as a bank-signed repost — a policy choice, not a protocol requirement.

## 10. Write a client and test end-to-end

You need a client that can:
1. Register a keypair and submit signed Voucher, Account, and Order docs via `submit_docs` (an issuer's first Order debits the issuer account negative — that's how vouchers come into existence; there is no mint call).
2. Produce and consume `barter://` invite strings and discover counterparty Offers via `list_offers`.
3. Act as coordinator: read the Order hashes from the Offers, call `create_records` on each participating bank, then send a signed `Mandate` per Order per bank via `submit_mandate`.
4. Watch the banks self-advance (`get_account_balance` / `get_record_signatures`) and relay missing signatures by hand — `get_record_signatures` on one bank, `notify_signatures` on the other — when a direct bank-to-bank push got lost.

Test against the reference banks (the browser SPA each bank serves at `/:bank/ui` is the reference client): publish Orders → create records → mandate → watch the banks settle. If your client can trade with `bank-alice` and `bank-bob`, your implementation is interoperable.

## 11. Production considerations

- **Backup your bank private key.** Lose it and every Voucher issued by that bank becomes unverifiable.
- **Rate-limit your RPC endpoint.** Signed RPCs are cheap to verify but expensive to handle.
- **Monitor the sum invariant.** Alert if it ever drifts — it should be impossible, but bugs happen.
- **Decide on a sweeper.** Stuck holds happen. A cron job that releases holds older than N hours is pragmatic.

## Reference file map

| Concern | Path in reference repo |
|---|---|
| Canonical JSON, crypto, doc types + validators | `packages/protocol/src/index.ts` (single file) |
| Deno host (wires storage into the shared engine) | `apps/bank/main.ts` |
| AWS Lambda host (DynamoDB + S3) | `apps/bank-aws/src/index.ts` |
| Storage seam (`KvStore` / `MediaStore`) | `packages/bank-core/src/kv.ts`, `media.ts` |
| Env var key loader | `packages/bank-core/src/env.ts` |
| RPC envelope handler | `packages/bank-core/src/rpc.ts` |
| Bank method registry | `packages/bank-core/src/registry.ts` |
| Per-method handlers | `packages/bank-core/src/handlers/*.ts` |
| Storage layer (KV-shaped) | `packages/bank-core/src/db.ts` |
| Advance engine | `packages/bank-core/src/advance.ts` |
| Web UI serving | `packages/bank-core/src/ui.ts` |
| Browser client | `apps/web/app.js` |
