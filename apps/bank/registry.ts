import type { Bank } from './types.ts';
import { submitDocs } from './handlers/submit_docs.ts';
import { submitMandate } from './handlers/submit_mandate.ts';
import { createRecords } from './handlers/create_records.ts';
import { notifySignatures } from './handlers/notify_signatures.ts';
import { getRecordSignatures } from './handlers/get_record_signatures.ts';
import {
  getVoucher,
  getAccountBalance,
  listAccounts,
  listOffers,
  getInvoice,
  getCheque,
  getOffer,
  listVouchers,
  getAddress,
  listPosts,
  getPost,
  getPostSignatures,
  getVoucherMeta,
} from './handlers/get.ts';

export type Handler = (
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
) => Promise<unknown>;

export const registry: Record<string, Handler> = {
  submit_docs: submitDocs,
  submit_mandate: submitMandate,
  create_records: createRecords,
  notify_signatures: notifySignatures,
  get_record_signatures: getRecordSignatures,
  get_voucher: getVoucher,
  get_account_balance: getAccountBalance,
  list_accounts: listAccounts,
  list_offers: listOffers,
  get_invoice: getInvoice,
  get_cheque: getCheque,
  get_offer: getOffer,
  list_vouchers: listVouchers,
  get_address: getAddress,
  list_posts: listPosts,
  get_post: getPost,
  get_post_signatures: getPostSignatures,
  get_voucher_meta: getVoucherMeta,
};
