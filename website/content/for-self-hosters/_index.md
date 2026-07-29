---
title: For Self-Hosters
---

## Run your own bank in 10 minutes

A barter.game bank is just an HTTP server that holds an ed25519 key and enforces a few invariants. The reference implementation runs on Deno Deploy using Deno KV, but you can port it to any stack that meets the protocol contract.

## The Deno Deploy path (reference implementation)

This is the fastest way to get a live bank. It uses the same code that runs the live demo banks.

### Prerequisites

- [Deno](https://deno.com) installed (for key generation and the `deno deploy` CLI)
- A [Deno Deploy](https://deno.com/deploy) account

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/ai-1st/barter.game.git && cd barter.game

# 2. Generate a bank private key
deno run apps/bank/genkey.ts
#    Prints two lines — BANK_ALICE_PRIV_KEY=<base58> and the matching
#    BANK_ALICE_PUB_KEY. Keep the private key safe; the pubkey is shareable.

# 3. Point the deploy block in deno.json at your own project
#    "deploy": { "org": "<your-org>", "app": "<your-app>" }

# 4. Set the env vars in the Deno Deploy dashboard
#    BANK_ALICE_PRIV_KEY = <the key from step 2>
#    Add BANK_BOB_PRIV_KEY, BANK_CAROL_PRIV_KEY, etc. to serve more banks from the same project.

# 5. Deploy
deno deploy

# 6. Verify it's live
curl https://<your-app>.<your-org>.deno.net/alice/barter-bank.json
```

You now have a bank. Tell your friends about it. They open `<your-url>/<bank>/ui`, register, and you're a tiny central bank in a federation of exactly however many people you've invited.

{{< callout type="info" >}}
**Prefer deploy-on-push?** Link your fork to the app in the Deno Deploy dashboard and every push to `main` builds and ships automatically — no CI config or workflow file needed. That's how the reference banks at `barter-game-banks.ai-1st.deno.net` deploy; the `deno deploy` command above then becomes just the manual escape hatch.
{{< /callout >}}

## The "bring your own server" path

Don't want Deno Deploy? No problem. You need four things:

### 1. An HTTP server

Any language, any framework. You just need to handle:
- `POST /<name>/rpc` — the JSON-RPC envelope
- `GET /<name>/barter-bank.json` — bank identity discovery
- `GET /<name>/address/<pubkey>` — address directory reads (optional but recommended; Address docs are written via the `submit_docs` RPC)
- `GET /<name>/media/<hash>.<ext>` — content-addressed media blobs; public and immutable-cacheable, needed for voucher images and posts carrying media
- `POST /<name>/media` — authenticated blob upload, restricted to image types (`svg`, `png`, `jpg`, `jpeg`, `webp`, `gif`)

### 2. An ed25519 keypair

Generate it however you like. The private key stays on the server. The pubkey is your bank's identity.

### 3. Storage that enforces two invariants

- **Sum-to-zero:** For any Voucher, the sum of all account balances equals zero (or the limit).
- **One active hold per account:** No two in-flight transactions can lock the same debit account simultaneously.

Deno KV with atomic check-and-set is one way. Postgres with a partial unique index is another. SQLite with application-level locking works for smaller deployments. An in-memory store with mutexes works for demos.

### 4. The protocol handlers

Implement the methods in `protocol/bank-rpc.md`. The reference handlers in `apps/bank/handlers/` are a working example you can read and adapt.

## Security checklist

- [ ] **Pin your bank's pubkey everywhere.** Clients should store `{pubkey, url}` and reject `barter-bank.json` responses that diverge.
- [ ] **Backup your private key.** Lose it and every Voucher issued by your bank becomes orphaned.
- [ ] **Rate-limit RPC endpoints.** Even cheap verification adds up.
- [ ] **Don't expose your database directly.** The Deno Deploy process / server is the trust boundary.
- [ ] **Monitor the sum invariant.** Alert if it ever drifts.

## Federation

Your bank does not need permission from anyone to join the network. There is no central registry in v1. Clients discover you by:

1. Hardcoding your URL+pubkey in their config.
2. Receiving an invite string from one of your users.
3. Checking `/<name>/barter-bank.json` and comparing against a pinned pubkey.

In v1.5 we may add a federated directory. For now, word of mouth is the discovery mechanism — which is exactly right for the trust model.

## Read more

- [Protocol contract →](https://github.com/ai-1st/barter.game/blob/main/protocol/README.md)
- [Reference bank server →](https://github.com/ai-1st/barter.game/blob/main/apps/bank/README.md)
- [Reference web client →](https://github.com/ai-1st/barter.game/blob/main/apps/web/README.md)
- [Developer guide →](../for-developers)
