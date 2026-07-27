# barter.game web client

The reference web client: a build-less, framework-less vanilla-JS SPA that the
bank serves itself. There is no bundler, no transpiler, and no build step — the
files in this directory are exactly what the browser runs.

The contract this client implements is the [protocol](../../protocol/README.md)
([base](../../protocol/base.md), [bank-schema](../../protocol/bank-schema.md),
[bank-rpc](../../protocol/bank-rpc.md)). This app is *one possible client* —
anyone can build their own against the same protocol. How a client manages
keypairs (browser keystore, hardware token, paper) is deliberately outside the
protocol; the scheme below is this client's choice.

## How it is served

The bank ([`../bank/main.ts`](../bank/main.ts), [`../bank/ui.ts`](../bank/ui.ts))
hosts the SPA directly:

| Route | What it does |
|---|---|
| `GET /:bank/ui` | `308` redirect to `/:bank/ui/`. The trailing slash is load-bearing: scope matching for the service worker and the manifest is a plain string prefix, so the slashless URL sits outside its own app's scope and would never be installable |
| `GET /:bank/ui/` | Returns `index.html` with `<base href="/:bank/ui/">` injected into `<head>`, so the relative `app/…` asset refs resolve |
| `GET /:bank/ui/app/*` | Serves the static files from `apps/web/` (paths are relative to the bank process CWD — run the bank from the repo root) |
| `GET /:bank/ui/manifest.webmanifest` | The install manifest, generated per bank (`webManifest` in `../bank/ui.ts`) — `id`/`start_url`/`scope` all carry this bank's path prefix |
| `GET /:bank/ui/sw.js` | The service worker, served from the UI root so its scope covers the whole SPA |

The SPA derives the bank name from the first URL path segment and boots by
fetching the public `GET /:bank/ui/config` for the bank's pubkey and URL.

Runtime dependencies are pinned in an import map in `index.html` and loaded
from esm.sh (`@noble/ed25519` 3.1.0, `@noble/hashes` 2.2.0, `@scure/base`
2.2.0, `ulid` 2.3.0); fonts come from Google Fonts. Nothing is bundled, and the
app is **not offline-capable**.

## Installing it (home screen)

The SPA is installable as a PWA — one bank, one installed app. Each bank gets
its own manifest whose `scope` is `/:bank/ui/`, so an installed app is confined
to the bank it was installed from and a Barter Link to a *different* bank opens
in the browser, where it belongs.

The offer is made in-app rather than left to the browser menu:

- Chromium fires `beforeinstallprompt`; `app.js` captures it (suppressing
  Chrome's own mini-infobar) and shows a card on the welcome hero and the
  dashboard, plus an entry in `#/settings`. The button replays the captured
  event, which is single-use.
- WebKit never fires it, so on iOS/iPadOS the same card shows the two Share-sheet
  steps instead.
- Where neither applies (Firefox, desktop Safari) the banner stays hidden —
  Settings still explains where to look.
- "Not now" snoozes the banner for 30 days (`barter.install_snoozed` in
  `localStorage`); Settings is always available.

**`sw.js` caches nothing, by design.** Chromium only offers an install for a
page controlled by a service worker with a fetch handler that yields a response
while offline, so the worker handles exactly one case — top-level navigations,
answered from the network or, if that fails, with an inline "you're offline"
page — and declines to respond to everything else, leaving app code and the
signed API on their normal network path. Caching signed, per-user, time-
sensitive responses (or a stale client that verifies them) would trade a clear
offline message for silently wrong balances. Offline re-unlock from a cached
keystore blob is a separate, unbuilt feature (`docs/REVIEW.md` §18).

Icons: `icon.svg` is the source of truth (it mirrors the `.logo-mark` in
`styles.css`); the PNGs and `favicon.ico` are rendered from it, and the
full-bleed variants exist because Android masks icons and iOS rounds them.

## Key handling & security model

The bank is a **blind custodian**: it stores only an encrypted keystore blob
and never sees the password or the plaintext key.

- **Registration** (`#/register`): an ed25519 keypair is generated in the
  browser. The 32-byte seed is encrypted with PBKDF2-HMAC-SHA-256 (250,000
  iterations, random 16-byte salt) deriving an AES-256-GCM key (random 12-byte
  nonce). The client `POST`s `{handle, pubkey, keystore, proof}` to
  `/:bank/ui/register`, where `proof` is an ed25519 signature over the
  canonical form of `{handle, pubkey, keystore_sha256}` — proving possession
  of the private key and binding the keystore blob to the registration. See
  [WORKAROUNDS.md §1](../../WORKAROUNDS.md) for why PBKDF2 rather than
  Argon2id.
- **Login** (`#/unlock`): the encrypted keystore is fetched from the public
  `GET /:bank/ui/keystore/:handle` (bank rate-limits it to 5/min per handle),
  decrypted locally, and the pubkey derived from the seed must match the
  registered pubkey. There is no password recovery.
- **In memory only**: the decrypted key lives in a JS variable; `localStorage`
  keeps only the last handle used. **Auto-lock** wipes the key after 10
  minutes of inactivity (checked every 30 s).
- **Recovery kit** (`#/settings`): downloads
  `{handle, pubkey, bank, keystore}` as JSON — useful only with the password.
- **Barter Links**: landing pages fetch the `?format=json` envelope and verify
  **every** document signature client-side (`verifyDoc`) before rendering
  anything. A foreign bank's link resolves at its origin bank.

## Screens

Hash-routed; the whole router is one function in `app.js`.

| Route | Purpose |
|---|---|
| `#/` | Welcome hero (logged out) / dashboard: balances, quick actions, recent activity |
| `#/register`, `#/unlock` | Create account / log in with handle + password |
| `#/connect` | Import a raw 32-byte base58 seed |
| `#/vouchers`, `#/vouchers/new` | List and create own vouchers; share profile QR |
| `#/orders`, `#/orders/new`, `#/orders/new/:voucher` | List orders; author a two-sided swap order. The `:voucher` form arrives from a post's "Trade for this" with that voucher preselected as what you receive |
| `#/invoices`, `#/invoices/new` | Credit-only orders (requests for payment) with shareable QR |
| `#/cheques`, `#/cheques/new` | Debit-only orders with shareable QR |
| `#/discover` | Poll known banks for published offers; accept one into a deal |
| `#/posts`, `#/posts/:voucher` | Voucher post feeds. Each post offers Reply, Repost, Follow author, and **Trade for this** — which trusts the voucher's issuer (pinning their bank if foreign) and opens a swap preloaded with it. An issuer composing about their own voucher can tick "update this voucher's look" to release a new icon/square SVG and description. Issuer SVGs render as `data:` URIs inside `<img>`, never inlined, so embedded scripts cannot run. Merges `list_posts` across every trusted author x known bank, newest-first, de-duplicated by content hash; compose, reply and repost; every post's signature tree is verified client-side before it renders |
| `#/deal/:id` | Deal status with per-leg ready/hold/settle; re-polls every 3 s until settled/rejected |
| `#/activity` | Transaction history |
| `#/network` | Following (feed subscriptions, incl. your bank), trusted issuers (with free-text notes), pinned banks, contacts |
| `#/scan` | Camera QR scanner (BarcodeDetector, jsQR fallback) or paste a link |
| `#/settings` | Identity, bank info, install on home screen, recovery kit, lock |
| `#/land/:kind/:value` | Barter Link landings (`i` profile, `v` invoice, `q` cheque, `o` offer, `x` invite) — work logged out, then resume the action after register/login |

Order/invoice/cheque forms use a **voucher chooser** (own issued vouchers plus
trusted issuers' vouchers resolved via the public `GET /:bank/ui/resolve/:pubkey`)
instead of raw hash pasting.

## Transports

Two signed channels, both authenticated by the user's ed25519 key:

1. **JSON-RPC** — `POST /:bank/rpc` with a signed envelope
   `{jsonrpc, id, method, params, pubkey, to, sig}`. This is the protocol
   surface ([bank-rpc](../../protocol/bank-rpc.md)).
2. **Signed REST** — `/:bank/ui/*` with an `X-Barter-Auth` header:
   `base64url(canonical authdoc) + "." + base58 signature`, where the authdoc
   is `{pubkey, method, path, id, ts, body_sha256}` (`path` includes the query
   string). The bank checks method/path match, ±120 s timestamp skew, a
   single-use `id` (replay protection), and the body hash.

Note: `/:bank/ui/*` (state, portfolio, history, orders, discover,
propose_deal, deal status, trusted/banks/contacts, keystore) is this bank's
**custom API layer** for its own client — an implementation detail, not part
of the protocol contract.

## Files

| File | What it is |
|---|---|
| `index.html` | Shell + import map + icon/manifest links; `<base>` is injected at serve time |
| `app.js` | The entire app: router, screens, transports, keystore crypto, install offer |
| `styles.css` | All styling |
| `sw.js` | Service worker: installability + offline page, no caching |
| `icon.svg` | The app mark — source artwork for every raster icon below |
| `favicon.ico` | 16/32/48 favicon, rendered from `icon.svg` |
| `icon-192.png`, `icon-512.png` | Manifest icons (`purpose: any`) |
| `icon-maskable-512.png` | Full-bleed manifest icon (`purpose: maskable`) for Android's icon mask |
| `apple-touch-icon.png` | 180×180 opaque home-screen icon for iOS |
| `protocol.js` | **Vendored** JS build of [`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts) — not imported from the workspace |
| `qr.js` | QR generation (ECC level M) and camera scanning |
| `vendor/qrcode.js` | qrcode-generator 1.5.0 (MIT), UMD → ESM |
| `vendor/jsqr.js` | jsQR 1.4.0 (Apache-2.0), UMD → ESM |

**Regenerating `protocol.js` is a manual step.** When the protocol package
changes: `npx tsc -p tsconfig.web.json` from `packages/protocol/` emits
`apps/web/index.js`; rename it to `protocol.js` and review the diff. No script
automates this, so the file can drift — treat protocol-package changes as
incomplete until this mirror is refreshed.

## Developing

There is no build step, and no meaningful standalone dev server — nearly every
screen needs the bank API. Run the bank from the repo root and let it serve
the SPA:

```sh
deno run apps/bank/genkey.ts   # prints a fresh BANK_..._PRIV_KEY line
BANK_ALICE_PRIV_KEY=<base58 seed> \
  deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv \
  apps/bank/main.ts
```

Open `http://localhost:8000/alice/ui`. The bank name comes from the env var
(`BANK_FOO_BAR_PRIV_KEY` → bank `foo-bar`); set several vars to run a local
federation on one port. Files are read from disk per request — edit and reload.

## Known gaps

- The deal screen's **"Relay signatures" button is a placeholder**: it posts
  empty `record_hashes` with `from` = `to` = the user's own bank, so it never
  relays anything.
- **Cross-bank order submission from `#/orders/new` is unfinished**: the order
  is only submitted to the user's own bank even when the credit voucher lives
  at another bank. Cross-bank deals work via the discover/landing accept paths,
  where the counterparty bank is known.
- The **voucher create form has no `expires` field**, although the protocol
  `Voucher` schema supports an optional `expires`.
- `#/cheques` is a stub that points at the Orders tab; only `#/cheques/new`
  does real work.
- Keystore KDF is PBKDF2, not Argon2id ([WORKAROUNDS.md §1](../../WORKAROUNDS.md)).
