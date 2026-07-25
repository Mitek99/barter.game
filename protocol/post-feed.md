# barter.game protocol — Voucher post feeds

Nostr-like publishing, anchored to vouchers. An issuer announces "redeem the
package at booth 12"; a holder posts "traded my mug voucher for a great
t-shirt"; a trusted issuer recommends another issuer's voucher. Posts ride the
same machinery as every other document: signed, content-addressed, stored by
banks, verified by readers.

Related: discovery surfaces in [`discovery.md`](./discovery.md); doc model and
signing in [`base.md`](./base.md); RPC methods in
[`bank-rpc.md`](./bank-rpc.md) §2.4.

---

## 1. The Post document

```ts
interface Post extends BaseDoc {
  type: 'post';
  pubkey: Base58PubKey;    // the AUTHOR — any keypair (bank, issuer, or user)
  ulid: ULID;              // feed ordering key (reverse-chronological)
  voucher: Base58SHA256;   // the Voucher this post is anchored to
  body_md: string;         // markdown body; may reference media by hash
  media?: Base58SHA256[];  // content-addressed media blobs (see §5)
  reply_to?: Post;         // the FULL parent Post, embedded (see §4)
  repost?: Post;           // the FULL reposted Post, embedded (see §4)
  sig: Base58Signature;    // author's signature
}
```

Posts are ordinary content-addressed docs: canonicalized, hashed, signed by
their author. Every post anchors to exactly one Voucher — the feed is the
voucher's, not the author's. Like all signed docs a post is irrevocable; what a
bank chooses to *store and serve* is another matter (§6).

`reply_to` and `repost` **embed the full referenced Post object** (including its
own `sig`, and its own `reply_to`/`repost` in turn), rather than a hash. A reply
or repost is therefore **self-contained and independently verifiable**: a reader
checks the whole thread's signatures from the bytes in hand, with no follow-up
fetch. Because the embed is recursive, a deep thread nests its ancestors; banks
cap embed depth and total post size at intake (§6), and a client renders as
deep as it received.

> **Invariant:** A Post's content hash is `base58(sha256(canonical(post minus
> top-level sig)))`, as for every signed doc. An embedded `reply_to`/`repost`
> keeps its own `sig` (only the *outer* post's top-level `sig` is stripped for
> hashing), so the outer author commits to the exact bytes — signatures
> included — of every ancestor it embeds.

## 2. Writing — `submit_docs`, accepted per bank policy

Posts are submitted through the standard `submit_docs` write path. The bank MUST
validate shape, author signature, that `voucher` resolves to a Voucher known to
this bank (its own, or one whose doc was presented to it — so any bank the
issuer uses can carry the feed), and that every embedded `reply_to`/`repost`
Post is itself well-formed and correctly signed. Any `media` hashes the post
references MUST already be stored at this bank (upload precedes the post, §5).
Beyond validity, **acceptance is bank policy** — a spam filter, an allowlist, a
paywall, per-key rate limits, or nothing at all. A rejected post gets `-32000`;
nothing obliges a bank to store any post.

This asymmetry is the spam defense. Everybody can *create* a post linked to any
voucher, but a post only becomes visible where a bank agreed to carry it.
Someone who needs their post noticed must get it accepted by a bank the issuer's
audience actually polls.

## 3. Reading — `list_posts`, newest-first, filtered by the reader

```ts
list_posts(pubkey: Base58PubKey,
           voucher_hash: Base58SHA256 | "all",
           before?: ULID)
→ { items: Post[], next_before?: ULID }

get_post(post_hash) → Post
get_post_signatures(post_hash) → { signatures: Signature[] }
```

- **`pubkey`** — the **author** whose feed is being read. Any keypair: a bank, an
  issuer, or a plain user. Required; there is no "all authors" query (that would
  be a global timeline, which the protocol deliberately does not offer — feeds
  are the reader's own trust graph, §7).
- **`voucher_hash`** — a Voucher hash to filter to a single voucher's feed, or
  the literal string **`"all"`** to return this author's posts across every
  voucher.
- **`before`** — optional ULID cursor for pagination: return only posts whose
  `ulid` sorts strictly before it. Omit for the newest page; pass the previous
  page's `next_before` to continue.

The bank returns stored Post bodies in **reverse-chronological order** (newest
`ulid` first). It returns what it stored — it does not curate for the reader.
Post bodies carry the author's `sig` inline (so an embedded thread verifies from
the bytes returned). **Additional** signatures on a post — endorsements,
reactions, an issuer co-signing a holder's post — accrue *after* the immutable
post is signed, so they cannot live in the post body; they are fetched
separately with `get_post_signatures(post_hash)`, mirroring
`get_record_signatures` for records.

`list_posts` and `get_post`/`get_post_signatures` are public reads. Because the
results are immutable and content-addressed, banks MAY also expose them as
cacheable REST GETs (`bank-rpc.md` §2.5).

**Visibility is client-side curation.** There is no global timeline and no
bank-side ranking. A reader's client polls the banks an author uses and shows
posts only from authors in its own trust graph (§7). Everybody can post; only
the reader's own follows/trust decide what they see.

## 4. Replies and reposts

Both work by **embedding the full referenced Post**, not by hash reference —
`reply_to` for a threaded reply, `repost` for a boost.

- **Reply.** `reply_to` embeds the parent Post. The parent's own `reply_to`, if
  any, is embedded within it, so the chain of ancestors travels with the reply
  and renders as a thread offline. A reply MAY anchor to a different `voucher`
  than its parent (e.g. recommending voucher B in reply to a post about A).
- **Repost.** `repost` embeds the post being boosted: the referenced post gains
  the reposter's audience. The canonical use is an issuer amplifying a valuable
  holder post to everyone who follows the voucher. A repost MAY carry its own
  `body_md` commentary or leave it empty.

Embedding (vs. a bare hash) is what makes a thread verifiable and renderable
without extra round-trips — the trade is size, which the intake caps (§6) bound.
A client that still wants the *canonical current* form of an embedded post (e.g.
to fetch its accrued endorsements) resolves it by hash via `get_post` /
`get_post_signatures`.

## 5. Embedded media

Media referenced by a post — images, video — is **content-addressed** and stored
by the carrying bank. Each blob is identified by `sha256` (base58); a post names
the blobs it uses in `media` (and/or references them inline in `body_md` by the
same hash).

- **Upload** precedes the post: the author uploads each blob to the bank
  (`bank-rpc.md` §2.5), which returns the hash; the post then references it.
  Acceptance (size caps, types, quotas) is bank policy, like posts.
- **Download** is a plain, **unauthenticated** `GET <bank-url>/media/<hash>` —
  whoever knows the hash can fetch the bytes directly. Blobs are immutable and
  content-addressed, so responses are freely cacheable. A bank verifies the
  bytes hash to the requested value before serving.

Media inherits the same carriage-is-policy stance as posts: a bank MAY decline
or stop serving a blob without affecting the post's signature.

## 6. Moderation and limits

Consistent with the bank openness posture (`README.md` §1.1): validity checks
are protocol, carriage is policy. A bank MAY decline posts or media at intake,
blocklist an abusive author key, cap embed depth / post size / media size, or
stop serving stored content. None of that revokes the author's signature — a
post, once signed, is a fact; the bank only controls its own distribution of it.

## 7. Client-side feeds (non-normative)

A user follows a set of author pubkeys and knows a set of banks. The client
builds two kinds of feed by **merging `list_posts` results across every followed
author × every known bank**, ordered by `ulid` descending, de-duplicated by post
hash (content addressing makes the same post identical everywhere):

- **Per-voucher feed** — for one Voucher `V`: for each followed author `P`, call
  `list_posts(P, V)` at each bank; merge. This is "everything the people I follow
  said about this voucher."
- **All-vouchers feed** — the reader's home timeline: for each followed author
  `P`, call `list_posts(P, "all")` at each bank; merge. This is "everything the
  people I follow posted, across all vouchers."

Pagination composes: keep a per-`(author, bank)` `before` cursor and merge the
newest page from each source. Because each source is already newest-first, a
k-way merge yields a correct global order without the bank doing any cross-author
ranking.

## 8. Storage (implementation guidance, non-normative)

To serve `list_posts(pubkey, voucher_hash, before)` as a single ordered range
scan, a bank stores each accepted post under **more than one index key**, all
ordered by ULID so reverse-chronological reads are a bounded `before`-seeked
scan (Deno KV: a reverse range, or an inverted-ULID key):

- the canonical body once, content-addressed (`doc/<hash>`, via the standard
  doc store);
- `post_by_author/<pubkey>/<ulid>` → hash — serves `list_posts(pubkey, "all")`;
- `post_by_author_voucher/<pubkey>/<voucher>/<ulid>` → hash — serves
  `list_posts(pubkey, voucher)`.

Media blobs are stored by content hash (`media/<sha256>` → bytes + sniffed
content-type) and served by the REST GET in §5. Endorsement signatures are
indexed by their target post hash (`post_sig/<post_hash>/<sig_hash>`), exactly
like `record_sig` for records, so `get_post_signatures` is a prefix scan.

## 9. Future work (non-normative)

Deliberately unspecified in v1, expected to be figured out as real feeds appear:

- **Embedded documents** — first-class rendering of pubkeys, Vouchers, Orders,
  and other protocol docs inside a post body, so a recommendation can carry the
  thing it recommends.
- **Endorsement/reaction vocabulary** — the concrete `action`/shape of the
  signatures returned by `get_post_signatures` (likes, issuer co-signs, flags).

Extensions MUST be backward-compatible: a v1 client seeing unknown fields
ignores them; a v1 bank stores what validates today.
