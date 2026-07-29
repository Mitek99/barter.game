# barter.game web client — UX report

Scope: the reference SPA (`apps/web/`) served by the two live banks
(`https://barter-game-banks.ai-1st.deno.net/{alice,bob}/ui/`). Current as of
`main` **`02960fe`** — what the banks serve now.

**Status: the UX-defect backlog is clear.** Four shipped rounds
(PR #14/#15 → #17 → #18 → #20) closed every finding from the original audit and
the follow-up re-audit — 40+ items, each verified live. Since then a further
stretch of work (#24–#42, row 5+ in §2) fixed defects found after that "clear"
and added major UX surfaces: post feeds, follows, the Discover gallery, the
implied-rate readout, and PWA install. What remains (§3) is product work that
needs protocol or schema changes, not client polish.

---

## 1. Where the client stands

Verified on production after the round-3 deploy:

- **Core flows work end to end.** Register → mint → cheque/invoice → share link →
  a second user registers *through the link* → claim/pay → settle, with correct
  balances, cross-account and cross-bank. The pending action resumes after
  register/login.
- **Failures look like failures.** Every data surface distinguishes "couldn't
  load" from "you have nothing" — no more empty states standing in for outages.
- **Nothing is shown blind.** Vouchers are named everywhere they're referenced
  (lists, landings, deal screen, activity, chooser); landings verify every
  signature client-side before rendering and say so.
- **Accessible.** Focus moves to a real heading on navigation, skip link, `<main>`
  landmark, labeled nav, dialog/sheet semantics with focus traps and Escape,
  WCAG AA contrast in light and dark, 40px touch targets, no-zoom inputs.
- **Mobile.** Persistent bottom bar (Home / Discover / New / Scan), a create sheet
  covering invoice / cheque / swap / voucher, and a Menu drawer for everything
  else.
- **Recoverable.** The recovery kit can now be both downloaded *and* restored
  (decrypted locally, no bank round-trip).

## 2. What shipped, by round

| Round | PR | Highlights |
|---|---|---|
| 1 | #14, #15 | Invoices-tab crash, permanently-empty Discover, error-vs-empty states, DOM-XSS hardening, deal-screen reload/polling, pay-blind landings, register form, de-jargoned forms, amount validation, cheque→QR, order rate/self-swap, friendly 429/404 |
| 2 | #17 | Focus-to-heading + skip link, accessible QR modal, dark mode, contrast, mobile tap targets, foreign-bank issuer resolution, offer/invite landings, cross-bank "use my account at another bank", voucher expiry, public registry browser, auto-lock warning |
| 3 | #18 | Mobile bottom nav + Menu drawer |
| 4 | #20 | Router/poll/focus regressions (R2/R6/R7), `list_vouchers filter:'mine'` (R1), error states on Dashboard/Network/choosers (R3), voucher names in own lists (R4), recovery-kit restore (R9), integer-voucher enforcement (R10), double-submit guards (R11), invoice QR (R12), foreign-issuer QR target (R13), cross-origin scan origin (R14), sheet a11y (R15), plus R5/R8/R16/R17/R18/R20 and the final a11y residue (contrast, nav label, `<main>`) |
| 5+ | #24–#42 | Defect fixes: same-bank swap minting one record pair per transfer (#24), swap-share Offer-vs-Order hash (#25), account-balance privacy (#26), embedded author/voucher name resolution (#29), feed bank naming (#36). New surfaces: post feeds with replies and reposts (#28), PWA install (#31), Logout in the menu replacing the header Lock button (#34), follows as a separate list from trusted issuers with Network UI (#35/#36), "Trade for this" (#38), the implied-rate readout — a ceiling, not a fixed price (#41), follows-feed Discover gallery + media vault (#42) |

Two classes of bug are worth calling out, because they'd recur:

- **Failure-as-empty.** Three separate rounds found surfaces where a swallowed
  `.catch(() => [])` made an outage read as "you have nothing". Worth a lint rule
  or a shared fetch wrapper rather than case-by-case fixes.
- **Fixes colliding.** Round 2's loading shell and focus management broke the
  deal screen's poll (skeleton flash, focus theft, stacked timers) — caught only
  by the re-audit. Round 4 fixed the interaction by making `route()` coalesce and
  distinguishing a refresh from a navigation.

---

## 3. What's left — roadmap

None of these are client-polish items; each needs protocol or schema work first.
Several are already tracked in [`scenarios/builder-event.md`](scenarios/builder-event.md)
and [`TODOS.md`](TODOS.md).

| Gap | Why it's blocked | Tractable first slice |
|---|---|---|
| **Atomic 1→2 split** (package → mug + shirt) | One Order carries one debit + one credit block + one scalar rate; `integer:true` blocks fractional workarounds. Even the non-atomic honored-offer workaround has no UI path — both deal-proposing paths pass exactly two orders to `propose_deal`. | A client-side "split" coordinator composing the package cheque + the issuer's component offers into one multi-pair deal |
| **Public-holdings discovery** ("X holds Y of Z, I'll get some" — INPUTS 33, discovery.md §6) | No `list_public_balances` RPC, no `Account.public` flag, no holder-balance view | Read-only `list_public_balances` + an account "public" toggle + a simple holdings view |
| ~~**Post / voucher feeds**~~ | **Built.** Write via `submit_docs`, read via `list_posts` merged client-side across a dedicated follows list (separate from trusted issuers; default: your own bank, which auto-reposts its users' accepted posts), replies and reposts, issuer voucher-meta releases, and the content-addressed media vault. `#/posts` is now linked in the nav. | — |
| **Profile-QR bundle selection** (discovery.md §4) | Sharing a profile advertises *all* of an issuer's vouchers; no shape for a curated subset | A bundle link/QR carrying a chosen voucher set |
| **Issuer backup / export of record history** | `list_voucher_records` is specified (`bank-rpc.md` §2.4) but not implemented at the bank (see TODOS: new protocol read surfaces), and there is no UI — so an issuer can't back up and re-issue holder records after a bank loss | An export button on the issuer's voucher (paginated, newest-first) |
| **Booth live view** (builder-event Phase 5) | Only the deal screen self-refreshes; Activity/Dashboard are static snapshots | Opt-in polling on an "Incoming" view filtered to credits on a chosen voucher |
| **Deal searcher** across public offers | Needs an LP solver + multi-bank offer scan | Out of scope for the reference client for now |

### Deliberately not done

- **Add-a-contact** (Network → Contacts lists and removes, but can't add). Skipped
  because the feature's purpose is undefined — contacts aren't used by any flow.
  Either give contacts a job or drop the section.
- **"Relay signatures"** on the deal screen remains a placeholder (documented in
  [`apps/web/README.md`](apps/web/README.md) known gaps).

---

## 4. Method

Findings came from live black-box testing on both production banks plus
multi-agent code audits across seven dimensions (empty/loading/error states,
copy & terminology, scenario coverage, forms, accessibility/responsive,
sharing/links/trust, and a dedicated regression hunt), with every finding
adversarially re-verified against the source before it was accepted. The
re-audit confirmed 41 findings and rejected 7 as already-fixed or unreachable.

Each fix was verified against a local two-bank federation before merge and
re-verified on production after deploy; the e2e suites (now nine: local,
cross-bank, cheque, reject-cascade, replay, forged-sigs, account-privacy, posts,
same-bank swap) pass, and a full claim → settle was driven in a browser
each round.

*Historical note: this file previously tracked open findings as U1–U20 (round 1)
and R1–R22 (re-audit). All are resolved; the IDs survive in the commit messages
and PR descriptions if you need to trace one.*
