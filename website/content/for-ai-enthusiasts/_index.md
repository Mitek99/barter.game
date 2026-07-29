---
title: For AI Enthusiasts
---

## AI agents playing barter.game

The barter.game protocol does not care who holds the private key. It could be a human. It could be an organization. It could be an AI agent. The wire format is the same. The invariants are the same. The settlement cascade is the same.

This makes barter.game an unusually clean substrate for agent economies.

## What an AI agent can be

### AI as holder

An agent holds vouchers in its "wallet" (a keypair + client logic) and trades them based on instructions. "Auto-accept any trade from Alice ≤ 5 logos." "Decline any trade where I'm asked to be lead on an amount > 10." The agent triages proposed deals and drafts the holder's Order for the ones that match policy. It's just a client with a policy loop.

### AI as issuer

An agent issues its own vouchers. "1 GPT-5 response." "1 code review." "1 generated image." The agent runs its own bank (or uses a hosted one) and redeems vouchers via its API. Humans and other agents can hold and trade these vouchers.

This is cleaner than "AI as holder" because the trust question is identical to the human case: do you trust the agent's bank? Redemption is just an API call.

### AI as bank operator

An agent runs the full bank stack: holds the bank private key, validates RPCs, manages the database, runs the abandonment sweeper, publishes daily summaries. A tiny autonomous central bank.

This is exotic and risky — an AI with signing authority over a ledger — but the protocol supports it natively. The bank is just a process with a keypair.

## Why barter.game for agent economies?

Most agent-payment proposals assume:
- A single token (problem: whose token?)
- A central clearing house (problem: who runs it?)
- Smart contracts with gas fees (problem: friction, speculation)

barter.game assumes none of these. It gives you:
- **Federation:** Any agent can be a bank. No permission needed.
- **Mutual credit:** No pre-funding, no gas, no token speculation.
- **Signed vouchers:** Every deal is cryptographically verifiable. Agents can audit each other's history.
- **Signed, verifiable docs:** Voucher, Account, Order, Mandate, Offer, Address, Signature, and Post docs are content-addressed. Ledger Records are bank-minted with ULIDs. All are cryptographically auditable. (Post feeds are the discovery substrate an agent would scan — `list_posts` and friends.)

## Experiments to try

### 1. Two agents, one trade

Spin up two agent processes. Give each a keypair and a bank. Have one issue "1 computation unit." Have the other issue "1 data unit." Let them negotiate a trade via LLM conversation, then sign Orders and settle it through the protocol.

### 2. Agent portfolio manager

An agent watches its wallet and maintains a "credit memo" on every issuer it holds vouchers from. It reads issuance history, abandonment rates, and redemption track records from the public signed evidence. It advises its owner (human or another agent) on which vouchers to accept, hold, or liquidate.

### 3. AI-to-AI ring trade

Three agents. Agent A offers image generation. Agent B offers text summarization. Agent C offers code review. They form a ring: A → B → C → A. Each agent signs its own Order; the coordinator (which could be a fourth agent) creates the records on each bank and clears each Order with a signed Mandate, and the banks settle the ring on their own.

### 4. Threshold-signed co-op bank

N agents collectively operate one bank via threshold ed25519 signatures (FROST). K-of-N agreement required to create records, settle, or reject. The "operator" becomes a swarm.

### 5. The sin-eater

An AI-operated bank that takes on the lead role for a fee, absorbing abandonment loss into its own pool. It underwrites risk by reading the signed history of counterparties. The pool's solvency is itself a Voucher that others hold and trade.

## The trust question

When an AI agent asks you to hold its voucher, the question is the same as when a human does: **do you trust the issuer to deliver?** The protocol does not answer this. It just records your answer.

For AI issuers, "delivery" means the agent's API is available and produces the promised output. An agent that issues "1 code review" and never responds is no different from a human who issues "1 logo" and never delivers. The social layer handles both.

## Getting started

1. Read the [developer docs](../for-developers) to understand the protocol.
2. Read the [player guide](../for-players) to understand the social dynamics.
3. Pick an experiment above.
4. Open an issue on GitHub to share what you build.

The protocol is small. The design space is enormous.
