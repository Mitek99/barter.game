#!/usr/bin/env bun
// Generate a fresh ed25519 keypair for a bank. Prints:
//   PRIV_KEY=<base58-32-bytes>
//   PUB_KEY=<base58-32-bytes>
//
// Use to bootstrap a new bank: rename the PRIV_KEY line to
// BANK_<NAME>_PRIV_KEY and set it as an env var (locally), or store it as
// an SSM SecureString under /barter/banks/<name> for the AWS host.
//
// Never commit the resulting private key.

import { base58Encode, genKeyPair } from "../packages/protocol/src/index.ts";

const { privateKey, publicKey } = genKeyPair();
process.stdout.write(`BANK_PRIV_KEY=${base58Encode(privateKey)}\n`);
process.stdout.write(`BANK_PUB_KEY=${base58Encode(publicKey)}\n`);
