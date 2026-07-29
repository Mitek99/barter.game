# barter.game protocol — Bank document schemas and ledger semantics

This file defines the banking entities and the ledger invariants that operate on them:

- `Voucher`, `Account`
- `Record`, `Order`, `Offer`, `Mandate`
- `Balance` (bank-signed position statement) *(specified, not yet implemented)*
- Per-record, per-bank state machine
- Concurrency and balance semantics

For the base doc shell, `Signature`, `Address`, canonicalization, and the JSON-RPC envelope, see [`base.md`](./base.md). For the RPC method definitions, see [`bank-rpc.md`](./bank-rpc.md). The `Post` doc type is defined in [`post-feed.md`](./post-feed.md). For the human narrative and trust/settlement models, see [`README.md`](./README.md).

---

## 1. Document types

All docs share the `BaseDoc` shell defined in [`base.md`](./base.md):

```ts
type BaseDoc = {
  type: "voucher" | "account" | "credit" | "debit" | "signature" | "order" | "offer" | "mandate" | "address" | "balance" | "post";
  pubkey: Base58PubKey;
  ulid: ULID;
}
```

> **Status: specified, not yet implemented.** The `"balance"` member of the union is reserved for the Balance doc (§1.7); the reference bank does not serve this yet (tracked in TODOS.md).

### 1.1 Voucher

A unit of value the `pubkey` owner vows to deliver.

```ts
Voucher: BaseDoc & {
  type: "voucher";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  images?: MediaRef[];    // content-addressed images, "<hash>.<ext>" each;
                          // [0] icon, [1] square card by convention; at most
                          // 8 (protocol-level cap, enforced at validation).
                          // Blobs must be stored at the bank before the
                          // voucher is accepted (post-feed.md §5); a later
                          // voucher_meta release overrides. Replaces the
                          // never-used inline image_svn of early drafts.
  description_md?: string; // markdown
  due?: DateString;       // optional maturity date (ISO 8601 datetime)
  expires?: DateString;   // optional expiration date (ISO 8601 datetime)
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}
```

**`bank` is part of the Voucher hash.** Two vouchers with the same name issued at different banks are different vouchers.

> **Invariant:** The Voucher schema fields and their types are fixed in v1.

### 1.2 Account

A holder's named bucket. Accounts are BaseDocs, signed by the holder, and **stored by the bank** so the bank can validate that any record referencing the account belongs to the account's owner. The `name` remains private to the holder.

```ts
Account: BaseDoc & {
  type: "account";
  name: string;           // local label, typically not public
  voucher: Base58SHA256;  // hash of the Voucher this account holds
  public?: boolean;       // opt in to third-party balance/history reads
                          // (default false; specified, not yet implemented)
}
```

`Account.pubkey` is the holder. `Account.ulid` uniquely identifies this account. The holder signs the Account doc; the bank stores it by hash after verifying the signature.

**Visibility.** Accounts are private by default: a bank MUST NOT disclose an account's balance or record history to anyone but its holder — and the Voucher's issuer, who may read the position of any account denominated in their own voucher via `get_account_balance` ([`bank-rpc.md`](./bank-rpc.md) §2.4). The issuer's voucher-wide record export, `list_voucher_records` (the backup path, [`bank-rpc.md`](./bank-rpc.md) §2.4), extends that read to full history. Setting `public: true` opts the account into third-party reads — it appears in `list_public_balances` and any caller may read its balance and records ([`bank-rpc.md`](./bank-rpc.md) §2.4, [`discovery.md`](./discovery.md) §6). Going public discloses the balance facts (holder pubkey, voucher, account hash, amounts) — the account `name` stays private either way.

> **Status: specified, not yet implemented.** The `public` opt-in, `list_public_balances`, and `list_voucher_records` are not served by the reference bank yet (tracked in TODOS.md); the shipped allow-list is exactly the holder and the voucher's issuer, via `get_account_balance`.

> **Invariant:** A bank MUST reject a record whose `details.account` hash does not resolve to a stored Account owned by the record's holder. Account names are private, but the Account doc itself is part of the bank's verified state.

### 1.3 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
Record: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  order: Base58SHA256;    // hash of the Order doc that authorizes this record
  details: Base58SHA256;  // hash of the bank-internal record details
}

RecordDetails {
  pair: ULID;             // ULID of the peer record (set by the bank at creation)
  deal_id: ULID;          // deal-wide identifier supplied by the coordinator
  coordinator: Base58PubKey; // pubkey of the coordinator that called create_records
  holder: Base58PubKey;   // pubkey of the holder
  account: Base58SHA256;  // hash of holder's Account doc
}
```

`deal_id` and `coordinator` are sealed inside `RecordDetails`, so only the
`details` **hash** appears on the public `Record`. A record can therefore only
be advanced by a `Mandate` (see §1.6) signed by the same `coordinator` pubkey
the bank sealed in at creation: knowing a `deal_id` is not enough to act on the
records, because the actor must also hold the coordinator's private key.

A **transfer** is one debit + one credit of the same Voucher for the same `amount`: value leaves the debited holder's account and lands in the credited holder's account, both at that Voucher's issuer bank. `pair` links the two halves by ULID. Transfers **chain** when the holder credited by one transfer is the holder debited by another — that holder is passing value along (`A → B → C`). The chain may be a line, a ring, or a general graph, spanning one bank or many.

Records are **bank-minted**: the bank assigns their ULIDs and ensures uniqueness. As BaseDocs, they have content hashes. The Order → record binding lives in `Record.order`. Banks sign `Signature` docs (see `base.md`) referencing Records by hash; holders do not sign Records directly.

For a normal transfer, the debit record references the giver's Order and the credit record references the receiver's Order. A bank MUST verify that every record it approves is covered by a valid Order, and for paired records it MUST verify that the referenced Orders describe mutually consistent terms and amounts.

### 1.4 Order

A **signed instruction that authorizes a bank to process specific records on the holder's behalf**. Orders are the only holder authorization primitive in v1. A holder creates an Order describing what they are willing to give and/or receive, signs it, and presents it to every bank that issues a Voucher referenced by the Order.

```ts
Order: BaseDoc & {
  type: "order";
  rate: number;             // debit_amount / credit_amount; must be positive
  debit?: {
    account: Base58SHA256;  // account to debit
    voucher: Base58SHA256;  // voucher being given
    bank: Base58PubKey;     // the bank of the voucher
    min: number;            // minimum amount to debit per match; prevents fragmentation
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    account: Base58SHA256;  // account to credit
    voucher: Base58SHA256;  // voucher being received
    bank: Base58PubKey;     // the bank of the voucher
    min: number;            // minimum amount to credit per match; prevents fragmentation
    max: number;            // maximum amount to credit per match
  };
  debit_order_limit?: number;    // maximum cumulative debit amount processed through this order
  credit_order_limit?: number;   // maximum cumulative credit amount processed through this order
  debit_account_limit?: number;  // minimum balance allowed on the debit account (optional floor)
  credit_account_limit?: number; // maximum balance allowed in the credit account; prevents overstocking
  lead: boolean;            // if true, holder authorizes lead role for matched Records
}
```

`Order.pubkey` MUST equal `pubkey` of each referenced Account.

When a bank receives an Order, it MUST validate the `rate`:

- `rate` MUST be a positive number.
- `rate` is the **maximum acceptable ratio of debit voucher to credit voucher** for the whole deal. Before issuing `ready` on any record tied to a two-sided Order, the bank aggregates **all records of the deal** matched to that Order and verifies that `total_debit / total_credit <= rate` (within the bank's rounding policy). It does not enforce the rate on individual record pairs or on one-sided Orders.
- If the Order is one-sided (invoice or cheque), `rate` is informational and MUST still be positive.

An Order may reference Vouchers at **different banks**. The holder submits the same signed Order to each of those banks; each bank checks only the side that involves a Voucher it issues. The `bank` field on each side tells a bank which bank issues the other voucher, so it can discover the counterparty's Address in the registry and validate that bank's signatures without seeing the foreign Voucher doc.

**`lead` flag.** `lead: true` means the holder authorizes their bank to act as the **lead party** in any deal where this Order is matched: the lead bank may hold and settle its records before peer banks have locked or settled. `lead: false` means the holder's bank is a **follower**: it must wait for the lead bank's `hold` signature before locking its own debit accounts, and for the lead bank's `settle` signature before settling. A bank learns which peer bank is lead by inspecting the `lead` flag and the side `bank` fields on the Orders it has stored; in a two-bank swap, the bank whose holder's Order is `lead=true` is the lead bank.

**Specializations.** Omitting one side produces the two authorization shortcuts. These are not separate doc types — they are Orders with a missing side:

- **Invoice** — an Order with `debit` omitted. It authorizes an unconditional credit to the holder; anyone may attach it to a transfer to move funds to the invoice holder.
- **Cheque** — an Order with `credit` omitted. It authorizes an unconditional debit from the holder; whoever has the cheque may attach it to a transfer to pull funds.

Public Offers for cheques make sense in airdrop scenarios; public Offers for invoices make sense in fundraising or charity scenarios.

**Order-Record matching.** A Record `R` matches an Order `O` when all of the following hold:

1. `R.order` resolves to the holder Order `O` (a valid, stored, signed Order).
2. `R` is a `debit` record and `O.debit` is present, OR `R` is a `credit` record and `O.credit` is present.
3. `R.details.holder` equals `O.pubkey`.
4. If `R` is a debit, `R.details.account` equals `O.debit.account`.
5. If `R` is a credit, `R.details.account` equals `O.credit.account`.
6. `R.amount` is between the corresponding `min` and `max`.
7. If `O` is two-sided, the bank verifies `debit_amount / credit_amount <= O.rate` (within the bank's rounding policy). When both sides of `O` are vouchers this bank issues, both amounts are local records. When `O` spans two banks, this bank holds only one side's records — but it holds **both Orders** of the pairing, so the counter amount is **bank-asserted**: at `create_records` it must lie inside both Orders' min/max windows for the foreign side and satisfy both rates (see `bank-rpc.md` §2.2). The holder's per-side `min`/`max`, enforced by whichever bank owns that side, remains the hard per-record bound.
8. The cumulative debit amount across all Records already matched to `O` does not exceed `O.debit_order_limit` (if set).
9. The cumulative credit amount across all Records already matched to `O` does not exceed `O.credit_order_limit` (if set).
10. The resulting balance of the debit account does not fall below `O.debit_account_limit` (if set).
11. The resulting balance of the credit account does not exceed `O.credit_account_limit` (if set).

If an Order matches, the bank treats it as equivalent to a holder authorization for the purposes of the ready/hold/settle waves. Specifically:

- During **ready**, the holder's bank checks that the `debit` account has enough **free balance** (current balance minus any existing holds) to cover the proposed debit, unless the holder is the issuer authorizing a debit from the issuer account. For two-sided Orders, the bank also checks the aggregate rate (`total_debit / total_credit <= rate`) and cumulative limits across all deal records matched to the Order. If all checks pass, the bank issues a `ready` signature on the matched **Record** on behalf of the Order; if not, it rejects.
- During **hold**, the bank locks the debit amount as it would for any authorized record.
- During **settle**, the bank applies the balance change and releases the hold.

A holder cancels an Order by emptying its `debit` account; the bank then has no available balance to ready against. Because Orders have no expiration, they remain on the ledger indefinitely, limited only by account balance.

### 1.5 Offer

When a bank receives an Order and the referenced Account objects, it MAY create a derived **Offer** doc on behalf of the bank. The Offer exposes the Order's trading terms while hiding the holder's identity and account hashes.

```ts
Offer: BaseDoc & {
  type: "offer";
  pubkey: Base58PubKey;     // bank's pubkey
  order: Base58SHA256;      // hash of the original order
  rate: number;             // debit_amount / credit_amount
  debit?: {
    voucher: Base58SHA256;  // voucher being given
    bank: Base58PubKey;     // bank that issues the debit voucher
    min: number;            // minimum amount to debit per match
    max: number;            // maximum amount to debit per match
  };
  credit?: {
    voucher: Base58SHA256;  // voucher being received
    bank: Base58PubKey;     // bank that issues the credit voucher
    min: number;            // minimum amount to credit per match
    max: number;            // maximum amount to credit per match
  };
  lead: boolean;            // copied from the original Order: true if the represented Order is lead
}
```

Banks MAY publish Offers through their public API. **Offers are a discovery-only surface:** a coordinator scans Offers (`list_offers`), reads each Offer's `order` field to obtain the underlying holder **Order hash**, and references *that Order hash* — never the Offer hash — when calling `create_records` (see `bank-rpc.md`). The Offer's `rate`, `min`/`max`, and `lead` are advisory copies of the Order's terms; the bank validates against the resolved Order, which it already holds because the holder submitted it via `submit_docs`.

A Record's `order` always references the authorizing **Order** hash (one holder-signed doc with a single canonical hash, resolvable identically at every bank the Order touches). Offers are never an authorization source on the execute path. The `lead` flag the bank uses comes from the resolved Order.

Like Orders, Offers may omit one side: an Offer with `debit` omitted is an **invoice offer**, and an Offer with `credit` omitted is a **cheque offer**.

> **Invariant:** Offers are bank-issued derived documents. They are not holder signatures, but they MUST be signed by the bank's pubkey and they MUST accurately reflect the terms of the referenced Order.

### 1.6 Mandate

A **Mandate** is the coordinator-signed **unit of work** a bank validates and executes. It tells one bank: "here are the records that satisfy this one Order at your bank — validate the Order's conditions against them and proceed." It is scoped **per (Order, bank)**: a deal produces one Mandate for each Order at each bank that holds records for that Order. Banks do not advance records until they receive a Mandate that covers them.

```ts
Mandate: BaseDoc & {
  type: "mandate";
  deal_id: ULID;            // deal-wide id supplied by the coordinator (secret; sealed in RecordDetails)
  order: Base58SHA256;      // the Order whose conditions these records satisfy
  bank: Base58PubKey;       // the bank this Mandate is addressed to
  records: Base58SHA256[];  // EVERY record satisfying `order` in this deal — across ALL banks
}
```

`Mandate.pubkey` is the coordinator; `Mandate.sig` is the coordinator's signature over the canonical unsigned doc. The coordinator submits the signed Mandate **together with all the Record bodies** it lists (see `bank-rpc.md` §2.1), so the request is self-contained. Record bodies are safe to share across banks: they are bank-signed, content-addressed, and their `details` (holder, account, pair, deal binding) stay behind an opaque hash — so the bank checking an Order sees the *amounts and sides* of the Order's foreign legs without learning anything about foreign holders or accounts.

When a bank receives a Mandate:

1. Verify the coordinator's signature.
2. Verify `Mandate.bank` equals the bank's own pubkey.
3. Resolve `Mandate.order` to a stored holder Order.
4. For each hash in `Mandate.records`:
   - **Local record** (minted by this bank): verify it was created for `deal_id`, that `details.coordinator` equals `Mandate.pubkey` (the anti-hijack binding — a Mandate signed by anyone else is rejected), and that `Record.order` is `Mandate.order`.
   - **Foreign record**: the supplied body must hash to the listed value, be signed by its minting bank, reference `Mandate.order`, and be minted by a bank one of the Order's sides names. The bank stores the body.
5. Verify **local completeness**: every record this bank minted for `(deal_id, order)` is listed — a Mandate cannot silently drop legs.
6. Validate the Order's conditions against the FULL listed set: per-record `min`/`max` and account bindings on the local side (the foreign bank enforces its own side), cumulative and account limits, balance coverage, and — for a two-sided Order — the rate `total_debit / total_credit <= rate` computed over **all** listed records, local and foreign alike. A two-sided Order whose Mandate lists no credit-side records fails the rate check outright (this closes the missing-leg attack).
7. Reject a **duplicate** Mandate for the same `(deal_id, order)` — the unit of work is accepted at most once.
8. Only then may the bank advance its own records out of `created`.

The coordinator sends a Mandate per Order per bank; the `records` list is identical across the addressed banks (it is the Order's whole-deal footprint), so every bank checks the same set and a split-brain coordinator is caught by the bank whose slice disagrees.

### 1.7 Balance

> **Status: specified, not yet implemented.** The reference bank does not serve this yet (tracked in TODOS.md). Today the shipped read is `get_account_balance`, which returns an unsigned `{ current, pending }` position to the account's holder or the voucher's issuer only.

A bank-signed statement that a specific holder has a specific amount of a specific voucher on a specific account. The ledger stays authoritative — a Balance doc is a **portable attestation** of the position as of its `ulid`, verifiable by anyone against the bank's pubkey without calling the bank.

```ts
Balance: BaseDoc & {
  type: "balance";
  pubkey: Base58PubKey;    // the BANK — banks sign Balance docs
  ulid: ULID;              // issuance moment; for the same account, newer supersedes older
  account: Base58SHA256;   // Account hash
  voucher: Base58SHA256;   // Voucher hash
  holder: Base58PubKey;    // the account's holder
  amount: number;          // settled balance at issuance
  pending?: number;        // amount locked by active holds, if any
}
```

Balance docs are issued on demand (`get_balance`) and served for public accounts (`list_public_balances`) — see [`bank-rpc.md`](./bank-rpc.md) §2.4 *(both methods specified, not yet implemented)*. Like all signed docs they are irrevocable; a Balance is a true statement *about the moment it was issued*, and a newer ULID for the same account supersedes it. Banks MUST NOT issue a Balance for a non-public account to anyone but its holder or the Voucher's issuer.

Use cases: a holder proving a position to a counterparty; public holdings in discovery ([`discovery.md`](./discovery.md) §6); an issuer's backup snapshots alongside `list_voucher_records`.



## 2. State machine (per-record, per-bank)

Each bank runs its own state machine over each record it owns. Records are created by the coordinator via `create_records`; they stay in `created` until both (a) valid Orders are bound and (b) a `Mandate` for the record's Order arrives. From `approved` onward the bank advances **itself**, re-evaluating on every event (a `submit_docs` binding an Order, a verified signature arriving via `notify_signatures`).

```
   per-record state (per bank)

   created ── create_records ──▶ all records minted

   submit_docs + submit_mandate (by coordinator/holders → bank)
        │
        ▼
   ┌──────────┐
   │ approved │  every owned Record has a valid Order bound and the Mandate
   └────┬─────┘  for its Order is received. The bank now knows the deal's FULL
        │        record set R (union of its Mandates' record lists) and
        │ advance │ gathers each record's signatures — its own, plus peers'
        │ engine  │ signatures delivered by fan-out (indexed by record hash).
        │        │ `ready` issued per record after Order validation; fanned out.
        ▼
   ┌──────────┐   HOLD is a cross-bank handshake carried by `seen` (`base.md` §3.1):
   │  held    │   • LEAD holds once EVERY record in R is `ready`; its `hold.seen`
   └────┬─────┘     = all `ready` hashes over R.
        │         • FOLLOW holds only after the lead's `hold` arrives AND its own
        │ advance   `ready` hashes are contained in that `hold.seen`; its
        │ engine    `hold.seen` = all `ready` hashes + the lead `hold` hashes.
        ▼
   ┌──────────┐   SETTLE is gated the same way:
   │ settled  │   • LEAD settles once EVERY record in R is `held` and each follow
   └──────────┘     `hold.seen` contains the lead's own `ready`+`hold` hashes;
        │           `settle.seen` = all `hold` hashes over R. Settles first.
        │         • FOLLOW settles once the lead's `settle` arrives AND its own
        │           `hold` hashes are contained in that `settle.seen`.
        ▼         A bank settles each of its TRANSFERS (debit/credit pair)
   (deltas applied, atomically — never one half of a pair — preserving the per-bank
    holds released,  sum invariant (§3.2).
    `settle` signed)

   Any pre-settled state can transition to rejected via a bank-issued `reject` signature on the record.
```

**Why the handshake, not "newest settle from that signer".** Each `hold`/`settle` transitively cites this deal's `ready` sigs, and every `ready` anchors to a **record whose hash is unique to the deal**. So the containment checks above bind every advance to *this* deal's specific records. A `hold`/`settle` replayed from a **different** deal (same banks, same voucher, even the same Order) carries that deal's hashes in `seen` and fails the check — a follow bank therefore never releases the follower's "give" unless a genuine lead bank actually participated **in this deal**. This closes the settle-replay / cross-leg-reuse attack without putting any `deal_id` on the wire (topology stays private). The checks are fail-closed: a missing or unverifiable predecessor waits; the only abort is `reject`; there is no rollback.

**Reject semantics.** `reject` is a bank-issued `Signature` (`base.md` §3.1), created and propagated exactly like `ready`/`hold`/`settle` — holders and the coordinator play no role in settlement and MUST NOT be able to trigger a reject. A bank MUST issue `reject` on a mandated record whose precondition failure is **permanent** — order side/account mismatch, amount outside min/max, an uncovered debit with no in-deal credit that could still cover it, or a `Voucher.limit` violation. Transient shortfalls (coverage that a not-yet-held same-deal credit may provide, an aggregate rate that later records may satisfy) are not rejected; the engine waits. A bank MAY additionally `reject` a **stalled** deal on its own **timeout** — a pre-settled record whose deal has made no progress for too long — releasing its holds so the locked accounts are freed for other deals. The protocol fixes **no threshold**: timeout-based rejection is bank policy (liveness recovery), not a protocol-mandated deadline, so there is no permanent hold wedge. A reject on any record cascades: the bank rejects every remaining pre-settled record of the deal, releases its holds, and fans the reject Signatures out to the counter-side banks named by the deal's Orders. Settled records stay settled — there is no rollback.

The coordinator is the only party that calls `create_records`. Holders submit Orders (or rely on previously submitted Orders). The coordinator then sends a `Mandate` per Order per bank once record creation is complete. After that, the bank's advance engine takes over, locking when safe, settling when safe, and emitting signatures. The coordinator **does** need to ensure every bank eventually receives the signatures its predecessors emit; direct bank-to-bank `notify_signatures` does this automatically, and `get_record_signatures` + `notify_signatures` is the recovery path.

> **Invariant:** These states, their transitions, and their preconditions are protocol. The storage representation and the event loop that drives self-advancement are implementation details — but a bank MUST NOT settle without its lead/follow precondition met, and MUST NOT apply a record's delta twice.

---

## 3. Concurrency

### 3.1 Double-spend prevention

When the advance engine attempts to acquire a hold on a debit account, it aggregates all records of the **same deal** that debit that account and locks the **total** amount once. If that account is already locked by a **different** deal, the engine simply issues no hold signatures on that pass and re-attempts on later events: the deal proceeds when the competing hold releases, or is eventually rejected by a bank's own stall timeout (§2). Holds span the full participant set, but each per-account lock is independent and bank-local.

The approve-time balance check is computed net of active holds, so a deal cannot be approved against balance that another in-flight deal has locked.

> **Invariant:** At most one active hold per account per external deal MUST be enforced. Multiple records of the same deal that debit the same account share a single aggregated hold. How (database unique index keyed by account+deal, mutex, optimistic locking) is an implementation detail.

### 3.2 Mutual-credit balance semantics

- **Issuers may start trading without a mint step.** An issuer's own Order can debit the issuer account, driving it negative. This negative balance represents vouchers the issuer owes the network. The first trade creates the issuer's negative row and a corresponding positive row in the buyer's account in one debit/credit pair.
- **No negative balance on non-issuer holder-authorized transfers.** A transfer authorized by a non-issuer holder Order or by a holder Order/Offer MUST NOT drive the debit account negative. The bank rejects any Record that would overdraw the account. The `Voucher.limit` field is honored if set; otherwise issuance is unbounded.
- **Sum invariant**: across all accounts for a given Voucher, balances always sum to zero (or the agreed limit). The bank enforces this on every `settle`.

> **Invariant:** The sum invariant is the load-bearing correctness guarantee of the ledger. Every implementation MUST preserve it on every settle.
