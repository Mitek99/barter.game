---
title: For Self-Hosters
---

## Run your own bank in 10 minutes

A barter.game bank is just an HTTP server that holds an ed25519 key and enforces a few invariants. The reference implementation runs on AWS — Lambda + DynamoDB + S3 behind CloudFront, deployed with SAM — but you can port it to any stack that meets the protocol contract.

## The AWS path (reference implementation)

This is the fastest way to get a live bank. It uses the same code that runs the live demo banks.

### Prerequisites

- An [AWS](https://aws.amazon.com) account
- The [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and the AWS CLI
- [Bun](https://bun.sh) installed (for the build and key generation)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/Mitek99/barter.game.git && cd barter.game
bun install

# 2. Generate a bank private key
bun run scripts/genkey.ts
#    Prints BANK_PRIV_KEY=<base58> and the matching BANK_PUB_KEY.
#    Keep the private key safe; the pubkey is shareable.

# 3. Put the bank key into SSM as a SecureString (one per bank)
aws ssm put-parameter --type SecureString --name /barter/banks/alice --value <base58-priv-key>

# 4. One-time per account: create the least-privilege deployer (as an admin)
cd apps/bank-aws
aws cloudformation deploy --template-file deployer-template.yaml \
  --stack-name barter-deployer --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CreateDeployerUser=true
#    This creates the app-deployer IAM user, the AppDeployerPolicy deploy
#    policy, and the AppDeployerBoundary permissions boundary every role it
#    creates must wear. See apps/bank-aws/README.md for the full model.

# 5. Deploy as the app-deployer user
AWS_PROFILE=app-deployer ./deploy.sh
#    = bun run build + sam deploy + sync of the web client to S3 + CloudFront
#    invalidation. First time you can also `bun run build` + `sam deploy --guided`.

# 6. Verify it's live — the stack outputs the CloudFront domain
curl https://<distribution>.cloudfront.net/alice/barter-bank.json
```

You now have a bank. Tell your friends about it. They open `https://<distribution>.cloudfront.net/alice/ui`, register, and you're a tiny central bank in a federation of exactly however many people you've invited. Add more banks by storing more keys under `/barter/banks/<name>` and redeploying — one Lambda serves every configured bank.

## The "bring your own server" path

Don't want AWS? No problem. You need four things:

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

DynamoDB conditional writes (the reference `KvStore` contract) are one way. Postgres with a partial unique index is another. SQLite with application-level locking works for smaller deployments. An in-memory store with mutexes works for demos.

### 4. The protocol handlers

Implement the methods in `protocol/bank-rpc.md`. The reference handlers in `packages/bank-core/src/handlers/` are a working example you can read and adapt.

## Security checklist

- [ ] **Pin your bank's pubkey everywhere.** Clients should store `{pubkey, url}` and reject `barter-bank.json` responses that diverge.
- [ ] **Backup your private key.** Lose it and every Voucher issued by your bank becomes orphaned.
- [ ] **Rate-limit RPC endpoints.** Even cheap verification adds up.
- [ ] **Don't expose your database directly.** The bank process (Lambda / server) is the trust boundary.
- [ ] **Monitor the sum invariant.** Alert if it ever drifts.

## Federation

Your bank does not need permission from anyone to join the network. There is no central registry in v1. Clients discover you by:

1. Hardcoding your URL+pubkey in their config.
2. Receiving an invite string from one of your users.
3. Checking `/<name>/barter-bank.json` and comparing against a pinned pubkey.

In v1.5 we may add a federated directory. For now, word of mouth is the discovery mechanism — which is exactly right for the trust model.

## Read more

- [Protocol contract →](https://github.com/ai-1st/barter.game/blob/main/protocol/README.md)
- [Reference bank server →](https://github.com/Mitek99/barter.game/blob/main/apps/bank-aws/README.md)
- [Reference web client →](https://github.com/ai-1st/barter.game/blob/main/apps/web/README.md)
- [Developer guide →](../for-developers)
