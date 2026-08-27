---
title: How it works?
weight: 2
aliases:
  - /how-it-works
  - /what-is-barter-game
  - /docs/what-is-barter-game
---

For 40+ years, every "alternative currency" attempt — LETS, time banks, mutual credit cooperatives — has run into the same wall: **bootstrap**. They needed strangers to trust each other before the system was useful, and strangers don't.

barter.game takes the opposite stance: **trust is local — and it attaches to the issuer, not your counterparty.** You trust whoever's promise backs the voucher ("Alice will actually make the logo"), and the bank that settles it. You do *not* need to trust the person on the other side of the trade: banks settle against signed Orders, so that counterparty is interchangeable and usually anonymous — two strangers at an event can swap a mug voucher for a t-shirt voucher without ever exchanging names.

So strangers *can* trade here safely. What the protocol declines to do is tell you whether a promise is any good — there is no reputation score and no arbitration. It gives trust a verifiable surface: signed receipts, atomic settlement, no ambiguity about who owes whom.

## The core loop

1. **Mint** a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked dinner" — issued by you, signed by you, redeemable from you.
2. **Trade** — offer your voucher for theirs with a signed invite string. Each holder signs their own Order; a coordinator — often just your own web app — builds the deal: ledger records on each bank, cleared by a signed Mandate per Order.
3. **Authorize** — your signed Order is both authorization and receipt confirmation. There is no separate accept step.
4. **Banks settle** — on their own, lead bank first, each citing cryptographic proof of the previous step. Sum per Voucher = 0.

## What makes it different

| Traditional alt-currency | barter.game |
|---|---|
| Strangers must trust each other | Trust the voucher's **issuer** and the **bank** — never your counterparty |
| Central clearing house | Anyone can run a bank; users hold accounts at a bank they trust — their own or someone else's. Federation is native |
| Reputation scores and arbitration | Social enforcement; the protocol records, it does not judge |
| Pre-funded collateral | Mutual credit: issuers go negative, holders go positive, sum = 0 |

## Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks talk to each other via signed HTTP. Anyone running the codebase can be a peer. The demo collapses several banks into one Lambda process and one DynamoDB table for operational simplicity; the *protocol* doesn't know or care.

If barter.game ever centralized — even subtly, even for "the demo" — we have built the wrong thing.

## Be your own bank — if you want to

The sovereignty lives in your keys, not your hosting: you may run your own bank, but you don't need to — you can host your vouchers in a bank run by somebody else, and leave it the moment your trust does. The full creed is [ethos §1](ethos).

## A trade, step by step

A barter.game trade is a cascade of signed documents across independent banks. Here's a bilateral swap — the simplest case — step by step.

### The setup

**Alice** banks at `bank-alice`. She issues "1 logo" — a voucher to design one logo.
**Bob** banks at `bank-bob`. He issues "1 hour" — a voucher to do one hour of consulting.

Neither has to *run* their bank — an account at a bank they trust is enough, though either could operate one. Alice and Bob agree to trade 1 logo for 1 hour. They happen to know each other here, but they needn't — each only has to trust the *other's voucher issuer* and the bank that settles it.

### Step 1: Publish intent

There is no mint step. Alice presents her signed Voucher doc plus two Account docs to bank-alice via `submit_docs` — one account for the "1 logo" voucher she gives, one for the "1 hour" voucher she wants. Then she signs an **Order**: debit 1 logo from her issuer account, credit 1 hour to her receiving account, at rate 1:1. Because she is the issuer, her Order is allowed to drive the issuer account **negative** — that negative balance is how vouchers come into existence. The same mechanism that moves value creates it.

She submits the same signed Order to both banks (each bank checks only the side whose voucher it issues) and asks bank-alice to publish a discovery **Offer** — a bank-signed derivation of the Order that exposes its terms while hiding her identity and account hashes.

Bob does the mirror image: his Order gives 1 hour, gets 1 logo.

There is no "open account" call anywhere in the protocol. Accounts come into existence the first time an Account doc is presented to a bank; the bank stores the doc by hash after verifying the holder's signature. Account names stay private to the holder.

### Step 2: Discovery

A **coordinator** finds the match. A coordinator is any keypair — often just the web app of one of the traders, here Alice's. It scans `list_offers` on the banks, finds two Offers on opposite sides of the same trade, and reads each Offer's `order` field to obtain the two holder **Order hashes**. Those hashes — never the Offers — are what the rest of the deal is built on.

### Step 3: Records

The coordinator asks each bank to create the records that connect the Orders:

1. It calls `create_records` on **bank-alice** (`giver`: Alice's Order, `receiver`: Bob's Order, `amount: 1`, `counter_amount: 1`, plus a fresh `deal_id`). Bank-alice mints one debit/credit record pair for "1 logo" — debit Alice, credit Bob — each record carrying the mandatory `pair` ULID of its twin, with the `deal_id` and the coordinator's pubkey sealed inside the record details.
2. It calls `create_records` on **bank-bob** with `giver`/`receiver` swapped, minting the "1 hour" pair — debit Bob, credit Alice.
3. Each bank validates the amounts against **both** Orders' `min`/`max` windows and rates before minting, and returns the record bodies. The records sit in state `created`.

### Step 4: The Mandate

Records don't move until the coordinator clears them. For each Order at each bank, the coordinator signs a **Mandate** — "here is every record in this deal that satisfies this Order, across all banks" — and sends it with the record bodies via `submit_mandate`.

Each bank verifies the coordinator's signature, checks that its own records were created for this `deal_id` by this coordinator, verifies the foreign record bodies against their minting banks' signatures, and validates the Order's conditions — including the rate — over the **full** record set. Only a Mandate signed by the same coordinator that created the records is accepted: knowing a `deal_id` is not enough to hijack a deal.

### Step 5: Ready and hold

From here, **the banks advance on their own** — nobody runs a hold or settle command.

Once a bank has a valid Order bound to its records and the Mandate for that Order, it issues a `ready` signature per record — checking that the debit account has enough free balance (or that the holder is the issuer authorizing a negative balance). Ready signatures travel bank-to-bank via `notify_signatures`; banks find each other through the `bank` fields in the Orders and the Address registry.

Then the holds. Alice's Order carries `lead: true`, so **bank-alice** is the lead: it locks its debit accounts and signs `hold` once every record in the deal is `ready`. **bank-bob** is a follower: it holds only after verifying the lead's `hold` signature. A held account cannot be debited by another deal until the hold is released by settlement or rejection. (A hold conflict just blocks quietly; the bank retries on the next incoming signature.)

### Step 6: Settle (the cascade)

Settlement follows the lead/follow order. **bank-alice** settles first: once it has seen `hold` signatures from every other bank in the deal, it applies its record pair to the balances, releases its holds, and signs `settle`.

**bank-bob** settles after observing bank-alice's settle signature — delivered bank-to-bank via `notify_signatures`, or relayed by hand (`get_record_signatures` on one bank, `notify_signatures` on the other) if a direct call got lost. Its own settle signature cites the upstream one's hash in `Signature.seen`: a verifiable proof chain that the upstream leg settled first.

The deal is done.

### Final balances

| Account | Voucher | Bank | Balance |
| --- | --- | --- | --- |
| Alice (issuer) | "1 logo" | bank-alice | **-1** (issued by her own Order) |
| Bob            | "1 logo" | bank-alice | **+1** (he received) |
| Bob (issuer)   | "1 hour" | bank-bob   | **-1** (issued by his own Order) |
| Alice          | "1 hour" | bank-bob   | **+1** (she received) |

Sum per Voucher = 0. The cryptographic version of "we're even."

### The risk

What if bank-bob refuses to settle after bank-alice already did? Alice's logo moved; Bob's hour didn't. This is the **lead/follow risk**, and it is **accepted by design**. The protocol has no rollback. In our trust model, Alice knows Bob (or his bank operator) personally. She yells at him. The protocol records the deal; it does not arbitrate it.

For multi-party rings and complex graphs, the same machinery scales: every holder signs their own Order, the coordinator creates the records and clears each Order with a Mandate, and the banks settle themselves in topological order — leads first, then followers, each citing upstream proof in `Signature.seen`. The coordinator is the only party that knows the full graph; each bank sees only the records that satisfy the Orders it stores — its own leg plus the counter-legs listed in those Orders' Mandates.
