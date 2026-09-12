# barter.game protocol — Base layer

This file defines the base layer of the v1 contract: the parts that are not
specific to any application domain:

- Identity (ed25519 + base58)
- Canonical JSON (RFC 8785 / JCS)
- The `BaseDoc` shell, `Signature`, and `Address` document types
- The JSON-RPC request envelope
- Replay protection and error codes
- Request signing

The base layer stands alone. The mutual-credit banking domain is built on it
([`bank-schema.md`](./bank-schema.md), [`settlement.md`](./settlement.md),
[`bank-rpc.md`](./bank-rpc.md), [`discovery.md`](./discovery.md)), and so are
voucher-anchored post feeds ([`post-feed.md`](./post-feed.md)) — but nothing
here presupposes either: a different service entirely, say a nostr- or
mastodon-style social graph, could be built on exactly these abstractions.

---

## 1. Identity

Every party is an ed25519 keypair. The pubkey is base58-encoded and used as
the identity in every doc.

- **A person**: a human holding a private key.
- **A service**: a process holding a private key.

The cryptography does not distinguish the two. There is no separate "address"
or "DID"; the pubkey IS the identity.

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
  type: string;         // doc-type tag — see the registry below
  pubkey: Base58PubKey; // owner / signer
  ulid: ULID;           // 26-char Crockford base32, generated at creation
}
```

The `type` vocabulary is layered. The base layer defines the two types in this
file; each domain built on the base layer registers its own:

| Layer | Doc types |
|---|---|
| Base (this file) | `signature`, `address` |
| Mutual-credit banking ([`bank-schema.md`](./bank-schema.md)) | `voucher`, `account`, `credit`, `debit`, `order`, `offer`, `mandate`, `balance` *(specified, not yet implemented)* |
| Post feeds ([`post-feed.md`](./post-feed.md)) | `post` |

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `2024-05-02T00:00:00Z` -  ISO 8601 datetime  

### 3.1 Signature

Attestations are first-class docs. A Signature anchors to **exactly one**
target via its `hash` field:

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;     // content-addressed target
  action?: string;         // a verb registered by a domain layer
  seen?: Base58SHA256[];   // hashes of prior Signature docs (see below)
  reason?: string;
  sig?: Base58Signature;   // ed25519 sig over canonical(doc minus sig)
}
```

What a Signature *means* — which actions exist and what they commit the signer
to — is defined by the domain layer, not here. The banking domain registers
`ready` / `hold` / `settle` / `reject` and their settlement semantics in
[`settlement.md`](./settlement.md) §1; the feed domain registers `endorse` in
[`post-feed.md`](./post-feed.md) §4. A domain implementation MUST reject
actions its domain does not register. An action-less Signature is a plain
attestation to its target; the domain decides what that attestation is worth
(e.g. in banking, a signer's action-less signature on their own Order is an
authorization, and a service's on a stored doc is a storage attestation).

#### `seen` — a partial order and a proof of pre-existence

`seen` lists the content hashes of Signature docs the signer had seen before
signing. Each entry is a **proof of pre-existence**: the cited signature
existed — and was known to this signer — no later than the moment this
signature was created. Transitively, `seen` edges induce a **partial order**
over signatures: if `S₂` lists `S₁`, then `S₁` precedes `S₂`. The order is
acyclic in practice — a cycle would require citing a hash before it was
computable.

A simple use: **bracketing an event in time without trusting its clock.**

1. A signs `S₁`; A's clock says `t₁`.
2. B signs `S₂` with `seen: [hash(S₁)]`.
3. A signs `S₃` with `seen: [hash(S₂)]`; A's clock says `t₃`.

Trusting only A's clock: `S₂` was created **no earlier than `t₁`** — it cites
`S₁`, which did not exist before `t₁` — and **no later than `t₃`**, because
`S₃` cites it at `t₃`. B's signing moment is pinned to the interval
`(t₁, t₃)` without B's clock being trusted at all.

`seen` proves order and pre-existence; nothing more. It says nothing about
*who* signed (that is the signature itself, plus whatever authority rules the
domain layer imposes — e.g. [`settlement.md`](./settlement.md) §5) and nothing
about *why* (the `action`). The banking domain's settlement cascade is the
heavy user of `seen`: [`settlement.md`](./settlement.md) §3.

### 3.2 Address

A party operating a network service publishes its current endpoint as a signed
**Address** doc. Address docs are indexed by pubkey; a newer Address (by ULID)
for the same pubkey replaces the older one.

```ts
Address: BaseDoc & {
  type: "address";
  url: string;            // current endpoint of the service
}
```

Services that call each other maintain public directories of Address docs and
resolve each other's current URL from them. When one service learns a peer's
pubkey, it looks up the peer's newest Address doc to obtain the peer's RPC
URL. Anyone MAY update an Address for a pubkey by submitting a signed Address
doc with a newer ULID through the service's doc-submission path. Address docs
let an entity announce URL changes in a verifiable, self-signed form. (The
banking domain's use of Address docs for peer discovery is in
[`bank-rpc.md`](./bank-rpc.md) §3.)

> **Invariant:** Address docs are signed by the pubkey they describe. A newer ULID overrides an older one for the same pubkey.

---

## 4. JSON-RPC envelope

All RPCs are `POST` to `<service-url>/rpc` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id":       "<ulid>",
  "method":   "<method-name>",
  "params":   { ... },
  "pubkey":   "<sender pubkey>",
  "to":       "<recipient pubkey>",
  "sig":      "<base58 sig>"
}
```

- `id` is a ULID claimed in the recipient's replay window.
- `to` binds the request to this specific recipient. A recipient with a different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by the private key corresponding to `pubkey`.
- Services use the same envelope when calling each other directly, discovering the peer's URL from its Address doc (§3.2).

### 4.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

Note what this window is and is not. It dedupes the *same signed request*
delivered twice — a transport-level concern. It is not a defense against a
*different*, freshly signed message that tries to re-drive old work; that kind
of replay resistance belongs to the domain layer (for settlement, the
Mandate's once-only acceptance — [`settlement.md`](./settlement.md) §2).

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
| `-32003` | Lock conflict (a resource is exclusively held) |
| `-32004` | Timeout (reserved; not used in v1) |
| `-32005` | Unknown doc (referenced hash not in the server's store) |

> **Invariant:** These error codes and their meanings are part of the v1 contract. Custom codes MUST use the `-32006..-32099` range.
