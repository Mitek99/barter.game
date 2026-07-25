import {
  getAccountBalance as dbGetAccountBalance,
  getAddress as dbGetAddress,
  getDoc,
  getOffer as dbGetOffer,
  getOrder,
  getRecord,
  getVoucher as dbGetVoucher,
  listAccounts as dbListAccounts,
  listOffers as dbListOffers,
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

export async function getAccountBalance(
  bank: Bank,
  params: Record<string, unknown>,
): Promise<unknown> {
  const hash = params.account_hash;
  if (typeof hash !== 'string') {
    throw new RpcError(-32602, 'account_hash required');
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
