---
title: How it works
---

A barter.game trade is a cascade of signed documents across independent banks. Here's a bilateral swap — the simplest case — step by step.

## The setup

**Alice** banks at `bank-alice`. She issues "1 logo" — a voucher to design one logo.
**Bob** banks at `bank-bob`. He issues "1 hour" — a voucher to do one hour of consulting.

Neither has to *run* their bank — an account at a bank they trust is enough, though either could operate one. Alice and Bob agree to trade 1 logo for 1 hour. They happen to know each other here, but they needn't — each only has to trust the *other's voucher issuer* and the bank that settles it.

## Step 1: Publish intent

There is no mint step. Alice presents her signed Voucher doc plus two Account docs to bank-alice via `submit_docs` — one account for the "1 logo" voucher she gives, one for the "1 hour" voucher she wants. Then she signs an **Order**: debit 1 logo from her issuer account, credit 1 hour to her receiving account, at rate 1:1. Because she is the issuer, her Order is allowed to drive the issuer account **negative** — that negative balance is how vouchers come into existence. The same mechanism that moves value creates it.

She submits the same signed Order to both banks (each bank checks only the side whose voucher it issues) and asks bank-alice to publish a discovery **Offer** — a bank-signed derivation of the Order that exposes its terms while hiding her identity and account hashes.

Bob does the mirror image: his Order gives 1 hour, gets 1 logo.

There is no "open account" call anywhere in the protocol. Accounts come into existence the first time an Account doc is presented to a bank; the bank stores the doc by hash after verifying the holder's signature. Account names stay private to the holder.

## Step 2: Discovery

A **coordinator** finds the match. A coordinator is any keypair — often just the web app of one of the traders, here Alice's. It scans `list_offers` on the banks, finds two Offers on opposite sides of the same trade, and reads each Offer's `order` field to obtain the two holder **Order hashes**. Those hashes — never the Offers — are what the rest of the deal is built on.

## Step 3: Records

The coordinator asks each bank to create the records that connect the Orders:

1. It calls `create_records` on **bank-alice** (`giver`: Alice's Order, `receiver`: Bob's Order, `amount: 1`, `counter_amount: 1`, plus a fresh `deal_id`). Bank-alice mints one debit/credit record pair for "1 logo" — debit Alice, credit Bob — each record carrying the mandatory `pair` ULID of its twin, with the `deal_id` and the coordinator's pubkey sealed inside the record details.
2. It calls `create_records` on **bank-bob** with `giver`/`receiver` swapped, minting the "1 hour" pair — debit Bob, credit Alice.
3. Each bank validates the amounts against **both** Orders' `min`/`max` windows and rates before minting, and returns the record bodies. The records sit in state `created`.

## Step 4: The Mandate

Records don't move until the coordinator clears them. For each Order at each bank, the coordinator signs a **Mandate** — "here is every record in this deal that satisfies this Order, across all banks" — and sends it with the record bodies via `submit_mandate`.

Each bank verifies the coordinator's signature, checks that its own records were created for this `deal_id` by this coordinator, verifies the foreign record bodies against their minting banks' signatures, and validates the Order's conditions — including the rate — over the **full** record set. Only a Mandate signed by the same coordinator that created the records is accepted: knowing a `deal_id` is not enough to hijack a deal.

## Step 5: Ready and hold

From here, **the banks advance on their own** — nobody runs a hold or settle command.

Once a bank has a valid Order bound to its records and the Mandate for that Order, it issues a `ready` signature per record — checking that the debit account has enough free balance (or that the holder is the issuer authorizing a negative balance). Ready signatures travel bank-to-bank via `notify_signatures`; banks find each other through the `bank` fields in the Orders and the Address registry.

Then the holds. Alice's Order carries `lead: true`, so **bank-alice** is the lead: it locks its debit accounts and signs `hold` once every record in the deal is `ready`. **bank-bob** is a follower: it holds only after verifying the lead's `hold` signature. A held account cannot be debited by another deal until the hold is released by settlement or rejection. (A hold conflict just blocks quietly; the bank retries on the next incoming signature.)

## Step 6: Settle (the cascade)

Settlement follows the lead/follow order. **bank-alice** settles first: once it has seen `hold` signatures from every other bank in the deal, it applies its record pair to the balances, releases its holds, and signs `settle`.

**bank-bob** settles after observing bank-alice's settle signature — delivered bank-to-bank via `notify_signatures`, or relayed by hand (`get_record_signatures` on one bank, `notify_signatures` on the other) if a direct call got lost. Its own settle signature cites the upstream one's hash in `Signature.seen`: a verifiable proof chain that the upstream leg settled first.

The deal is done.

## Final balances

| Account | Voucher | Bank | Balance |
| --- | --- | --- | --- |
| Alice (issuer) | "1 logo" | bank-alice | **-1** (issued by her own Order) |
| Bob            | "1 logo" | bank-alice | **+1** (he received) |
| Bob (issuer)   | "1 hour" | bank-bob   | **-1** (issued by his own Order) |
| Alice          | "1 hour" | bank-bob   | **+1** (she received) |

Sum per Voucher = 0. The cryptographic version of "we're even."

## The risk

What if bank-bob refuses to settle after bank-alice already did? Alice's logo moved; Bob's hour didn't. This is the **lead/follow risk**, and it is **accepted by design**. The protocol has no rollback. In our trust model, Alice knows Bob (or his bank operator) personally. She yells at him. The protocol records the deal; it does not arbitrate it.

For multi-party rings and complex graphs, the same machinery scales: every holder signs their own Order, the coordinator creates the records and clears each Order with a Mandate, and the banks settle themselves in topological order — leads first, then followers, each citing upstream proof in `Signature.seen`. The coordinator is the only party that knows the full graph; each bank sees only the records that satisfy the Orders it stores — its own leg plus the counter-legs listed in those Orders' Mandates.
