# barter.game protocol — Base layer

This file defines the parts of the v1 contract that are not specific to banking entities or RPC methods:

- Identity (ed25519 + base58)
- Canonical JSON (RFC 8785 / JCS)
- The `BaseDoc` shell, `Signature`, and `Address` document types
- The JSON-RPC request envelope
- Replay protection and error codes
- Request signing
- Bank discovery and pubkey pinning
- Standard vs custom API surface

For Voucher/Account/Record/Order/Offer/Mandate/Balance schemas and ledger semantics, see [`bank-schema.md`](./bank-schema.md). For the bank RPC method definitions, see [`bank-rpc.md`](./bank-rpc.md).

---

## 1. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key.
- **Bank**: a process holding a private key.

There is no separate "address" or "DID"; the pubkey IS the identity.

> **Invariant:** ed25519 + base58 encoding is mandatory for v1 interoperability.

---

## 2. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero → `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

### 2.1 The preimage: one rule for both signing and hashing

Define, for any doc `D`:

```
preimage(D) = canonical(D minus its TOP-LEVEL "sig" key)
```

Both operations use **exactly this preimage**:

| | Definition |
|---|---|
| **Signature** | `sig = ed25519_sign(SHA-256(preimage(D)))` |
| **Content hash** | `hash(D) = base58(SHA-256(preimage(D)))` |

Three consequences, all load-bearing:

1. **No circularity.** `sig` is a container attached *after* signing, never an input to what it signs. There is no self-reference to resolve.
2. **One identity per doc.** A doc's hash is the same before and after it is signed, and is unaffected by *which* valid signature it carries. A doc has exactly one content address, and its signature commits to precisely that address — "the signature signs the hash" is literally true. Any implementation that hashes the doc *including* `sig` gives every doc two different hashes (the one it is stored under and the one its signature attests) and makes identity inherit signature malleability. That is non-conformant.
3. **Only the top level is stripped.** A nested doc embedded inside another (e.g. a `Post` embedded as `reply_to`, [`post-feed.md`](./post-feed.md) §1) keeps its own `sig` *inside* the preimage, so the outer author commits to the exact signed bytes — signature included — of everything it embeds.

> **Invariant:** `hash(D)` and the message its signature commits to MUST be computed over the identical byte string `preimage(D)`, stripping only the top-level `sig`. Two implementations must also produce byte-identical canonical JSON for the same document, or every signature becomes unverifiable across implementations. You MUST implement RFC 8785 (or equivalent JCS) and you MUST verify cross-runtime parity before claiming v1 compatibility.

---

## 3. Document types

All docs share the `BaseDoc` shell:

```ts
type BaseDoc = {
  type: "voucher" | "account" | "credit" | "debit" | "signature" | "order" | "offer" | "mandate" | "address" | "balance" | "post";
  pubkey: Base58PubKey;   // owner / signer
  ulid: ULID;              // 26-char Crockford base32, generated at creation
}
```

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `2024-05-02T00:00:00Z` -  ISO 8601 datetime  

The concrete types defined in this file are `Signature` and `Address`. Voucher, Account, Record, Order, Offer, Mandate, and Balance are defined in [`bank-schema.md`](./bank-schema.md); Post is defined in [`post-feed.md`](./post-feed.md).

### 3.1 Signature

Attestations are first-class docs. A signature with an `action` anchors to **exactly one** target via its `hash` field:

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // content-addressed target (record hash, Order hash, Offer hash, Address hash)
  action?: "ready" | "hold" | "settle" | "reject";
  seen?: Base58SHA256[];     // hashes of prior Signature docs
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```

`pubkey` may be a user OR a bank. The action map:

| Action | Signer | Target | Meaning |
|---|---|---|---|
| `ready` | bank | `hash` = a record hash | the bank's per-record limits/validity verdict |
| `hold` | bank | `hash` = a record hash | this bank's debit account is locked for this record |
| `settle` | bank | `hash` = a record hash | this bank applied this record's delta |
| `reject` | bank | `hash` = a record hash | this record is rejected; holds released |

A holder's signature on an Order (no `action`) is the holder's authorization for the transfers described in that Order. A bank's signature on an Offer or Address (no `action`) is a pure attestation that the bank has stored/derived the doc.

#### `seen` is a causal chain that binds the cascade to one deal

`seen` is the load-bearing field for multi-party settlement. Each `hold`/`settle` a bank issues lists the hashes of the **prior signatures it verified** before advancing — so the signatures of a deal form a causal chain rooted in `ready` sigs, and every `ready` anchors (via its `hash`) to a **record**, whose hash is unique to the deal (records carry ULIDs). A later signature that transitively cites a set of `ready` sigs is therefore committing to *those specific records* — i.e. to *this* deal — and nothing else.

This is what makes a signature **non-replayable across deals without a public deal tag.** A bank never advances on "any settle from that signer"; it advances only when the upstream signature it received *cites this deal's own signatures in its `seen`*. A `hold`/`settle` minted in a different deal carries that deal's hashes and fails the containment check below. (There is no `deal_id` in a Signature — the binding is the chain, so topology stays private.)

##### The two-bank settlement handshake

For a bilateral deal across two banks, one bank hosts the **lead** transfer and the other the **follow** transfer. (A *transfer* is a debit/credit pair of one voucher, both records at that voucher's issuing bank; it is *lead* iff its debit-side `Order.lead` is `true`.) Let `R` be the deal's full record set — every bank can enumerate `R` from the Mandates it holds (`bank-schema.md` §1.6) and gather each record's signatures from the peers' fan-out.

1. **ready** — each bank validates each of its own records against that record's Order (`bank-schema.md` §1.4) and issues `ready(r)` with `seen = []`. Banks fan `ready` sigs out to the peer.
2. **hold** —
   - **lead**: once *every* record in `R` carries a `ready` (its own plus the peer's), it locks its debit accounts and issues `hold(r)` for each own `r` with `seen =` the hashes of **all `ready` sigs over `R`**. Fans out.
   - **follow**: on the lead's `hold`, it verifies the lead `hold` is validly signed **and every one of its own `ready` hashes is present in that `hold`'s `seen`** (this proves the lead is holding *this* deal). It then locks and issues `hold(r)` with `seen =` **all `ready` hashes + the lead `hold` hashes**. Fans out.
3. **settle** —
   - **lead**: once every record in `R` carries a `hold`, it verifies each follow `hold`'s `seen` **contains its own `ready`+`hold` hashes**, then settles each of its transfers atomically and issues `settle(r)` with `seen =` **all `hold` hashes over `R`**. Fans out.
   - **follow**: on the lead's `settle`, it verifies the `settle` is validly signed **and its `seen` contains the follower's own `hold` hashes**, then settles its transfers atomically and issues `settle(r)` with `seen =` **all `hold` hashes + the lead `settle` hashes**. Terminal.

The lead settles first, so a cautious holder can `follow` (receive before giving) to bound counterparty risk. The containment checks are **fail-closed**: an unverifiable or missing predecessor never advances a record — the engine waits (and `reject` is the only abort; there is no rollback, `bank-schema.md` §2). N-party (≥3 bank) deals generalize the same rule over each transfer's predecessor set; that DAG is out of scope for v1 (see `../docs/design/mandate-validation.md` §5 at the repo root).

> **Invariant:** `Signature.seen` carries the cascade proof. A bank MUST NOT issue `hold`/`settle` for a record until it has verified that the upstream signature it depends on **cites this deal's own signatures in its `seen`** (own `ready` ⊆ lead `hold.seen` before follow-hold; own `hold` ⊆ lead `settle.seen` before follow-settle; and the symmetric lead-side checks). Advancing on a signature not so bound — e.g. the newest `settle` from a signer regardless of deal — is a protocol violation. The exactly-one-target rule for actioned signatures is protocol.

### 3.2 Address

A bank publishes its current endpoint as a signed **Address** doc. Address docs are indexed by pubkey; a newer Address (by ULID) for the same pubkey replaces the older one.

```ts
Address: BaseDoc & {
  type: "address";
  url: string;            // current endpoint of the bank
}
```

Banks maintain public directories of Address docs and use them to call each other directly. When a bank learns a peer bank's pubkey (e.g. from the `bank` field in an Order), it looks up the peer's newest `Address` doc to obtain the peer's RPC URL. Anyone MAY update an Address for a pubkey by submitting a signed Address doc with a newer ULID via `submit_docs`. The canonical discovery endpoint is `<bank-url>/barter-bank.json` (see §5.1); Address docs allow an entity to announce URL changes in a verifiable, self-signed form.

> **Invariant:** Address docs are signed by the pubkey they describe (a bank or a user). A newer ULID overrides an older one for the same pubkey.

---

## 4. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id":       "<ulid>",
  "method":   "<method-name>",
  "params":   { ... },
  "pubkey":   "<sender pubkey>",
  "to":       "<recipient bank pubkey>",
  "sig":      "<base58 sig>"
}
```

- `id` is a ULID claimed in the recipient's replay window.
- `to` binds the request to this specific recipient. A peer bank with a different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by the private key corresponding to `pubkey`.
- For holder-facing methods, `pubkey` is the holder's user pubkey. Banks also use the same JSON-RPC envelope when calling each other directly (e.g. `notify_signatures`), using the peer bank's Address doc to discover the URL.

### 4.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

> **Invariant:** The envelope shape, the `to` binding, and the replay-protection semantics are protocol. The exact window size, pruning policy, and storage backend are implementation details.

### 4.2 Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (body wasn't JSON) |
| `-32600` | Invalid request (envelope malformed) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | Validation (doc shape, business rule) |
| `-32001` | Signature invalid (`to` mismatch, bad sig) |
| `-32002` | Replay (ULID already seen) |
| `-32003` | Lock conflict (concurrent hold on same account) |
| `-32004` | Timeout (reserved; not used in v1) |
| `-32005` | Unknown doc (referenced hash not in this bank's DB) |

> **Invariant:** These error codes and their meanings are part of the v1 contract. Custom codes MUST use the `-32006..-32099` range.

---

## 5. Bank discovery + pubkey pinning

### 5.1 Discovery

A bank's **canonical URL** is the base path clients use for that bank. Different banks MAY live at different paths on the same domain — for example `https://example.com/banks/alice` and `https://example.com/banks/bob`. The bank exposes its identity document at:

```
GET <bank-url>/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use. It MUST be a prefix of the URL from which `barter-bank.json` was fetched.

Banks MAY maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from, sourced from discovery documents and from explicitly presented **Address** docs (§3.2). This cache is on the settlement hot path: banks deliver `ready`/`hold`/`settle`/`reject` signatures to each other directly via `notify_signatures`, resolving peer URLs through Address docs (see `bank-rpc.md` §4).

### 5.2 Pubkey pinning (security)

The discovery document is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see `README.md`).
- `barter-bank.json` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

> **Invariant:** The `barter-bank.json` format and the pinning semantics are protocol. How the client stores its config is an implementation detail.

---

## 6. Standard vs custom API

The open bank API that ensures interoperability and cross-bank transactions is standardized in this directory: document schemas, JSON-RPC envelope, method semantics, invite strings, and discovery formats.

Banks MAY also expose custom API endpoints and UI beyond the standard surface. For example, a bank may choose its own KYC flow, fee model, admin tooling, or web dashboard. Such customizations MUST NOT alter the standard document schemas or the semantics of the methods defined in `bank-rpc.md`. Different banks may implement the custom layer differently; clients that speak only the standard protocol can still trade across them.

> **Invariant:** Anything required for two independent implementations to interoperate belongs in this protocol directory. Anything that is operator-specific or UX-specific belongs in a custom or implementation layer.
