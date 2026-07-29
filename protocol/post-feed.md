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
  body_md: string;         // markdown body; may reference media by ref
  media?: MediaRef[];      // content-addressed media refs "<hash>.<ext>" (§5);
                           // at most 12 per post (protocol cap, §5)
  icon?: MediaRef;         // voucher icon (meta releases; see voucher_meta)
  square?: MediaRef;       // voucher square card image (meta releases)
  voucher_meta?: boolean;  // true ⇒ this post RELEASES the voucher's meta:
                           // icon/square + body_md become the voucher's
                           // current presentation, newest release winning.
                           // Only the voucher's issuer may release; clients
                           // read the result via get_voucher_meta (§3).
  reply_to?: Post;         // the FULL parent Post, embedded (see §4)
  repost?: Post;           // the FULL reposted Post, embedded (see §4)
  sig: Base58Signature;    // author's signature
}

type MediaRef = string;    // "<base58(sha256(bytes))>.<ext>" — see §5
```

**Legacy forms (normative).** Posts signed before media extensions existed
carry `media` entries that are **bare base58 hashes** (no extension); such
entries remain valid forever — signed docs are immutable, and any validator
walking an embedded tree MUST accept them. Likewise, early meta releases used
inline-SVG fields `icon_svg` / `square_svg` (bounded `<svg>` strings) instead
of refs; the fields are deprecated in favor of `icon`/`square` but remain
valid and still feed a release when the ref fields are absent.

**Meta releases merge, artwork-wise.** A release that carries any artwork
(`icon`/`square`, or the legacy inline fields) defines the voucher's look
completely. A release that carries none is a **description update**: the bank
keeps the current artwork (from the previous release, or the Voucher doc's
own `images`) — otherwise a text-only release would silently strip a live
currency of its face.

Posts are ordinary content-addressed docs: canonicalized, hashed, signed by
their author. Every post anchors to exactly one Voucher — the feed is the
voucher's, not the author's. Like all signed docs a post is irrevocable; what a
bank chooses to *store and serve* is another matter (§6).

`reply_to` and `repost` **embed the full referenced Post object** (including its
own `sig`, and its own `reply_to`/`repost` in turn), rather than a hash. A reply
or repost is therefore **self-contained and independently verifiable**: a reader
checks the whole thread's signatures from the bytes in hand, with no follow-up
fetch. Because the embed is recursive, a deep thread nests its ancestors; the
protocol caps nesting at **8 levels** of `reply_to`/`repost` — validation
rejects deeper trees at every bank and client, a termination guarantee rather
than a tunable — banks additionally cap total post size at intake (§6), and a
client renders as deep as it received.

> **Invariant:** A Post's content hash is `base58(sha256(canonical(post minus
> top-level sig)))`, as for every signed doc. An embedded `reply_to`/`repost`
> keeps its own `sig` (only the *outer* post's top-level `sig` is stripped for
> hashing), so the outer author commits to the exact bytes — signatures
> included — of every ancestor it embeds.

## 2. Writing — `submit_docs`, accepted per bank policy

Posts are submitted through the standard `submit_docs` write path. The bank MUST
validate shape, author signature, that `voucher` resolves to a Voucher known to
this bank (its own, or one whose doc was presented to it — so any bank the
issuer uses can carry the feed), that every embedded `reply_to`/`repost`
Post is itself well-formed and correctly signed, and — when `voucher_meta` is
true — that the author's pubkey equals the Voucher's issuer pubkey (`-32001`
otherwise; only the issuer may restyle its own currency). Every media ref the
post commits to — across its whole embedded tree — MUST already be stored at
this bank (upload precedes the post, §5). The reference bank additionally
accepts a post only from the author's own authenticated session — the author
pubkey must equal the RPC sender (`-32001`), so a third party cannot relay
someone else's signed post there; a bank that wants relayed submission may
allow it as policy.
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

get_voucher_meta(voucher_hash)
→ { voucher, icon?, square?, icon_svg?, square_svg?,
    description_md?, post, ulid } | null
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

**`get_voucher_meta`** answers "what does this voucher look like right now":
the bank caches the newest issuer meta release per voucher at intake and
returns it here (`post` names the releasing Post's hash). When the issuer has
never released, it falls back to the Voucher doc's own fields — `images[0]` as
icon, `images[1]` as square card (by convention) and `description_md` — and
returns `null` only when the voucher carries neither. This is the read half of
`voucher_meta` releases (§1); the Discover surface
([`discovery.md`](./discovery.md) §5) resolves every sighted voucher through
it.

`list_posts`, `get_post`/`get_post_signatures`, and `get_voucher_meta` are
public reads. Because post bodies are immutable and content-addressed, banks
MAY also expose the post reads as cacheable REST GETs (`bank-rpc.md` §2.5);
`get_voucher_meta` is mutable (newest release wins) and caches accordingly.

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

## 5. Embedded media — the vault

Images (and later, other media) live **separately from the documents that use
them**, in the bank's content-addressed **vault**. A Voucher, a Post, an
Address never embeds image bytes — it carries **refs**:

```
MediaRef = "<base58(sha256(bytes))>.<ext>"     e.g. "8fJk…Qz2.svg"
```

The **hash is the identity**: two uploads with the same content hash are the
same blob, and re-storing it overwrites (a no-op — the bytes are identical by
construction). The **extension is for delivery**: a bank serves

```
GET <bank-url>/media/<hash>.<ext>      — unauthenticated
```

with the `Content-Type` the extension implies and immutable caching headers.
The extension set is **closed at the protocol level** — exactly `svg`
(`image/svg+xml`), `png`, `jpg`/`jpeg`, `webp`, `gif`; a ref with any other
extension fails validation at every bank (`bank-rpc.md` §2.5). Because
the URL is content-addressed and the extension names the type, blobs can be
statically hosted and pushed through any caching CDN — fast, cheap public
downloads with no byte-sniffing anywhere. The bank verifies the bytes hash to
the ref's hash before serving.

- **Upload precedes the doc.** The author uploads each blob to the bank
  (`bank-rpc.md` §2.5), which returns the ref; the doc then carries the ref.
  Acceptance (size caps, quotas) is bank policy, like posts; the format set
  is the closed protocol list above.
- **Media counts are protocol caps.** A post carries at most **12** `media`
  refs — enforced by validation, so it binds every post in an embedded tree
  at every compliant bank. Separately, the reference bank's intake bounds the
  media refs across the **whole embedded tree** at **64** (`-32000`); that
  bound is reference-bank policy, since per-ref checking and cross-bank
  copying are work deep embeds could otherwise multiply.
- **Accepting a doc means holding its images.** When a bank accepts a Post it
  MUST already hold every ref the post commits to — across the **whole
  embedded `reply_to`/`repost` tree**, `media` lists and `icon`/`square`
  alike. The same applies to a Voucher's `images`. A doc whose blobs are
  missing is rejected (`-32005`).
- **Reposting across banks copies the blobs.** A repost embeds the original
  post — whose refs may name blobs stored only at the origin bank. Since the
  accepting bank requires presence, the reposting **client downloads each blob
  from the origin bank and uploads it to the bank it is reposting to** before
  submitting. Content addressing makes this safe: the copied bytes hash to the
  same ref everywhere, so the embedded post's signature still verifies.
- **Moderation is the bank's.** A bank MAY refuse a blob at intake or stop
  serving one it holds; the protocol does not prescribe how a bank moderates
  images. Refusing a blob effectively refuses the posts that need it.

## 6. Moderation and limits

Consistent with the bank openness posture (`README.md` §1.1): validity checks
are protocol, carriage is policy. A bank MAY decline posts or media at intake,
blocklist an abusive author key, cap post size / media size, bound the total
media refs across an embedded tree (the reference bank allows 64, §5), or
stop serving stored content. Embed depth is **not** a per-bank knob: the
protocol itself caps nesting at 8 (§1). None of that revokes the author's
signature — a post, once signed, is a fact; the bank only controls its own
distribution of it.

*Non-normative:* the reference bank **reposts every user post it accepts**
under its own key — a bank-signed post whose `repost` embeds the stored post.
Because new users follow their host bank by default
([`discovery.md`](./discovery.md) §5), this carriage-policy amplification is
what seeds a newcomer's feed; unfollowing the bank is the opt-out. The repost
is best-effort and never fails the author's write.

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

Media blobs are stored in the vault keyed by content hash (`media/<sha256>` →
bytes, plus size/chunking metadata and the upload-time content type). The
ref's extension names the Content-Type for canonical `"<hash>.<ext>"` GETs;
the recorded type serves legacy bare-hash GETs (§5). Blobs are served by the
REST GET in §5. Endorsement signatures are
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
