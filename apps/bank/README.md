# apps/bank — reference bank server

The reference implementation of a barter.game v1 bank: a single Deno process
that serves **one or more named banks** (one ed25519 keypair each) from **one
Deno KV database**. It exposes the standard protocol surface (discovery,
signed JSON-RPC, address directory), plus a custom `/ui/*` API and the SPA in
[`../web/`](../web/) on top.

This is a **reference**, not the contract. The normative contract lives in
[`../../protocol/`](../../protocol/README.md) —
[`base.md`](../../protocol/base.md) (identity, canonical JSON, envelope,
replay protection), [`bank-schema.md`](../../protocol/bank-schema.md)
(document schemas, ledger semantics), and
[`bank-rpc.md`](../../protocol/bank-rpc.md) (the RPC API). You may swap any
implementation choice here — storage, runtime, process layout — as long as
the wire format and invariants in those documents hold.

## HTTP surface

Routing is in [`main.ts`](./main.ts); `/ui/*` and Barter Links are in
[`ui.ts`](./ui.ts). Only `/rpc`, `/barter-bank.json`, and `/address` are
protocol; everything under `/ui/` is a **custom layer** per
[`base.md` §6](../../protocol/base.md) (standard vs custom API) — other banks
may implement it differently or not at all.

| Group | Routes | Notes |
|---|---|---|
| Health | `GET /` | Lists bank names served by this process |
| Discovery | `GET /:bank/barter-bank.json` | `{ pubkey, url, name, protocol_version }` |
| RPC | `POST /:bank/rpc` | Signed JSON-RPC envelope (protocol) |
| Address directory | `GET /:bank/address[/:pubkey]` | Newest signed `Address` doc (protocol) |
| Media | `POST /:bank/media`, `GET /:bank/media/:hash` | Content-addressed blobs for posts. Upload is authed (`X-Barter-Auth`) and takes `{content_type, data_base64}`; download is unauthenticated and immutable-cacheable |
| Barter Links | `GET /:bank/{i,v,q,o,x}/:value` | `i` profile, `v` invoice (credit-only Order), `q` cheque (debit-only Order), `o` offer, `x` invite. HTML landing page by default; machine envelope via `?format=json` or `Accept: application/barter+json` |
| UI API (public) | `GET /:bank/ui/handle/:handle`, `POST .../register`, `GET .../keystore/:handle`, `GET .../challenge`, `GET .../config`, `GET .../resolve/:pubkey` | Handle registry, encrypted keystore fetch, auth bootstrap |
| UI API (authed) | `/:bank/ui/{state, trusted, follows, contacts, banks, prefs, portfolio, history, orders, discover, relay, relay_signatures, propose_deal, deal/:id}`, `PUT .../keystore` | Requires `X-Barter-Auth`: a signed authdoc over method + path + query |
| SPA | `GET /:bank/ui`, `GET /:bank/ui/app/*` | Serves `./apps/web/index.html` with an injected `<base>`, and static assets from `./apps/web/` |

A post with `voucher_meta: true` is a **meta release**: the bank takes its
`icon_svg`, `square_svg` and `body_md` (as the description) as the voucher's
current presentation and caches them under `voucher_meta`, newest ULID winning.
Only the voucher's **issuer** may release — a Voucher doc is content-addressed
and immutable, so this is how a live currency gets restyled without reissuing
it and orphaning every balance denominated in it. Read it back with
`get_voucher_meta`.

`follows` is the feed subscription list — deliberately separate from `trusted`,
because reading someone and accepting their currency are different decisions. A
user who has never touched it defaults to following their own bank, and the bank
reposts every user post it accepts, so a new account has a non-empty feed on day
one. Unfollowing the bank is the opt-out.

`propose_deal` is the built-in **coordinator**: it builds the deal's Orders
into records across the participating banks and mandates them; `deal/:id`
reports deal status; `relay` / `relay_signatures` forward envelopes and
signatures for clients that cannot reach a peer bank directly.

## RPC methods

[`rpc.ts`](./rpc.ts) verifies the envelope signature (canonical JSON minus
`sig`), checks `to` against the bank's pubkey, and claims the envelope `id`
in a 24h replay window before dispatching via [`registry.ts`](./registry.ts):

| Method | Handler | Does |
|---|---|---|
| `submit_docs` | [`handlers/submit_docs.ts`](./handlers/submit_docs.ts) | Validate and store signed docs (Voucher, Account, Order, Address, Signature, Post); optionally derive and publish discovery Offers |
| `submit_mandate` | [`handlers/submit_mandate.ts`](./handlers/submit_mandate.ts) | Validate and execute one per-(deal, order) coordinator Mandate; store foreign record bodies; trigger advance |
| `create_records` | [`handlers/create_records.ts`](./handlers/create_records.ts) | Coordinator creates the deal's paired credit/debit records at this bank |
| `notify_signatures` | [`handlers/notify_signatures.ts`](./handlers/notify_signatures.ts) | Peers push `ready`/`hold`/`settle`/`reject` signatures; indexed by record hash; triggers re-advance of the owning deal |
| `get_record_signatures` | [`handlers/get_record_signatures.ts`](./handlers/get_record_signatures.ts) | Return a record and every signature stored on it |
| `subscribe` | [`handlers/subscribe.ts`](./handlers/subscribe.ts) | Store a Subscription doc for signature fan-out |
| `get_voucher`, `get_account_balance`, `list_accounts`, `list_offers`, `get_invoice`, `get_cheque`, `get_offer`, `list_vouchers`, `get_address`, `list_posts`, `get_post`, `get_post_signatures`, `get_voucher_meta` | [`handlers/get.ts`](./handlers/get.ts) | Reads |

## The advance engine

[`advance.ts`](./advance.ts) is how a deal moves `created → approved → held →
settled`. It is **bank-driven and event-triggered**: `advanceDeal()` runs
after `submit_mandate` and after every `notify_signatures` push — there are
no clocks, timers, or cron jobs. Each pass evaluates the three waves
(`ready → hold → settle`) against the deal's full record set, gated by
seen-chains (each signature cites the hashes it acted on, so a stale
signature from another deal cannot satisfy a gate).

- **Holds**: debits are aggregated per account per deal and acquired
  atomically; an account already held by a different deal refuses the hold.
- **Settle**: both halves of a transfer settle in the same pass — the balance
  delta is applied, the hold released, and the `settle` signature issued — so
  each voucher's balances keep summing to zero.
- **Reject**: an uncoverable debit rejects the whole deal (reject signatures
  on every pre-settled record, holds released). Settled records never roll
  back.

## Storage

[`db.ts`](./db.ts) uses a single Deno KV store; **every key is prefixed
`[bank.pubkey, ...]`**, which is what lets many banks share one process and
one database. Balances are stored as plain numbers. This table is
implementation detail, not contract (it replaces the old root schema doc):

| Group | Key prefixes |
|---|---|
| Docs | `doc` (every signed doc, content-addressed by hash) |
| Posts & media | `post_by_author`, `post_by_author_voucher` (both ULID-inverted for newest-first scans), `post_sig`, `voucher_meta` (latest issuer meta release, newest ULID wins), `media_meta`, `media_chunk` |
| Ledger | `voucher`, `issuer_voucher`, `account`, `holder_account` |
| Orders & discovery | `order`, `holder_order`, `order_usage`, `offer`, `order_offer`, `voucher_offer` |
| Deals & records | `record`, `deal_record`, `account_record`, `deal_pair`, `mandate`, `record_sig`, `foreign_record_deal`, `proposed_deal` |
| Holds | `hold`, `active_hold` |
| Directory & fan-out | `address`, `subscription` |
| UI / auth (custom layer) | `handle`, `handle_by_pubkey`, `keystore`, `ui_state`, `rl_keystore` (keystore-fetch rate-limit bucket, written by `ui.ts`) |
| Replay | `replay` (shared 24h window for RPC envelope ids and `X-Barter-Auth` request ids) |

Any replacement storage layer must enforce: at most **one active hold per
account** (acquired with an atomic check), **per-voucher sum-to-zero** across
accounts on settle, and **atomic state transitions** (holds, order usage,
balance updates, and `ui_state` revisions all use KV check-and-set here).

## Configuration

| Env var | Required | Meaning |
|---|---|---|
| `BANK_<NAME>_PRIV_KEY` | at least one | Base58 ed25519 private key (32 bytes). One var per bank; `<NAME>` is uppercased with `_` where the bank name has `-` (`BANK_ALICE_PRIV_KEY` → bank `alice`) |
| `BANK_<NAME>_URL` | no | Pins the bank's canonical URL. If unset, it is derived from the origin of the first incoming request |
| `BANK_KV_PATH` | no | Path to a local KV database file — used to run several isolated bank processes on one machine. Leave unset on Deno Deploy |
| `PORT` | no | Listen port, default `8000` |

## Running locally

From the **repo root** (the import map and `./apps/web/` reads are
root-relative):

```bash
# Generate a keypair (prints BANK_ALICE_PRIV_KEY / BANK_ALICE_PUB_KEY)
deno run apps/bank/genkey.ts

BANK_ALICE_PRIV_KEY=<base58-key> \
deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv apps/bank/main.ts
```

(`--unstable-kv` is also enabled via `unstable: ["kv"]` in the root
`deno.json`; the flag is kept explicit in `.claude/launch.json`, the
known-good local invocation.) Add more `BANK_<NAME>_PRIV_KEY` vars to serve
more banks from the same process.

Smoke check and UI:

```bash
curl http://localhost:8000/alice/barter-bank.json
# {"pubkey":"...","url":"http://localhost:8000/alice","name":"alice","protocol_version":"barter.game/v1"}
```

The web UI is then at `http://localhost:8000/alice/ui`.

## Deploying

**Pushing to `main` deploys this bank to production.** Deno Deploy's GitHub
integration builds the repo on every push — no GitHub Actions workflow is
involved, so don't read the empty `.github/` as "deploys are manual." The root
[`deno.json`](../../deno.json) pins the target in its deploy block
(`{"org": "ai-1st", "app": "barter-game-banks"}`).

For an out-of-band deploy (unpushed work, a rollback), the CLI is the manual
path — from the repo root:

```bash
deno deploy --prod
```

The app needs a provisioned Deno KV database assigned to it
(`deno deploy database provision` / `assign`), and the bank keys loaded as
env vars (`deno deploy env add` or `env load`). Multiple banks on Deno Deploy
are still **one process, one app** — just more `BANK_<NAME>_PRIV_KEY` vars.

## Tests

```bash
deno test   # from the repo root
```

The root `deno.json` includes `packages/protocol/test-deno/*.deno-test.ts`
and `apps/bank/**/*.test.ts` / `*.deno-test.ts` — currently the protocol
crypto/canonicalization unit tests, including
[`protocol.test.ts`](./protocol.test.ts).

Four standalone e2e scripts run against a live server (start one first):

| Script | Exercises |
|---|---|
| [`e2e-local.ts`](./e2e-local.ts) | Single-bank end-to-end smoke test (`deno run --allow-net --allow-env apps/bank/e2e-local.ts`) |
| [`e2e-crossbank.ts`](./e2e-crossbank.ts) | Bilateral swap across two banks — co-located by default, or two separate deployments via `E2E_BANK_A_URL` / `E2E_BANK_B_URL` (`deno run --allow-net --allow-env ...`) |
| [`e2e-reject.ts`](./e2e-reject.ts) | An uncoverable debit must reject the whole deal, not stall it |
| [`e2e-replay.ts`](./e2e-replay.ts) | A replayed settle signature from another deal must be refused by the seen-chain |
| [`e2e-posts.ts`](./e2e-posts.ts) | Voucher post feeds: write/read, `"all"` vs per-voucher, `before` pagination, reply/repost embedding, media upload + unauthenticated fetch, and the four rejections (unknown voucher, wrong sender, forged embedded ancestor, unstored media) |

## Known constraints

See [`../../WORKAROUNDS.md`](../../WORKAROUNDS.md) for everything currently
in effect. The one that shapes this package's structure: **Deno Deploy blocks
an isolate from fetching its own deployment URL** (508 Loop Detected), so
when the coordinator or the advance engine targets a bank served by this same
process, [`local.ts`](./local.ts) dispatches the call in-process instead of
over HTTP ([WORKAROUNDS.md §4](../../WORKAROUNDS.md)). Any change to bank
fan-out must preserve that in-process path, or co-located banks will 508 in
production.
