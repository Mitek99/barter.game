# barter.game protocol — Settlement mechanics

This file defines how a mutual-credit deal actually settles: the `Signature`
action vocabulary (`ready` / `hold` / `settle` / `reject`), the Mandate's role
as the once-only, complete unit of work, and the cross-bank handshake carried
by `Signature.seen`.

The document schemas (`Record`, `Order`, `Mandate`) are defined in
[`bank-schema.md`](./bank-schema.md); the generic `Signature` shell and the
domain-independent meaning of `seen` are in [`base.md`](./base.md) §3.1; the
RPC methods that drive all of this are in [`bank-rpc.md`](./bank-rpc.md). For
the narrative trust/risk model, see [`README.md`](./README.md) §2.

---

## 1. The settlement actions

A signature with an `action` anchors to **exactly one** target via its `hash`
field (`base.md` §3.1). The banking domain registers exactly four actions:

| Action | Signer | Target | Meaning |
|---|---|---|---|
| `ready` | bank | `hash` = a record hash | the bank's per-record limits/validity verdict |
| `hold` | bank | `hash` = a record hash | this bank's debit account is locked for this record |
| `settle` | bank | `hash` = a record hash | this bank applied this record's delta |
| `reject` | bank | `hash` = a record hash | this record is rejected; holds released |

An implementation of the banking domain MUST reject a settlement signature
carrying any other action. Action-less signatures play their own roles in the
domain (a holder's signature on an Order is the holder's authorization; a
bank's signature on an Offer or Address is a pure attestation that the bank
has stored/derived the doc).

## 2. Mandate — the replay and completeness gate

The Mandate ([`bank-schema.md`](./bank-schema.md) §1.6) is where settlement's
protection against replayed and incomplete transactions actually lives. Three
mechanisms, each checked before any record leaves `created`:

- **Replay.** The envelope replay window (`base.md` §4.1) only dedupes
  *identical* RPC calls — it says nothing about a different, validly signed
  message that tries to re-drive an old deal. The Mandate closes that hole.
  A Mandate is accepted **at most once per `(deal_id, order)`** — a duplicate
  is rejected outright. Records are minted under a fresh `deal_id` per deal
  with the coordinator's pubkey sealed into `RecordDetails`, so only that
  coordinator's Mandate can clear them (the anti-hijack binding): re-running
  an old deal's construction produces *new* records under a *new* deal, never
  a second application of the old ones. And settlement itself is once-only at
  the record level: a record's delta is applied atomically on the
  `held → settled` transition, and a later `settle` or `reject` for an
  already-settled record is a no-op — settle-first wins
  ([`bank-schema.md`](./bank-schema.md) §2).
- **Completeness.** The Mandate lists **every record satisfying the Order
  across all banks**, and the receiving bank verifies *local completeness*:
  every record it minted for `(deal_id, order)` must be listed — a Mandate
  cannot silently drop legs. For a two-sided Order the rate check runs over
  the full listed set, so a Mandate with a missing credit leg fails outright.
  An incomplete transaction therefore never advances: it either validates
  whole, or it stays in `created` until the bank's stall policy rejects it.
  Settling then applies each transfer as one atomic debit/credit pair — never
  one half alone.
- **Split-brain.** The `records` list is identical across the Mandates
  addressed to each bank (it is the Order's whole-deal footprint), so every
  bank checks the same set and a coordinator telling different banks different
  stories is caught by the bank whose slice disagrees.

`seen` (§3) plays a different, complementary role: it does **not** protect
against deal replay — that is the Mandate's and the state machine's job, as
above. `seen` protects the **signature cascade**: it binds each
`hold`/`settle` to *this* deal's signatures, so a signature replayed from a
different deal fails the containment check below.

## 3. `seen` binds the cascade to one deal

`seen` is the load-bearing field for multi-party settlement. Each
`hold`/`settle` a bank issues lists the hashes of the **prior signatures it
verified** before advancing — so the signatures of a deal form a causal chain
rooted in `ready` sigs (the generic partial-order semantics of `seen` are in
`base.md` §3.1), and every `ready` anchors (via its `hash`) to a **record**,
whose hash is unique to the deal (records carry ULIDs). A later signature that
transitively cites a set of `ready` sigs is therefore committing to *those
specific records* — i.e. to *this* deal — and nothing else.

This is what makes a signature **non-replayable across deals without a public
deal tag.** A bank never advances on "any settle from that signer"; it
advances only when the upstream signature it received *cites this deal's own
signatures in its `seen`*. A `hold`/`settle` minted in a different deal
carries that deal's hashes and fails the containment check below. (There is no
`deal_id` in a Signature — the binding is the chain, so topology stays
private.)

## 4. The two-bank settlement handshake

For a bilateral deal across two banks, one bank hosts the **lead** transfer
and the other the **follow** transfer. (A *transfer* is a debit/credit pair of
one voucher, both records at that voucher's issuing bank; it is *lead* iff its
debit-side `Order.lead` is `true`.) Let `R` be the deal's full record set —
every bank can enumerate `R` from the Mandates it holds (`bank-schema.md`
§1.6) and gather each record's signatures from the peers' fan-out.

1. **ready** — each bank validates each of its own records against that
   record's Order (`bank-schema.md` §1.4) and issues `ready(r)` with
   `seen = []`. Banks fan `ready` sigs out to the peer.
2. **hold** —
   - **lead**: once *every* record in `R` carries a `ready` (its own plus the
     peer's), it locks its debit accounts and issues `hold(r)` for each own
     `r` with `seen =` the hashes of **all `ready` sigs over `R`**. Fans out.
   - **follow**: on the lead's `hold`, it verifies the lead `hold` is validly
     signed **and every one of its own `ready` hashes is present in that
     `hold`'s `seen`** (this proves the lead is holding *this* deal). It then
     locks and issues `hold(r)` with `seen =` **all `ready` hashes + the lead
     `hold` hashes**. Fans out.
3. **settle** —
   - **lead**: once every record in `R` carries a `hold`, it verifies each
     follow `hold`'s `seen` **contains its own `ready`+`hold` hashes**, then
     settles each of its transfers atomically and issues `settle(r)` with
     `seen =` **all `hold` hashes over `R`**. Fans out.
   - **follow**: on the lead's `settle`, it verifies the `settle` is validly
     signed **and its `seen` contains the follower's own `hold` hashes**, then
     settles its transfers atomically and issues `settle(r)` with `seen =`
     **all `hold` hashes + the lead `settle` hashes**. Terminal.

The lead settles first, so a cautious holder can `follow` (receive before
giving) to bound counterparty risk. The containment checks are **fail-closed**:
an unverifiable or missing predecessor never advances a record — the engine
waits (and `reject` is the only abort; there is no rollback, `bank-schema.md`
§2). N-party (≥3 bank) deals generalize the same rule over each transfer's
predecessor set; that DAG is out of scope for v1 (see
`../docs/design/mandate-validation.md` §5 at the repo root).

## 5. Signer authority

`seen` proves a cascade is **fresh** and bound to this deal. It says nothing
about **who** asserted it — and record hashes and `seen` chains are public
(`get_record_signatures` is an open read). So freshness alone is not enough: a
bank MUST also check that each signature it advances on came from the party
entitled to make that claim.

For a record, that party is the **bank that minted it** — `Record.pubkey` —
which is exactly the bank the holder's own signed Order names for that side.
Concretely:

- a `ready`/`hold`/`settle`/`reject` on a **foreign** record counts only if
  signed by that record's minting bank;
- a `reject` on a bank's **own** record counts only if signed by that bank
  itself (it is the sole authority over the voucher it issues; a peer's reject
  arrives on the peer's own record and cascades from there);
- a signature whose target record cannot be resolved MUST be ignored — fail
  closed.

Without this, any keypair can self-sign `ready`, `hold`, and `settle` anchored
to the lead bank's record hashes, with correct `seen` containment copied from
public reads, and walk a follow bank through the entire cascade — releasing
the follower's goods with no counterparty bank ever participating.

> **Invariant:** `Signature.seen` carries the cascade proof. A bank MUST NOT
> issue `hold`/`settle` for a record until it has verified **both** that the
> upstream signature **cites this deal's own signatures in its `seen`** (own
> `ready` ⊆ lead `hold.seen` before follow-hold; own `hold` ⊆ lead
> `settle.seen` before follow-settle; and the symmetric lead-side checks)
> **and** that the signature is signed by the record's minting bank. Freshness
> without authority, or authority without freshness, is a protocol violation —
> as is advancing on a signature bound by neither, e.g. the newest `settle`
> from a signer regardless of deal. The exactly-one-target rule for actioned
> signatures is protocol.
