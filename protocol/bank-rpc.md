# barter.game protocol — Bank RPC API

This file defines the bank's public interface:

- JSON-RPC methods for voucher/account/order submission, record creation, authorization clearance, signature fan-out, and reads
- REST endpoints (address directory, media blobs)
- Orchestration recipe
- Bank discovery

For document schemas and ledger semantics, see [`bank-schema.md`](./bank-schema.md). For the envelope, signatures, and base types, see [`base.md`](./base.md). For discovery surfaces, see [`discovery.md`](./discovery.md); for voucher post feeds, [`post-feed.md`](./post-feed.md). For the trust and settlement narrative, see [`README.md`](./README.md).

---

## 1. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with the envelope shape defined in [`base.md`](./base.md): `jsonrpc`, `id`, `method`, `params`, `pubkey`, `to`, `sig`. Replay protection and error codes are also defined there.

---

## 2. Bank API

The bank API is **doc-oriented and signature-driven**. Clients present signed documents and document-creation requests; banks store the documents they are shown, mint bank-owned identifiers (record ULIDs and `pair` values), issue their own signatures, and fan out those signatures to the other banks in the deal.

The API surface below is intentionally small. Wave 1 (ready) is driven by coordinator calls to `create_records` followed by holder `submit_docs` (for Orders/Accounts) and coordinator `submit_mandate`; waves 2–3 (hold, settle) are **bank self-advanced** — the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied. Banks learn each other's URLs from the Address registry and call each other directly.

### 2.1 Doc submission

| Method | Caller | Side effect |
|---|---|---|
| `submit_docs(docs, publish_offers?)` | any → bank | Validate and store each BaseDoc in `docs`. The bank routes by `type`: Vouchers must name this bank in their `bank` field (any issuer may sign them), and every `images[]` MediaRef must already be stored in this bank's vault — upload precedes the doc (§2.5, [`post-feed.md`](./post-feed.md) §5) — or the submit is rejected; Accounts must reference a known Voucher and be signed by the holder; Orders must reference known Accounts signed by the same holder and have a valid, positive `rate`; Addresses update the address directory if newer by ULID; standalone Signatures are verified against their signer and stored (an alternate delivery path to `notify_signatures`, §2.3 — storage only, without the advance-engine re-run); Posts must reference a Voucher this bank issues and are accepted per bank policy ([`post-feed.md`](./post-feed.md) §2). A bank MAY repost an accepted third-party post under its own key (the reference bank does, as a bank-signed Post with `repost` set), so `list_posts` on the bank's own pubkey serves as the default feed for accounts that follow only their host bank ([`post-feed.md`](./post-feed.md)). Optionally derive and publish discovery Offers for any Order hashes listed in `publish_offers`. Return the hashes of stored docs and any derived Offers. |
| `submit_mandate(mandate, records)` | coordinator → each participating bank | Validate and execute one [`Mandate`](bank-schema.md#16-mandate) as a unit of work. `mandate.records` lists **every record satisfying `mandate.order` in the deal, across all banks**; the coordinator passes all the record **bodies** alongside. The bank verifies the coordinator signature and `mandate.bank`; checks each **local** record (created for `mandate.deal_id`, `details.coordinator == mandate.pubkey`, `Record.order == mandate.order`) and each **foreign** body (hashes to the listed value, signed by its minting bank, references the order, minted by a bank the Order names); verifies its local slice is complete; then validates BOTH sides of the Order — including the rate over the full local+foreign set. Duplicate `(deal_id, order)` Mandates are rejected. Only then may the bank advance its records out of `created`. |

### 2.2 Record creation

| Method | Caller | Side effect |
|---|---|---|
| `create_records({ giver, receiver, amount, counter_amount, deal_id })` | coordinator → each bank | Mint the single debit/credit record pair that moves **this bank's voucher** from the `giver` to the `receiver`; seal `deal_id` and the coordinator pubkey into each `RecordDetails`; return the record bodies. Records are stored as `created` and stay there until a matching [`Mandate`](bank-schema.md#16-mandate) and the authorizing Orders arrive. |

```ts
create_records(params: {
  giver:          Base58SHA256;  // Order hash — the holder GIVING this bank's voucher (its `debit` side is here)
  receiver:       Base58SHA256;  // Order hash — the holder RECEIVING this bank's voucher (its `credit` side is here)
  amount:         number;        // units of THIS bank's voucher moved giver → receiver
  counter_amount: number;        // units of the counterparty voucher (the giver's `credit` / receiver's `debit`), for the rate check
  deal_id:        ULID;
})
```

**Order hashes only.** `giver` and `receiver` are hashes of holder-signed **Order** docs — never Offers. An Order has a single canonical hash and the holder submits the same Order to every bank its sides touch, so the same hash resolves identically at every participating bank (a coordinator reads the Order hash from a discovery Offer's `order` field). Both Orders must already be stored at this bank (via `submit_docs`).

This bank issues exactly one voucher `V`. The call mints **one** transfer of `V`:

- a **debit** record on `giver`'s `debit.account` (giver's `debit.voucher` is `V`), and
- a **credit** record on `receiver`'s `credit.account` (receiver's `credit.voucher` is `V`),

both for `amount`, paired by a fresh `pair` ULID, tagged with `deal_id`, and sealed with `details.coordinator = <sender pubkey>`.

The bank verifies:

- `giver` and `receiver` resolve to valid, signed, stored Orders.
- `giver.debit.voucher == receiver.credit.voucher == V` (this bank's voucher); both `bank` fields are this bank.
- `amount` is within `giver.debit.min/max` and `receiver.credit.min/max`.
- **Counter leg — bank-asserted, never trusted** (two-sided Orders): the bank holds BOTH Orders (every holder submits their Order to each bank a side touches), so it validates the caller's `counter_amount` against the signed docs themselves: the giver's `credit` side and the receiver's `debit` side MUST name the same foreign voucher and bank; `counter_amount` MUST lie inside **both** Orders' min/max windows for that side; and both rates MUST hold — `amount / counter_amount <= giver.rate` and `counter_amount / amount <= receiver.rate`. For one-sided pairings (invoice/cheque) `counter_amount` MUST be `0`. What the bank cannot observe is the foreign leg's *settled* records; the counterparty bank enforces the same windows on its side, and the ready→hold→settle cascade ties the legs together.
- The resulting records would not violate `Voucher.limit` or any Order cumulative/account limit.

The bank rejects the request if any check fails.

**Idempotency.** `create_records` MUST be idempotent on `(deal_id, giver, receiver)`: a repeated call with the same terms returns the originally minted record pair; a repeated call with **different** `amount`/`counter_amount` for the same key MUST be rejected (`-32000`), never mint a second pair. Distinct pairs within one deal (merge/branch, spread legs) differ in `giver` or `receiver` and are unaffected.

**Same-bank deals.** When this bank issues **both** vouchers in the swap, the coordinator calls `create_records` **twice** — once per voucher — with `giver` and `receiver` swapped:

```ts
// Voucher X (Alice gives, Bob gets):  amount = X units, counter_amount = Y units
create_records({ giver: Aorder, receiver: Border, amount: 100, counter_amount: 90,  deal_id })
// Voucher Y (Bob gives, Alice gets):  amount = Y units, counter_amount = X units
create_records({ giver: Border, receiver: Aorder, amount: 90,  counter_amount: 100, deal_id })
```

Across two banks, the coordinator makes one call to each bank, with `giver`/`receiver` chosen so each call's `giver.debit.voucher` is that bank's voucher.

> **No other caller may create records.** There is no `mint`; issuers begin trading by placing Orders that debit the issuer account.

### 2.3 Signature fan-out

| Method | Caller | Side effect |
|---|---|---|
| `notify_signatures(signatures)` | peer bank (direct) or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |

### 2.4 Read

> **Pagination.** Methods marked *paginated* accept optional `cursor` (an
> opaque, bank-issued continuation token) and `limit` (advisory; banks MAY cap
> it) parameters, and return `{ items, next_cursor? }` — an absent
> `next_cursor` means the listing is exhausted. Ordering is **newest-first by
> ULID**. The convention applies equally to the paginated methods in
> [`discovery.md`](./discovery.md). The post-feed methods use their own
> variant — a `before` ULID cursor returning `{ items, next_before? }`
> ([`post-feed.md`](./post-feed.md) §3, and the `list_posts` row below) — not
> the opaque `cursor`/`next_cursor` pair.

> **Privacy default.** Balances and record history are private: a bank serves
> them to the account **holder** and to the **issuer of the Voucher** the
> account is denominated in, and MUST NOT disclose them to anyone else. The
> issuer's bank necessarily sees every position in the voucher it settles; the
> issuer is the party accountable for it — hence the issuer reads balances
> directly (`get_account_balance`) and has the protocol-mandated backup path
> over all of the voucher's records (`list_voucher_records`).
>
> An account marked public (`Account.public`,
> [`bank-schema.md`](./bank-schema.md) §1.2) opts out of the default and may be
> disclosed to third parties.
>
> **Status: specified, not yet implemented.** The reference bank does not serve
> this yet (tracked in TODOS.md) — there is no `Account.public` field in the
> shipped protocol types, so holder-or-issuer is the whole allow-list.

| Method | Caller | Side effect |
|---|---|---|
| `get_record_signatures(record_hash)` | any → bank | Return the record body and every signature anchored to this record hash. Used by follow parties verifying a deal, by watchers, and by relaying clients. |
| `get_address(pubkey)` | any → bank | Return the newest signed `Address` doc for the given pubkey, or an error if none is known. Equivalent to `GET /address/<pubkey>`. |
| `get_voucher(voucher_hash)` | any → bank | Return the Voucher doc body. |
| `get_voucher_meta(voucher_hash)` | any → bank | Return the voucher's current presentation — `{ voucher, icon, square, description_md, ulid, post, at }` (`icon`/`square` are MediaRefs) — from the issuer's newest meta release ([`post-feed.md`](./post-feed.md)), falling back to the Voucher doc's own `images[0]`/`images[1]` and `description_md` when no release exists. Returns `null` (not an error) when the voucher has neither. |
| `get_account_balance(account_hash)` | holder or Voucher issuer → issuer bank | Return current and pending balance as plain numbers — the lightweight read. Served to the account's holder or the issuer of the Voucher the account is denominated in (see the privacy default above). |
| `get_balance(account_hash)` | holder → issuer bank | *(specified, not yet implemented)* Return a bank-signed [`Balance`](bank-schema.md#18-balance) document attesting the account's current position. The sender MUST be the account's holder unless the account is public. |
| `list_accounts()` | holder → bank | Return all accounts owned by the sender at this bank, with Voucher bodies. |
| `list_account_records({ account, cursor?, limit? })` | holder → bank | *(specified, not yet implemented)* *Paginated.* Return the records that touch the given account — bodies plus every signature anchored to them. The sender MUST be the account's holder unless the account is public. This is the holder's record-history query. |
| `list_voucher_records({ voucher, cursor?, limit? })` | issuer → issuing bank | *(specified, not yet implemented)* *Paginated.* Return **all** records for the given Voucher — record bodies, their `RecordDetails`, and every signature anchored to them. Banks **MUST** provide this to the Voucher's issuer to comply with the protocol; serving other callers is bank policy. This is the issuer's backup path: with the full record and signature set, an issuer can prove every holder's position and re-create holder balances at another bank (with new Vouchers) if this bank disappears. |
| `list_public_balances({ holder?, voucher?, cursor?, limit? })` | any → bank | *(specified, not yet implemented)* *Paginated.* Return bank-signed [`Balance`](bank-schema.md#18-balance) docs for **public** accounts, filtered by holder pubkey and/or Voucher hash. Non-public accounts MUST NOT appear. See [`discovery.md`](./discovery.md) §6. |
| `list_offers(voucher_hash, intention)` | any → bank | Return Offers for the given Voucher and intention (`sell` or `buy`). |
| `get_offer(offer_hash)` | any → bank | Return the discovery Offer doc at `offer_hash`. This is how a coordinator fetches a single Offer (and reads its `order` field, §4 step 2) without scanning `list_offers`. |
| `get_invoice(hash)` / `get_cheque(hash)` | any → bank | Return the **Order** at `hash` if it has the invoice (`debit` omitted) or cheque (`credit` omitted) specialization. Offer hashes are not accepted (`-32005`); an Offer's invoice/cheque form is reached via `get_offer` or `list_offers`. |
| `list_vouchers({ issuer?, cursor?, limit? })` | any → bank | *Paginated* *(pagination specified, not yet implemented — the reference bank ignores `cursor`/`limit` and returns a bare `Voucher[]` array, not an `{ items }` envelope)*. Return Vouchers from the bank's public registry. The `issuer` filter is protocol: given an issuer pubkey, return every registry-published Voucher signed by it; the reference bank also accepts `filter: 'mine'` as a convenience alias for the sender's own pubkey. Which Vouchers enter the registry is bank policy ([`discovery.md`](./discovery.md) §2). |
| `list_posts(pubkey, voucher_hash, before?)` | any → bank | *Paginated, newest-first.* Return stored Post docs by **author** `pubkey` (a bank, issuer, or user), for a single `voucher_hash` **or** the literal `"all"` (no voucher filter). Optional `before` ULID pages backward in time. Bodies carry the author `sig` inline ([`post-feed.md`](./post-feed.md) §3). |
| `get_post(post_hash)` | any → bank | Return the Post doc body. |
| `get_post_signatures(post_hash)` | any → bank | Return the **additional** signatures anchored to a post (endorsements, reactions, issuer co-signs) — accrued after the immutable post was signed. The author's own signature lives in the post body. Mirrors `get_record_signatures`. |

> **Status: specified, not yet implemented.** The reference bank does not serve
> the rows marked *(specified, not yet implemented)* yet (tracked in TODOS.md);
> calling an unregistered method returns `-32601`.

### 2.5 REST endpoints

Two read/serve surfaces are plain HTTP (cacheable, no JSON-RPC envelope):

- `GET /address/<pubkey>` — return the newest Address doc for the pubkey, or `404`. A bare `GET /address` (no pubkey) returns the bank's own newest Address doc.
- `GET /media/<hash>.<ext>` — return a vault blob by its `MediaRef`
  ([`post-feed.md`](./post-feed.md) §5), served with the Content-Type the
  extension implies and immutable caching. **Unauthenticated:** whoever knows
  the ref may fetch the bytes. The bank verifies the bytes hash to the ref's
  hash before serving; unknown hash → `404`. A bare `<hash>` (no extension) is
  the legacy form and serves the content type recorded at upload. Responses
  carry `X-Content-Type-Options: nosniff` and a sandboxing
  `Content-Security-Policy`, so a served SVG renders as an image but can never
  run script on the bank's origin.

Address docs are submitted and updated through the standard `submit_docs`
JSON-RPC method. Media blobs are uploaded to the carrying bank before the doc
that references them:

```
POST /media          (authenticated — signed-header scheme below)
{ "data_base64": "<base64 bytes>", "ext": "svg" }      — or "content_type": "image/svg+xml"
→ 201 { "hash": "<base58 sha256>", "ref": "<hash>.<ext>", "size": n, "content_type": "…" }
```

The upload MUST resolve to a known image extension (`svg`, `png`, `jpg`,
`jpeg`, `webp`, `gif`) — a caller-chosen Content-Type never reaches storage.
Docs carry the returned `ref`. Further acceptance (size caps, quotas) is bank
policy. This keeps the write path uniform: docs via `submit_docs`, blobs via
`/media`.

**Write authentication.** REST writes carry a signed-header credential — the
same scheme every bank UI write uses:

```
X-Barter-Auth: <base64url(JSON authdoc)>.<base58 signature>
```

The signature is over the authdoc (same signing rules as any doc, `base.md`)
and is verified against `authdoc.pubkey`, which becomes the authenticated
caller. The authdoc fields:

- `pubkey` — the caller's base58 pubkey.
- `method` — the HTTP method; must match the request.
- `path` — the request's pathname **plus query string**, so query parameters
  are tamper-proof.
- `id` — a single-use replay id; the bank claims it on first use and rejects
  reuse (`409`).
- `ts` — Unix milliseconds; rejected beyond a ±120 s skew window.
- `body_sha256` — base58 SHA-256 of the raw request body text; `null` (or
  absent) when the request carries no body — an empty body binds nothing.

---

## 3. Bank discovery

A bank exposes its identity document at:

```
GET <bank-url>/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use. It MUST be a prefix of the URL from which `barter-bank.json` was fetched. Discovery and pubkey pinning semantics are defined in [`base.md`](./base.md) §5.

---

## 4. Orchestration with the doc-oriented API

The coordinator builds the deal by discovering compatible Orders (via their discovery Offers) and asking each bank to create the records that connect them.

1. **Holders publish intent.** Each holder calls `submit_docs` with their Voucher, Account, and Order docs, optionally requesting discovery-Offer publication (`publish_offers: [<order-hash>]`). The same Order is submitted to every bank that issues a Voucher on either side of it.
2. **Coordinator discovers Orders.** The coordinator scans `list_offers` (or an off-band stream) for two Offers on opposite sides of the same Voucher that form a mutually acceptable trade, and reads each Offer's `order` field to obtain the two holder **Order hashes** (`giver`, `receiver`).
3. **Share Address docs.** Before banks can call each other directly, each bank must have a signed `Address` doc for every peer bank. The coordinator fetches each bank's current Address (`get_address`) and submits it to the other participating banks via `submit_docs`. Banks also accept newer Address docs at any time.
4. **create_records** on every participating bank, referencing the two Order hashes plus `amount` / `counter_amount` and a shared `deal_id`. Each bank mints the debit/credit record pair for the voucher it issues; for a same-bank swap the coordinator calls twice with `giver`/`receiver` swapped (see §2.2).
5. **submit_mandate.** For each (Order, bank) the coordinator builds a `Mandate` naming that Order and listing **every record satisfying it across all banks**, signs it, and sends it **with all the record bodies** to the bank. The list is the same at every addressed bank.
6. **Banks advance.** Once a bank has both (a) a `Mandate` for an Order and (b) that Order bound to its records (already stored via `submit_docs`), its advance engine issues `ready`, then `hold`, then `settle` automatically as preconditions are met. Because `hold` and `settle` are gated on the deal's **full** record set carrying the right upstream signatures (the `seen` handshake, `base.md` §3.1), banks fan out **every** signature they issue — `ready` and `hold` as well as `settle` — to the peer banks named by the deal's Orders, so each side can see the others' records advance. Banks discover each other via the `bank` fields in the Orders and use the Address registry to call each other directly; `notify_signatures` is the canonical bank-to-bank delivery path.
7. **Relay fallback.** If direct bank-to-bank delivery fails, any party can relay signatures by hand (`get_record_signatures` → `notify_signatures`).

Unsigned orchestration data (grouping, topology) is **not authority**: every gate that moves money — Order resolution, per-record ready, hold preconditions, settle proofs, Mandate clearance — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are protocol. The exact HTTP client library, retry policy, timeout values, and how the coordinator discovers Orders are implementation details.
