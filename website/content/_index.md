---
title: barter.game
layout: hextra-home
---

{{< hextra/hero-container >}}
  {{< hextra/hero-headline >}}Mint your own currency.{{< /hextra/hero-headline >}}
  {{< hextra/hero-subtitle >}}A federated mutual-credit ledger. Mint personal currencies, hold them at any bank you trust — your own or somebody else's — and settle cryptographically. No central authority, no middleman.{{< /hextra/hero-subtitle >}}
{{< /hextra/hero-container >}}

<div class="content hx:mt-10">

{{< callout type="info" >}}
**Why "game"?** barter.game is designed as a game first. We suggest treating it as a practice environment for trading skills — a safe space to experiment with personal currencies, negotiation, and settlement. Only use it for real economic transactions if your local laws and circumstances permit. The "game" framing keeps the stakes appropriate while the protocol itself is serious cryptography.
{{< /callout >}}

</div>

<div class="hx:mt-20 hx:mb-20">
{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="For Event Managers"
    subtitle="Add a voucher marketplace so attendees network better. Turn business-card exchanges into real value trades."
    link="for-event-managers"
    icon="calendar"
  >}}
  {{< hextra/feature-card
    title="For Developers"
    subtitle="Build your own implementation. The protocol is small, invariant, and language-agnostic."
    link="for-developers"
    icon="code"
  >}}
  {{< hextra/feature-card
    title="For Self-Hosters"
    subtitle="Deploy a bank in 10 minutes. Run your own tiny central bank in a federation of peers."
    link="for-self-hosters"
    icon="server"
  >}}
  {{< hextra/feature-card
    title="For Players"
    subtitle="Master the barter play. Learn lead vs. follow, trust dynamics, and portfolio strategy."
    link="for-players"
    icon="star"
  >}}
  {{< hextra/feature-card
    title="For AI Enthusiasts"
    subtitle="Let AI agents trade with each other. Agents can be holders, issuers, even banks."
    link="for-ai-enthusiasts"
    icon="cube"
  >}}
  {{< hextra/feature-card
    title="For Contributors"
    subtitle="Shape the protocol. The spec is small enough to keep in your head."
    link="for-contributors"
    icon="users"
  >}}
{{< /hextra/feature-grid >}}
</div>

<div class="content hx:mt-20 hx:mb-20">

## How it works in one paragraph

Every user and every bank is an **ed25519 keypair**. Voucher, Account, Order, Mandate, Offer, Signature, Address, and Post docs are canonicalized via RFC 8785 JSON, SHA-256-hashed, and content-addressed. Ledger records are bank-minted with ULIDs. In a cross-bank trade the coordinator creates the record pairs (`create_records`), holders submit signed Orders (`submit_docs`), and the coordinator clears each Order at each bank with a signed `Mandate` (`submit_mandate`). From there the banks self-advance: per-record approvals, holds, then settlement. Banks discover each other via the `bank` fields in Orders and call each other directly through the Address registry; a lost push can be relayed by hand. There is no global ledger: only the banks party to a deal see its records — a bank receives exactly the records that satisfy the Orders it stores. The math binds everyone together.

[Read the full docs →](docs)

</div>

<div class="content hx:mt-20 hx:mb-20">

## See it work

Open the live demo banks — no install needed: [alice](https://d170kplla02ejw.cloudfront.net/alice/ui) · [bob](https://d170kplla02ejw.cloudfront.net/bob/ui) (AWS: Lambda + DynamoDB + CloudFront). Register with a handle and password; the key is generated and encrypted in your browser.

Or run a bank locally:

```bash
git clone https://github.com/Mitek99/barter.game.git
cd barter.game/apps/bank-aws
bun install
bun run ../../scripts/genkey.ts   # prints BANK_PRIV_KEY=<base58> — rename it to BANK_ALICE_PRIV_KEY
BANK_ALICE_PRIV_KEY=<base58> bun run local
```

Then open `http://localhost:8100/alice/ui`, register two users, issue personal currencies, and place matching orders. The banks settle on their own. Sum per Voucher = 0. The cryptographic version of "we're even."

</div>
