# Would the bank API benefit from server-sent events / streaming?

**Answer: no — not now.** No response is large enough for streaming to help,
the slow endpoints are slow because of storage read-amplification (which
streaming does not fix), and the single genuine push candidate — the deal
screen's 3-second poll — resolves in a couple of polls and would cost more in
auth redesign and dual-runtime complexity than it saves. What the data does
justify: batched reads in the list handlers and a server-side aggregation
endpoint for the client's per-render fan-out.

Measured 2026-08-02 against the live Deno Deploy banks
(`barter-game-banks.ai-1st.deno.net`), 5 runs each, p50, from a location with
~250–300 ms baseline round trip — treat the *deltas* between rows, not the
absolute values, as the signal.

| Endpoint | p50 | Size | What it is |
|---|---:|---:|---|
| `GET /:bank/barter-bank.json` | 314 ms | 164 B | identity doc (≈ pure network) |
| `GET /:bank/ui/config` | 289 ms | 164 B | SPA boot config |
| `GET /:bank/ui/resolve/:pubkey` | 333 ms | 474 B | issuer resolution |
| `rpc list_accounts` (empty user) | 527 ms | 90 B | one signed write (replay claim) + reads |
| `rpc list_posts` (limit 30) | 1 138–1 813 ms | 9–11 KB | **feed page** |
| `rpc list_vouchers` (no filter) | 2 069 ms | 7.7 KB | **full voucher registry, unpaginated** |
| `GET /:bank/media/<ref>` | 279 ms | 31 KB | content-addressed blob |
| Discover-style fan-out (4 × list_posts in parallel) | 1 690 ms | ~40 KB | one Posts-screen render |

## Why streaming does not help here

**Every response is small.** The heaviest pages are ~10 KB of JSON — a single
TCP window-ish of data. Streaming pays when the body is big enough that
time-to-first-byte matters over transfer time, or when generation is
incremental over seconds. Here the entire body is generated before any of it
could stream.

**The latency is read amplification, not payload.** `list_posts` costs
~1–1.5 s *server-side* because the index scan is followed by one KV `get` per
post hash (N+1); `list_vouchers` scans the registry then fetches each voucher
doc. An SSE channel delivering the same N+1 reads would arrive just as late.
The fix is batching (`BatchGetItem` in the DynamoDB store, parallel gets in
Deno KV) or denormalizing bodies into the index rows — either collapses the
p50 by an order of magnitude and needs no wire change.

**Nothing else long-runs.** The advance engine is strictly event-triggered
inside `submit_mandate` / `notify_signatures`; there are no jobs to stream
progress from. The protocol has no subscription concept (bank-schema §1.7 is
`Balance`, not `Subscription`), and every client call is one short
request/response.

## The one real push candidate — and why it still loses

The web client's only true poll is the **deal screen**: after `propose_deal`
it fetches `GET /:bank/ui/deal/:id` every 3 s until `settled`/`rejected`
(apps/web/app.js `renderDeal`), including an infinite retry while the deal is
not yet visible. Everything else fetches once per render.

A deal normally settles within the first one or two polls (the whole
ready→hold→settle cascade runs synchronously inside the triggering requests —
see the e2e suites' 500 ms poll caps). So SSE would save ~1–3 short requests
per deal and cut at most ~3 s of perceived latency, in exchange for:

- **Auth redesign.** `EventSource` cannot send the `X-Barter-Auth` header;
  push would need a signed query-string token variant of the authdoc (a new
  wire-auth surface to specify, implement, and keep replay-safe) or
  `fetch()`-streaming plumbing in the client.
- **Two runtimes, one client.** The Deno Deploy and AWS deployments serve the
  same SPA, so both would need the SSE endpoint: Deno KV `watch` on one side,
  Lambda Function URL `RESPONSE_STREAM` + CloudFront passthrough on the
  other — and on Lambda an open stream bills wall-clock while a 3 s poll
  bills ~100 ms per hit.
- **A worse failure mode.** The poll's infinite-retry loop currently doubles
  as recovery for cross-bank replication lag; a dropped stream would need the
  poll as fallback anyway.

If real-time deal state ever becomes a product requirement (e.g. deals that
stay pending for minutes because a human must approve), the AWS-native shape
is **DynamoDB Streams → push channel** (API Gateway WebSockets), not
SSE-from-the-request-path — it decouples notification from the settlement
hot path and works for cross-bank deals where the interesting write happens
at the *other* bank.

## What to do instead (ranked by measured payoff)

1. **Batch the N+1 reads** in `list_posts` / `list_vouchers` / portfolio
   aggregation (`packages/bank-core/src/db.ts`). Expected: `list_posts` p50
   from ~1.5 s to network baseline. Wire format unchanged.
2. **Aggregate the render fan-out server-side** — the Posts/Discover screen
   fires `list_posts` × (banks × authors) plus per-voucher resolution from
   the browser (dozens of requests per render; on Lambda, dozens of paid
   invocations). One `/ui/feed` endpoint assembling the page at the bank
   would do more for perceived speed than any transport change.
3. **Implement the already-specified pagination** for `list_vouchers` /
   `list_offers` (bank-rpc.md defines `cursor`/`limit`; the implementation
   ignores them) before registries grow — this is the only place a response
   can become genuinely large (Function URL buffered responses cap at 6 MB).

## Function URL / CloudFront envelope (for reference)

Buffered Lambda Function URL payloads cap at ~6 MB each way. Current maxima:
media blobs 1 MiB (≈1.37 MB as base64 JSON upload — fits), feed pages ≤200
posts ≈ tens of KB, `list_vouchers` unbounded (see item 3 above). Response
streaming (`RESPONSE_STREAM`) raises the response cap to 20 MB and enables
SSE if ever needed — the adapter seam (`apps/bank-aws/src/adapter.ts`) is
where it would slot in, without touching the shared engine.
