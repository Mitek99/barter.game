# barter.game — Review: Protocol Gaps, UI Improvements & Future Directions

*Prepared 2026-07-06, against `main` after PR #1 (QR + landing journeys). Sources: `protocol/` contract, `apps/bank` + `apps/web` reference implementation, `docs/ui/claude-ui.md`, `scenarios/`, `WORKAROUNDS.md`, and live browser testing of every flow named below.*

## How to read this

- **Part I — Protocol gaps** (S1–S22, ranked): where the v1 contract is incomplete, ambiguous, or diverges from the reference implementation. Each has a failure scenario and a suggested resolution direction.
- **Part II — UI improvements** (1–20, ranked by user impact): what remains after the QR/landing work.
- **Part III — Future directions**: a near/mid/far roadmap grounded in what v1 already promises.
- **Part IV — Per-voucher blogs**: a concrete design sketch for the nostr-style feed idea, ready to review; its §8 lists the decisions only you can make.

## Executive summary

**What works today (browser-verified):** register with in-browser key encryption → issue vouchers → share profile/invoice/cheque QR codes → a second user scans, registers through the landing page, claims a cheque (+10 settled), pays an invoice (−3 settled), and trusts the issuer — all through signed docs verified client-side, settling through the Mandate flow on the live bank. Cross-bank swaps settle in the same-deployment configuration.

**The three findings I would act on first:**

1. **Reject is unimplemented (S1).** Per the owner: no-timeout (S2) and fire-and-forget fan-out are by design, so the one genuine gap in this cluster is that banks never issue the `reject` Signature the contract mandates — an underfunded payer produced a silently stalled deal during browser testing. Reject is a bank-issued Signature fanned out like `hold`/`settle`; coordinator and holders play no role and must not be able to trigger it.
2. **Cross-bank rate should be derived from the counterparty Order (S4).** Each bank already stores both Orders of the exchange, so the rate check can be bank-asserted instead of trusting the caller's `counter_amount` — a contract + implementation alignment worth making. (`seen`/S3 is by design — opaque partial-order evidence — and will be discussed separately.)
3. **Federation: now proven cross-process, cloud pending.** The HTTP bank-to-bank path (Address sharing, create_records, submit_mandate, the lead/follow notify_signatures cascade) settled a bilateral swap between two fully isolated local bank processes (separate ports and KV stores) on 2026-07-06 — topologically two deployments. The remaining step is repeating it across two real Deno Deploy apps (blocked only on dashboard access to create the second app).

**Fixed during this review** (PR #1, found by driving the UI): the advance engine could hold/settle the *ready subset* of a deal's records, letting one half of a debit/credit pair settle alone (sum-invariant violation); a filtered-array index bug mispaired records with Orders in the settle wave; signed-request auth dropped the query string, silently blanking `/ui/orders?kind=…`; `submit_docs` was order-sensitive within a batch.

**On the voucher-blog idea:** it fits v1 unusually well — posts are just another signed, content-addressed BaseDoc; the issuing bank is a natural home relay; issuer curation maps to repost semantics with zero new crypto. Part IV is a full design. The open questions that shape it most: deletion/retraction policy, curated-vs-firehose default, and whether posting requires holding the voucher.

---

# Part I — Protocol gaps

## barter.game v1 — Protocol Gap Analysis

Findings ranked by severity. Each cites the doc location and, where relevant, the reference implementation's forced choice. "Impl" = `apps/bank`.

---

### S1 — Reject issuance and reject-cascade are a MUST with no wire mechanism and no reference implementation

> **Owner verdict (2026-07-06):** Reject is a **Signature**, propagated exactly like the other signature actions. Settlement is bank-only: once the Coordinator signs a Mandate, banks settle among themselves — coordinator and holders are passive, and the coordinator must NOT be able to request a reject. The open work is therefore exactly: banks auto-issue `reject` on failed preconditions and fan it out like `hold`/`settle`. The earlier suggestion of a coordinator-initiated reject is withdrawn. **Implemented 2026-07-06**: permanent-failure detection at ready, deal-wide cascade with hold release, fan-out to counter-side banks (`advance.ts`, verified by `e2e-reject.ts`; spec in `bank-schema.md` §2). Remaining piece: *acting on a foreign bank's reject* needs the slice-enumeration Mandate — see `docs/design/mandate-validation.md`.

> **Partial fix landed during this review (PR #1):** a related sum-invariant bug — the hold wave used to hold/settle the *ready subset*, so one half of a debit/credit pair could settle while its mate was stuck — is fixed (`advance.ts` now requires every owned record ready before any hold). The reject gap itself is untouched: a failed precondition still silently stalls the deal instead of cascading a reject.
`bank-schema.md §2` and `README.md §2.0(2)` say a bank "MUST issue a `reject` signature" when a record can't be held, that reject "propagates to the record's paired counterpart and is fanned out to peer banks," and that any bank with dependent records "MUST reject those as well." But **nothing is specified about how**: no method to submit a reject, no rule for who may originate one (only banks sign `reject`, yet a stuck coordinator/holder has no way to trigger one), no definition of "records depending on the rejected ones" across the visibility boundary (a peer bank can't see which of its records pair with a foreign rejected record), and no fan-out target list. The reference `advance.ts` **never calls `signAndStore(..., 'reject')` on any path** — `readyCheck` failure and `acquireHoldsForDeal` failure just silently `return` (advance.ts:92–97, 100–110), leaving records in `created`/`approved` forever. So the one abort primitive the protocol advertises is both underspecified and unimplemented.
*Failure:* an uncovered debit or lock conflict silently hangs the whole deal instead of cascading a reject; counterparties' holds never release. *Fix:* define a `reject` origination rule (bank auto-rejects on failed precondition and fans out to `Order.bank` peers; coordinator may request reject via a signed call), specify the dependency graph a peer uses to propagate (paired `pair` ULID + Mandate record set), and require the impl to emit it.

### S2 — No timeout anywhere: stuck holds and never-expiring Orders are permanent griefing surface

> **Owner verdict (2026-07-06):** **By design.** No timeouts; docs stay active forever because this is a distributed system. Not a gap to fix at the protocol level (implementations may still surface stuck states in UX).
`README.md §2.2` and the locked-decisions table make "no protocol-level timeout" an explicit invariant, and `bank-schema.md §1.4` states Orders "have no expiration, they remain on the ledger indefinitely." Combined with S1 (no working reject), a lead bank that holds and never settles (`coordinator-arbitrage.md §Attack 1`) locks a counterparty's balance with no protocol recovery. A malicious coordinator can `create_records` + `submit_mandate` against a victim's standing Order, forcing a `hold` on the victim's account, then walk away — the victim's funds are frozen until an *optional* implementation sweeper (which the impl does not have) releases them. *Fix:* even if rollback stays social, add an OPTIONAL-but-recommended hold TTL after which a bank MUST self-reject (`-32004` is already reserved for Timeout but "not used in v1"), and let Orders carry an `expires` field like Vouchers do.

### S3 — Follower's `seen` cascade proof cannot actually be validated across the visibility boundary

> **Owner verdict (2026-07-06):** **By design; to be discussed separately.** `seen` lists all related signatures to establish a *partial order*; it is intentionally opaque — only a party holding all docs and signatures of the deal can validate correctness. (The reference implementation's peer-settle selection may still deserve a look when that discussion happens.)
`base.md §3.1` makes `Signature.seen` "the load-bearing field": a follower MUST verify predecessors' `settle` signatures before applying balances. But `README.md §2.3` forbids a follow bank from seeing the lead's record bodies — it holds only opaque record hashes. So a follower can verify a settle signature is *validly signed by the lead pubkey*, but **cannot verify it settles the record that corresponds to this deal**, because it doesn't know which of the lead's record hashes belong to its transfer. The impl exposes this concretely: `notify_signatures` stores foreign settle sigs keyed only by signer pubkey (db.ts:685–692, `storePeerSettleSig`), and follow settle grabs `peerSigs[0]` — the newest settle from that signer *from any deal* (advance.ts:135–140) — and cites it in `seen`. A lead who settled an unrelated deal X supplies a "proof" that unblocks the follower on deal Y. *Fix:* the protocol must give the follower a verifiable binding from a peer settle to its own records (e.g. coordinator supplies the predecessor record hashes per follow record in the Mandate, or `seen` must reference hashes the follower can correlate), otherwise the cascade proof is decorative.

### S4 — Cross-bank rate is coordinator-asserted with only a one-sided hard bound; soft side enables shortchanging

> **Owner verdict (2026-07-06):** The rate is **bank-asserted, not coordinator-trusted**: each bank holds BOTH Orders of the bilateral exchange (the holder submits the same Order to every bank its sides touch), so a bank validates the ratio from the two signed Orders themselves. The contract/implementation should be brought in line with this framing (derive the counter amount from the counterparty Order rather than trusting the caller's `counter_amount`). **Implemented 2026-07-06, in full.** Two layers: (1) `create_records` validates `counter_amount` against BOTH stored Orders (same foreign voucher, both windows, both rates; `0` for one-sided pairings) as an early filter; (2) per the owner's correction, the **Mandate lists every record satisfying the Order across all banks and carries the bodies** — bank-signed, details opaque — so each bank validates BOTH sides and the rate numerically over the full set, multi-leg included, and the missing-leg attack fails closed. Verified across two isolated deployments. Analysis: `docs/design/mandate-validation.md`.
`bank-schema.md §1.4(7)` and `bank-rpc.md §2.2` are explicit: for a cross-bank deal `counter_amount` is "the coordinator's assertion and the rate is enforced softly," with per-side `min`/`max` as "the cryptographically hard bound." The gap: `min`/`max` bound each voucher's amount *independently*; they do **not** bound the ratio. If Alice's Order says give 100 A (min/max 100) to get B with `rate` allowing 90 B, and Bob's Order says give B to get A, a coordinator can pass `counter_amount` values that satisfy each bank's local `min`/`max` while the *actual* B amount Alice receives at Bob's bank is whatever Bob's `min` allows — Alice's A-bank has no way to confirm B ever arrived at the promised ratio because it never sees the B leg. The "hard bound" only constrains fragmentation, not exchange fairness. *Fix:* state plainly that cross-bank rate fairness is NOT cryptographically guaranteed (only social + coordinator honesty), or require both holders to co-sign a deal digest that binds both amounts so each bank can verify the counter amount independently.

### S5 — `create_records` is non-idempotent: duplicate calls mint unbounded record pairs for one deal_id

> **Owner verdict (2026-07-06):** **Fixed.** `create_records` is now idempotent on `(deal_id, giver, receiver)` — a replay returns the original pair; changed terms are rejected. Made normative in `bank-rpc.md §2.2` and implemented in the reference bank.
`bank-rpc.md §2.2` and impl `create_records.ts` mint a **fresh** debit/credit pair (new `pair` ULID, new record ULIDs) on every call. There is no dedup on `(deal_id, giver, receiver, amount)`. The only backstops are `Voucher.limit` and `debit_order_limit`/`credit_order_limit` — all optional (`bank-schema.md §3.2`: "otherwise issuance is unbounded"). A coordinator (or anyone who can call the bank — calls are open) can loop `create_records` on the same deal to flood the ledger with `created` records, and `addOrderUsage` only caps if a limit is set. *Fix:* require idempotency keyed by `(deal_id, order-pair, pair-intent)` or a coordinator-supplied nonce, and/or make a per-deal record cap normative.

### S6 — Unbounded doc storage from anyone: `submit_docs` / `notify_signatures` spam, moderation is key-blocking only

> **Owner verdict (2026-07-06):** **By design / bank policy.** Banks will rate-limit and bound storage ad-hoc; not a protocol concern.
`README.md §1.1` makes banks open by default and states moderation is "key-blocking, not gatekeeping." Impl `submit_docs` stores Vouchers/Accounts/Orders/Addresses/Signatures from any signed sender, and `notify_signatures` stores any validly-signed Signature from anyone (notify_signatures.ts:24–46). An attacker rotates through fresh keypairs (keys are free, `base.md §1`) and submits millions of valid Accounts/Orders/signatures — key-blocking is useless against per-key-generated spam. There is no fee, stake, proof-of-work, or storage bound in the contract. *Fix:* the protocol should acknowledge this as a named DoS and at minimum sanction rate-limit / storage-quota policies, or an optional anti-spam token, rather than leaving "key-blocking" as the sole lever.

### S7 — Address doc update authorization allows squatting / endpoint hijack

> **Owner verdict (2026-07-06):** **Not a problem.** ULIDs carry a timestamp and Address docs are signed by the key they describe — a third party can only replay docs that key already signed, and an older ULID never overrides a newer one. Withdrawn.
`base.md §3.2` and `bank-rpc.md §2.5`: "Anyone MAY update an Address for a pubkey by submitting a signed Address doc with a newer ULID." The invariant claims Address docs are "signed by the pubkey they describe," but the *submitter* need not be that pubkey, and the impl `storeAddress` (db.ts:524–531) only compares ULIDs — it does **not** verify `addr.sig` matches `addr.pubkey` beyond the generic `verifyOrFail` in submit_docs (which does check sig==pubkey, good) — but ULID is client-chosen, so the legitimate bank cannot prevent a stale replay being "newer": anyone who once saw a signed Address can re-submit it, and there's no monotonic anchor beyond an attacker-influenceable 26-char ULID. More broadly, first-writer-with-highest-ULID wins with no rate control. *Fix:* tie Address freshness to a timestamp the describing key signs, define conflict resolution, and state that only the described key's own submissions bump the record.

### S8 — Lead-set determination for >2 banks (rings, multi-lead) is described by example, not algorithm
`README.md §2.2` gives the multi-lead graph `A→C, B→C, C→D, D→A, D→B` and asserts the lead set is `{A,B}`, but provides **no general procedure** for a bank to compute its own lead/follow role and its predecessor set from only its local slice. The impl `determineLeadBank` (advance.ts:191–206) uses a purely local heuristic — "the lead bank is the bank on the opposite side of this transfer" — which is correct only for the bilateral case and has an explicit fallthrough `return bank.pubkey` for one-sided/ambiguous records. For a true ring the follower needs to know *all* predecessors, but it only sees one counter-side `bank` field. *Fix:* specify that the coordinator MUST hand each bank its explicit predecessor-bank set (the doc hints at this in §2.3 "pubkeys of its immediate predecessor banks" but never says how it's conveyed or authenticated), and give the lead-set as an algorithm over the deal DAG.

### S9 — Both-follower deadlock and both-lead double-settle are coordinator-policy, not protocol-enforced
`coordinator-arbitrage.md §Attack 9`: if both holders set `lead:false` the deal deadlocks; if both set `lead:true` both settle independently "there is no follower." The contract pushes detection onto the coordinator ("should detect... and refuse"), but a coordinator is untrusted and a bank validates only its own side. Nothing stops a griefing coordinator from creating a both-false deal that permanently holds both accounts (feeding S2). *Fix:* require each bank to refuse `hold` when it can determine from stored Orders that no lead exists in the deal, or make lead-set validity a Mandate precondition.

### S10 — `get_account_balance` has no caller restriction — balance disclosure
`bank-rpc.md §2.4` documents `get_account_balance` as "holder → issuer bank," but the impl handler (get.ts:30–41) accepts **any** sender and returns current+pending for any account hash. Account hashes are not secret to counterparties/coordinators (they appear in Orders and RecordDetails), so anyone who has transacted with a holder can poll their running balance. The spec never states the access rule normatively. *Fix:* make holder-only balance reads a MUST (verify `sender == Account.pubkey`), or explicitly declare balances public.

### S11 — Rounding policy ("within the bank's rounding policy") is entirely unspecified, breaking cross-bank rate agreement
`bank-schema.md §1.4` and §1.3 defer the rate comparison to "the bank's rounding policy," and Vouchers default to **float** amounts (`integer?: boolean`, §1.1). The impl hardcodes `EPS = 1e-9` (advance.ts:30, create_records.ts:21). Two banks with different epsilon/rounding will disagree on whether `total_debit/total_credit <= rate`, so one settles and the other rejects — a split-brain deal. Float amounts also make the "sum invariant = zero" (§3.2) unenforceable exactly under accumulation. *Fix:* mandate a canonical rounding (e.g. fixed decimal scale, banker's rounding) and a normative epsilon, or restrict rate-gated amounts to integers/rationals.

### S12 — Replay window sizing is hand-waved; 24h fixed window trades memory for safety with no guidance
`base.md §4.1` requires a window "large enough to tolerate out-of-order delivery" and "pruned to prevent unbounded growth" but gives no bound. The impl picks a flat 24h TTL (db.ts:18, `REPLAY_WINDOW_MS`). A ULID `id` (`base.md §4`) embeds a timestamp, but the contract never requires the recipient to reject ids whose embedded time is outside the window — so an attacker can pre-generate far-future ULIDs and replay them after the 24h TTL evicts the record. *Fix:* bind the replay id's acceptable timestamp to the window (reject ids too far from now), and specify a minimum window relative to expected clock skew + delivery delay.

### S13 — `notify_signatures` fan-out is fire-and-forget with no liveness guarantee and no relay incentive
`README.md §2.4`/§5 and `bank-schema.md §1.7` make bank-to-bank delivery and subscriptions best-effort; the impl `fanOutSettleSigs` swallows all errors (advance.ts:361–368). The stated recovery path is client relay (`get_record_signatures`→`notify_signatures`), but **no party is obligated or incentivized to relay**, and a follower that never learns the lead settled will hold indefinitely (again feeding S2). The `WORKAROUNDS.md §4` note reveals the real HTTP bank-to-bank path is untested — only the co-located in-process dispatch is verified — so cross-deployment liveness is unproven. *Fix:* specify at least one party (coordinator) as the obligated relayer with a defined retry contract, or make settle-signature pull (follower polls predecessor) a normative fallback.

### S14 — `list_offers` / `list_vouchers` pagination, filtering, and total-result bounds are unspecified
`bank-rpc.md §2.4`: `list_offers(voucher_hash, intention)` and `list_vouchers(filter)` have "method shape is protocol" but "exact filters are bank policy." No pagination, ordering, or result cap. Impl returns *all* matching offers/vouchers unpaginated (get.ts:55–65, 106–111; db.ts:300–315). At scale this is both a DoS (unbounded response) and non-interoperable (a coordinator can't page a large offer book deterministically). *Fix:* define cursor pagination and a max page size in the method contract.

### S15 — `barter-bank.json` trust bootstrapping relies on pinning that the contract never requires be transmitted
`base.md §5.2` says the discovery doc "is not a trust anchor" and pubkey must be pinned OOB, but the only OOB carriers defined (invite strings `README.md §3.1`) are optional to a coordinator assembling a deal from discovery Offers. When a coordinator learns a peer bank purely from an `Order.bank` field and looks up its Address, **the pubkey-URL binding is TOFU** — `get_address` returns whatever Address doc the bank stored, which (per S7) anyone could have submitted. The pinning story is complete only for the invite-string path; the discovery-driven path has no pin. *Fix:* require that `Order.bank` pubkeys be resolved only against pinned/`barter-bank.json`-verified endpoints, and define what a bank does when it has an `Order.bank` pubkey but no trusted Address for it.

### S16 — `Voucher.limit` vs issuer-negative-balance interplay is ambiguous, and limit enforcement races
`bank-schema.md §3.2`: issuers may go negative ("vouchers the issuer owes the network") while `Voucher.limit` "is honored if set." But the two interact undefinedly: is `limit` a cap on total issued (sum of positive holder balances), on the issuer's negative magnitude, or on gross record volume? The impl computes `totalIssuedForVoucher` as the **sum of all record amounts ever** (create_records.ts:188–197, advance.ts:371–380) — which counts every transfer, not net issuance, so a voucher that circulates hits its "limit" far below the intended supply, and the check is done non-atomically at create-time and again at ready-time with no lock, so concurrent deals can both pass and overshoot. *Fix:* define `limit` precisely (net outstanding issuance = issuer's max negative), and enforce it under the same per-account lock as holds.

### S17 — RecordDetails hash hides contents from peers but the issuing bank sees everything; privacy claim is overstated
`README.md §2.3` sells strong visibility isolation, but `bank-schema.md §1.2`/`coordinator-arbitrage.md §10` admit the Account `name` is stored in cleartext at the bank and "this is a trust assumption on the bank operator." The `details` hash hides `deal_id`/`coordinator`/`holder`/`account` from *other banks*, but the issuing bank stores `RecordDetails` in full (db.ts RecordRow) and thus sees holder identity, account, deal linkage, and every counterpart it transacts. The contract markets content-addressing as privacy without stating the bank is a full observer of its own voucher's graph. *Fix:* state the privacy model honestly (bank sees all local records + identities; peers see nothing; holders trust their bank), and if holder-name privacy matters, make name-omission or encryption normative rather than a scenario footnote.

### S18 — Mandate lifetime / re-issuance after partial failure is undefined
`bank-schema.md §1.6(5)` and impl `submit_mandate` reject a **duplicate** `(deal_id, order)` Mandate (returning idempotent success). But if the first Mandate listed the wrong records, or a record later needs re-mandating after a transient failure, there is **no way to supersede a Mandate** — the `(deal_id, order)` slot is burned permanently. Combined with no reject (S1), a single malformed Mandate can wedge an Order's participation in a deal forever. *Fix:* allow a superseding Mandate (newer ULID) that has not yet advanced records, or define an explicit Mandate-cancel.

### S19 — "Anyone may relay signatures" + open `submit_docs` lets third parties inject Orders/Accounts that were never meant for this bank
`README.md §1.1`: banks "accept and store any docs/signatures... from anyone — the sender need not be the doc's owner." The impl enforces `account.pubkey == sender` and `order.pubkey == sender` (submit_docs.ts:60, 73) — which actually **contradicts** the README's "sender need not be the owner" for Accounts/Orders. So the contract and reference disagree on who may submit an Order: the prose says any relayer, the code says only the signer. This ambiguity matters because coordinators legitimately need to present a *counterparty's* Order to a bank (`bank-schema.md §1.4`: "The holder submits the same signed Order to each bank"), but the impl would reject a coordinator relaying it. *Fix:* reconcile — Orders/Accounts are self-authenticating (signed), so any relayer should be allowed; drop the `== sender` check or state the owner-only rule normatively.

### S20 — Same-bank swap requires two `create_records` calls with no atomic linkage
`bank-rpc.md §2.2` "Same-bank deals" calls `create_records` twice with `giver`/`receiver` swapped, sharing only `deal_id`. Nothing binds the two calls atomically: the second can fail (or be omitted) after the first succeeds, leaving a half-created deal whose rate check (`aggregateRateCheck`, advance.ts:262–279) can't complete because one leg's records are missing — the impl returns `true` ("cannot check yet") when `creditAmount==0`, so a lone leg could conceivably advance on a one-sided view. *Fix:* for same-bank deals define a single call that mints both pairs, or require the Mandate to enumerate all deal records so the bank refuses to advance a partial same-bank deal.

### S21 — `seen` and lock aggregation assume one hold per account per deal, but multi-Order same-account deals are underspecified
`bank-schema.md §3.1` aggregates "all records of the same deal that debit that account" into one hold. But a deal may reference the same account across *different* Orders (e.g. the coordinator's spread account in `coordinator-arbitrage` receives from two legs). `acquireHoldsForDeal` sums debits by account across the deal (advance.ts:281–298) — fine — but the ready-time free-balance check (`readyCheck`, advance.ts:230–246) evaluates each record independently against `bal.current - bal.pending` without reserving for sibling debits in the same deal not yet held, so two same-deal debits on one account can each individually pass ready while their sum exceeds balance, and only the hold catches it (or doesn't, for issuers). *Fix:* specify that ready-time coverage must net sibling same-deal debits, not just existing holds.

### S22 — `integer` voucher amounts: rate and min/max can force non-representable amounts
`bank-schema.md §1.1` `integer?: boolean` and create_records.ts:101 reject non-integer amounts, but the rate check (`amount/counter_amount <= rate`) and cross-bank counter amounts can only be satisfied by fractional values when both vouchers are integer and `rate` is non-integer (e.g. 3-for-2). The contract doesn't say what happens: does the bank round (which direction, favoring whom?), reject, or is such a pairing simply unfulfillable? *Fix:* define behavior for integer vouchers under non-integer rates (reject at match time, or define rounding that preserves the `<= rate` inequality direction).

---

## Cross-cutting observations

- **Spec vs. reference divergences** are themselves gaps the contract should close: reject is a MUST but unimplemented (S1); `submit_docs` owner-only checks contradict the "anyone may relay" prose (S19); `get_account_balance` auth differs from its documented caller (S10). Each is a place the contract is ambiguous enough that the reference "had to choose," and chose inconsistently with the prose.
- **The three worst clusters** all feed the same failure mode — a wedged deal with frozen balances and no recovery — because S1 (no reject), S2 (no timeout), and S13 (no liveness) compound. Closing any one materially reduces griefing exposure; the protocol currently relies entirely on the social trust model to paper over all three.
- **`WORKAROUNDS.md §4`** flags that the genuine cross-deployment bank-to-bank path (the one all cross-bank gaps above depend on) is **untested**, so S3/S4/S8/S13/S15 are not just spec gaps but unvalidated in practice.

---

# Part II — UI improvements

## UI/UX Improvement Backlog — barter.game web app

Measured against `docs/ui/claude-ui.md` (spec) and the shipped code in `apps/web/app.js`, `apps/web/index.html`, `apps/bank/ui.ts`, `apps/bank/main.ts`. Excludes QR generate/scan, Activity, Network/trusted-issuers, and richer landing pages (in flight on a parallel branch). Ranked by user impact.

### 1. Returning users cannot reach the Unlock screen (S) — bug, highest impact

> **Fixed in PR #1** — the logged-out router now serves `#/unlock` (landing pages link to it as "Log in & pay/claim/trust").
`app.js` router (lines 149–155): when `state.user` is null, only `#/register` and `#/connect` are handled; everything else falls to `renderWelcome`. `renderUnlock` is only reachable **when already logged in**. So after `lock()` (which sets `user = null` then navigates to `#/unlock`) or any page refresh, a registered user lands on Welcome with only "Create account" / "I have a key" — the password-unlock path (`GET /ui/keystore/:handle`) is dead. Spec §8.2.4 makes Unlock the primary re-entry. Fix: move the `unlock` route into the logged-out branch, add an "Unlock" CTA on Welcome, and remember the last handle (non-secret) in `localStorage` to prefill it.

### 2. Discover is functionally empty for every real user (S–M)
`renderDiscover` (app.js:581) posts `{ vouchers: [], intentions: [...] }`; `handleDiscover` (ui.ts:541) treats `[]` as "given" (`?? state.catalog` never kicks in), so the voucher loop never runs — **zero offers, always**. Even fixed, `state.banks` and `state.catalog` are never populated by the SPA and there is no UI to add a bank or seed the catalog. The core discovery loop (spec Goal 8, §9.5) is unreachable in the shipped UI. Fix: derive vouchers from the user's portfolio/orders by default, add a known-banks input (or reuse the parallel-branch Network screen's data), and render the `unreachable[]` array the backend already returns (SPA currently ignores it).

### 3. Accept-offer flow violates spec §8.14 — silently matches an arbitrary order (M–L)
`acceptOffer` (app.js:595–618) grabs `mine.orders[0]` as "my side" with no selection, no amount adjustment within min/max, no review-terms screen, no trust check ("is this issuer in Trusted?"), no untrusted-warning confirm. A user with two orders can commit the wrong one to a deal with one click. Build §14.1–14.2: review terms → pick/adjust my order → confirm → sign, with the trust-check banner.

### 4. No recovery kit and no keystore export — "forgot password = lose account" with no escape hatch (M)

> **Half-fixed in PR #1** — Settings now offers "Download encrypted backup" (keystore + bank pins as JSON). Still missing: a restore-from-file path on Connect, and printable/BIP39 form.
Spec §4 mandates a one-time recovery kit at registration (BIP39 mnemonic + `.barterkey` file) and §8.15.1 an "Export recovery kit" in Settings; `PUT /ui/keystore` exists server-side (ui.ts:172) but the SPA has no export, no change-password, no kit. `doRegister` (app.js:243) drops the user straight into the dashboard. Given irreversible key loss is the product's sharpest edge, this is the highest-value security-UX gap: kit modal at creation, `kit_issued` nag, export + change-password in Settings.

### 5. Crypto libs load from esm.sh — vendor them, add SRI + CSP (S–M)
`index.html` import map pulls `@noble/ed25519`, `@noble/hashes`, `@scure/base`, `ulid` from `https://esm.sh` — directly contradicting spec §4 ("No third-party scripts, no CDN… crypto libs are vendored… SRI on every script") for pages that hold the plaintext key. `apps/web/vendor/` already exists (jsqr/qrcode). Vendor the four libs, add `integrity` attributes, and have `serveSpa`/`serveStaticAsset` (main.ts:148, ui.ts:934) emit the spec's CSP (`script-src 'self'`), `frame-ancestors 'none'`, `X-Content-Type-Options`, etc. Currently zero security headers are set.

### 6. Injection vector + inline handlers block any CSP (M)
`renderDiscover` (app.js:588) interpolates remote-bank-supplied strings (`o.order`, `o.bank`, `o.bank_url` — spread verbatim from peer `list_offers` responses in ui.ts:557–563) into an `onclick="acceptOffer('${…}')"` attribute **unescaped** — a malicious/compromised peer bank can achieve XSS in a key-holding page. All actions use `onclick=` + `window.*` globals, which also makes the spec's no-`unsafe-inline` CSP impossible. Refactor to `addEventListener` with data held in JS (not attributes), and escape every interpolation.

### 7. CORS wildcard on everything, including the keystore (S)
`cors()` (ui.ts:959) sets `Access-Control-Allow-Origin: *` on every response and `main.ts` applies it globally — so any website can fetch `GET /ui/keystore/:handle` ciphertext (rate-limit 5/min aside) and enumerate handles cross-origin. Spec §4 wants a documented `connect-src` allowlist and anti-harvesting posture (§10.5). Restrict CORS to known bank origins (or none for keystore/register), keep `*` only for the public protocol routes that need it.

### 8. No auto-lock, no visibility wipe, weaker KDF than specced (S–M)

> **Partially fixed in PR #1** — a 10-minute idle auto-lock shipped. Visibility-change wipe and the Argon2id KDF upgrade remain open.
Spec §4/§8.18.1/§11 require a 15-min idle auto-lock (configurable Off/1/5/15/60), key wipe on `pagehide`/hidden-beyond-grace, and draft preservation across lock. The SPA has only the manual Lock button; the seed sits in `state.user` indefinitely. Also PBKDF2 runs 250k iterations (app.js:18) vs the spec fallback's 600k, and AES-GCM omits the pubkey-binding AAD (§4 pipeline step 4). Add the idle/visibility timers + Settings control, bump iterations, add AAD (with back-compat decrypt), and keep Argon2id (WORKAROUNDS.md §1) as the follow-up.

### 9. Error surfaces: raw codes, invisible partial failures, vague validation (M)
Errors render as `"-32005: not found"` (app.js:111, 132) instead of the §18.3 code→copy mapping ("The bank doesn't know one of these documents yet" + re-submit action). Register's only validation message is "Check fields and acknowledgement" (app.js:250). Discover/portfolio `unreachable[]` partial failures are dropped instead of per-bank chips. Toasts are 4-second divs with no dismiss, no queueing, no `aria-live`. Implement the mapping table, inline field errors, per-bank failure chips with retry, and an accessible toast component.

### 10. Onboarding friction on Register/Connect (M)
Missing vs §8.2.2–2.3: live handle-availability check (backend `GET /ui/handle/:handle` exists, unused), password strength meter + min-length ≥10, `autocomplete="new-password"/"current-password"` attributes, generated-pubkey preview before submit, and the blocking "no recovery" modal copy. Connect (app.js:274–302) has dead code (line 296), no pubkey preview, no mnemonic/file import, and no "back up here" option — imported keys are ephemeral-only with no warning flag, silently diverging from spec flow B.

### 11. Balance & voucher clarity: hashes everywhere, no Wallet screen (M)
Dashboard shows balances but Invoices/Orders/Discover render voucher **hash slices** (`o.credit.voucher.slice(0,12)`) instead of names, amounts without units, and `direction: debit/credit` raw. No `/wallet` screen (§8.5): no current-vs-pending explanation, no "you owe (issuer)" labeling for negative issuer positions, no limit/integer badges, no row quick-actions (Trade/Invoice/Cheque prefilled). Resolve names via the catalog (see #13) and build Wallet — it's the screen users will stare at most.

### 12. Deal screen: full-page re-render loop, reload-button "refresh", no-op relay (M)
`renderDeal` (app.js:620–652) re-renders the entire app every 3s (flicker, scroll/focus loss), "Refresh" is `location.reload()`, and `relayDeal` sends `from == to == own bank` with `record_hashes: []` — guaranteed no-op, yet toasts "Relay attempted". No §14.3 stepper (created→approved→held→settled per bank), no reject `reason`, no stuck-detection surfacing relay with real record hashes. Also cosmetic: backend emits state `approved` but CSS only styles `.state-ready` (styles.css), so approved chips render unstyled.

### 13. Drafts + catalog: specced in §7.3, absent on both sides (M)
`ui.ts` implements `/state`, `/trusted`, `/contacts`, `/banks`, `/prefs` but not `GET/PUT /ui/catalog` or `GET/PUT/DELETE /ui/drafts/:id`. The SPA never saves a draft — an auto-lock or accidental navigation mid–Create-Order loses everything, though §8.18.1 requires draft preservation across lock. Add the two sub-resources, autosave forms to drafts (sessionStorage locally + server sync), and use the catalog to cache voucher name/issuer for #11's name resolution.

### 14. Accessibility fundamentals (M)
Labels are not associated with inputs (no `for`/wrapping — app.js form templates), toasts lack `role="status"`, nav lacks `aria-current`, route changes replace `#app` innerHTML with no focus management or document.title updates, state chips are color-only (add text/icons — they do have text, but approved/ready mismatch aside, contrast of chip backgrounds needs checking), and everything hangs off `onclick` globals. A pass adding label association, focus-to-heading on route change, `aria-live` regions, and keyboard-visible focus styles is cheap and broad.

### 15. Mobile ergonomics (M)
Header nav is a wrapping row of small text links (styles.css `.nav`); spec §8.1.2/§8.3.2 calls for a bottom tab bar + "More" sheet on mobile. Touch targets are below 44px, there's no pull-to-refresh (§18.4), no OS share-sheet integration for links (§8.13 — coordinate with the parallel QR branch), and forms don't set `inputmode`/`enterkeyhint`. The single-column layout mostly survives, but navigation and target sizes need real mobile treatment.

### 16. Multi-bank UX: no switcher, no default bank, cross-bank order gap (M–L)
The bank is chosen only by URL path (`parsePath`, app.js:79); root `/` returns bare JSON listing banks (main.ts:44) rather than a chooser. No account/bank switcher in the header (§8.3.1), no `prefs.default_bank`, and `doCreateOrder` (app.js:567–571) contains a literal TODO: cross-bank orders are only submitted to the local bank, so a swap whose credit voucher lives on another bank never reaches it. Add a bank picker on the root, a header switcher, and fan-out `submit_docs` to each referenced bank per §9.3.

### 17. Performance: no cache headers, N+1 history, serial fetches, unpaused polling (M)
`serveStaticAsset` (main.ts:148) sends no `Cache-Control`/`ETag`, so every asset re-downloads; the esm.sh imports add a third-party round-trip on the critical unlock path (fixed by #5). Backend `/ui/history` (ui.ts:466–506) does per-record + per-signature KV reads in a nested loop. Dashboard awaits portfolio then history serially (app.js:337–338). Polling never pauses on `document.hidden` (§18.4/§11). All individually small; together they define perceived speed.

### 18. Offline/PWA shell + offline re-unlock (M)

> **Partially fixed** — the SPA is now installable: a per-bank manifest
> (`apps/bank/ui.ts`), a cache-less service worker with an offline page
> (`apps/web/sw.js`), and an in-app install offer on the hero/dashboard/Settings
> (`apps/web/app.js`). Deliberately **not** done: caching the app shell or any
> bank response, so offline re-unlock and read-only cached balances remain open.

No manifest, no service worker. Spec §4 explicitly expects the keystore ciphertext to be "cached locally, so no network is needed to re-unlock" — cache the encrypted blob (it's ciphertext, safe) in IndexedDB, add a manifest + SW for the app shell, and show a clear offline banner with read-only cached balances. Makes the app installable for the market/festival use cases the QR journeys target.

### 19. Optimistic-vs-confirmed state model (M)
§18.2: after `submit_docs`/accept, show `submitting… → pending` chips and only flip to confirmed on an observed `settle` Signature; a `reject` rolls back with `reason`. Today every write just navigates away and re-fetches; users get no feedback between "toast said created" and the next poll, and the Dashboard has no attention strip for stuck/rejected deals (§8.4).

### 20. i18n scaffolding (M–L, lowest urgency)
All strings are hardcoded English template literals scattered through `app.js`. Before the screen count grows (parallel branch + this backlog), extract to a message dictionary with a `t()` helper and locale detection — retrofitting later across dozens of screens is far more expensive. Number/date formatting via `Intl` also fixes the current raw `Date.now()`/float rendering.

---

**Suggested sequencing:** #1 and #2 are small fixes that unblock the core loop; #5–#8 form one coherent security-hardening pass; #4 + #10 complete the identity lifecycle; #9, #11, #12 are the day-to-day quality tier; the rest are structural investments.

---

# Part III — Future directions

A roadmap grounded in what exists today: the Mandate/Coordinator protocol (`protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`), the Deno reference bank (`apps/bank/`), the minimal SPA (`apps/web/app.js`), the full UI spec (`docs/ui/claude-ui.md`), the scenario traces (`scenarios/*.md`), and the deferred-work ledger (`TODOS.md`, `WORKAROUNDS.md`, `ETHOS.md`).

**The organizing principle:** v1 deliberately froze a small, signature-driven core — coordinator-created records, Order-only holder authorization, per-(Order, bank) Mandates, bank self-advancement through `ready → hold → settle`, no clocks, no rollback (`protocol/README.md` §4 "locked decisions"). Almost everything below is either (a) a *layer* the protocol explicitly sanctions ("Implementers MAY add… extensions MUST be backward-compatible," `protocol/README.md` §1.1; the custom-layer rule in `base.md` §6), or (b) a *v2 wire change* the v1 docs already name as out of scope (`protocol/README.md` §5). That distinction drives the ordering: layers first, wire changes last.

---

## Near horizon (v1.x) — prove the claims v1 already makes

### 1. Federation at scale, part 1: make cross-deployment settlement real

**What.** Run two (or more) genuinely separate bank deployments and exercise the real HTTP bank-to-bank path end to end; then harden it (retries, relay fallback, sweeper hygiene).

**Why it follows from v1.** Federation is the ethos' table stakes (`ETHOS.md` §6), and the machinery exists: `apps/bank/peer.ts` implements `fetchDiscovery` + `bankRpcCall` with signed envelopes, `notify_signatures` is the canonical bank-to-bank delivery path (`bank-rpc.md` §2.3), and Address docs + `barter-bank.json` + pubkey pinning are the discovery substrate (`base.md` §5). But **WORKAROUNDS §4** is blunt: because Deno Deploy blocks self-fetch (508 Loop Detected), all four demo banks dispatch in-process via `apps/bank/local.ts`, and *"genuinely federated banks on separate deployments… is not yet tested end-to-end."* v1's central claim — a fifth bank can join tomorrow — is currently unverified on production.

**Implementation changes (no protocol changes).**
- A second Deno Deploy app (or a VPS) running `apps/bank/main.ts` with its own `BANK_*_PRIV_KEY`; extend `apps/bank/e2e-crossbank.ts` into a true cross-deployment test.
- Delivery hardening in `peer.ts`: bounded retries with backoff for `notify_signatures` (fan-out is fire-and-forget per `protocol/README.md` §5; client relay via `get_record_signatures` → `notify_signatures` is the recovery floor — automate that relay in the coordinator/UI, cf. spec §8.14.4 "Relay-if-stuck").
- The **hold sweeper** from `TODOS.md` (v1.5): an operator policy that `reject`s stuck deals so abandoned holds don't pin balances forever — explicitly a hygiene convenience, not a correctness mechanism (`protocol/README.md` §2.2 invariant; `ETHOS.md` §5).

**Dependencies.** None; this is the first thing to do. Everything in "federation part 2" and "market mechanics" assumes this path is trustworthy.

### 2. Federation at scale, part 2: bank directories

**What.** A directory where banks publish `{pubkey, url, name, protocol_version}` so clients and peers discover banks beyond a hardcoded list. `protocol/README.md` §5 already names it: *"a global federated directory is a v1.5+ extension."*

**Why it follows from v1.** Every primitive exists: the discovery doc (`barter-bank.json`, `bank-rpc.md` §3), signed self-describing `Address` docs with newest-ULID-wins semantics (`base.md` §3.2), and the pinning rule that the directory is *never* a trust anchor (`base.md` §5.2). A directory is pure discovery; trust stays OOB per the trust model. `TODOS.md` lists the open decision: shared JSON file vs. relay/gossip (Mastodon-style) vs. even "a public Gist everyone agrees on."

**Implementation changes.** A directory service that accepts signed Address docs + discovery documents, periodically re-fetches `barter-bank.json` to verify liveness and pubkey consistency, and serves a signed feed. Client side: `apps/web` "Known Banks" screen (spec §8.9.4) gains an "import from directory" flow that still forces per-bank pin confirmation. No wire changes — the directory itself can speak `submit_docs`/`get_address`.

**Dependencies.** Cross-deployment path (above), so a directory has something real to list. This unblocks half the `TODOS.md` agent ideas (due-diligence agent, reputation miner, matchmaker) which all list "federated bank directory" as their dependency.

### 3. Cross-bank client aggregation (the wallet grows up)

**What.** One inbox/portfolio view merging balances and in-flight deals across every bank the user touches (`TODOS.md` "Cross-bank inbox aggregation"), plus finishing the screen inventory from `docs/ui/claude-ui.md` §8 (WORKAROUNDS §2: only the minimal Register → Voucher → Invoice/Cheque → Discover → Pay → Deal-status path is built in `apps/web/app.js`, ~675 lines).

**Why it follows from v1.** The issuing bank is sole authority for its voucher's balances (`protocol/README.md` §4), so aggregation is inherently client-side; Subscription docs (`bank-schema.md` §1.7) already give push delivery, making this a merge problem, not a polling problem. The `/ui/*` backend (`apps/bank/ui.ts`: `/ui/portfolio`, `/ui/discover`, `/ui/relay`, `/ui/propose_deal`, `/ui/deal/:id`) was shaped exactly so screens can be added without protocol changes.

**Dependencies.** None protocol-side. This is also where the keystore upgrade lands (WORKAROUNDS §1: PBKDF2+AES-GCM today → Argon2id + XChaCha20-Poly1305 per spec §4/§12, once a WASM build step is accepted).

### 4. Mobile apps and native deep links

**What.** Ship the spec's "one link, three outcomes" story: *app installed → native open; no app → web landing; webapp fetch → machine payload* (`docs/ui/claude-ui.md` §5, "The `barter://` custom-scheme mirror and native deep-linking").

**Why it follows from v1.** The spec has already done the hard design: banks serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` covering the `/i/ /v/ /q/ /o/ /x/` Barter-Link namespace; the `#b` fragment carries inline signed docs that never touch the server; the App-Clip hook (`apple-itunes-app` meta, `app-clip-bundle-id=game.barter.clip`) is even sketched in the example `<head>`. The self-validation rule — verify signatures before any network call, pin pubkeys, fail closed (`spec §5 "Self-validation"`, §6.6) — means a native app is *just another reader* of the same links. QR budgets (ECC-M, ≤~400 bytes, prefer REFERENCE mode) are already fixed.

**Implementation changes.** Sequence: (1) PWA-ify the SPA (installability, offline shell, camera QR scanning) — cheapest way to get "app installed" semantics; (2) serve the two `/.well-known/` files from `apps/bank/main.ts`; (3) a thin native wrapper (Capacitor or Swift/Kotlin) whose core is the JCS canonicalizer + ed25519 verify from `packages/protocol` (the cross-runtime parity vectors in `packages/protocol/test/fixtures/canonical/vectors.json` become the porting contract); (4) platform keystore custody (Secure Enclave / StrongBox), which is strictly better than the browser keystore and the natural stepping stone to the `TODOS.md` hardware-wallet item.

**Dependencies.** Landing routes (already spec'd, spec §7.8) must be fully implemented; per-bank clean URLs (`TODOS.md` cosmetic item) matter more here because universal links are origin-scoped — a shared multi-bank domain means one AASA file covering many banks' paths.

### 5. Reputation, phase 1: read-only trust layers (no protocol change)

**What.** Client-side and third-party services that *read* the public signed evidence and surface issuer trustworthiness: issuer due-diligence memos (outstanding supply vs. `Voucher.limit`, settle/reject history), transitive trust ("you trust Alice; Alice holds lots of Carol's vouchers"), lead/follow risk advice, and external verification of the sum invariant (the "bank-integrity auditor").

**Why it follows from v1.** v1 bans on-protocol reputation (`protocol/README.md` §5) but its extensibility clause invites layered trust, and the UI already ships the seed: the **trusted-issuers list** (`/ui/trusted` in `apps/bank/ui.ts`; spec §8.9.1 — "custom UI state; the protocol has no trust concept") with QR-scan auto-trust as the onboarding funnel (spec §6). Crucially, the trust model says you trust *issuers*, not holders — so issuer reputation is consistent with the ethos, while holder ratings are not. `TODOS.md` has the full menu graded by weirdness: emitter due-diligence (W:4), trust-graph propagator (W:5), voluntary-reputation miner (W:6), bank-integrity auditor (W:6).

**Implementation changes.** Banks need public read endpoints for voucher issuance/settlement history (an extension of `get_record_signatures`/`list_vouchers`, in the sanctioned custom `-32006..-32099`/custom-route space). Portable trust lists: today `/ui/trusted` is a per-bank server blob; export it as a *user-signed* doc so trust follows the key, not the bank. The transitive propagator and auditor are pure aggregators.

**Dependencies.** Bank directory (to find banks to audit); public read access policy per bank. Deliberately **not** dispute resolution — `TODOS.md` is right that on-protocol arbitration/stakes is "likely the LAST thing to build" (see Far horizon).

---

## Mid horizon — market structure on the frozen core

### 6. Richer market mechanics: order books, partial fills, multi-hop routing

**What.** Turn the coordinator role from "demo matchmaker" into real market infrastructure: per-voucher order books, partial fills against standing Orders, and route-finding that composes `A → B → C (→ A)` chains automatically.

**Why it follows from v1 — this is the payoff of the Mandate/Coordinator rework.** The primitives are startlingly complete:
- **Standing orders with partial-fill semantics already exist.** An Order carries per-match `min`/`max` on each side, a `rate` cap enforced deal-wide, cumulative `debit_order_limit`/`credit_order_limit`, and account floors/ceilings (`bank-schema.md` §1.4, matching rules 6–11). Orders never expire; cancellation is emptying the account (`ETHOS.md` §5). A coordinator can therefore fill one Order across *many successive deals* until its cumulative limits exhaust — partial fills need **zero wire changes**, only coordinator bookkeeping.
- **The discovery surface exists and is privacy-preserving.** Bank-derived `Offer` docs hide holder identity and account hashes (`bank-schema.md` §1.5); `list_offers(voucher, intention)` is the queryable book. An order book is "index Offers, sort by `rate`" — a service, not a schema.
- **Rings and general graphs are already protocol-legal.** `protocol/README.md` §2.2 works the ring and the multiple-leads example explicitly; `scenarios/merge-branch.md` demonstrates a merge/branch deal across three banks; `scenarios/coordinator-arbitrage.md` shows a coordinator taking a spread. `packages/protocol/src/deal.ts` already computes lead/follow roles and per-bank predecessors.

**What's missing is pure coordinator software:** (1) a **matching engine** that ingests Offers from many banks (directory-fed), maintains books, and emits `create_records` + `Mandate` sequences; (2) a **route-finder** — graph search over the Offer set where nodes are vouchers and edges are Orders, finding paths/cycles that satisfy every hop's `rate` and `min` (this is exactly how "I hold Avoucher, I want Cvoucher, nobody trades that pair directly" gets solved through B); (3) **lead-set computation** for arbitrary graphs (the §2.2 rule: every giver a merge node depends on must lead); (4) failure handling — `-32003` lock conflicts and `reject` cascades mean the router needs re-plan logic.

**Trust caveat to design deliberately:** multi-hop routes put strangers' vouchers in your account. The trust model says that's fine for *holding* (holders aren't trust-bearing) but you ultimately redeem against an issuer you may not know — so route-finding should integrate the reputation layer (§5) at quote time, and the `TODOS.md` liquidity-provider bot (W:5) is the natural market-maker to seed thin books.

**Dependencies.** Bank directory + tested federation (routes span deployments); reputation phase 1 for route scoring. Coordinator economics (spread-taking is already demonstrated in `scenarios/coordinator-arbitrage.md`) makes this the first plausibly self-funding component.

### 7. Messaging between counterparties

**What.** Signed, end-to-end-encrypted messages between pubkeys, attached to the objects people already exchange: a note on an invoice, a haggle thread on an Offer, a "delivered, please confirm" ping on a settled deal.

**Why it follows from v1.** The UI spec explicitly reserves it: *"Direct messaging between issuer and viewer from the landing page, and voucher 'blogs'… are explicitly future"* (`docs/ui/claude-ui.md` §6.8). And v1's social-recourse model ("Alice yells at Bob," `protocol/README.md` §1) *assumes* a communication channel it never provides — today recourse requires an out-of-band relationship. Mechanically, the pieces exist: every party is a pubkey (ed25519 keys convert to X25519 for ECDH), `BaseDoc` + content addressing give tamper-evident envelopes, banks already store and relay third-party docs (`submit_docs` accepts docs "from anyone," `protocol/README.md` §1.1), and Subscriptions give push delivery.

**Implementation changes.** A custom-layer `message` doc (new `type`, sender-signed, body encrypted to recipient pubkey, optional `about: <hash>` anchoring it to a voucher/order/deal), a bank inbox endpoint under `/ui/*`, and Subscription-style push. Keep it custom-layer first; promote the doc type to protocol only if cross-implementation messaging demand appears. This also unblocks deal UX: the coordinator flow (spec §8.14) currently has no way to say "your counterparty declined because…".

**Dependencies.** Mobile/push (§4) makes messaging worthwhile; key rotation (§9) matters before conversations accrue to long-lived keys.

### 8. Economics: mutual-credit limits, clearing houses, demurrage

**What.** The monetary-design layer: (a) richer issuer credit limits, (b) clearing houses that net multilateral obligations, (c) demurrage/maturity mechanics.

**Why it follows from v1.** v1 is already a LETS-pattern mutual-credit system — issuers go negative via their own Orders, sum-to-zero is the load-bearing invariant (`bank-schema.md` §3.2; `ETHOS.md` §3) — and the schema contains dormant hooks: `Voucher.limit` (max supply, honored if set), `Voucher.due` and `Voucher.expires` (defined in `bank-schema.md` §1.1, currently unused — `TODOS.md` "voucher-as-bond pricer" notes `due` exists "but v1 does nothing with it"), and Order-level account floors/ceilings.
- **Mutual-credit limits** mostly need *policy and UI*, not protocol: per-issuer negative-balance caps are `Voucher.limit`; per-holder exposure caps are `credit_account_limit` ("prevents overstocking"). What's missing is bank-operator policy surface (default limits for unknown issuers — a natural moderation tool alongside key-blocking, `ETHOS.md` §10) and wallet-side exposure dashboards (the `TODOS.md` "default-aware portfolio manager").
- **Clearing houses** fall out of the coordinator pattern: a clearing coordinator collects standing Orders from a community, periodically computes a multilateral netting cycle (a big merge/branch deal exactly like `scenarios/merge-branch.md`), and settles it in one `deal_id`. Because every gate still flows from holder-signed Orders and coordinator-signed Mandates (`bank-rpc.md` §4, "unsigned orchestration data is not authority"), a clearing house needs **no new trust** — it can only fragment or stall its own deal. The `TODOS.md` "sin-eater insurance pool" (a professional lead-risk absorber) is the derivative product on top.
- **Demurrage** (holding-cost decay to encourage circulation) is the one that fights the ethos: `ETHOS.md` §5 forbids clocks and expirations at protocol level. Two honest options: implement it as *issuer policy at redemption* (an issuer honors older vouchers at a discount — zero protocol change, purely social/UI, aided by the bond-pricer analytics on `due`), or defer true ledger-level decay to v2 where activating `expires` semantics would have to be reconciled with "forever docs."

**Dependencies.** Clearing houses need the market-mechanics engine (§6) and directory; limits work is near-term-doable but is listed here because it only matters once volumes exist.

---

## Far horizon (v2) — the wire changes v1 explicitly deferred

These break the "locked" table in `protocol/README.md` §4, so they batch into a versioned protocol revision (`protocol_version: "barter.game/v2"`; the Barter-Link format already carries version in three redundant places with a must-ignore rule, spec §5 "Versioning + extensibility", so link/client plumbing survives the bump).

### 9. Key rotation, then account recovery

The load-bearing v2 item. v1 locks "lose key → lose account" and "no rotation" (`protocol/README.md` §4); `TODOS.md` calls this "unworkable for anything resembling production" and sketches the design fork: signed rotation docs (old key signs a successor link) vs. an external authority root. Rotation docs fit the existing grammar best — a new `rotation` BaseDoc, content-addressed, propagated like Address docs (newest-wins per pubkey), with banks resolving "current key for identity X" through the chain. **Account recovery** (social M-of-N, hardware custody) explicitly depends on rotation existing (`TODOS.md`), and messaging/reputation both raise the cost of key loss — so rotation should be designed *early* even though it ships in v2. Threshold ed25519 (FROST, per the `TODOS.md` co-op-bank entry) is the same design family and would let bank keys be committee-held.

### 10. Non-fungible (NFT-style) vouchers

Named as v2 in both the locked table ("Voucher fungibility… NFT-style is v2") and `TODOS.md`. Use cases: signed art, event tickets, provenance. Change surface: Records must reference voucher *instances* rather than amounts — a per-instance ID (mint-time ULID) plus instance-level transfer semantics; balance accounting becomes set-membership rather than sums, so the sum invariant generalizes to "each instance has exactly one holder." Note two existing half-steps: `Voucher.integer` already constrains amounts, and `ETHOS.md` §7 already carves out bank-minted ULID-referenced records as the non-content-addressed exception — instance IDs extend that carve-out. The `TODOS.md` "forgery sentinel" (near-identical `Voucher.name` homoglyph detection) is the cheap fungibility-ambiguity patch worth shipping long before v2.

### 11. Encrypted account names / stronger ledger privacy

`bank-schema.md` §1.2 says the Account `name` "remains private to the holder," yet the name sits in plaintext inside the signed Account doc the bank stores. v2 candidate: client-side-encrypted or committed (salted-hash) names, so the bank verifies ownership without reading labels. This slots into a broader privacy track that v1 already leans toward: Offers hide holder identity (`bank-schema.md` §1.5), the visibility boundary hides deal shape from banks (`protocol/README.md` §2.3), and the `TODOS.md` holder-anonymity router (W:8) shows where deliberate design is needed before privacy becomes an accidental mixer. Changing the Account doc's signed contents changes its hash → v2.

### 12. Protocol-level timeouts and standardized sweepers

v1 has no clocks by conviction (`ETHOS.md` §5), but it left itself a door: error code **`-32004` "Timeout (reserved; not used in v1)"** (`base.md` §4.2). If federation-at-scale experience shows operator-policy sweepers cause cross-bank disagreement (bank A swept a hold that bank B still counts), v2 can standardize: holder-declared validity windows on Orders (`exp` already exists on invite strings), a signed `expire`/`sweep` action in the Signature action map so releases are first-class audit events (today a sweep must masquerade as `reject`), and bounded-skew rules instead of synchronized clocks. This should be *evidence-driven* — adopt only if the no-clock stance demonstrably fails in the wild.

### 13. On-protocol reputation / dispute resolution

The deliberate caboose. `TODOS.md` v2+: stakes/bonds, arbitration banks, signed dispute docs — each "fundamentally changes the trust model," and the guidance stands: build it last, only if real users hit disputes at a frequency that the layered reputation of §5 can't absorb. The healthy path is: trusted-issuer lists (shipped) → read-only evidence aggregators (near) → portable signed trust docs (mid) → and only then, if needed, protocol-level stakes.

---

## Suggested sequencing (dependency graph in prose)

1. **Now:** cross-deployment federation test + delivery hardening + hold sweeper (unblocks everything; closes WORKAROUNDS §4).
2. **Next:** bank directory → cross-bank wallet aggregation → PWA + deep-link well-known files. In parallel: reputation phase 1 aggregators (needs directory), keystore Argon2id upgrade, full screen inventory (WORKAROUNDS §2).
3. **Then:** coordinator matching engine → order books → multi-hop route-finder (needs directory + reputation scoring); native mobile wrappers with platform keystores; messaging as custom-layer docs.
4. **Then:** clearing houses / LP bots / lead-insurance on the matching engine; mutual-credit limit policy + exposure dashboards; issuer-policy demurrage.
5. **v2 (design early, ship together):** key rotation (+ recovery, threshold keys), NFT vouchers, encrypted account names, optional timeout semantics via the reserved `-32004`, and — only if the layered approach proves insufficient — on-protocol reputation.

The through-line: v1's coordinator rework quietly turned barter.game from "a settlement demo" into "a settlement *substrate*" — order books, clearing houses, route-finders, reputation services, and even the AI-agent bestiary in `TODOS.md` are all just coordinators and readers of signed evidence. The near-term job is to make federation real and discoverable; the mid-term job is to grow markets and communication on the frozen core; the far-term job is the small set of wire changes (keys, instances, privacy, time) that v1 was honest enough to name and defer.

---

# Part IV — Per-voucher blogs (design sketch)

**Owner's idea:** "every voucher will have its own blog (nostr style) where issuers will post updates and other users post too; the issuer may choose which posts to repost and give them better coverage."

This sketch reuses the exact primitives already in the v1 contract: canonical JSON (RFC 8785/JCS) per `protocol/base.md §2`, ed25519 + base58 identity (`base.md §1`), content-addressed hashes (`SHA-256(canonical(doc minus sig))`, base58), ULIDs as identity+time-ordering, `submit_docs` as the universal write path (`protocol/bank-rpc.md §2.1`), and the v1 openness posture — "banks accept and store any docs linked to vouchers that reference this bank, from anyone; moderation is key-blocking, not gatekeeping" (`protocol/README.md §1.1`).

---

## 1. The `Post` doc — a new BaseDoc kind

Add `"post"` to the `BaseDoc.type` union in `protocol/base.md §3` and define the schema alongside `Voucher`/`Order` in `protocol/bank-schema.md` (proposed §1.8):

```ts
Post: BaseDoc & {
  type: "post";
  voucher: Base58SHA256;    // hash of the Voucher this post attaches to — the feed key
  content?: string;         // markdown; REQUIRED unless repost_of is present; ≤ 4 KiB UTF-8
  reply_to?: Base58SHA256;  // hash of the parent Post (threading)
  repost_of?: Base58SHA256; // hash of a boosted Post (curation / quote-boost)
  sig: Base58Signature;     // ed25519 over canonical(doc minus sig)
}
```

- `pubkey` = author (anyone — issuer, holder, stranger). `ulid` = creation time and the pagination cursor.
- **Post id = doc hash** — `base58(sha256(jcs(doc minus sig)))`, exactly like every other doc. Content-addressed, immutable, self-authenticating, relay-agnostic: any party can carry a Post anywhere and any receiver can verify it with zero trust in the carrier. This is the nostr event model expressed in barter.game's existing primitives.
- **Shape rules** (validated at submission):
  - Plain post: `content` only. Reply: `reply_to` + `content`. Plain repost: `repost_of`, no `content` (nostr kind-6 analog). Quote-boost: `repost_of` + `content`.
  - `reply_to` and `repost_of` are mutually exclusive (keeps threads and boosts distinct; revisit later if quote-replies are wanted).
  - Referenced posts, when resolvable, MUST belong to the same `voucher`. Banks MAY accept a post whose parent hash is not yet known (`-32005` alternative: store as orphan and backfill) — this tolerates federation arrival-order, mirroring how signatures arrive out of order today.
- **No edits.** Editing = posting a new Post; the old one stands (content-addressed docs can't change). Deletion is an open question (§8).
- **Special significance of the issuer key:** a Post whose `pubkey` equals `Voucher.pubkey` is an **issuer post**; an issuer post with `repost_of` is an **issuer boost**. No new signature machinery needed — the Voucher doc already binds the issuer pubkey.

## 2. Storage & serving — the issuing bank is the home relay

`Voucher.bank` already makes one bank the sole source of truth for that voucher's ledger; the same bank is the natural **home relay** for its blog. Concretely in the reference implementation:

**Write path — a `'post'` case in `submit_docs`** (`apps/bank/handlers/submit_docs.ts`, next to the existing `voucher`/`account`/`order`/`address`/`signature` cases):
1. `validatePost(raw)` shape check; `verifyOrFail(doc, sig, pubkey)` — note the sender need **not** be the author (v1 openness: anyone may relay anyone's post, same as signatures).
2. Resolve `post.voucher` to a stored Voucher with `bank == this bank`; else `-32005 unknown doc`. (Mirror banks relax this — §6.)
3. Enforce size cap (`-32000`) and per-pubkey rate limit (new custom code **`-32006 rate_limited`**, inside the reserved `-32006..-32099` custom range from `base.md §4.2`).
4. Store and index. Deno KV keys following the `db.ts` conventions (`k(bank, ...)`):
   - `('doc', hash)` → post body (existing universal doc store)
   - `('voucher_post', voucherHash, ulid, hash)` → firehose index, ULID-ordered; page with `kv.list({reverse: true})`
   - `('voucher_curated', voucherHash, ulid, hash)` → written only when the author is the issuer (posts and boosts)
   - `('post_reply', parentHash, ulid, hash)`, `('post_boost', targetHash, ulid, hash)` → thread/boost counts
   - `('post_author', voucherHash, pubkey, ulid)` → per-key rate-limit window + moderation lookups

**Read path — two surfaces:**

- **RPC** (add to `bank-rpc.md §2.4` and `apps/bank/handlers/get.ts`):
  - `list_posts(voucher_hash, { view?: "curated" | "all" | "issuer", before?: ULID, after?: ULID, limit?: number })` → page of Post bodies, newest-first, `limit ≤ 100` (default 25). Cursor = the `ulid` of the last item; `after` supports incremental sync for mirrors.
  - `get_post(hash)` → post body + `reply_count`, `boost_count`, `issuer_boosted: bool`.
  - `list_replies(post_hash, { before?, limit? })` → one thread level.
- **REST public feed** (unsigned read, exactly like the `GET /address/<pubkey>` precedent in `bank-rpc.md §2.5`; wire in `apps/bank/main.ts`):
  - `GET <bank-url>/feed/<voucher-hash>?view=curated&before=<ulid>&limit=50` → JSON `{ posts: Post[], next_before?: ULID }`. Cacheable, linkable, works for logged-out Barter Link landing pages.

**Pagination is ULID-native:** ULIDs sort lexicographically by time, are already the doc identity field, and Deno KV range-lists them directly — no offset/cursor machinery needed.

## 3. Issuer curation = repost semantics

- **Curated view (the default)** = issuer-authored posts ∪ targets of issuer boosts. A boost is returned as `{ boost: Post, target: Post }` so the client can render "Issuer boosted @xyz's post" with attribution intact — the boosted author's signature still speaks for the content; the issuer's signature only vouches for visibility.
- **Firehose view** (`view: "all"`) = every stored post for the voucher, newest-first, one toggle away.
- **Ranking:** structural, not algorithmic — the curated view *is* the ranking (issuer material only). Within the firehose the client visually elevates issuer-badged and issuer-boosted posts (pin styling), but server ordering stays pure ULID-desc so pagination remains deterministic and mirror-reproducible.
- Anyone may publish a `repost_of` post (nostr-style boost); only issuer-signed ones affect the curated index. Non-issuer boosts just increment `boost_count`.
- **Un-boost / retraction:** open question (§8) — either immutability-only ("the issuer boosted it at time T" stays true) or a tombstone mechanism.

## 4. Spam & abuse

Layered, all consistent with README §1.1 ("moderation is key-blocking, not gatekeeping"):

| Measure | Mechanic | Verdict |
|---|---|---|
| Size caps | `content ≤ 4 KiB`, whole doc `≤ 8 KiB`; reject `-32000` | **Do it.** Cheap, uncontroversial. |
| Per-pubkey rate limits | e.g. 6 posts/hour and 30/day per (pubkey, voucher), sliding window over `post_author` index; reject `-32006 rate_limited` | **Do it.** Limits are bank policy (values not protocol); the error code is standardized. |
| Key-blocking | Bank-level blocklist (already the sanctioned v1 mechanism) + an **issuer mute list**: banks SHOULD honor issuer requests to exclude a pubkey from that voucher's feeds (firehose shows a "muted" collapse, curated never shows them) | **Do it.** Whether the mute is a signed doc or a `/ui/*` custom call is open (§8). |
| Skin in the game — must hold a balance | Only accept posts from pubkeys with an Account (weak) or nonzero balance (strong) in the voucher. Bank can check locally since it owns the ledger. Caveats: issuer balances are *negative* (mutual credit — special-case), and it silences prospective buyers asking pre-purchase questions, which is a real discovery loss | **Optional per-voucher policy, default off.** Offer `holders_only` as a toggle. Note: `Voucher` schema is frozen in v1, so the flag can't live there — needs an issuer-signed settings mechanism or bank policy (§8). |
| Proof-of-work (nostr NIP-13) | ULID/nonce grinding for hash difficulty | **Skip in v1.** Rate limits + key-blocking suffice at current scale; keep as an escape hatch. |

Replay is a non-issue: resubmitting the same post is idempotent (same hash), and the RPC envelope already has replay protection (`base.md §4.1`).

## 5. UI

Grounded in `docs/ui/claude-ui.md §8` and the current SPA (`apps/web/app.js` hash-router):

- **Voucher detail page gains a Feed tab.** Route `#/vouchers/:hash` (spec §8.7 "My Vouchers") gets tabs **Details | Feed**. Feed tab: curated view by default, **"Show all posts"** firehose toggle; infinite scroll paged by `before` ULID; issuer posts carry an **Issuer badge** (pubkey == `Voucher.pubkey`); boosts render as "boosted by issuer" cards; muted/blocked authors collapsed in firehose.
- **Compose box** at the top (auth'd users): markdown textarea with byte counter (4 KiB), Reply / Quote affordances filling `reply_to` / `repost_of`. The Post is **signed in the browser** with the unlocked key — same custody rule as every doc (spec §4: plaintext key never leaves the browser) — then sent via `submit_docs` to the voucher's home bank (resolved from `Voucher.bank` + Address registry, same as the deal flow).
- **Boost button:** on every post for the issuer (their curation lever, one tap = plain repost, long-form = quote-boost); on posts for everyone else as a plain nostr-style boost that doesn't affect curation.
- **Discover (§8.12):** Offer cards get a one-line "latest issuer update" snippet + post count (one `list_posts(voucher, {view:"issuer", limit:1})` per hydrated voucher, batched with the existing `get_voucher` hydration); clicking deep-links to `#/vouchers/:hash` Feed tab. An active blog is a strong liveness/trust signal next to the rate and trust badge.
- **Dashboard:** an "Updates from your vouchers" widget — merged curated heads of the vouchers the user holds (client-side merge of per-bank `GET /feed/...` calls, same poll pattern as Discover's "poll known banks").
- **Public landing:** the voucher's Barter Link page (§5/§6 journeys) renders the curated feed via the unsigned REST endpoint — the blog doubles as the voucher's public storefront and an onboarding funnel for logged-out visitors.

## 6. Federation

Posts replicate exactly like Signatures do today (`README.md §2.4`): they carry their own authority, so **anyone may deliver them, and the receiver verifies independently**.

- **Home relay:** `Voucher.bank` is authoritative for the feed, as it already is for balances.
- **Push:** extend `Subscription` (`bank-schema.md §1.7`) — it already has a `voucher` filter — with `kinds?: ("signature" | "post")[]` (default `["signature"]` for backward compatibility). Matching posts are POSTed to `Subscription.url` fire-and-forget, mirroring `notify_signatures`.
- **Relay/mirror:** replication *is* `submit_docs` — it already accepts docs from any sender. A mirror bank subscribes (or polls `list_posts(voucher, {after})` for incremental catch-up), stores foreign-voucher posts, and serves read-only feeds. Content-addressing dedupes; ULIDs merge-order; no consensus needed. A dropped push recovers via pull — same push/relay/pull triad as signature fan-out. (Deployment note: co-located banks must use the in-process dispatch path per `WORKAROUNDS.md §4`.)

**Nostr comparison:**

| Concern | nostr | barter.game posts |
|---|---|---|
| Event id | sha256 of serialized event | sha256 of JCS-canonical doc minus `sig`, base58 — already universal |
| Keys/sig | secp256k1 Schnorr, hex/bech32 | ed25519 + base58 — already universal |
| Event kinds | integer registry (1=note, 6=repost, 7=reaction…) | one `type:"post"` string + typed optional fields (`repost_of` ≈ kind 6; reply e-tag ≈ `reply_to`) |
| Tags (`e`/`p`/`a` arrays) | positional string arrays | first-class typed fields: `voucher`, `reply_to`, `repost_of` |
| Timestamp | `created_at` unix seconds | ULID — timestamp **and** pagination cursor **and** doc identity |
| Transport | websocket REQ/EVENT/EOSE, relay lists, outbox model | JSON-RPC `submit_docs` / `list_posts` + REST GET feed + optional `Subscription` push |
| Relay selection | user-chosen relay set | deterministic home relay = the issuing bank; mirrors optional |
| Identity | NIP-05 DNS mapping | pubkey IS the identity (`base.md §1`); handles bank-local |
| **Borrowed** | signed immutable content-addressed events; ids as hashes; open posting; boost-based curation; relay-agnostic delivery | |
| **Skipped** | kind-number registry, websocket sub protocol, NIP-05, relay-list gossip, PoW (deferred), replaceable/parameterized events | |

## 7. Protocol placement

Standardize the doc shape and method semantics in `protocol/` (add `"post"` to the BaseDoc union in `base.md §3`; Post schema in `bank-schema.md`; `list_posts`/`get_post`/`GET /feed/...` in `bank-rpc.md`) so posts are portable across implementations — but mark the whole feature an **optional capability**: a bank that doesn't serve blogs answers `submit_docs` posts with `-32600 unsupported doc type` and remains fully v1-conformant for trading (per `base.md §6`, extensions must not break the base wire format). Optionally advertise `"features": ["posts"]` in `barter-bank.json`.

Touch points in the reference stack: `protocol/{base,bank-schema,bank-rpc}.md`; `apps/bank/handlers/submit_docs.ts` (`'post'` case), `apps/bank/handlers/get.ts` (reads), `apps/bank/db.ts` (`storePost` + indexes), `apps/bank/main.ts` (REST feed route), `apps/bank/handlers/subscribe.ts` + `notify` path (`kinds`); `apps/web/app.js` (Feed tab, compose, boost, Discover snippet); a new `scenarios/voucher-blog.md` trace.

## 8. Open questions for the owner

1. **Deletion/retraction:** strictly immutable (pure nostr ethos, simplest), or a signed tombstone (`Post` with e.g. `delete_of`, honored only from the original author/issuer) that banks SHOULD stop serving? Same question for **un-boosting**.
2. **Default view:** curated-first (proposed — issuer's storefront) or firehose-first (community-first)?
3. **Posting gate:** open-to-anyone default with `holders_only` as opt-in per voucher — and since the `Voucher` schema is frozen in v1, where does that flag live: an issuer-signed voucher-settings doc, or bank-local policy?
4. **Issuer mute list:** a protocol-standard signed doc (portable to mirrors, verifiable) or a custom `/ui/*` bank call (simpler, bank-local)?
5. **Media:** markdown text only in v1? Inline images (the `image_svn` precedent) collide with the 4 KiB cap; external links bring link-rot/tracking. Suggest text + links in v1, media later.
6. **Cross-posting:** single `voucher` field (proposed) vs. an array — does one announcement to N vouchers mean N signed posts?
7. **Reactions/likes** (nostr kind 7): skip, or add later as a tiny content-less doc? (Boost count may be enough signal for v1.)
8. **Rate-limit numbers & retention:** are 6/hour + 30/day per (pubkey, voucher) and indefinite retention acceptable defaults, and may banks prune firehose posts (never issuer/curated ones) after N months?
9. **Issuer notifications:** should the issuer's client auto-subscribe (`Subscription` with `kinds:["post"]`) to hear about replies/mentions, or is poll-on-open enough for v1?
10. **Capability advertisement:** add a `features` array to `barter-bank.json`, or let clients feature-detect via a probe call?
