# barter.game

A federated mutual-credit ledger. **Your currency, your keys.**

Mint a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked
dinner" — issued by you, signed by you, redeemable from you. Host it at a
bank somebody else runs, or run your own — sovereignty lives in your keys,
not in who operates the bank. Trade it with people who know and trust you.
No central authority. No middleman. Just signed vouchers and their atomic
settlement.

## The big idea

For 40+ years, every "alternative currency" attempt (LETS, time banks,
mutual credit cooperatives) has run into the same wall: bootstrap. They
needed strangers to trust each other before the system was useful, and
strangers don't.

barter.game takes the opposite stance: **trust is local — and it attaches to
the issuer, not your counterparty.** You trust the person whose promise backs
the voucher, and the bank that settles it. You do *not* have to trust whoever
is on the other side of the trade; the banks settle against signed Orders, so
that counterparty is interchangeable and usually anonymous. Strangers can
trade here safely — what the protocol declines to do is tell you whether a
promise is any good. Discovery surfaces (registries, offers, QR profiles,
voucher feeds) distribute *facts*; deciding whom to trust stays human.

See [the Ethos](https://barter.game/docs/ethos/) for the full set of beliefs (source: [`website/content/docs/ethos.md`](./website/content/docs/ethos.md)).

## Just test it — here's how

Demo banks run live on Deno Deploy. Each bank serves a full web client:

```
https://barter-game-banks.ai-1st.deno.net/alice/ui
https://barter-game-banks.ai-1st.deno.net/bob/ui
```

1. Open a bank's `/ui`, create an identity (handle + password — the ed25519
   key is generated and encrypted **in your browser**; the bank stores only
   ciphertext).
2. Mint a voucher: "1 coffee", "1 code review" — whatever you can deliver.
3. Share your profile QR; a friend scans it, trusts you as an issuer, and
   places an order against your voucher.
4. Settle. Watch the balances: your issuer account goes negative — that's
   mutual credit. Across all accounts, every voucher sums to **zero**:

| Holder | Voucher | Bank | Balance |
| --- | --- | --- | --- |
| Alice | "1 logo" | bank-alice (issuer) | **−1** (she owes it) |
| Bob   | "1 logo" | bank-alice | **+1** (he holds it) |
| Bob   | "1 hour" | bank-bob (issuer)   | **−1** (he owes it) |
| Alice | "1 hour" | bank-bob   | **+1** (she holds it) |

The demo client is also a small social layer: publish a post about your
voucher (artwork rides along via the bank's media vault), follow people —
your host bank is followed by default, and a bank reposts every user post it
accepts into its own feed — and browse **Discover**, a voucher gallery built
from your follows' posts with a "Trade for this" shortcut that trusts the
issuer and preloads the swap. The wire format is in
[`protocol/post-feed.md`](./protocol/post-feed.md); discovery surfaces in
[`protocol/discovery.md`](./protocol/discovery.md).

Machine access works too — every bank publishes its identity document:

```bash
curl https://barter-game-banks.ai-1st.deno.net/alice/barter-bank.json
```

To run everything locally and execute the test suite:

```bash
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install
bun run test:all     # Bun protocol suite + the same golden vectors under Deno
deno test            # cross-runtime parity + the bank integration suite
```

Nine end-to-end suites (bank boot, cross- and same-bank swaps, single-bank
cheque, reject cascade, settle-replay resistance, forged peer signatures,
account privacy, post feeds and media) live in `apps/bank/e2e-*.ts` — see
[`apps/bank/README.md`](./apps/bank/README.md) for how to run them.

Step-by-step protocol walkthroughs — who signs what, in which order —
are in [`scenarios/`](./scenarios/), including a full
[builder-event journey](./scenarios/builder-event.md) from bank setup to
voucher feeds.

## Run your own bank — here's how

The reference bank is one Deno process serving any number of named banks
from a single Deno KV database. Each bank's key is an env var.

```bash
# 1. Generate a bank keypair
deno run apps/bank/genkey.ts        # prints BANK_ALICE_PRIV_KEY=<base58>

# 2. Run locally
BANK_ALICE_PRIV_KEY=<base58> \
deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv apps/bank/main.ts

# 3. Look at it
curl http://localhost:8000/alice/barter-bank.json
open http://localhost:8000/alice/ui
```

Deploying to Deno Deploy is `deno deploy` with the `deploy` block already in
[`deno.json`](./deno.json); serving more banks is just more
`BANK_<NAME>_PRIV_KEY` env vars — no extra processes. Full routes, storage
key-space, configuration, and operational notes:
[`apps/bank/README.md`](./apps/bank/README.md).

Prefer AWS? The same bank engine
([`packages/bank-core`](./packages/bank-core/README.md)) also ships as a
serverless host — Node.js Lambda + DynamoDB + S3 behind CloudFront, deployed
with SAM: [`apps/bank-aws/README.md`](./apps/bank-aws/README.md). Either
host runs the same protocol and the same e2e suites; pick a runtime, not a
fork.

You now have a bank. Tell your friends about it, and you're a tiny central
bank in a federation of exactly however many people you've invited.

## Build your own implementation — here's the protocol spec

The contract lives in [`protocol/`](./protocol/) — read it cover to cover
and you can build a bank or client in any language:

| File | Contents |
|---|---|
| [`protocol/README.md`](./protocol/README.md) | Overview: trust model, settlement model (ready → hold → settle), invariants |
| [`protocol/base.md`](./protocol/base.md) | Identity, canonical JSON (RFC 8785), `BaseDoc`, `Signature`, `Address`, RPC envelope, replay protection |
| [`protocol/bank-schema.md`](./protocol/bank-schema.md) | Document schemas (`Voucher`, `Account`, `Record`, `Order`, `Offer`, `Mandate`, `Balance`) and ledger semantics |
| [`protocol/bank-rpc.md`](./protocol/bank-rpc.md) | Bank JSON-RPC methods, pagination, orchestration recipe |
| [`protocol/discovery.md`](./protocol/discovery.md) | Finding banks, vouchers, issuers, offers, and public holdings |
| [`protocol/post-feed.md`](./protocol/post-feed.md) | Voucher-anchored post feeds (nostr-like publishing) |

The protocol only covers what interoperability needs. Everything else —
runtime, storage, UI, keypair management — is your choice. The reference
implementation documents its own choices per package:
[`packages/protocol/`](./packages/protocol/README.md) (shared primitives —
port its canonicalizer and validate against the golden vectors),
[`apps/bank/`](./apps/bank/README.md) (Deno bank server), and
[`apps/web/`](./apps/web/README.md) (browser SPA).

## What's in this repo

```
barter.game/
├── README.md             ← you are here
├── website/content/docs/ethos.md  ← the beliefs driving the design (published at barter.game/docs/ethos)
├── AGENTS.md             ← orientation for AI coding agents
├── TODOS.md              ← roadmap and deferred work
├── WORKAROUNDS.md        ← in-effect implementation compromises
├── EMULATED.md           ← emulated-users playbook for the live demo banks
├── protocol/             ← the INVARIANT protocol contract
├── scenarios/            ← step-by-step interaction traces
├── packages/protocol/    ← @barter.game/protocol — shared TS primitives
├── apps/bank/            ← the Deno bank server (serves RPC + web UI)
├── apps/web/             ← the browser SPA the bank serves at /:bank/ui
├── docs/                 ← design notes, reviews, legacy material
├── scripts/              ← utilities (see note below)
└── website/              ← Hugo/Hextra static site (barter.game)
```

> `scripts/demo-local.sh` and `scripts/demo-deploy.sh` predate the removal
> of the CLI and are currently broken; rebuilding them against the web/RPC
> flow is tracked in [`TODOS.md`](./TODOS.md). `scripts/emu`
> (`scripts/emulate.ts`) is a working CLI client — it speaks the same signed
> RPC envelopes and auth as the web client and targets the live demo banks
> by default; see [`EMULATED.md`](./EMULATED.md).

## Tests

```bash
bun run test        # protocol library under Bun
bun run test:deno   # SAME golden vectors under Deno (cross-runtime parity)
bun run test:all    # both
deno test           # parity vectors + the bank integration suite (deno.json test.include)
```

Cross-runtime canonicalization parity is the load-bearing invariant: if two
runtimes disagree on one canonical byte, every signature in the federation
becomes unverifiable. Details in
[`packages/protocol/README.md`](./packages/protocol/README.md).

## Honest limitations

- **No protocol-level rollback.** After a lead bank settles, an abandoning
  follower means the lead is out. Recourse is social — see
  [the Ethos](https://barter.game/docs/ethos/) §8.
- **No key recovery, no key rotation.** Lose the key and the password,
  lose the account.
- **No reputation, no dispute resolution.** The protocol records; humans
  adjudicate.
- The v1.5+ roadmap, including the gaps we know about, is in
  [`TODOS.md`](./TODOS.md).

## License

MIT — see [`LICENSE`](./LICENSE).

## Contributing

This is early. The protocol is small enough to keep in your head. If you
find a bug, a mismatch between the spec and the code, or a place where the
ETHOS got compromised — open an issue, and bring receipts.
