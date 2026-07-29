# barter.game protocol — v1 overview

> **This directory is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in these files. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in these documents is an implementation detail — you may change it.
>
> If you are building your own bank or client, read this overview first, then see:
>
> - [`base.md`](./base.md) — identity, canonical JSON, `BaseDoc`, `Signature`, `Address`, the JSON-RPC envelope, replay protection, and request signing.
> - [`bank-schema.md`](./bank-schema.md) — bank document schemas (`Voucher`, `Account`, `Record`, `Order`, `Offer`, `Mandate`, `Balance` *(specified, not yet implemented)*) and ledger semantics (state machine, concurrency, balance invariants).
> - [`bank-rpc.md`](./bank-rpc.md) — the bank JSON-RPC API and REST endpoints (address directory, media vault).
> - [`discovery.md`](./discovery.md) — how parties find banks, vouchers, issuers, offers, and posts through follows (the Discover surface); public holdings are specified there but not yet implemented.
> - [`post-feed.md`](./post-feed.md) — voucher-anchored post feeds (`Post` doc, publishing, reading, moderation, the embedded media vault, voucher meta releases).
> - [`../scenarios/`](../scenarios/) — step-by-step interaction traces.
>
> The reference implementation documents its own choices in [`../apps/bank/README.md`](../apps/bank/README.md), [`../apps/web/README.md`](../apps/web/README.md), and [`../packages/protocol/README.md`](../packages/protocol/README.md).

A federated mutual-credit ledger enabling multi-party barter deals where parties issue Vouchers for their goods and services and exchange them with others. A deal is a chain of paired credit/debit transfers — one or more holders moving Vouchers among themselves across one or more banks — completed via signed JSON-RPC, ending with every participating bank agreeing on the new balances.

The simplest non-trivial deal is bilateral: two holders at two banks swap. But the same machinery covers a single holder moving value inside one bank, a three-party ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What never changes: a deal is a set of credit/debit pairs, each holder authorizes their own view of it by signing **their own Order**, and one or more **lead** banks settle first while everyone else follows.

### Core concepts: Voucher, Issuer, Holder, Bank

A **Voucher** is a signed, content-addressed document in which one party (the **Issuer**) commits to deliver a specific good or service — "1 logo," "1 hour of consulting," "a hand-drawn portrait." The Voucher is bound to a single **Bank** (an ed25519 keypair operating a ledger) that tracks every unit of that Voucher issued, held, and transferred.

- **Issuer**: the owner of the Voucher. The issuer decides what the Voucher means and how many may exist. The issuer is personally accountable for redemption.
- **Holder**: any user with a positive balance in an Account for that Voucher. Holders trade Vouchers among themselves; they are not accountable for the issuer's delivery, only for their own ledger position.
- **Bank**: the ledger operator whose pubkey appears in `Voucher.bank`. The bank is the sole source of truth for balances of that Voucher. It stores the docs presented to it, verifies signatures, and applies transfers. **The artifacts a bank creates under its own key are ledger records, signatures, and the statements it derives from stored docs** — discovery `Offer`s, per-voucher meta, and the bank-signed repost `Post`s that seed its host feed ([`post-feed.md`](./post-feed.md)). It does not guarantee the issuer's performance — that trust is social, out-of-band.

A **transfer** moves a Voucher from one holder to another. The debit holder's balance decreases; the credit holder's balance increases. The sum across all Accounts for a given Voucher is always zero.

**Issuers start trading without a mint step.** An issuer's own Order can debit the issuer account, driving it negative. That negative balance represents vouchers the issuer owes the network; the first buyer's account is credited in the same debit/credit pair. There is no separate mint operation.

---

## 1. Trust model

barter.game v1 is built on three behavioral assumptions. They are not enforced by cryptography; they are the social substrate that makes the protocol's risk posture coherent.

1. **Users already know the issuers of the Vouchers they hold.**
   Trust formation is out of band — DM, in-person, group chat. The protocol ships discovery surfaces for *facts* — voucher registries, Offers, profile QR bundles, post feeds and the follows-based Discover galleries, voucher meta ([`discovery.md`](./discovery.md), [`post-feed.md`](./post-feed.md)) — but it does not rate issuers, rank search results, or verify goods/service delivery. Deciding whom to trust stays human. Balances are not a discovery surface: a bank discloses an account's balance only to its holder or the Voucher's issuer (public holdings are specified in [`discovery.md`](./discovery.md) §6 but not yet implemented).

2. **Trust is socially enforced.**
   If Alice delivers and Bob ghosts, Alice yells at Bob. The protocol records the deal cryptographically; it does not arbitrate. Recourse is human, not algorithmic.

3. **Bank operators are accountable to their issuers and holders.**
   Anyone can run a bank, but the issuers who route their Vouchers through it and holders have to trust the operator. An operator can erase its ledger or abort transactions — there is no cryptographic prevention — but it cannot forge a plausible alternative history alone, because every deal requires holder signatures.

### 1.1 v1 openness

Banks are open by default. The v1 reference posture:

- Banks allow **any** Voucher to be registered by its issuer.
- Banks accept new ledger records for new accounts and new vouchers; they only check that the voucher references the bank.
- Banks accept and store docs/signatures linked to vouchers that reference this bank. `Voucher`, `Address`, and `Signature` docs are accepted **from anyone** — the sender of the request need not be the doc's owner (counterparties legitimately present each other's Vouchers and relay each other's signatures). `Account`, `Order`, and `Post` docs MUST be submitted by their signing owner: `submit_docs` rejects them when the sender is not the doc's `pubkey`.
- All calls to bank APIs are signed by the sender's key. Moderation is **key-blocking**, not gatekeeping: banks MAY refuse or rate-limit service to spammers and abusers based on their pubkey.

> **Extensibility:** Implementers MAY add additional trust, reputation, KYC, or audit mechanisms on top of the protocol. Such extensions MUST be backward-compatible: they must not prevent a client and bank from interacting using only the base v1 wire format.

---

## 2. Settlement model — coordinator-created records, Order authorization, lead/follow

A deal executes in three waves: **ready → hold → settle**. Records are created by a coordinator, authorized by holder Orders, and cleared by a coordinator `Mandate` (one per Order per bank). Banks self-advance as signatures arrive, and there is no client `hold` or `settle` call.

### 2.0 Three-wave execution model: ready → hold → settle

**1. Ready** — A bank issues a record-level `ready` signature on each of its own Records when it has:

- a valid `Order` bound to the record, **and**
- a `Mandate` from the coordinator for that record's Order, **and**
- sufficient coverage on the debit account.

Authorization is independent per holder: Alice can submit her Order without waiting for Bob. Authorization comes from:

- A matching signed `Order` doc (see `bank-schema.md`). When a holder is represented by an Order, the holder's bank issues `ready` on the matched Records on the holder's behalf, checking at ready time that the relevant accounts have sufficient free balance (or that the holder is the issuer authorizing a negative balance).
- A matching `Offer` doc (see `bank-schema.md`) — a bank-issued derivation of an Order. The underlying Order still provides the authorization.
- An invoice or cheque specialization of an Order or Offer (one side omitted, see `bank-schema.md`).

**2. Hold** — `ready` signatures are sent directly to peer banks (or relayed by any party), so every bank can see which records are approved. A bank holds its own records in a deal when all of its records are `ready` and:

- the authorizing Order has `lead=true`, **or**
- the authorizing Order has `lead=false` and the lead bank's `hold` signatures on the corresponding records have been verified.

A bank may issue a `hold` only if the debit is covered. Coverage means either:

- the account has enough available balance after existing holds, **or**
- the account will receive a credit in this deal that has already been held by this bank.

Issuers are the exception: an issuer's own Order may debit the issuer account below zero, representing vouchers the issuer owes the network. No separate mint step exists.

The bank MUST NOT hold an amount that would make a non-issuer account's effective balance negative. If several debits compete for the same available balance or held credit, the bank SHOULD prefer debits whose covering credit is in the same holder Order.

If a record cannot be held — because its debit is uncovered, the account is unknown, `reject` received for any record the Order depends on, or any other precondition fails — the bank MUST issue a `reject` signature for that record. The reject propagates to the record's paired counterpart and is fanned out to peer banks; any bank that has records depending on the rejected ones MUST reject those as well. A single reject therefore aborts the deal cascade.

**3. Settle** — settlement is an ordered cascade of record-level signatures, not a single atomic flip:

- a **lead** bank settles first on its own records — but only once it has observed `hold` Signatures on the corresponding records from **every other bank in the deal**, so the whole graph is locked before anyone moves;
- a **follow** bank settles on its own records only after it has verified record-level `settle` Signatures from **every one of its predecessors**, and cites their hashes in its own settle's `Signature.seen` (see `base.md`).

Settling means: apply the deltas of every owned record, release the holds, issue `settle` signatures, fan out.

> **Implementation note:** The coordinator calls `create_records` on each bank referencing the two holder **Order hashes** (`giver`, `receiver`) plus `amount` / `counter_amount` and a shared `deal_id`. Each bank mints one debit/credit record pair for the Voucher it issues (a same-bank swap takes two calls with `giver`/`receiver` swapped). The coordinator then sends a `Mandate` per Order per bank — naming the Order and listing EVERY record satisfying it across all banks — together with all the record bodies, so each bank can validate both sides of the Order (including the rate) from bank-signed records. Holders submit their docs via `submit_docs` (or have already submitted them). Once a bank has both the `Mandate` and the valid Order for its records, its advance engine issues `ready`, then `hold`, then `settle` automatically as preconditions are satisfied.

### 2.1 Authorization sources

A bank advances a record only when it has valid authorization — a holder-signed Order — for every **Record** (credit or debit) touching a holder's account, and a coordinator `Mandate` for that record's Order. See `bank-schema.md` for the doc shapes and `bank-rpc.md` for how `submit_docs` and `submit_mandate` resolve them.

### 2.2 Risk — lead and follow

The lead set is whichever holders must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead settles first on its own records; the follower settles on its own records once the lead's record-level `settle` signatures arrive — delivered bank-to-bank via `notify_signatures`, or relayed by any party as the fallback.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A's bank, B's bank}`. After they settle, C's bank settles `C → D`, then D's bank settles `D → A` and `D → B`, closing both cycles.

If any downstream bank refuses to apply (compromise, malice, downtime), every record that already settled stays settled: their vouchers moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank owns only its own records

**No bank ever sees the whole deal's private substance.** A bank *operates on* only the transfers of the vouchers *it issues* — "this much of my voucher leaves holder X; this much arrives at holder Y." It only ever locks, applies, and signs records whose `pubkey` is its own; this falls straight out of the issuer-authority rule: a transfer of voucher `P` lives entirely at `P`'s issuer bank, and every record carries `pubkey =` `P`'s issuer bank.

The **coordinator** is the one party that legitimately knows the whole deal — it designed it. To let each bank validate its slice, the Mandate flow (`bank-rpc.md` §2.1) does hand a bank the **bodies of foreign records** listed in the Mandates addressed to it — but those bodies expose only the mechanical terms: type, amount, the Order they satisfy (an Order this bank already holds — Orders are submitted to every bank they touch), and the opaque `details` hash. What never leaves a record's own bank is its `RecordDetails` body: the account hash, the `pair` ULID, and the `deal_id`. Concretely, per bank:

- **Full knowledge:** its own records and their `RecordDetails`.
- **Terms only:** foreign record bodies from Mandates — types, amounts, and Order references, needed for the cross-set rate check; accounts and deal grouping stay behind the opaque `details` hash.
- **Routing:** the pubkeys of the peer banks named by the deal's Orders (so it can verify their record-level signatures, see `base.md`). It learns *that* a peer bank participates and *what quantities* move, not which accounts they touch.

> **Invariant:** This visibility boundary is load-bearing. `RecordDetails` bodies MUST NOT be disclosed to other banks; a foreign bank sees a record's details only as an opaque hash.

### 2.4 Signature fan-out — Bank-to-bank direct, with client relay

Banks advance on **signatures**, wherever they come from. In the reference flow, banks discover each other via the `bank` fields in Orders and call each other directly using the Address registry:

- **Bank-to-bank direct** (the reference default): a follow bank looks up the lead bank's `Address` doc, then calls its `notify_signatures` endpoint with the signed `hold` / `settle` signatures it needs. The receiver verifies the signatures independently and advances its own records.
- **Client relay** (the floor): signatures carry their own authority — signer pubkey plus an ed25519 signature over the doc — so *anyone* may deliver them. A client can read one bank's signatures (`get_record_signatures`) and hand them to another (`notify_signatures`). A lost direct call is recovered by relay.

Every received-and-verified signature re-evaluates the bank's advance engine for the records it touches.

---

## 3. Invite strings and deep links

Both OOB handoffs carry signed, self-validating content: the receiver verifies signatures before trusting anything — an invite string validates before any network call; a deep link's document bundle validates on fetch. Tampering invalidates either.

### 3.1 Invite strings

The inviter's offer:

```
barter://<inviter-pubkey>@<inviter-bank-url>
  ?give=<voucher-hash>:<amount>:<account-hash>
  &get=<voucher-hash>:<amount>:<account-hash>
  [&accs=<base64url(JSON Account docs)>]
  &exp=<unix-seconds>&sig=<inviter-sig>
```

- `give`: what the inviter offers — voucher, amount, and the inviter's **funded account** it will be debited from.
- `get`: what the inviter wants — voucher, amount, and the inviter's **receiving account** (authored locally; accounts are implicit).
- `accs`: the inviter's Account docs referenced by the records, so the initiator can verify them and build the deal against the right account hashes. (Account docs reach a bank only from their owner — §1.1 — so the inviter submits them itself; the bundle is for the initiator's validation, not relay.)
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by the inviter's pubkey.

### 3.2 Deep links

Signed documents — an issuer profile, a voucher, an invoice or cheque Order — are shared as short deep links, typically rendered as QR codes ([`discovery.md`](./discovery.md) §4). When another user scans the link with a smartphone camera, it opens a bank webapp that suggests creating a new key or logging into an existing account. Inside the app the user verifies the documents' signatures and adds the voucher, address, or issuer to their personal catalog. The exact UX is implementation-specific; carrying verifiable signed documents is the protocol property.

> **Invariant:** The invite string format, its fields, and its self-validating property are protocol. How the invite is conveyed (QR code, NFC, deep link, copy-paste) is an implementation detail.

---

## 4. Protocol design decisions, locked

| Decision | Resolution | Invariant? |
|---|---|---|
| Risk model | Lead/follow; no protocol-level rollback | **Yes** |
| Trust model | Holders trust voucher **issuers** (redemption) and **banks** (settlement); holders need not trust — or even identify — each other | **Yes** |
| Coordinator pattern | **Coordinator-orchestrated**: a coordinator calls `create_records` on each bank, then sends a `Mandate` per Order per bank; banks never call each other to create or clear records — they exchange settlement signatures directly via `notify_signatures` | **Yes** |
| Visibility | Each bank owns only the records of the vouchers it issues; foreign records arrive as terms-only bodies via Mandates, their `RecordDetails` staying an opaque hash; peer bank pubkeys come from `Order.bank`; no bank sees the deal's private substance | **Yes** |
| Record creation | Only the coordinator may create records, and only via `create_records({ giver, receiver, … })` referencing holder Order hashes | **Yes** |
| Advance gate | A bank advances records only after receiving a `Mandate` for the record's Order and the valid Order itself | **Yes** |
| Issuer authority | Issuer is sole source of truth for its Voucher's balances | **Yes** |
| Concurrent holds | Rejected `-32003`; first-write-wins on per-Account lock | **Yes** |
| Key recovery | Out of scope (lose key → lose account) | **Yes** |
| Key rotation | Out of scope; redeploy with new secret if compromised | **Yes** |
| Canonicalization | RFC 8785 / JCS; cross-runtime golden vectors | **Yes** |
| Account creation | Accounts are BaseDocs signed by the holder and stored by the issuing bank | **Yes** |
| Voucher fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 | **Yes** |
| Order cardinality | Open: `K ≥ 1` transfer pairs across 1..N banks; bilateral (`K=2`) is the simplest case | **Yes** |
| Order ownership | **One Order per participating holder**, containing the records that touch that holder's accounts | **Yes** |
| Holder authorization | Holders sign Voucher, Account, Order, Address, and Post docs; banks sign Record, Offer, and lifecycle Signature (`ready`/`hold`/`settle`/`reject`) docs, plus their own Address and bank-repost Post docs | **Yes** |
| Balance floor | Non-issuer holder-authorized transfers cannot overdraw the debit account; issuers may go negative via their own Orders | **Yes** |
| Offers | Banks MAY derive and publish Offer docs from Orders; Offers hide holder identity and account hashes | **Yes** |

---

## 5. What the protocol does NOT do

These are out of scope for v1. An implementation MAY add them, but they are not part of the barter.game v1 contract:

- **No web UI.** The protocol is transport-agnostic; a web UI is a client-layer concern.
- **No protocol-level rollback.** If a follow bank goes rogue after the lead settles, the lead is out. Recourse is social.
- **No guaranteed delivery.** Fan-out is fire-and-forget; client relay is the recovery path. There is no message queue in the protocol.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Vouchers.** Issued Vouchers are fungible.
- **No automated settle-cascade retry.** The advance engine re-evaluates whenever a new signature arrives, but if a follower bank goes permanently offline after the lead settles, the lead remains settled — the lead/follow risk, resolved socially. The protocol provides only per-record `reject` for pre-settled aborts.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No global bank discovery directory.** `barter-bank.json`, Address docs, and direct URL+pubkey pinning are the v1 baseline; a global federated directory is a v1.5+ extension.

---

## 6. Implementing barter.game

If you are building your own bank or client:

1. Read this overview cover to cover.
2. Read [`base.md`](./base.md) for the wire format and signature rules.
3. Read [`bank-schema.md`](./bank-schema.md) for the document schemas and ledger invariants.
4. Read [`bank-rpc.md`](./bank-rpc.md) for the bank API methods, then [`discovery.md`](./discovery.md) and [`post-feed.md`](./post-feed.md) for the discovery and feed surfaces.
5. Walk the traces in [`../scenarios/`](../scenarios/) — cheque, invoice, bilateral swap, coordinator arbitrage, merge-branch, and the builder-event journey.
6. See how the reference implementation did it: [`../apps/bank/README.md`](../apps/bank/README.md) (Deno bank server, Deno KV key-space), [`../apps/web/README.md`](../apps/web/README.md) (browser SPA), and [`../packages/protocol/README.md`](../packages/protocol/README.md) (shared primitives + the canonicalization golden vectors to port against). You may use any stack that enforces the invariants in `bank-schema.md`.
