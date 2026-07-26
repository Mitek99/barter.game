import {
  getAccount as dbGetAccount,
  getAccountBalance as dbGetAccountBalance,
  getAddress as dbGetAddress,
  getDoc,
  getOffer as dbGetOffer,
  getOrder,
  getPost as dbGetPost,
  getRecord,
  getSignaturesForPost as dbGetSignaturesForPost,
  getVoucher as dbGetVoucher,
  listAccounts as dbListAccounts,
  listOffers as dbListOffers,
  listPosts as dbListPosts,
  listVouchers as dbListVouchers,
  listVouchersByIssuer as dbListVouchersByIssuer,
} from '../db.ts';
import { hashDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

export async function getVoucher(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.voucher_hash;
  if (typeof hash !== 'string') {
    throw new RpcError(-32602, 'voucher_hash required');
  }
  const v = await dbGetVoucher(bank, hash);
  if (!v) throw new RpcError(-32005, 'unknown voucher');
  return v;
}

// Accounts are private by default (bank-schema.md §1.2): a bank MUST NOT
// disclose an account's balance to anyone but its holder — and the issuer of
// the voucher the account is denominated in, who is entitled to see every
// position in their own currency. v1 has no `Account.public` opt-in, so those
// two are the whole allow-list.
export async function getAccountBalance(
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  const hash = params.account_hash;
  if (typeof hash !== 'string') {
    throw new RpcError(-32602, 'account_hash required');
  }
  const account = await dbGetAccount(bank, hash);
  if (!account) throw new RpcError(-32005, 'unknown account');
  if (sender !== account.doc.pubkey) {
    const voucher = await dbGetVoucher(bank, account.doc.voucher);
    if (!voucher || sender !== voucher.pubkey) {
      throw new RpcError(-32001, 'not authorized to read this account');
    }
  }
  const bal = await dbGetAccountBalance(bank, hash);
  if (!bal) throw new RpcError(-32005, 'unknown account');
  return bal;
}

export async function listAccounts(
  bank: Bank,
  _params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  const rows = await dbListAccounts(bank, sender);
  return {
    accounts: rows.map((r) => r.account),
    vouchers: rows.map((r) => r.voucher).filter(Boolean),
  };
}

export async function listOffers(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const voucher = params.voucher_hash;
  const intention = params.intention;
  if (typeof voucher !== 'string' || (intention !== 'sell' && intention !== 'buy')) {
    throw new RpcError(-32602, 'voucher_hash and intention (sell|buy) required');
  }
  return dbListOffers(bank, voucher, intention);
}

export async function getInvoice(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.hash;
  if (typeof hash !== 'string') throw new RpcError(-32602, 'hash required');
  const order = await getOrder(bank, hash);
  if (!order || order.type !== 'order' || order.debit !== undefined) {
    throw new RpcError(-32005, 'not an invoice');
  }
  return order;
}

export async function getCheque(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.hash;
  if (typeof hash !== 'string') throw new RpcError(-32602, 'hash required');
  const order = await getOrder(bank, hash);
  if (!order || order.type !== 'order' || order.credit !== undefined) {
    throw new RpcError(-32005, 'not a cheque');
  }
  return order;
}

export async function getOffer(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.offer_hash;
  if (typeof hash !== 'string') {
    throw new RpcError(-32602, 'offer_hash required');
  }
  const o = await dbGetOffer(bank, hash);
  if (!o) throw new RpcError(-32005, 'unknown offer');
  return o;
}

export async function listVouchers(
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  // filter:'mine' -> the caller's own vouchers; an explicit issuer -> that
  // issuer's; otherwise the full public registry. Previously this ignored its
  // params and always returned the whole registry, so clients that asked for
  // 'mine' saw every bank voucher labeled as their own.
  const issuer = typeof params.issuer === 'string'
    ? params.issuer
    : (params.filter === 'mine' ? sender : null);
  if (issuer) return dbListVouchersByIssuer(bank, issuer);
  return dbListVouchers(bank);
}

export async function getAddress(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const pubkey = params.pubkey;
  if (typeof pubkey !== 'string') throw new RpcError(-32602, 'pubkey required');
  const addr = await dbGetAddress(bank, pubkey);
  if (!addr) throw new RpcError(-32005, 'unknown address');
  return addr;
}

export { hashDoc };

// --- posts ----------------------------------------------------------------

// Advisory page size; the bank caps it (bank-rpc.md §2.4 pagination note).
const POSTS_DEFAULT_LIMIT = 50;
const POSTS_MAX_LIMIT = 200;

/**
 * `list_posts(pubkey, voucher_hash, before?)` — post-feed.md §3.
 *
 * `pubkey` is the AUTHOR whose feed is read and is required: there is
 * deliberately no "all authors" query, because that would be a global
 * timeline and feeds are the reader's own trust graph (§3, §7).
 */
export async function listPosts(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const author = params.pubkey;
  const voucher = params.voucher_hash;
  const before = params.before;
  if (typeof author !== 'string') {
    throw new RpcError(-32602, 'pubkey (author) required');
  }
  if (typeof voucher !== 'string') {
    throw new RpcError(-32602, "voucher_hash required (a hash, or \"all\")");
  }
  if (before !== undefined && typeof before !== 'string') {
    throw new RpcError(-32602, 'before must be a ULID string');
  }
  const rawLimit = typeof params.limit === 'number' ? params.limit : POSTS_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(rawLimit, POSTS_MAX_LIMIT));
  return await dbListPosts(bank, author, voucher as string, before, limit);
}

export async function getPost(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.post_hash;
  if (typeof hash !== 'string') throw new RpcError(-32602, 'post_hash required');
  const p = await dbGetPost(bank, hash);
  if (!p) throw new RpcError(-32005, 'unknown post');
  return p;
}

/**
 * Signatures that accrued on a post AFTER it was signed — endorsements,
 * reactions, an issuer co-signing a holder's post. The author's own signature
 * lives in the post body. Mirrors `get_record_signatures`.
 */
export async function getPostSignatures(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.post_hash;
  if (typeof hash !== 'string') throw new RpcError(-32602, 'post_hash required');
  return { signatures: await dbGetSignaturesForPost(bank, hash) };
}
