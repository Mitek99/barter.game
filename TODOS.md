# TODOS

Deferred items. Each entry: **what / why / context / depends on**.

## v1.5 — likely-next-up

### Multi-leg Orders (1→N bundle splits)
- **What:** Extend the Order schema so a single Order can atomically give one voucher in exchange for a **bundle** — e.g. 1 swag-package → 1 mug + 1 t-shirt.
- **Why:** Today an Order carries exactly one `debit` block and one `credit` block, each naming a single voucher with one scalar `rate`. The split is only expressible as multiple one-sided Orders, which loses atomicity ("give the package ONLY IF I receive both items") and breaks entirely for `integer: true` vouchers, whose 1-unit debit cannot be spread across two Orders.
- **Context:** [`scenarios/builder-event.md`](./scenarios/builder-event.md) documents the gap and the non-atomic workaround (issuer-honored standing Offers, each direction settling as its own deal). A schema extension ripples into `create_records` pairing and Mandate rate validation.
- **Depends on:** Stable v1 Order semantics; a decision on rate semantics for multi-leg Orders.

### Implement the new protocol read surfaces
- **What:** Implement in `apps/bank` what [`protocol/bank-rpc.md`](./protocol/bank-rpc.md) §2.4 now specifies: `list_voucher_records` (issuer backup export — **MUST** for compliance), `list_account_records` (holder history), `get_balance` (bank-signed `Balance` doc — needs the `Balance` type + validator in `packages/protocol`), `list_public_balances` + `Account.public`, and pagination + the issuer filter on `list_vouchers`. Enforce the privacy default while at it: `get_account_balance`/`list_account_records` restricted to the holder unless the account is public.
- **Why:** The spec now leads the implementation. Issuer backup/re-issue (ETHOS §7) and public-holdings discovery ([`protocol/discovery.md`](./protocol/discovery.md) §6) hang off these surfaces; the unrestricted `get_account_balance` disclosure gap (docs/REVIEW.md S10) closes as a side effect.
- **Context:** `protocol/bank-schema.md` §1.2 (`public` flag) and §1.8 (`Balance`); pagination convention in `bank-rpc.md` §2.4.
- **Depends on:** Nothing — additive.

### ~~Implement voucher post feeds~~ — DONE
- **What:** `Post` doc type + validator in `packages/protocol`; `submit_docs` routing with a bank acceptance-policy hook (spam filter / allowlist / rate limit); `list_posts` + `get_post`; a feed screen in the web UI.
- **Status:** shipped. `Post` + `validatePost`/`verifyPostTree` in the protocol lib, `submit_docs` acceptance, `list_posts`/`get_post`/`get_post_signatures`, media blobs at `/media`, and a `#/posts` feed with reply/repost in the SPA. Covered by `apps/bank/e2e-posts.ts`. A bank acceptance-policy hook beyond validity is still bank-specific and not implemented here.
- **Why:** Feeds are the social layer of discovery — issuer announcements, recommendations, testimonials ([`protocol/post-feed.md`](./protocol/post-feed.md)).
- **Context:** docs/REVIEW.md Part IV ("per-voucher blogs") is the original design sketch.
- **Depends on:** Nothing — additive.

### Rebuild the demo scripts
- **What:** `scripts/demo-local.sh` and `scripts/demo-deploy.sh` still invoke the removed CLI (`apps/cli/src/index.ts`) and are broken; rebuild them against the RPC/web flow (the `apps/bank/e2e-*.ts` scripts are the working seeds) or delete them. `scripts/genkey-deno.ts` imports a nonexistent module (`apps/bank/protocol.ts`) — fix or remove (`apps/bank/genkey.ts` is the working keygen).
- **Why:** A README that points at broken scripts costs trust; right now the README routes around them.
- **Depends on:** Nothing.

### Deal searcher (linear-programming reference implementation)
- **What:** A tool that scans public Offers across a number of banks, combines them with the private Orders the user knows about and recent deal-readiness history, and performs an exhaustive search for closable deals — including deals where the user acts as lead holder of vouchers they don't particularly trust. Offers translate into linear expressions; an LP solver finds the profitable compositions.
- **Why:** Liquidity for the network, and a potential margin for the brave coordinator (with all the risks of charting shady banks/vouchers/issuers). The deal searcher is *enabled* by the protocol but deliberately not *specified* by it; a reference implementation belongs in this repo.
- **Context:** Subsumes the "Counterparty-blind coordinator" idea in the AI-agents section below; `scenarios/builder-event.md` and `scenarios/coordinator-arbitrage.md` show the manual version.
- **Depends on:** Public Offer polling at enough banks to matter; the federated directory (below) helps.

### Post replies, media, and embedded documents
- **What:** Threaded replies (`reply_to`), embedded images/video, and first-class embedded protocol docs (pubkeys, Vouchers, Orders) inside posts — so a recommendation can carry the thing it recommends.
- **Why:** Reserved as future work in [`protocol/post-feed.md`](./protocol/post-feed.md) §6; to be figured out as real feeds appear.
- **Depends on:** Post feeds shipped and used.

### Cross-bank inbox aggregation
- **What:** A single inbox view that shows all of a user's balances and in-flight deals across every bank that issued a Voucher they hold.
- **Why:** The web UI is scoped to one bank at a time; a user with Vouchers across 3 banks has to open 3 tabs.
- **Context:** The issuing bank is the sole authority for its Voucher's balances, so the client must hit every issuer bank (`list_accounts`, `list_account_records`, `get_record_signatures`) and merge. Subscription docs already let a client point each bank's signature fan-out at its own endpoint, so aggregation is a merge problem, not a polling problem.
- **Depends on:** Stable protocol; a client-side endpoint to receive `notify_signatures` pushes; a merge-order decision (last-write-wins by ULID?).

### Hold sweeper & orphaned-record hygiene
- **What:** An operator sweeper that rejects deals that died before settling (releasing their holds) and garbage-collects records that were created (`create_records`) but never mandated.
- **Why:** Banks self-advance but the protocol has no clocks (ETHOS §9). The spec now explicitly allows a bank to `reject` a **stalled** deal on its own timeout (`protocol/bank-schema.md` §2, reject semantics) — the sweeper is the operator policy that exercises it.
- **Context:** Hygiene, not correctness: the single-hold-per-account gate stays the double-spend defense either way. The sweep must issue proper `reject` signatures so the release is part of the audit trail.
- **Depends on:** Decide the operator policy surface (config per bank vs. hardcoded demo default).

### Federated bank directory
- **What:** A registry where banks publish themselves so clients/peers can discover them beyond out-of-band links.
- **Why:** Today a bank is discovered by being linked or told about. That's by design for trust — but a directory helps *finding*, and the trust model already says a directory is for discovery, not trust.
- **Context:** Could be a shared JSON file, a relay model, or a barter.game-operated good-citizen service. Decision pending. See `protocol/discovery.md` §1 ("no global directory" is the v1 baseline).
- **Depends on:** Decide whether the directory is decentralized or operated.

### Key rotation
- **What:** Allow a bank or user to roll their ed25519 key without orphaning existing Vouchers/Accounts.
- **Why:** v1's "lose key → lose account" is acceptable for a demo but unworkable for anything resembling production.
- **Context:** Requires either (a) signed key-rotation docs linking old pubkey → new pubkey, or (b) a separate authority root signing rotations. Each has bootstrap tradeoffs.
- **Depends on:** Decide rotation model first; document the migration path for existing Vouchers.

### Account recovery
- **What:** Some way for a user to recover their account if they lose their key and password.
- **Why:** The hard "lose key, lose account" rule is a UX cliff. Real users WILL lose keys.
- **Context:** Options: social recovery (M-of-N trusted parties sign a key replacement), hardware wallets, additional encrypted backups. The recovery kit download in the web UI (encrypted keystore file) already covers the "lost device, remembered password" case; this item is about the rest.
- **Depends on:** Key rotation (above). Without rotation, recovery would break the cryptographic identity model.

### Per-bank deployment isolation
- **What:** Migrate from "one Deno Deploy app hosts N banks in one process/KV" to "each bank in its own deployment."
- **Why:** Multi-tenancy collapses operational independence — one outage takes down all co-located banks. True federation wants process and storage isolation.
- **Context:** The protocol already supports it (banks are URLs + keys). Note the Deno Deploy self-fetch constraint (WORKAROUNDS.md §4): co-located banks must dispatch in-process; separated banks talk plain HTTP.
- **Depends on:** Stable protocol so the migration doesn't reintroduce bugs.

### Browser key UX deep tune
- **What:** Production-grade Argon2id-in-WASM for browser-side private key encryption, replacing PBKDF2-SHA256 (250k iterations).
- **Why:** Argon2id is the right KDF but heavy (~100ms + WASM loading state); PBKDF2 iteration counts need real-device benchmarks.
- **Context:** WORKAROUNDS.md §1 documents the current compromise and the upgrade path (kdf field is versioned; old keystores re-wrap on next login).
- **Depends on:** Real users with real value at stake.

### Per-bank custom domain (clean URLs)
- **What:** Serve banks at clean subdomains (`a.barter.game`, `b.barter.game`) instead of path prefixes.
- **Why:** Pretty URLs. No functional difference.
- **Depends on:** Real users complaining about URLs (probably never).

## Done — shipped

### Web UI (apps/web)
- **What:** Browser-based client: register/login with handle+password (browser-encrypted keystore), voucher minting, orders/invoices/cheques, offer discovery, deal proposing and monitoring, QR share/scan of Barter Links, trusted-issuer network with notes.
- **Status:** Shipped and actively developed. See [`apps/web/README.md`](./apps/web/README.md); in-effect compromises in WORKAROUNDS.md.

### Multi-party deals (Order/Mandate model)
- **What:** A single deal can involve any number of banks and holders, composed from holders' Orders (two-sided or one-sided cheque/invoice specializations). The coordinator creates record pairs at each bank (`create_records`) and clears each Order with a Mandate (`submit_mandate`); banks self-advance `created → approved → held → settled` in lead/follow order, fanning signatures to each other directly.
- **Status:** Shipped — see `scenarios/merge-branch.md` (3-bank merge/branch), `scenarios/coordinator-arbitrage.md` (spread-taking coordinator), and the `apps/bank/e2e-*.ts` settlement checks (crossbank, reject cascade, settle-replay resistance).

## v2+ — bigger swings

### NFT-like unique Vouchers
- **What:** Each Voucher instance is a distinct, non-fungible token (vs v1 where any "1 logo" issued by Alice is interchangeable).
- **Why:** Some use cases need provenance (signed art, specific event tickets).
- **Context:** Schema change: Records reference Voucher instances, not just Voucher types. Bigger rewrite of balance accounting.
- **Depends on:** Use case demand.

### Reputation / dispute resolution
- **What:** Some on-protocol mechanism for "Alice settled but Bob never delivered."
- **Why:** v1's social-recourse model breaks at scale.
- **Context:** Options: stakes/bonds, arbitration (mutually-trusted third bank), public signed dispute docs. Each fundamentally changes the trust model.
- **Depends on:** Real users hitting the dispute problem often enough that protocol-level intervention beats social recourse. Likely the LAST thing to build.

### Hardware wallet / Ledger integration
- **What:** Private keys on hardware (Ledger, YubiKey) rather than a browser keystore.
- **Why:** Security upgrade for users with material value in their accounts.
- **Context:** WebAuthn / U2F integration; significant client work; deliberately punts on recovery (key never leaves device).
- **Depends on:** Use cases where account value > "1 logo for a friend."

## AI agents — speculative extensions

Brainstorm output, not committed direction. These are agentic layers that could sit on top of v1 without modifying the wire protocol. They explore the seams the trust model opens up: issuer-side trust infrastructure (directory, due-diligence, audit), holder-side automation (inbox, portfolio, deal search), and the wider question of whether agents themselves can be issuers, holders, or banks.

`W:` = weirdness, 1-10. 1 is "obviously useful", 10 is "blue-sky deranged". Taste signal, not priority. Overlapping ideas already covered above are noted but not re-listed (federation cartographer → "Federated bank directory"; dispute mediator → "Reputation / dispute resolution"; counterparty-blind matching → "Deal searcher").

### Conversational wallet (W: 2)
- **What:** LLM front-end that translates intent ("mint me 5 logos and offer 2 to Alice for an hour of design review") into signed docs and RPC calls.
- **Why:** The web UI helps non-technical users; a conversational shell helps more.
- **Context:** Pure client-side layer over `packages/protocol`. No protocol changes.
- **Depends on:** Stable library API.

### Inbox triage agent (W: 3)
- **What:** Watches proposed deals and the subscription push feed, summarizes them in plain English, drafts the holder's Order based on standing instructions ("auto-accept anything from Alice ≤ 5 logos").
- **Why:** Reviewing deal terms by hand is correct protocol but tedious UX. Triage reduces friction without touching the wire.
- **Context:** Client-side only. Standing instructions live alongside the encrypted key. The agent never invents authority — it signs (or declines) the holder's own Order after the same verification a human would run.
- **Depends on:** Inbox UI track.

### Issuer due-diligence agent (W: 4)
- **What:** Before accepting Vouchers from an issuer you don't know, fetch their issuance history, outstanding supply vs `limit`, and redemption track record. Returns a one-paragraph credit memo.
- **Why:** The trust model is "trust the issuer, not the holder." That trust still has to be assessed somehow; an agent reads the signed history for you.
- **Context:** Pure aggregator over public signed evidence — `list_vouchers`, `list_voucher_records` (where the issuer serves it), public Balance docs. Surface in the wallet at accept-time.
- **Depends on:** Federated bank directory; the new read surfaces implemented.

### Voucher pricing oracle (W: 4)
- **What:** LLM-suggested exchange rate: "what's a fair amount of `alice-logos` per `bob-hour`?"
- **Why:** Even people who know each other still have to haggle. An oracle gives an anchor; humans pick the binding amount.
- **Context:** Reads issuer histories + Voucher descriptions. Pure suggestion, never enforcement (ETHOS §5: value is local).
- **Depends on:** Nothing — could ship as a standalone web service.

### Lead/follow strategist (W: 5)
- **What:** Recommends whether the user should be lead or follow on a proposed deal, based on counterparty-issuer history, amount, `due` date, and prior abandonment patterns.
- **Why:** v1 puts the lead/follow decision on humans, who have no data. The signed evidence has the data.
- **Context:** Pure recommendation. Could auto-decline trades over a configurable risk threshold.
- **Depends on:** Voluntary-reputation miner (below) for abandonment rates.

### Trust-graph transitive propagator (W: 5)
- **What:** Reasons "you trust Alice; Alice holds many of Carol's Vouchers and has never rejected one; therefore Carol is probably trustworthy as an issuer." Builds issuer-trust transitively from public signed evidence.
- **Why:** Direct trust lists are small. Transitive trust extends reach without violating "trust your counterparty" — the signed-evidence graph IS the authority.
- **Context:** Read-only aggregator over public Balance docs and voucher feeds. Could feed the due-diligence agent.
- **Depends on:** Federated bank directory; public holdings adoption.

### Liquidity provider bot (W: 5)
- **What:** Autonomous holder of a diversified Voucher basket that quotes two-way prices and lubricates trade flow.
- **Why:** The LETS critical-mass / liquidity-failure mode is real. LPs are the standard finance solution — and the trust model accommodates them because LPs are holders, and holders aren't trust-bearing.
- **Context:** Runs as a regular user with its own keypair. Capital from depositors or from its own LP-credit Voucher.
- **Depends on:** Stable v1; pricing oracle for quote generation; deal searcher for routing.

### Voucher narrator (W: 6)
- **What:** For each settled deal, an LLM writes a one-paragraph human-readable story ("On Tuesday at the Berlin hackathon, Alice settled 1 logo to Bob in exchange for 30 minutes of debugging").
- **Why:** Signed evidence is dry. Narratives make the ledger legible — and post feeds give them a place to live.
- **Context:** Cheap LLM plumbing. Generate at settle-time or on demand; publish as a Post.
- **Depends on:** Nothing.

### Voluntary-reputation miner (W: 6)
- **What:** Reads the public signed-evidence trail and computes issuer reputation scores: abandonment rate, issuance discipline, redemption track record.
- **Why:** v1 bans ratings to avoid marketplace dynamics. But issuer reputation (not holder reputation) is consistent with the trust model — you trust issuers, so rating them is legitimate. Different category than the dispute-resolution entry above.
- **Context:** Read-only. Opt-in for issuers who want to surface their track record.
- **Depends on:** Federated bank directory; public read access to settle/reject signatures.

### Bank-integrity auditor (W: 6)
- **What:** Watches a bank's signed evidence stream and externally validates the sum invariant ("balances across all accounts for a given Voucher sum to zero").
- **Why:** The sum invariant is enforced by the issuing bank itself. An issuer+bank that collude could issue Vouchers off-ledger. Only an external auditor reading the public signed history catches this.
- **Context:** This is the missing patch on the trust model — banks could cheat, and the protocol's defense is "other banks notice." The auditor automates the noticing. `list_voucher_records` (where served publicly) is its raw feed.
- **Depends on:** Public read access to signed docs, or a gossip protocol where banks publish issuance history.

### Voucher-as-bond pricer (W: 6)
- **What:** Treats Vouchers with a `due` field as zero-coupon bonds. Computes yield-to-maturity, time-discount, default risk.
- **Why:** `Voucher.due` exists in the spec but nothing uses it yet. Once it does, Vouchers acquire a yield curve.
- **Context:** Wall Street primitive applied to friend-currency. Mostly UI/analytics.
- **Depends on:** Issuer due-diligence agent (for default risk input).

### Default-aware portfolio manager (W: 6)
- **What:** Watches a user's basket of issuer-issued Vouchers, flags issuers showing solvency stress, advises liquidation.
- **Why:** Holders aren't passive — their portfolio has health. Credit-portfolio management for friend-currency.
- **Context:** Combines the due-diligence agent with active monitoring and standing rules.
- **Depends on:** Due-diligence agent; voluntary-reputation miner.

### AI as bank operator (W: 7)
- **What:** A bank with no human operator. Agent rotates keys, applies migrations, watches the holds, runs the stalled-deal sweeper, publishes a daily summary.
- **Why:** Extends "tiny central bank" to "tiny autonomous central bank."
- **Context:** Inherits all human-operator collusion risk, plus alignment risk on top. "Lose the bank key, lose all its Vouchers" becomes existentially weirder. Interesting demo; do not run with real value.
- **Depends on:** Stable v1; bank-integrity auditor to externally check the AI operator.

### Personality-clone pre-approver (W: 7)
- **What:** Train an agent on past trades, conversations, and decisions. Auto-signs the user's own Orders on deals the user would have approved.
- **Why:** Sovereignty extended into agentic form — your tiny central bank runs while you sleep.
- **Context:** Disturbing because the signed evidence is yours but the decision wasn't. Failure modes are reputation damage to a real pubkey.
- **Depends on:** Conversational wallet; robust eval of clone fidelity.

### Receipt-witness agent (W: 7)
- **What:** Inspects the delivered artifact and attests "yes, this is the deliverable Alice promised."
- **Why:** Adds machine corroboration to the holder's own signed authorization, which v1 leaves purely human ("code cannot verify a logo is a logo").
- **Context:** Directly challenges an ETHOS premise. Probably right for narrow Voucher types (file deliverables, signed text) and wrong for fuzzy ones ("dinner"). Decide carefully — this is one of the load-bearing v1 assumptions.
- **Depends on:** Decision to soften the "human attestation mandatory" premise; per-Voucher-type witness adapters.

### Forgery sentinel for fungibility ambiguity (W: 7)
- **What:** Watches every issuer's issuance history for Vouchers with near-identical names ("1 logo" vs "1 logo " (trailing space), Unicode homoglyphs, "1 logo (rev2)").
- **Why:** v1 fungibility is implicit in Voucher-hash equality, but humans read names. An issuer could confuse holders with near-identical names.
- **Context:** Cheap to implement (Unicode NFKC normalization + similarity scoring). Warns the wallet at accept-time.
- **Depends on:** Nothing protocol-level; bolts onto the wallet.

### AI as issuer (W: 7)
- **What:** Agents are first-class issuers. An agent mints `1 code review`, `1 generated image` Vouchers against its own bank.
- **Why:** Trust question is identical to the human case: do you trust the agent's bank and its redemption? Composability becomes interesting: human-issuers and agent-issuers denominated in the same protocol.
- **Context:** Cleaner framing than "AI as holder." Redemption happens via the agent's API.
- **Depends on:** Stable v1; clear redemption mechanism for digital-deliverable Vouchers.

### Sin-eater insurance pool (W: 8)
- **What:** An AI-operated bank that takes on the lead role for a fee, absorbing abandonment loss into its own pool. The pool's solvency is itself a Voucher others hold and trade.
- **Why:** Lead/follow risk in v1 is "you eat the loss." Insurance is the standard hedge. The risk model gets a tradeable derivative.
- **Context:** Three layers: underwriting model, capital-pool Voucher, routing mechanism for using the pool as lead. The lead "carries the small remaining risk"; sin-eater takes that risk professionally.
- **Depends on:** Protocol stability; abandonment-risk pricing; voluntary-reputation miner for risk input.

### Holder-anonymity router (W: 8)
- **What:** Routes a Voucher through N intermediate holders/banks to obscure the previous-holder chain, without weakening trust (since holders aren't trust-bearing).
- **Why:** The trust model implies holder-chain privacy is free — recipients don't care who held it before, only who issued it.
- **Context:** This is barter.game accidentally inventing a mixer. Issuer identity stays visible forever (good); holder chain becomes optionally obscurable (potentially good, potentially regulatory-attractive). Add deliberately.
- **Depends on:** Stable v1; deliberate decision about whether to expose this property.

### AI-to-AI economy as parallel federation (W: 9)
- **What:** N agent-banks, each issuing currency for its own niche service. Agents trade among themselves; humans plug in as just another peer.
- **Why:** barter.game protocol as the substrate for an LLM economy where compute, capability, and attention are denominated in Vouchers. No token, no marketcap, no gas — just signed deliverables.
- **Context:** Differentiator vs other agent-payment systems is the federation property and the human-included peer graph.
- **Depends on:** Several v1.5 items (federated directory, key rotation); AI-as-issuer pattern proven first.

### Threshold-signed co-op bank (W: 9)
- **What:** N agents collectively operate one bank via threshold ed25519 signatures. K-of-N agreement required to settle/reject.
- **Why:** The "operator" becomes a swarm. Federation gains committee-banks alongside human-banks.
- **Context:** Threshold ed25519 (FROST or similar) is real and shippable. Emergent committee behavior gets weird fast — research vehicle, exotic demo.
- **Depends on:** Stable v1; FROST or equivalent threshold scheme; governance model for the committee.

### Dream-currency (W: 10)
- **What:** Vouchers denominated in dream-content: "1 dream-favor (lucid, involving canals)."
- **Why:** `Voucher.name` is `string`. The spec doesn't say it has to be useful. Mutual-credit ledger as surrealist art project.
- **Context:** Probably the most barter.game-shaped joke available. Listed for completeness.
- **Depends on:** Sense of humor.

### Posthumous-voucher bank (W: 10)
- **What:** A bank that only issues Vouchers payable after the issuer's death ("1 letter to my child, delivered when they turn 18").
- **Why:** Takes "your own seal of office" seriously enough to extend it past mortality.
- **Context:** Requires legal/estate integration well beyond scope. Listed for design-space completeness; not a serious roadmap item.
- **Depends on:** Estate-execution integration; AI executor (agent that settles when conditions are met).
