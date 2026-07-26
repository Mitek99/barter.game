# Emulated users

Six invented people living on the two deployed demo banks. They exist to make
the demo look inhabited, and — because driving them exercises every screen and
every RPC — to shake out what is broken. Four real bugs fell out, and the one wholly
missing feature (post feeds) has since been built; see
[Gaps and defects](#gaps-and-defects).

Current as of `main` **`a0afd41`+**. Everything below is live on the deployed
banks: the six users have vouchers, trust links, settled deals, and — since
post feeds shipped ([#28](https://github.com/ai-1st/barter.game/pull/28)) —
posts, replies, reposts and cross-bank feeds.

**Target:** the deployed banks, not localhost.

```
https://barter-game-banks.ai-1st.deno.net/alice/ui
https://barter-game-banks.ai-1st.deno.net/bob/ui
```

**Password for every emulated user: `12345678`.**
(`123` was the original intent; the register screen enforces an 8-character
minimum — see [gap 6](#6-registration-requires-8-characters-client-side-only).)

Anyone can log into either bank's UI with a handle below and that password —
the key is decrypted from the bank-held keystore in the browser, exactly as a
real user's would be.

| Bank | Pubkey |
|---|---|
| `alice` | `9Fv3kB8N1cp96opUrmvQRK7VNtw7N6jZFNdyqqs4hNCK` |
| `bob` | `CP94rE9FJUV9wfMhKFg5t7cW8ybcAbHuznrkisC3s2kV` |

---

## The cast

### Bank `alice`

#### mira — Mira Okonkwo, graphic designer

- **pubkey** `EjzgX5h7f8wTqHKFvdQA1JMKfBiffiKKFWt9WttnrhcT`
- **issues** `1 logo concept` — `7ZJqzmrwQzre7XeWyrArJz2Qp1Fw8apUNZqYAhttbz5R`
  - *One original logo concept: three routes sketched, one taken to final in vector. Includes a light/dark lockup and a one-page usage note. Two revision rounds.*
  - issuer account `2PzeLRM45B8hVYGCJu4bdnVhUmdRQgN6jiowjJagdJhf`
- **holds** `6H9J7kpgn2aF8Sa9ytLgZ1icf219SXM8h3soU7aYJ9cm` — +1 `1 haircut`
- **balances** `1 logo concept` **−1** · `1 haircut` **+1**

**Memory.** Registered through the browser, not the CLI — she is the one
identity created by hand, so she is the proof that the UI onboarding path
works end to end. Minted her voucher through the UI too. Trusts tomas ("cuts
my hair every six weeks"), priya ("sorted my residency paperwork in one
sitting"), and kai across on bank bob ("wants a poster for his recital").

**Intentions.** Trade design work for the things she actually needs rather
than invoicing for money. She has already paid for a haircut with a logo.

**Next steps.**
1. Deliver kai's recital poster and settle it cross-bank — she has bank bob
   pinned and trusts him, but no order exists yet.
2. Mint a second, cheaper voucher (`1 brand palette`) so she has something to
   offer below the price of a full logo.
3. Once [PR #24](https://github.com/ai-1st/barter.game/pull/24) ships, redo the
   tomas trade as a single atomic swap instead of the two one-sided deals it
   took today.

#### tomas — Tomás Reyes, barber

- **pubkey** `3JeGtj2XHeCrh2kHFz41wY9UNxNJu3F6V5JGsF3CiWP1`
- **issues** `1 haircut` — `FLbcMSRvYrwWzh8StpCb7of6eZ4zsNnymYnVvbb9dZ9L`
  - *A proper cut and hot-towel finish at the chair on Rua Verde. Walk-ins welcome; redeem any Tuesday to Saturday.*
  - issuer account `Ho3UWYsKDdFthV29wXjuzt3hiGEguARGwi61Fx2xZmbN`
- **holds** `FFCfsN5fwi4A9THV4wfgkVKigfooJi8LTuXTW3MxCjzE` — +1 `1 logo concept`
- **balances** `1 haircut` **−1** · `1 logo concept` **+1**

**Memory.** Registered and driven entirely from the CLI. Trusts mira
("designed the sign above my chair") and priya ("everyone on the street sends
their visa questions to her"). His chair is the social hub of the alice bank —
both other alice users trust him or are trusted by him.

**Intentions.** Keep a small, steady float of haircuts outstanding. He is
comfortable being negative; that is the credit he extends to his street.

**Next steps.**
1. Publish a standing cheque for 3 haircuts so newcomers can claim one without
   negotiating.
2. Redeem the logo concept from mira — he holds +1 but has not called it in.
3. Meet the bob-bank users; he has pinned no foreign bank yet and so cannot
   trade across.

#### priya — Priya Raman, immigration lawyer

- **pubkey** `6g5F1oSprNG466okGCXKe6P7JdvtdWYBN2uNJbgA8L3u`
- **issues** `1 hour of legal advice` — `9Bz2mvoK3MkzeizXfKBrWcFaj3q5e2D5HtbGXxuvBqWy`
  - *One hour of immigration law consultation — visa routes, appeals, paperwork review. Remote or in person.*
  - issuer account `GjAaAu9a4igbr5nsTrNcSsQC2bJbf16yT7mxQYAfXxWY`
- **holds** `HV74dWEZfN2FRvozWjjWdMumNxxh22bYiG5PAMmt85sh` **at bank bob** — +1 `1 sourdough loaf`
- **balances** `1 hour of legal advice` **−1** (alice) · `1 sourdough loaf` **+1** (bob)

**Memory.** The federation's first cross-bank trader. Pinned bank bob, trusted
yusuf, opened an account on his voucher *at his bank*, and settled a genuine
bilateral swap: one hour of legal advice for one sourdough loaf. That deal —
`01KYC7T4ZNZW93AJ7643W4CCHE` — settled on the first poll.

**Intentions.** Prove that trust can cross banks. She is the reference case for
the whole federated premise.

**Next steps.**
1. Her sourdough holding is **invisible in the alice UI** — `/portfolio` only
   reports local accounts ([gap 4](#4-portfolio-is-local-only--cross-bank-holdings-are-invisible)).
   Until that is fixed she has to be told her own balance.
2. Offer a second hour to tomas, who has visa questions from the street.
3. Set a supply `limit` on her voucher — she cannot actually deliver unbounded
   legal hours, and nothing currently stops her issuing them.

### Bank `bob`

#### yusuf — Yusuf Demir, sourdough baker

- **pubkey** `CPgS2kmC4VWgWUP9u4i7CSZQSZSrFTdyvEirGzTxpzNQ`
- **issues** `1 sourdough loaf` — `6URaUWGHHSLrdRoSmjbiaTkE8spGAjzdsXoMT1YNdD7S`
  - *A 1kg naturally leavened sourdough, baked the morning you redeem it. 48-hour cold ferment.*
  - issuer account `7SYa3VqTKht3zqvoWax6qB7Z6eRXxMmeoqmnxgkkhnfm`
- **holds** `EZL6VXXnDHv3cKQoN3Cv3cuJ9iMWHcQ7gLUMohYQZVKB` **at bank alice** — +1 `1 hour of legal advice`
- **balances** `1 sourdough loaf` **−1** (bob) · `1 hour of legal advice` **+1** (alice)

**Memory.** Priya's counterparty in the cross-bank swap. Pinned bank alice,
trusts priya ("handling my sister's visa — straight answers, no padding") and
lena ("keeps the delivery bike running through winter").

**Intentions.** Trade bread for the professional services he cannot afford in
cash. His sister's visa is the reason he crossed banks at all.

**Next steps.**
1. Redeem the legal hour — he holds +1 at alice and has a real question.
2. Publish a weekly standing offer (Friday loaves) rather than one-off orders.
3. Same invisibility problem as priya: his alice holding does not show in the
   bob UI ([gap 4](#4-portfolio-is-local-only--cross-bank-holdings-are-invisible)).

#### lena — Lena Vogt, bike mechanic

- **pubkey** `5DybViMKvW8xEN5RWvVS8wC9ehnecq1qj3hCSHYtGB3F`
- **issues** `1 bike tune-up` — `8hhMTyZdf8ov85uJXPJhptXKghi6iWGGXb2Q5d4DV3q8`
  - *Full drivetrain clean, brake and gear adjustment, true both wheels. Parts not included.*
  - issuer account `9CpDJS13mCcT9rpJTdb7rmgAKPJWV7ZuuozP7wo3SFXM`
- **holds** `F7qMLP4jeP2dpwH4BFzDYcWBhrXv7kfcvXbhhfJjiv7G` — +1 `1 piano lesson`
- **balances** `1 bike tune-up` **−1** · `1 piano lesson` **+1**

**Memory.** Trusts kai ("teaches my daughter — patient, turns up on time") and
yusuf ("best loaf in the neighbourhood, no argument"). Traded a tune-up for a
lesson, and hit the same-bank swap bug doing it
([gap 2](#2-critical-a-two-sided-swap-inside-one-bank-can-never-settle)) before
falling back to two one-sided deals.

**Intentions.** Keep the neighbourhood's bikes running and take payment in
things her daughter needs.

**Next steps.**
1. Trade with yusuf — she trusts him and they share a bank, but no order exists.
2. Advertise winter servicing before the season.
3. Retry the kai swap atomically once [PR #24](https://github.com/ai-1st/barter.game/pull/24) lands.

#### kai — Kai Nakamura, piano teacher

- **pubkey** `H56jpj7YV29dRCCR66hHmb8bboJushDXnkgEFCEeNzdt`
- **issues** `1 piano lesson` — `Bs71vA49AVkUfYaqpESiJT4juJduNqSUNhDgUeNjk8RB`
  - *A 45-minute piano lesson, beginner to intermediate. Classical or jazz voicings, your pick.*
  - issuer account `9f3NSJ8g9cu1qNXuHzHRHoJLM8Y9V6SvDB1ktJ6vkU6W`
- **holds** `CESHAi7GYx8963M3vSQtME2aqTADZp2Ti4YbqRCceZzq` — +1 `1 bike tune-up`
- **balances** `1 piano lesson` **−1** · `1 bike tune-up` **+1**

**Memory.** The only bob user who has pinned bank alice *and* trusts someone
there (mira, for the recital poster) without yet trading with them. Trusts lena
("rebuilt my rear hub for the price of a lesson") and yusuf.

**Intentions.** Fill his teaching week by trading lessons for everything else.

**Next steps.**
1. Commission mira's recital poster — the trust and the bank pin are in place;
   only the orders are missing. This is the cleanest next cross-bank deal.
2. Cap his voucher supply; he has finite hours in a week.
3. Publish a beginner-rate lesson at a lower quantity.

---

## The trust graph

```
bank alice                                   bank bob
──────────                                   ────────
mira ──trusts──▶ tomas                       lena ──trusts──▶ kai
mira ──trusts──▶ priya                       kai  ──trusts──▶ lena
tomas ─trusts──▶ mira                        yusuf ─trusts──▶ lena
tomas ─trusts──▶ priya                       lena ──trusts──▶ yusuf
priya ─trusts──▶ mira                        kai  ──trusts──▶ yusuf

                   ── across the federation ──
        priya ◀──trusts──▶ yusuf     (traded: settled)
        mira  ◀──trusts──▶ kai       (not yet traded)
```

Banks pinned: `priya`, `mira` → bob · `yusuf`, `kai` → alice.
`tomas` and `lena` are bank-local only.

Contacts (a separate list from trust) were populated for `mira` (tomas, priya,
kai) and `priya` (yusuf) — **from the CLI only**, because the UI cannot create
them ([gap 5](#5-contacts-are-readable-and-removable-in-the-ui-but-cannot-be-added)).

---

## Deals

| Deal | What | Banks | State |
|---|---|---|---|
| `01KYC7T4ZNZW93AJ7643W4CCHE` | priya's legal hour ⇄ yusuf's loaf | alice + bob | **settled** |
| `01KYCK7CNZ2QP0N2BBY76DQG2Q` | tomas → mira, 1 haircut | alice | **settled** |
| `01KYCK854HPYBFYP8752T34K1Y` | mira → tomas, 1 logo concept | alice | **settled** |
| `01KYCK9TYZF4VKJKEWDS4GAAE9` | lena → kai, 1 bike tune-up | bob | **settled** |
| `01KYCKA5MBCTZJTZWDKGQNNZ9G` | kai → lena, 1 piano lesson | bob | **settled** |
| `01KYC7PDD1FT1BY67C9BWK66KF` | mira ⇄ tomas atomic swap | alice | **rejected — [gap 2](#2-critical-a-two-sided-swap-inside-one-bank-can-never-settle)** |
| `01KYC7VWRZRQV2E3QSMW5QFN41` | lena ⇄ kai atomic swap | bob | **rejected — [gap 2](#2-critical-a-two-sided-swap-inside-one-bank-can-never-settle)** |

Every voucher sums to zero across its accounts. The two rejected deals are the
bug, not a scenario: the same-bank pairs had to be re-run as two one-sided
cheque/invoice deals each, which loses atomicity — either side can walk after
the first leg settles.

---

## How they were driven

Both interfaces, deliberately.

**UI** — `mira` was registered by hand at
`https://barter-game-banks.ai-1st.deno.net/alice/ui`, minted `1 logo concept`
through the New-voucher form, logged back in with handle + password after a
reload, and her Network screen was used to verify trust and contact rendering.

**CLI** — the repo has no CLI (`apps/cli/` was deleted; `scripts/demo-*.sh`
still invoke it and are broken — [gap 8](#8-the-repo-has-no-cli)), so
`scripts/emulate.ts` was written for this. It speaks the same two transports
the SPA does, and writes the **same PBKDF2-SHA256(250k) + AES-256-GCM keystore
blob**, which is what makes the two interchangeable: a CLI-registered user can
log into the browser, and a browser-registered user can be driven from the CLI.

```bash
./scripts/emu register mira@alice          # or log in at /alice/ui — same account
./scripts/emu mint     tomas@alice "1 haircut" --desc "..."
./scripts/emu open     priya@alice <voucher> bob
./scripts/emu cheque   lena@bob <voucher> bob <account> 1
./scripts/emu invoice  kai@bob  <voucher> bob <account> 1
./scripts/emu propose  priya@alice <order1> <order2> 1 alice,bob
./scripts/emu deal     priya@alice <dealId>
./scripts/emu discover priya@alice <voucher,...> alice,bob
./scripts/emu portfolio yusuf@bob
```

`./scripts/emu` with no arguments prints the full command list. Target another
deployment with `BARTER_BASE=http://localhost:8000`.

`.emulated-state.json` caches handles, pubkeys and private keys locally. It is
only a cache — `loadUser` falls back to fetching the keystore from the bank and
decrypting it with the password, so the file can be deleted at any time.

---

## Posts and feeds

Each user announced their voucher, then the conversation crossed banks.

| Author | Bank | Post |
|---|---|---|
| mira | alice | *"Two logo slots open in August. I'd rather trade than invoice — haircuts, legal hours, bread, all welcome."* |
| tomas | alice | *"Chair is free Thursday afternoons. First cut of the month goes to whoever brings the most interesting swap."* |
| priya | alice | *"Visa season. I have four consultation hours to give this month — appeals and paperwork review included."* |
| yusuf | bob | *"Friday bake is up: 1kg naturally leavened, 48-hour cold ferment. Reserve one and collect it warm."* |
| lena | bob | *"Winter is coming for your drivetrain. Booking tune-ups now — I take lessons, bread and legal advice."* |
| kai | bob | *"Two lesson slots free on Tuesdays. Beginners very welcome; jazz voicings if you'd rather."* |

Then the threads:

- **mira → tomas** (reply, same bank): *"Bringing sketches Thursday — swapping you a logo concept for the chair."*
- **kai → lena** (repost, same bank): *"Can vouch — she rebuilt my rear hub for the price of a lesson."* — an issuer amplifying a neighbour's post to his own followers.
- **yusuf → priya** (reply, **cross-bank**): *"She sorted my sister's visa and took a loaf for it. Worth crossing banks for."* — yusuf banks at bob, but posted into the feed alice carries, which §2 allows for any bank that knows the voucher.

### Discovery through posts

There is no global timeline. Each reader's feed is their own trust graph merged
across every bank they have pinned — so **every user sees a different feed**:

```
feed for mira@alice  — 4 post(s) from 4 author(s) across 2 bank(s)
feed for priya@alice — 5 post(s) from 3 author(s) across 2 bank(s)
feed for kai@bob     — 7 post(s) from 4 author(s) across 2 bank(s)
feed for lena@bob    — 4 post(s) from 3 author(s) across 1 bank
```

Mira sees kai's piano-lesson post *because she trusts him and pinned bank bob* —
she discovered a voucher on another bank purely through the feed. Lena sees only
one bank's worth, because she never pinned alice.

Drive it with `./scripts/emu`:

```bash
./scripts/emu post  mira@alice <voucher> "Two logo slots open in August."
./scripts/emu post  mira@alice <voucher> "Bringing sketches Thursday." --reply <postHash>
./scripts/emu post  kai@bob    <voucher> "Can vouch."                   --repost <postHash>
./scripts/emu post  yusuf@bob  <voucher> "Worth crossing banks for." --reply <hash> --at alice
./scripts/emu feed  priya@alice
./scripts/emu posts mira@alice <authorPubkey> all
```

Or in the browser: **Posts** in the nav (it was previously an unlinked route).
The feed filter switches between "everything from people I trust" and a single
voucher's feed; Reply and Repost embed the parent post.

## Gaps and defects

Found by driving the six users. Three had fixes worth opening; the rest are
recorded here.

### 1. ~~Post feeds do not exist~~ — BUILT

When these users were first driven, post feeds were the one part of the brief
that could not be done: no `Post` type, no handler, no KV namespace, and a
"Posts — coming soon" card in the UI. The spec existed; nothing implemented it.

**Now implemented** ([#28](https://github.com/ai-1st/barter.game/pull/28),
plus label polish in [#29](https://github.com/ai-1st/barter.game/pull/29)) and
deployed. The six users now announce their vouchers with real posts, reply to
each other, repost, and discover each other **through those posts** — see
[Posts and feeds](#posts-and-feeds) below.

Still bank policy and not implemented here: an acceptance hook beyond validity
(spam filter, allowlist, paywall, per-key rate limits). §2 makes that
deliberately bank-specific.

### 2. CRITICAL: a two-sided swap inside one bank can never settle

→ **[PR #24](https://github.com/ai-1st/barter.game/pull/24)** (fix + `e2e-sameswap.ts`)

`handleProposeDeal` minted one record pair **per participating bank**. A
two-sided swap moves two vouchers and needs two pairs; when both vouchers are
issued by the same bank there is only one participating bank, so only one pair
was created. The counterparty Order's legs were never mandated, and
`aggregateRateCheck` correctly treats a two-sided Order with a missing leg as
the permanent missing-leg case — so the deal is **rejected**, not stalled.

Hit by both same-bank pairs (mira⇄tomas, lena⇄kai). The deal dump shows two
legs naming the *same* voucher; the other voucher's pair simply does not exist.
Cross-bank swaps are unaffected, which is why `e2e-crossbank` never caught it,
and `e2e-cheque-local` is one-sided so it was unaffected too. The uncovered
cell was exactly *two transfers, one bank*.

### 3. `/o/` share links for swaps always 404

→ **[PR #25](https://github.com/ai-1st/barter.game/pull/25)**

The Orders screen shared a two-sided order as `showShare('o', o.order, …)`, but
`/o/<value>` resolves an **Offer** hash via `getOffer`, which returns null for
an Order doc. Every swap QR and copied link was dead:

```
GET /alice/o/<order hash>?format=json -> 404 {"code":-32005,"message":"not found"}
GET /alice/o/<offer hash>?format=json -> 200 {"v":1,…,"kind":"offer",…}
```

`/ui/orders` already returns the derived Offer hashes. Invoice (`v`) and cheque
(`q`) links are fine — those kinds do resolve Order hashes.

### 4. Account balances were readable by anyone

→ **[PR #26](https://github.com/ai-1st/barter.game/pull/26)**

`get_account_balance` never looked at the envelope sender — it resolved the
account hash and returned the balance to whoever asked. Account hashes are not
secrets: they sit inside every Order side a counterparty signs. Verified live
with `kai@bob` reading an unrelated alice account:

```
balance GjAaAu9a4igb… @alice: {"current":-1,"pending":0}
```

`bank-schema.md` §1.2 says accounts are private by default; `Account.public`
does not exist in v1, so holder + voucher-issuer is the whole allow-list.

### 4b. `/portfolio` is local-only — cross-bank holdings are invisible

**Not fixed; needs a design call.** `handlePortfolio` lists only
`listAccounts(bank, pubkey)` and hardcodes `unreachable: []`. Priya really does
hold +1 sourdough at bank bob, but the alice UI shows her only the legal-advice
leg — so a cross-bank trader sees half their position and the Home "Balances"
card silently understates what they own.

Distinct from the "public-holdings discovery" item in `UX-REPORT.md` §3 — that
is about seeing *other people's* balances (`list_public_balances`,
`Account.public`). This is a user unable to see **their own** holdings at a bank
they have already pinned.

The hardcoded `unreachable: []` and the whole `/banks` pinning mechanism imply
this was meant to fan out. The bank cannot do it itself: `list_accounts` keys
off the envelope sender, so a peer bank calling it gets *its own* accounts, not
the user's. The fix belongs in the client — have the SPA call `/ui/portfolio`
at each pinned bank with its own signed auth (`signedRequestAt` already exists)
and merge. Left alone rather than guessed at, since it changes the trust model
slightly and deserves its own review.

### 4c. Activity / history is always empty

**Root cause not pinned — reported as a reproducible symptom.**

Every emulated user has settled deals, and the Home screen shows their settled
balances correctly, but "Recent activity" reads *No activity* and the Activity
screen is blank. `/ui/history` returns nothing:

```
/history?limit=20 -> {"events":[],"next_cursor":null}
```

Reproduced from scratch on a **local** bank — register two users, mint, settle
one cheque/invoice deal, then query as each party:

```
rhx29835@alice -> { "events": [], "next_cursor": null }
ghx29835@alice -> { "events": [], "next_cursor": null }
```

So it is not a production data artifact. `handleHistory` scans
`[bank.pubkey, 'account_record', <accountHash>]`, and `storeRecord` does write
`k(bank, 'account_record', details.account, h)` — the two look like they should
line up, and `list_accounts` correctly returns both of a user's accounts. I did
not get to the bottom of why the scan comes back empty; it needs someone with
KV access to dump the `account_record` prefix after a settle. Not PR'd, because
I will not guess at a fix for a cause I have not proven.

Effect: the ledger is correct but invisible. A user can see *what* they hold and
never *how they got there*, which for a mutual-credit ledger is most of the
story.

### 5. Contacts cannot be added from the UI — *known and deliberate*

Not a new finding. `UX-REPORT.md` §3 already records it under **Deliberately
not done**:

> **Add-a-contact** (Network → Contacts lists and removes, but can't add).
> Skipped because the feature's purpose is undefined — contacts aren't used by
> any flow. Either give contacts a job or drop the section.

Recorded here only because driving the users demonstrated the other half: the
endpoint works fine. Contacts POSTed from the CLI render correctly on mira's
Network screen (tomas, priya, kai), so the gap really is just the missing
browser affordance, not a broken API. The "give it a job or drop it" call still
stands.

### 6. Registration requires 8 characters (client-side only)

The brief asked for `123`. `#/register` refuses it:

> Password must be at least 8 characters

`MIN_PASSWORD = 8` is enforced in `apps/web/app.js` at registration only. The
**login** path has no minimum, and the server validates nothing — `/ui/register`
stores whatever keystore blob it is handed. So a 3-character password is
reachable via the API and would then log in fine through the UI; only the
register form blocks it. Hence `12345678` throughout.

Worth deciding which layer owns this rule: right now it is advisory, and a
non-browser client can ignore it.

### 7. A page reload logs you out

The decrypted key is held in memory only, so any full navigation drops the
session back to the welcome screen. Correct for key hygiene, but it means deep
links into `#/vouchers/new` and friends cannot be opened cold, and any
automation must drive the SPA purely through in-page hash routing. Worth an
explicit "your session ended, log back in" state rather than a silent bounce.

### 8. The repo has no CLI

`apps/cli/` was deleted; `scripts/demo-local.sh` and `scripts/demo-deploy.sh`
still invoke it and are broken (already flagged in `README.md`, `AGENTS.md` and
`TODOS.md`). `scripts/emulate.ts` here is a working substitute for this
scenario, not a replacement for the removed CLI.

### 9. Pre-existing debris on the demo banks

The alice and bob registries carry leftovers from earlier e2e runs
(`FGX-…`, `FGY-…`) plus two `PROBE-…` vouchers from diagnosing gap 2. There is
no delete path and `list_vouchers` returns everything, so the Registry screen
shows test junk beside the emulated users' real vouchers. Per the v1 migration
policy the remedy is to wipe the demo banks' KV.

### 10. Non-issue, worth knowing: content addressing changed recently

`cfaf3bb fix(protocol): hash a doc over the same preimage its signature signs`
changed `hashDoc` to strip `sig` before hashing. Anything scripted against a
checkout older than that commit will compute different content addresses than
the deployed banks and fail with `-32005 account voucher unknown`. The vendored
`apps/web/protocol.js` **is** in sync — the parity test *"web mirror agrees with
the source on hashing and signing"* passes. Pin scripts to `origin/main`.
