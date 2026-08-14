---
title: For Developers
---

## Build your own implementation

The barter.game protocol is intentionally small. You can read the full contract in an afternoon. The reference implementation is TypeScript on AWS (Lambda + DynamoDB + CloudFront), but **the protocol does not care what language or stack you use**.

## The invariant contract

**Read [the `protocol/` spec](https://github.com/ai-1st/barter.game/blob/main/protocol/README.md) first.** It defines:

- The document types: Voucher, Account, Order, Mandate, Record, Offer, Signature, Address, Post — Records are bank-minted and identified by ULID; posts, reposts, and media refs are specified in [`protocol/post-feed.md`](https://github.com/ai-1st/barter.game/blob/main/protocol/post-feed.md)
- RFC 8785 canonical JSON (cross-runtime parity is load-bearing)
- ed25519 signatures over SHA-256 hashes
- The JSON-RPC envelope and replay protection
- Coordinator-orchestrated approval: each holder signs their own Order (`lead`/`follow`), a coordinator creates the records and clears each Order with a signed Mandate, and the banks self-advance with a lead-first settle cascade
- The state machine (created → approved → held → settled / rejected)
- The concurrency invariants (sum-to-zero, one active hold per account)

Everything in that file is the contract. Change it and you are no longer speaking barter.game v1.

## What you CAN change

| Layer | Reference choice | Your choice |
|---|---|---|
| Language | TypeScript | Rust, Go, Python, Zig, whatever |
| Runtime | Node.js (AWS Lambda) | Bun, Rust Axum, Go net/http, Python FastAPI |
| Database | DynamoDB single-table | SQLite, Postgres, CockroachDB, custom WAL |
| Client | Web UI (browser SPA, `apps/web`) | CLI, mobile app, Telegram bot, AI agent loop |
| Key storage | Plaintext JSON | Encrypted keystore, hardware wallet, OS keychain |
| Inbox | 10s polling | WebSocket, SSE, push, email |
| Hosting | AWS (Lambda + CloudFront) | VPS, Fly, Cloudflare, home server |

See [the reference implementation notes](https://github.com/Mitek99/barter.game/blob/main/apps/bank-aws/README.md) for how the reference team made each choice and what alternatives you might consider.

## Quickstart checklist

If you're building a bank from scratch:

1. [ ] Implement RFC 8785 canonical JSON. Verify cross-runtime parity.
2. [ ] Implement ed25519 sign/verify and SHA-256. Use audited libraries.
3. [ ] Define the doc types and their validators.
4. [ ] Build the JSON-RPC envelope handler with replay protection.
5. [ ] Implement `submit_docs`, `create_records`, `submit_mandate`, `notify_signatures`, `get_record_signatures`, and the read methods (`get_voucher`, `get_account_balance`, `list_accounts`, `list_offers`, `list_vouchers`, `get_offer`, `get_invoice`, `get_cheque`, `list_posts`, `get_post`, `get_post_signatures`, `get_voucher_meta`, …).
6. [ ] Implement the advance engine: records self-advance created → approved → held → settled, evaluated on every incoming signature.
7. [ ] Enforce **sum-to-zero** on every settle.
8. [ ] Enforce **at most one active hold per account**.
9. [ ] Expose `GET /<name>/barter-bank.json` (and `GET /<name>/address/<pubkey>` if you want an address directory).
10. [ ] Write a client that can run a trade end-to-end (publish Orders → discover Offers → create records → mandate → banks settle), bilateral or N-party.
11. [ ] Run it against the reference banks to verify interop.

## The protocol library

The reference `packages/protocol/` is MIT-licensed, dependency-light, and a **single source file** — `src/index.ts`. It runs under Bun, Node, and browser. You can import it directly or treat it as the spec to port:

| Piece (all in `src/index.ts`) | What to port |
|---|---|
| Canonicalizer | RFC 8785 canonical JSON. **Must be byte-identical.** |
| Crypto | ed25519 + SHA-256 + base58. Thin wrappers; easy to replicate. |
| Doc types + validators | Voucher, Account, Order, Mandate, Record, Offer, Signature, Address, Post. Replicate in your type system of choice. |

## Read more

- [Invariant protocol contract →](https://github.com/ai-1st/barter.game/blob/main/protocol/README.md)
- [Reference bank server →](https://github.com/Mitek99/barter.game/blob/main/apps/bank-aws/README.md)
- [Reference web client →](https://github.com/ai-1st/barter.game/blob/main/apps/web/README.md)
- [Source code →](https://github.com/ai-1st/barter.game/tree/main/packages/protocol)
