# barter.game protocol — Discovery

How parties find banks, vouchers, issuers, offers, and public holdings.

One boundary shapes everything in this file: **discovery distributes facts, not
trust**. Every surface below hands the receiver signed documents they can
verify; none of them tells the receiver whom to trust. Deciding to trust an
issuer stays a human, out-of-band act — the protocol's job is to make the facts
that inform that decision portable and verifiable.

All discovery surfaces are additive: a v1 bank that implements none of the
optional ones still interoperates on the settlement path. Methods referenced
here are defined in [`bank-rpc.md`](./bank-rpc.md); document schemas in
[`bank-schema.md`](./bank-schema.md); post feeds in
[`post-feed.md`](./post-feed.md).

---

## 1. Bank discovery

A bank's identity document lives at `GET <bank-url>/barter-bank.json` —
`{pubkey, url, name, protocol_version}`. Clients pin `{pubkey, url}` together
and fail closed on divergence. Defined in [`base.md`](./base.md) §5 and
[`bank-rpc.md`](./bank-rpc.md) §3.

Banks find each other's endpoints through signed `Address` docs
([`base.md`](./base.md) §3.2): anyone may submit a newer signed Address via
`submit_docs`; newest ULID wins. There is deliberately **no global bank
directory** — a bank is discovered by being linked, printed, emailed, or spoken
aloud by someone the user already knows.

## 2. Public voucher registry

A bank MAY maintain a public registry of the Vouchers it issues and expose it
through `list_vouchers`:

```ts
list_vouchers({ issuer?: Base58PubKey, cursor?: string, limit?: number })
→ { items: Voucher[], next_cursor?: string }
```

- **The issuer filter is protocol.** Given `issuer`, the bank returns every
  registry-published Voucher signed by that pubkey. This is how "check a bank's
  public registry of vouchers, optionally filtered by issuer" works for any
  compliant client.
- **What enters the registry is bank policy.** A bank may list everything it
  stores, only what issuers opt in to, or nothing. Vouchers kept out of the
  registry still exist and settle normally — they are simply not browsable;
  issuers can share them selectively via profile bundles (§4).
- Results are paginated newest-first (`bank-rpc.md` §2.4, *Pagination*).

## 3. Offers — anonymous trade intent

The `Offer` doc ([`bank-schema.md`](./bank-schema.md) §1.5) is the discovery
half of an Order: a bank-signed derivation that carries the trade terms but
**hides the holder's identity and account hashes**. Holders opt in at
submission time (`submit_docs` with `publish_offers`); anyone polls them with
`list_offers(voucher_hash, intention)`.

Offers are why counterparties don't need to know each other: a participant
trusts the *voucher* (because they trust its issuer) and the *bank* (because
the issuer chose it) — the holder on the other side of the deal is
interchangeable. Records always reference the underlying Order hash; an Offer
is never an authorization source.

## 4. Profile bundles — QR and link sharing

Any party MAY share a **signed document bundle** out of band: a set of docs
selected by the sharer, typically their `Address` plus the Vouchers they want
the receiver to see, optionally an invoice or cheque Order. The receiver MUST
verify every document's signature before displaying or acting on it — the
bundle is self-authenticating and needs no trusted channel.

- **Conveyance is an implementation detail**: QR code, NFC tag, URL, email
  attachment — the protocol only cares that the bytes arrive intact.
- The reference implementation serves bundles as *Barter Links* — public bank
  routes `/i/<pubkey>` (issuer profile: pubkey + published Vouchers),
  `/v/<hash>` (invoice), `/q/<hash>` (cheque), `/o/<hash>` (offer), and
  `/x/<payload>` (inline payload) — each rendering as HTML for humans or a
  JSON doc envelope for machines.
- A bundle can carry Vouchers that are **not** in the public registry: the
  issuer decides what to include per bundle. Scanning an issuer's QR is the
  canonical "get their key and the voucher list they chose to advertise" flow.

## 5. Social discovery — recommendations through feeds

Issuers and holders publish voucher-anchored Posts
([`post-feed.md`](./post-feed.md)). A trusted issuer's post can recommend
another issuer or voucher; the reader's client resolves the referenced pubkey
or voucher hash and lets the reader extend trust deliberately. The chain is
always explicit: *I trust A; A recommended B; I chose to trust B.* The
protocol carries the recommendation; the human makes the decision.

**Vouchers surface through the feed.** The recommended client "Discover"
surface is built entirely from posts by the pubkeys the reader follows
(post-feed.md §7) — every post is anchored to a voucher, so a merged
newest-first feed *is* a stream of voucher sightings:

1. Merge `list_posts(author, "all")` across followed authors × known banks,
   walking embedded reposts/replies too (a bank reposting its users is how a
   newcomer sees anyone at all).
2. De-duplicate the anchoring vouchers, newest sighting first; resolve each
   voucher's doc (issuer, name) and its current presentation
   (`get_voucher_meta` — icon/square media refs and description, falling back
   to the Voucher's own `images`).
3. Render a voucher gallery: image, name, issuer, description, and the
   actions that close the loop — *trade for this* (build an order preloaded
   with it), *read its feed* (the per-voucher feed), *follow the issuer*.

There is no bank-side "trending" and no global search: what a reader can
discover is exactly what the people they chose to follow have posted about —
the trust graph is the index.

## 6. Public holdings

By default, balances are private: a bank MUST NOT disclose an account's
balance or record history to anyone but its holder (and the Voucher's issuer,
via the backup path — [`bank-rpc.md`](./bank-rpc.md) §2.4). A holder who wants the
world to know they hold a voucher opts in by marking the account public
(`Account.public`, [`bank-schema.md`](./bank-schema.md) §1.2). For public
accounts the bank exposes:

```ts
list_public_balances({ holder?: Base58PubKey, voucher?: Base58SHA256,
                       cursor?: string, limit?: number })
→ { items: Balance[], next_cursor?: string }
```

Each item is a bank-signed `Balance` document
([`bank-schema.md`](./bank-schema.md) §1.7) — a portable, verifiable statement
that *holder X has amount N of voucher V on account A*. This enables the
"I scanned a QR and learned that X holds Y vouchers from Z — I'll get a few
myself" flow: the QR is just a pointer; the balance facts arrive bank-signed.

Marking an account public discloses the balance facts (holder pubkey, voucher,
account hash, amounts) — not the Account doc body; the account `name` stays
private either way.

## 7. What discovery does not do

- **No global directory.** All surfaces are bank-local.
- **No reputation, no ranking.** The protocol serves signed facts in ULID
  order; weighing them is the client's and the human's job.
- **No trust transfer.** Nothing in this file makes anyone trustworthy;
  it only makes claims checkable.
