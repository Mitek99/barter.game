# Mandate validation in multi-leg deals — analysis & resolution

*2026-07-06. Follow-up to the owner's question: what must a bank validate when Mandates join several Orders — e.g. `A→B, B→C, B→A`, or a chain `A→B→C`? Resolved per the owner's model: **the Mandate carries every record satisfying the Order, across all banks** — implemented; remaining open questions in §5.*

## 1. The validation principle (corrected)

A bank validates **every Order its records reference**, and for each Order it must verify **both sides — and the rate — in full**, even when one side's voucher lives at another bank. The information to do that is supplied by the Mandate:

> `Mandate.records` lists **every record satisfying `Mandate.order` in the deal, across all participating banks**, and the coordinator passes all the record **bodies** alongside (`submit_mandate(mandate, records)`).

This works because record bodies were designed to be shareable: they are **bank-signed** (the minting bank's attestation of the amount and side), **content-addressed**, and their `details` — holder, account, pair, deal binding — sit behind an opaque hash. A bank reading a foreign record for an Order it already holds learns *only* the foreign leg's amount and direction: exactly what the rate check needs, nothing about foreign holders or accounts. (`get_record_signatures` already serves bodies publicly; this is the same exposure.)

So the earlier "local aggregates vs. deal-wide aggregates" split was wrong: with the full record set in hand, **the rate is an ordinary, locally-computable check** — `Σ debit / Σ credit ≤ rate` over the mandated set, foreign legs included. What stays genuinely local-per-side are account bindings and balance coverage (each bank enforces them for the voucher it issues) and per-side cumulative limits (an Order's debit side lives wholly at one bank).

## 2. Why the coordinator can't cheat this

- **Foreign records are unforgeable** — signed by their minting bank; the validating bank checks the signature against the bank pubkey the *holder's own Order* names for that side (pinned in the signed doc).
- **Omission fails closed** — a two-sided Order whose Mandate lists no credit-side records fails the rate check outright (`credit = 0`), so the *missing-leg attack* (mandating only the give side of a `lead` Order) now rejects instead of settling one-sided.
- **Local completeness is enforced** — a bank rejects a Mandate that omits any record it minted for `(deal, order)`, so legs can't be silently dropped.
- **Split-brain Mandates are caught** — the record list is the Order's whole-deal footprint and is the same at every addressed bank; a coordinator sending different lists is exposed at whichever bank's own slice disagrees.

## 3. The worked cases

### `A→B, B→C, B→A` — three Orders at one bank
Legs `B→C`, `B→A` are B's voucher (bank **V_B**); `A→B` is A's voucher (bank **V_A**). V_B holds records referencing three Orders — B's (both debits), C's (credit), A's (credit) — and validates each: per-record windows and accounts locally, cumulative limits locally, and **B's rate `(β+γ)/α ≤ B.rate` numerically**, because B's Mandate lists the foreign `A→B` record (amount α, bank-signed by V_A) alongside the two local debits. Symmetrically V_A validates B's rate from its side.

### `A→B→C` — the pass-through holder
Cross-voucher chain (X @ bank X, Y @ bank Y): bank Y holds B's and C's Orders; B's Mandate carries the bank-X credit record body, so B's rate is again fully checkable at Y. Same voucher throughout: everything was local already.

### Where pairwise checks still fit
`create_records` keeps the pairwise bank-asserted counter validation (both Orders' windows, both rates, same foreign voucher, `0` for one-sided pairings). It is an **early filter** — correct and complete for bilateral deals, merely partial for multi-leg topologies (compensation from a third party, per-leg totals). The authoritative both-sides check happens at Mandate time over the full set.

## 4. What this also buys: cross-bank signature binding via `seen`

The Mandate's full enumeration hands every bank the exact **record hashes** that concern its deal — its own plus the foreign legs. That enumeration is what lets `seen` become a **causal chain that binds settlement to one specific deal**, which is the settle-replay mitigation (resolved — see `base.md` §3.1, `bank-schema.md` §2):

- Each `ready` anchors (via `hash`) to a record whose hash is **unique to the deal**. Each `hold`/`settle` cites the prior signatures it verified in `seen`, so it transitively commits to *those* records.
- A follower advances only when the upstream signature it received **cites this deal's own signatures in its `seen`** — own `ready` ⊆ lead `hold.seen` before it holds; own `hold` ⊆ lead `settle.seen` before it settles. It never advances on "newest settle from that signer."
- A `hold`/`settle` replayed from a **different** deal (same banks, same voucher, even the same Order) carries the other deal's hashes and fails containment. So the follow bank cannot be tricked into releasing the follower's "give" without a genuine lead committing **in this deal** — and no `deal_id` goes on the wire, so topology privacy is preserved.
- **reject** rides the same enumeration: a foreign reject Signature is bound to the local deal because its `hash` is in a stored Mandate's record list, and it triggers the local cascade.

Earlier drafts considered a **Mandate-hash citation** to bind signatures to a deal. The `seen` chain achieves the same binding *without* a new field and without exposing any deal identifier, so it is preferred.

Implementation status: enumeration + rate over the full set are **live**; the `seen`-chained ready→hold→settle handshake and the deal-scoped signature gather (over the enumerated record set, replacing the newest-from-signer heuristic) are implemented in the advance engine — see `packages/bank-core/src/advance.ts`.

## 5. Open questions for the owner

1. **Record replay across deals.** A record body carries no public deal binding (`deal_id` is hidden in `details` — deliberately). A coordinator could list an *old* record of the same Order (from a previous deal) to satisfy a rate check. The `seen` handshake (§4) blunts the worst of this — an old record already settled in its own deal carries a `settle` and cannot re-settle (settlement is idempotent per record hash), and an old record can never gather *this* deal's fresh `ready`→`hold`→`settle` chain — but a never-settled record from an abandoned deal can still be *listed* to pad a rate check. Cheapest residual mitigations: banks compare the record's ULID timestamp against the `deal_id` ULID timestamp (records of a deal are minted around its creation), or the per-order cumulative limits absorb the damage. The tight fix would make some deal binding public — which trades away topology privacy. Where do you want this on the spectrum?
2. **Foreign-hash signature gates.** ✅ **Resolved.** A follower's `hold`/`settle` now waits for the peer's upstream signatures bound to *this* deal via `seen` containment (§4), replacing the newest-from-signer heuristic. Implemented in `packages/bank-core/src/advance.ts`.
3. **Mandate size.** The full-set Mandate grows with the Order's deal footprint (fine for realistic deals; a 100-leg merge would carry 100 bodies per Mandate). Cap, paginate, or accept?
4. **N-party (≥3 bank) generalization.** The `seen` handshake is specified and implemented for the **2-bank bilateral** case (one lead transfer, one follow transfer). A deal spanning three or more banks is a DAG of transfers where a bank may lead some and follow others, and a follow record may have several predecessors. The same `seen`-containment rule generalizes over each transfer's *predecessor set*, but computing that set requires an explicit deal dependency graph (which record's `settle` gates which) — the lead-set determination that the spec currently gives by example, not algorithm. Design the predecessor-graph representation before enabling ≥3-bank settlement.
