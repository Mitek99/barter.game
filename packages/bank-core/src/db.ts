import type {
  Account,
  Address,
  Base58PubKey,
  Base58SHA256,
  Mandate,
  Offer,
  Order,
  Post,
  BankRecord,
  Signature,
  ULID,
  Voucher,
} from '@barter.game/protocol';
import { hashDoc } from '@barter.game/protocol';
import type { Bank } from './types.ts';
import type { KvKey, KvKeyPart, KvListSelector } from './kv.ts';
import { sha256Base58Bytes, type MediaMeta } from './media.ts';
export { MEDIA_MAX_BYTES, type MediaMeta } from './media.ts';

const REPLAY_WINDOW_MS = 1000 * 60 * 60 * 24; // 24h

// --- key builders ---------------------------------------------------------

// Storage schema version. Every index below is keyed by content hash, so a
// change to the content-addressing rule relocates ALL of them at once. Bumping
// this moves the whole namespace instead of leaving pre-change rows to be
// half-read under post-change hashes — which fails silently (settled deals
// rendering as `created`, holds stranded, usage counters reset) rather than
// loudly. Old rows stay in KV, inert and invisible; no destructive wipe needed.
//
// v2: hashDoc now hashes canonical(doc minus top-level `sig`) — the same
//     preimage the signature commits to (`protocol/base.md` §2.1). Every doc
//     hash changed, so every key changed.
const SCHEMA = 'v2';

function k(bank: Bank, ...parts: KvKeyPart[]): KvKey {
  return [bank.pubkey, SCHEMA, ...parts];
}

// --- generic docs ---------------------------------------------------------

export async function storeDoc(
  bank: Bank,
  doc: unknown,
): Promise<Base58SHA256> {
  const h = hashDoc(doc);
  await bank.kv.set(k(bank, 'doc', h), doc);
  return h;
}

export async function getDoc<T = unknown>(
  bank: Bank,
  hash: Base58SHA256,
): Promise<T | null> {
  const r = await bank.kv.get<T>(k(bank, 'doc', hash));
  return r.value;
}

export async function hasDoc(
  bank: Bank,
  hash: Base58SHA256,
): Promise<boolean> {
  const r = await bank.kv.get(k(bank, 'doc', hash));
  return r.value !== null;
}

// --- vouchers -------------------------------------------------------------

export async function storeVoucher(
  bank: Bank,
  voucher: Voucher,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, voucher);
  await bank.kv.set(k(bank, 'voucher', h), { stored_at: Date.now() });
  await bank.kv.set(k(bank, 'issuer_voucher', voucher.pubkey, h), true);
  return h;
}

// The doc store is one flat content-addressed namespace shared by every type,
// so a hash must be type-checked before it is treated as a Voucher — otherwise
// any signed doc (an Address, say) can pose as one, and the issuer/limit gates
// that key off `voucher.pubkey` read a field that means something else.
export async function getVoucher(
  bank: Bank,
  hash: Base58SHA256,
): Promise<Voucher | null> {
  const doc = await getDoc<Record<string, unknown>>(bank, hash);
  if (!doc || doc.type !== 'voucher') return null;
  return doc as unknown as Voucher;
}

export async function listVouchers(bank: Bank): Promise<Voucher[]> {
  const iter = bank.kv.list<{ stored_at: number }>({
    prefix: k(bank, 'voucher'),
  });
  const out: Voucher[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const v = await getVoucher(bank, hash);
    if (v) out.push(v);
  }
  return out;
}

export async function listVouchersByIssuer(
  bank: Bank,
  issuer: Base58PubKey,
): Promise<Voucher[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'issuer_voucher', issuer),
  });
  const out: Voucher[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const v = await getVoucher(bank, hash);
    if (v) out.push(v);
  }
  return out;
}

// --- accounts -------------------------------------------------------------

export type AccountRow = {
  holder: Base58PubKey;
  voucher: Base58SHA256;
  balance: number;
  ulid: ULID;
};

export async function storeAccount(
  bank: Bank,
  account: Account,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, account);
  // An Account doc is content-addressed and immutable, so re-submitting one is
  // a legitimate no-op — but it MUST NOT reset the ledger. Writing balance: 0
  // unconditionally let anyone wipe their own (possibly negative) position by
  // re-sending the same signed doc, breaking the per-voucher sum invariant.
  const existing = await bank.kv.get<AccountRow>(k(bank, 'account', h));
  const row: AccountRow = {
    holder: account.pubkey,
    voucher: account.voucher,
    balance: existing.value?.balance ?? 0,
    ulid: account.ulid,
  };
  await bank.kv.set(k(bank, 'account', h), row);
  await bank.kv.set(
    k(bank, 'holder_account', account.pubkey, account.voucher, h),
    true,
  );
  return h;
}

export async function getAccount(
  bank: Bank,
  hash: Base58SHA256,
): Promise<{ doc: Account; row: AccountRow } | null> {
  const doc = await getDoc<unknown>(bank, hash);
  if (!doc) return null;
  const row = await bank.kv.get<AccountRow>(k(bank, 'account', hash));
  if (!row.value) return null;
  return { doc: doc as Account, row: row.value };
}

export async function listAccounts(
  bank: Bank,
  holder: Base58PubKey,
): Promise<{ account: Account; voucher: Voucher | null; balance: number }[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'holder_account', holder),
  });
  const out: { account: Account; voucher: Voucher | null; balance: number }[] =
    [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const a = await getAccount(bank, hash);
    if (!a) continue;
    const voucher = await getVoucher(bank, a.doc.voucher);
    out.push({ account: a.doc, voucher, balance: a.row.balance });
  }
  return out;
}

export async function getAccountBalance(
  bank: Bank,
  accountHash: Base58SHA256,
): Promise<{ current: number; pending: number } | null> {
  const a = await getAccount(bank, accountHash);
  if (!a) return null;
  const holds = await listHoldsForAccount(bank, accountHash);
  const pending = holds.reduce((sum, h) => sum + h.amount, 0);
  return { current: a.row.balance, pending };
}

export async function updateAccountBalance(
  bank: Bank,
  accountHash: Base58SHA256,
  delta: number,
): Promise<void> {
  const key = k(bank, 'account', accountHash);
  const r = await bank.kv.get<AccountRow>(key);
  if (!r.value) throw new Error('account not found');
  const ok = await bank.kv
    .atomic()
    .check(r)
    .set(key, { ...r.value, balance: r.value.balance + delta })
    .commit();
  if (!ok.ok) throw new Error('account balance conflict');
}

// --- orders ---------------------------------------------------------------

export async function storeOrder(
  bank: Bank,
  order: Order,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, order);
  await bank.kv.set(k(bank, 'order', h), { stored_at: Date.now() });
  await bank.kv.set(k(bank, 'holder_order', order.pubkey, h), true);
  return h;
}

export async function getOrder(
  bank: Bank,
  hash: Base58SHA256,
): Promise<Order | null> {
  const doc = await getDoc<Record<string, unknown>>(bank, hash);
  if (!doc) return null;
  if (doc.type !== 'order') return null;
  return doc as Order;
}

export async function listOrdersByHolder(
  bank: Bank,
  holder: Base58PubKey,
): Promise<Order[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'holder_order', holder),
  });
  const out: Order[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const o = await getOrder(bank, hash);
    if (o) out.push(o);
  }
  return out;
}

export async function getOrderUsage(
  bank: Bank,
  orderHash: Base58SHA256,
): Promise<{ debit: number; credit: number }> {
  const r = await bank.kv.get<{ debit: number; credit: number }>(
    k(bank, 'order_usage', orderHash),
  );
  return r.value ?? { debit: 0, credit: 0 };
}

export async function addOrderUsage(
  bank: Bank,
  orderHash: Base58SHA256,
  debit: number,
  credit: number,
): Promise<void> {
  const key = k(bank, 'order_usage', orderHash);
  const r = await bank.kv.get<{ debit: number; credit: number }>(key);
  const cur = r.value ?? { debit: 0, credit: 0 };
  const ok = await bank.kv
    .atomic()
    .check(r)
    .set(key, { debit: cur.debit + debit, credit: cur.credit + credit })
    .commit();
  if (!ok.ok) throw new Error('order usage conflict');
}

// --- offers ---------------------------------------------------------------

export async function storeOffer(
  bank: Bank,
  offer: Offer,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, offer);
  await bank.kv.set(k(bank, 'offer', h), { stored_at: Date.now() });
  await bank.kv.set(k(bank, 'order_offer', offer.order, h), true);
  // index by voucher + intention
  if (offer.debit) {
    await bank.kv.set(
      k(bank, 'voucher_offer', offer.debit.voucher, 'sell', h),
      true,
    );
  }
  if (offer.credit) {
    await bank.kv.set(
      k(bank, 'voucher_offer', offer.credit.voucher, 'buy', h),
      true,
    );
  }
  return h;
}

export async function getOffersForOrder(
  bank: Bank,
  orderHash: Base58SHA256,
): Promise<Base58SHA256[]> {
  const iter = bank.kv.list<boolean>({ prefix: k(bank, 'order_offer', orderHash) });
  const out: Base58SHA256[] = [];
  for await (const entry of iter) {
    out.push(entry.key[entry.key.length - 1] as string);
  }
  return out;
}

export async function getOffer(
  bank: Bank,
  hash: Base58SHA256,
): Promise<Offer | null> {
  const doc = await getDoc<Record<string, unknown>>(bank, hash);
  if (!doc) return null;
  if (doc.type !== 'offer') return null;
  return doc as Offer;
}

export async function listOffers(
  bank: Bank,
  voucherHash: Base58SHA256,
  intention: 'sell' | 'buy',
): Promise<Offer[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'voucher_offer', voucherHash, intention),
  });
  const out: Offer[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const o = await getOffer(bank, hash);
    if (o) out.push(o);
  }
  return out;
}

// --- records --------------------------------------------------------------

export type RecordRow = {
  doc: BankRecord;
  details: {
    pair: ULID;
    deal_id: ULID;
    coordinator: Base58PubKey;
    holder: Base58PubKey;
    account: Base58SHA256;
  };
};

// Idempotency marker for create_records: one record pair per
// (deal_id, giver order, receiver order). A repeated call with identical
// terms returns the original pair; different terms are rejected.
export type DealPairRow = {
  records: Base58SHA256[];
  amount: number;
  counter_amount: number;
};

export async function getDealPair(
  bank: Bank,
  dealId: ULID,
  giver: Base58SHA256,
  receiver: Base58SHA256,
): Promise<DealPairRow | null> {
  const r = await bank.kv.get<DealPairRow>(
    k(bank, 'deal_pair', dealId, giver, receiver),
  );
  return r.value;
}

export async function storeDealPair(
  bank: Bank,
  dealId: ULID,
  giver: Base58SHA256,
  receiver: Base58SHA256,
  row: DealPairRow,
): Promise<void> {
  await bank.kv.set(k(bank, 'deal_pair', dealId, giver, receiver), row);
}

export async function storeRecord(
  bank: Bank,
  record: BankRecord,
  details: RecordRow['details'],
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, record);
  await bank.kv.set(k(bank, 'record', h), { doc: record, details });
  await bank.kv.set(k(bank, 'deal_record', details.deal_id, h), true);
  await bank.kv.set(k(bank, 'account_record', details.account, h), true);
  return h;
}

export async function getRecord(
  bank: Bank,
  hash: Base58SHA256,
): Promise<RecordRow | null> {
  const r = await bank.kv.get<RecordRow>(k(bank, 'record', hash));
  return r.value;
}

/**
 * Hashes of records that touched an account, via the account_record index.
 * `limit` is passed down to the store so a caller that only needs a page
 * does not drag the whole index across the wire.
 */
export async function listRecordHashesByAccount(
  bank: Bank,
  accountHash: Base58SHA256,
  limit?: number,
): Promise<Base58SHA256[]> {
  const iter = bank.kv.list<boolean>(
    { prefix: k(bank, 'account_record', accountHash) },
    limit === undefined ? undefined : { limit },
  );
  const out: Base58SHA256[] = [];
  for await (const entry of iter) {
    out.push(entry.key[entry.key.length - 1] as string);
  }
  return out;
}

export async function listRecordsByDeal(
  bank: Bank,
  dealId: ULID,
): Promise<RecordRow[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'deal_record', dealId),
  });
  const out: RecordRow[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const r = await getRecord(bank, hash);
    if (r) out.push(r);
  }
  return out;
}

export async function listRecordsByVoucher(
  bank: Bank,
  voucherHash: Base58SHA256,
): Promise<RecordRow[]> {
  // Heuristic: scan all records and filter by voucher via the underlying order.
  const iter = bank.kv.list<RecordRow>({ prefix: k(bank, 'record') });
  const out: RecordRow[] = [];
  for await (const entry of iter) {
    const row = entry.value;
    const order = await getOrder(bank, row.doc.order);
    const side =
      row.doc.type === 'debit' ? order?.debit : order?.credit;
    if (side && side.voucher === voucherHash) out.push(row);
  }
  return out;
}

// --- holds ----------------------------------------------------------------

export type Hold = {
  account: Base58SHA256;
  deal_id: ULID;
  amount: number;
};

export async function listHoldsForAccount(
  bank: Bank,
  accountHash: Base58SHA256,
): Promise<Hold[]> {
  const iter = bank.kv.list<number>({
    prefix: k(bank, 'hold', accountHash),
  });
  const out: Hold[] = [];
  for await (const entry of iter) {
    const dealId = entry.key[entry.key.length - 1] as string;
    out.push({ account: accountHash, deal_id: dealId, amount: entry.value });
  }
  return out;
}

export async function getActiveHold(
  bank: Bank,
  accountHash: Base58SHA256,
): Promise<Hold | null> {
  const r = await bank.kv.get<Hold>(k(bank, 'active_hold', accountHash));
  return r.value;
}

/**
 * Acquire an aggregated hold for a single account+deal. Rejects if the
 * account is already held by a different external deal.
 */
export async function acquireHold(
  bank: Bank,
  accountHash: Base58SHA256,
  dealId: ULID,
  amount: number,
): Promise<boolean> {
  const activeKey = k(bank, 'active_hold', accountHash);
  const holdKey = k(bank, 'hold', accountHash, dealId);
  const r = await bank.kv.get<Hold>(activeKey);
  if (r.value && r.value.deal_id !== dealId) {
    return false;
  }
  const ok = await bank.kv
    .atomic()
    .check(r)
    .set(activeKey, { account: accountHash, deal_id: dealId, amount })
    .set(holdKey, amount)
    .commit();
  return ok.ok === true;
}

export async function releaseHold(
  bank: Bank,
  accountHash: Base58SHA256,
  dealId: ULID,
): Promise<void> {
  const activeKey = k(bank, 'active_hold', accountHash);
  const holdKey = k(bank, 'hold', accountHash, dealId);
  const r = await bank.kv.get<Hold>(activeKey);
  const atomic = bank.kv.atomic().delete(holdKey);
  if (r.value && r.value.deal_id === dealId) {
    atomic.delete(activeKey);
  }
  await atomic.commit();
}

// --- mandates -------------------------------------------------------------
// Mandates are the per-(deal, order) unit of work. Stored under
// (deal_id, order) so the advance engine can check whether a given record's
// Order has been cleared, and so duplicate mandates for the same (deal, order)
// are rejected.

export type MandateRow = {
  hash: Base58SHA256;
  order: Base58SHA256;
  coordinator: Base58PubKey;
  records: Base58SHA256[];
  at: number;
};

export async function storeMandate(
  bank: Bank,
  mandate: Mandate,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, mandate);
  const row: MandateRow = {
    hash: h,
    order: mandate.order,
    coordinator: mandate.pubkey,
    records: mandate.records,
    at: Date.now(),
  };
  await bank.kv.set(k(bank, 'mandate', mandate.deal_id, mandate.order), row);
  return h;
}

export async function getMandate(
  bank: Bank,
  dealId: ULID,
  order: Base58SHA256,
): Promise<MandateRow | null> {
  const r = await bank.kv.get<MandateRow>(k(bank, 'mandate', dealId, order));
  return r.value;
}

// --- signatures -----------------------------------------------------------

export async function storeSignature(
  bank: Bank,
  sig: Signature,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, sig);
  if (sig.hash) {
    await bank.kv.set(k(bank, 'record_sig', sig.hash, h), true);
    // The same Signature shape carries post endorsements. Index under post_sig
    // only when the target really is a stored Post, so the record index keeps
    // its exact previous shape and we don't mirror every ledger signature into
    // a second namespace. Endorsements necessarily accrue AFTER the immutable
    // post exists (post-feed.md §3), so the post is already stored by then.
    if (await getPost(bank, sig.hash)) {
      await bank.kv.set(k(bank, 'post_sig', sig.hash, h), true);
    }
  }
  return h;
}

// --- media blobs ----------------------------------------------------------
// Blob storage lives behind the MediaStore interface (media.ts) — chunked KV
// on Deno, S3 on AWS. These wrappers keep the bank-scoped call shape the
// handlers use.

export async function hasMedia(
  bank: Bank,
  hash: Base58SHA256,
): Promise<boolean> {
  return bank.media.has(bank.pubkey, hash);
}

/** Store a blob and return its sha256 (base58). Re-storing the same bytes is a no-op. */
export async function storeMedia(
  bank: Bank,
  bytes: Uint8Array,
  contentType: string,
): Promise<Base58SHA256> {
  const hash = await sha256Base58Bytes(bytes);
  await bank.media.put(bank.pubkey, hash, bytes, contentType);
  return hash;
}

export async function getMedia(
  bank: Bank,
  hash: Base58SHA256,
): Promise<{ bytes: Uint8Array; meta: MediaMeta } | null> {
  return bank.media.get(bank.pubkey, hash);
}

// --- posts ----------------------------------------------------------------

/**
 * ULIDs sort ascending lexicographically, but feeds are read newest-first.
 * Deno KV has no per-query reverse for `list` bounds we can seek into cheaply
 * across two prefixes, so posts are keyed by an INVERTED ULID: each Crockford
 * base32 character is mapped to its complement, turning "newest last" into
 * "newest first" under a plain ascending scan (post-feed.md §8).
 *
 * The inversion is its own inverse, so the same function decodes.
 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function invertUlid(u: ULID): string {
  let out = '';
  for (const ch of u.toUpperCase()) {
    const i = ULID_ALPHABET.indexOf(ch);
    out += i < 0 ? ch : ULID_ALPHABET[ULID_ALPHABET.length - 1 - i];
  }
  return out;
}

export async function storePost(
  bank: Bank,
  post: Post,
): Promise<Base58SHA256> {
  const h = await storeDoc(bank, post);
  const inv = invertUlid(post.ulid);
  // Two indexes, both newest-first: the author's whole feed, and the author's
  // feed filtered to one voucher.
  await bank.kv.set(k(bank, 'post_by_author', post.pubkey, inv), h);
  await bank.kv.set(
    k(bank, 'post_by_author_voucher', post.pubkey, post.voucher, inv),
    h,
  );
  return h;
}

export async function getPost(
  bank: Bank,
  hash: Base58SHA256,
): Promise<Post | null> {
  const doc = await getDoc<unknown>(bank, hash);
  if (!doc || (doc as { type?: string }).type !== 'post') return null;
  return doc as Post;
}

/**
 * Newest-first page of an author's posts, optionally filtered to one voucher.
 *
 * `before` is a plain ULID cursor: only posts strictly older than it are
 * returned. Because keys are inverted, "older than" is "lexicographically
 * after" — so the scan starts just past the inverted cursor.
 */
export async function listPosts(
  bank: Bank,
  author: Base58PubKey,
  voucherHash: Base58SHA256 | 'all',
  before: ULID | undefined,
  limit: number,
): Promise<{ items: Post[]; next_before?: ULID }> {
  const prefix = voucherHash === 'all'
    ? k(bank, 'post_by_author', author)
    : k(bank, 'post_by_author_voucher', author, voucherHash);

  // `start` is inclusive, so a cursored page can re-see the cursor key itself;
  // it is dropped explicitly below rather than by appending a sentinel char.
  const selector: KvListSelector = before
    ? { prefix, start: [...prefix, invertUlid(before)] }
    : { prefix };
  const cursorKey = before ? invertUlid(before) : null;

  // Read one key beyond the page to learn whether more exist (plus one slot for
  // the possibly-echoed cursor), then resolve bodies. Counting KEYS rather than
  // resolved bodies keeps the "more" signal honest if a body has gone missing.
  const hashes: Base58SHA256[] = [];
  const iter = bank.kv.list<Base58SHA256>(selector, { limit: limit + 2 });
  for await (const entry of iter) {
    if (cursorKey && entry.key[entry.key.length - 1] === cursorKey) continue;
    hashes.push(entry.value);
  }

  const more = hashes.length > limit;
  const items: Post[] = [];
  for (const h of hashes.slice(0, limit)) {
    const post = await getPost(bank, h);
    if (post) items.push(post);
  }
  const last = items[items.length - 1];
  return more && last ? { items, next_before: last.ulid } : { items };
}

/**
 * The current presentation of a voucher, derived from its issuer's newest
 * meta-release post (post-feed.md). Cached here so a client needs one read
 * instead of scanning the issuer's whole feed for the latest release.
 *
 * `ulid` is the releasing post's ULID and is the ordering key: a release only
 * wins if it is newer than what is stored, so posts arriving out of order
 * (relayed, or replayed from another bank) cannot roll the meta backwards.
 */
export type VoucherMeta = {
  voucher: Base58SHA256;
  /** MediaRef "<hash>.<ext>" — the canonical form; blobs live in the vault. */
  icon?: string;
  square?: string;
  /** @deprecated inline SVG from releases that predate media refs. */
  icon_svg?: string;
  square_svg?: string;
  description_md?: string;
  ulid: ULID;
  post: Base58SHA256;
  at: number;
};

export async function getVoucherMeta(
  bank: Bank,
  voucherHash: Base58SHA256,
): Promise<VoucherMeta | null> {
  const r = await bank.kv.get<VoucherMeta>(k(bank, 'voucher_meta', voucherHash));
  return r.value;
}

/** Store a release only if it is newer than the one already cached. */
export async function putVoucherMeta(
  bank: Bank,
  meta: VoucherMeta,
): Promise<boolean> {
  const key = k(bank, 'voucher_meta', meta.voucher);
  const current = await bank.kv.get<VoucherMeta>(key);
  if (current.value && current.value.ulid >= meta.ulid) return false;
  const ok = await bank.kv.atomic().check(current).set(key, meta).commit();
  return ok.ok;
}

export async function getSignaturesForPost(
  bank: Bank,
  postHash: Base58SHA256,
): Promise<Signature[]> {
  const iter = bank.kv.list<boolean>({ prefix: k(bank, 'post_sig', postHash) });
  const out: Signature[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const s = await getDoc<unknown>(bank, hash);
    if (s) out.push(s as Signature);
  }
  return out;
}

export async function getSignaturesForRecord(
  bank: Bank,
  recordHash: Base58SHA256,
): Promise<Signature[]> {
  const iter = bank.kv.list<boolean>({
    prefix: k(bank, 'record_sig', recordHash),
  });
  const out: Signature[] = [];
  for await (const entry of iter) {
    const hash = entry.key[entry.key.length - 1] as string;
    const s = await getDoc<unknown>(bank, hash);
    if (s) out.push(s as Signature);
  }
  return out;
}

// --- addresses ------------------------------------------------------------

export async function storeAddress(bank: Bank, addr: Address): Promise<void> {
  await storeDoc(bank, addr);
  const key = k(bank, 'address', addr.pubkey);
  const existing = await bank.kv.get<Address>(key);
  if (!existing.value || addr.ulid > existing.value.ulid) {
    await bank.kv.set(key, addr);
  }
}

export async function getAddress(
  bank: Bank,
  pubkey: Base58PubKey,
): Promise<Address | null> {
  const r = await bank.kv.get<Address>(k(bank, 'address', pubkey));
  return r.value;
}

// --- replay window --------------------------------------------------------

export async function claimReplayId(
  bank: Bank,
  sender: Base58PubKey,
  id: ULID,
  to: Base58PubKey,
): Promise<boolean> {
  const key = k(bank, 'replay', sender, id, to);
  const existing = await bank.kv.get(key);
  if (existing.value !== null) return false;
  const ok = await bank.kv
    .atomic()
    .check(existing)
    .set(key, Date.now(), { expireIn: REPLAY_WINDOW_MS })
    .commit();
  return ok.ok === true;
}

// --- UI state -------------------------------------------------------------

export type UiState = {
  pubkey: Base58PubKey;
  // Trusted issuers. Legacy entries may be bare pubkey strings; current entries
  // carry an optional user note ("met at the train station, seemed OK"). Read
  // through normTrustedIssuers() in the UI layer, which normalizes both shapes.
  trusted: (Base58PubKey | { pubkey: Base58PubKey; note?: string; at?: number })[];
  /**
   * Authors whose posts appear in this user's feed. Deliberately SEPARATE from
   * `trusted`: trusting an issuer is a financial judgement (I will accept this
   * promise as money), following is an editorial one (I want to read them).
   * Conflating them meant you could not read someone without vouching for
   * their currency — and a new user who had done neither saw an empty app.
   *
   * `undefined` means "never set", which resolveFollows() migrates rather than
   * treating as "follows nobody" — see below.
   */
  follows?: Base58PubKey[];
  contacts: { pubkey: Base58PubKey; handle?: string; note?: string }[];
  banks: { pubkey: Base58PubKey; url: string }[];
  catalog: unknown[];
  drafts: unknown[];
  prefs: Record<string, unknown>;
  rev: number;
};

export function emptyUiState(pubkey: Base58PubKey): UiState {
  return {
    pubkey,
    trusted: [],
    follows: undefined,
    contacts: [],
    banks: [],
    catalog: [],
    drafts: [],
    prefs: {},
    rev: 0,
  };
}

export async function getUiState(
  bank: Bank,
  pubkey: Base58PubKey,
): Promise<UiState> {
  const r = await bank.kv.get<UiState>(k(bank, 'ui_state', pubkey));
  return r.value ?? emptyUiState(pubkey);
}

/**
 * The effective follow list, applying the default for anyone who has never
 * touched it.
 *
 * - Never set (`undefined`): default to this bank plus every issuer the user
 *   already trusts. New users therefore see their bank's feed immediately
 *   instead of an empty app, and users who predate follows keep the feed they
 *   had (which was their trusted list).
 * - Set (including `[]`): taken literally. An empty array is a user who
 *   unfollowed everyone, and MUST NOT be re-seeded with the bank — otherwise
 *   "unfollow the bank" silently undoes itself on the next read.
 */
export function resolveFollows(bank: Bank, state: UiState): Base58PubKey[] {
  if (Array.isArray(state.follows)) return state.follows;
  const trusted = (state.trusted ?? []).map((t) =>
    typeof t === 'string' ? t : t?.pubkey).filter(Boolean) as Base58PubKey[];
  return [bank.pubkey, ...trusted.filter((t) => t !== bank.pubkey)];
}

export async function putUiState(
  bank: Bank,
  state: UiState,
  expectedRev?: number,
): Promise<number> {
  const key = k(bank, 'ui_state', state.pubkey);
  const current = await bank.kv.get<UiState>(key);
  if (expectedRev !== undefined && current.value?.rev !== expectedRev) {
    throw new Error('stale revision');
  }
  const next = { ...state, rev: (current.value?.rev ?? 0) + 1 };
  const ok = await bank.kv
    .atomic()
    .check(current)
    .set(key, next)
    .commit();
  if (!ok.ok) throw new Error('ui state conflict');
  return next.rev;
}

// --- UI keystore / handle -------------------------------------------------

export type KeystoreBlob = {
  ciphertext: string;
  nonce: string;
  salt: string;
  kdf: Record<string, unknown>;
  aead?: string;
  kit_issued?: boolean;
};

export async function registerHandle(
  bank: Bank,
  handle: string,
  pubkey: Base58PubKey,
  keystore: KeystoreBlob,
): Promise<void> {
  await bank.kv.set(k(bank, 'handle', handle), pubkey);
  await bank.kv.set(k(bank, 'handle_by_pubkey', pubkey), handle);
  await bank.kv.set(k(bank, 'keystore', pubkey), keystore);
}

export async function getHandleInfo(
  bank: Bank,
  handle: string,
): Promise<{ available: true } | { available: false; pubkey: Base58PubKey }> {
  const r = await bank.kv.get<Base58PubKey>(k(bank, 'handle', handle));
  if (r.value) return { available: false, pubkey: r.value };
  return { available: true };
}

export async function getKeystore(
  bank: Bank,
  handle: string,
): Promise<{ pubkey: Base58PubKey; keystore: KeystoreBlob } | null> {
  const r = await bank.kv.get<Base58PubKey>(k(bank, 'handle', handle));
  if (!r.value) return null;
  const kstore = await bank.kv.get<KeystoreBlob>(k(bank, 'keystore', r.value));
  if (!kstore.value) return null;
  return { pubkey: r.value, keystore: kstore.value };
}

export async function setKeystore(
  bank: Bank,
  pubkey: Base58PubKey,
  keystore: KeystoreBlob,
): Promise<void> {
  await bank.kv.set(k(bank, 'keystore', pubkey), keystore);
}

export async function getHandleByPubkey(
  bank: Bank,
  pubkey: Base58PubKey,
): Promise<string | null> {
  const r = await bank.kv.get<string>(k(bank, 'handle_by_pubkey', pubkey));
  return r.value;
}

// --- foreign record → deal index ------------------------------------------
// When a Mandate lists a record minted at ANOTHER bank, we store its body
// (submit_mandate) and remember which deal it belongs to. This lets
// notify_signatures route a peer's signature on that foreign record to the
// right deal — and, because we only ever gather signatures for records in a
// deal's known set, every peer artifact is deal-scoped (no by-signer,
// cross-deal reuse). Replaces the old by-signer `peer_settle` store.

export async function storeForeignRecordDeal(
  bank: Bank,
  recordHash: Base58SHA256,
  dealId: ULID,
): Promise<void> {
  await bank.kv.set(k(bank, 'foreign_record_deal', recordHash), dealId);
}

export async function getForeignRecordDeal(
  bank: Bank,
  recordHash: Base58SHA256,
): Promise<ULID | null> {
  const r = await bank.kv.get<ULID>(k(bank, 'foreign_record_deal', recordHash));
  return r.value;
}

// --- deal propose idempotency ---------------------------------------------

export async function markProposedDeal(
  bank: Bank,
  dealId: ULID,
): Promise<boolean> {
  const key = k(bank, 'proposed_deal', dealId);
  const r = await bank.kv.get(key);
  if (r.value) return false;
  const ok = await bank.kv.atomic().check(r).set(key, true).commit();
  return ok.ok === true;
}
