import {
  getDoc,
  getVoucher,
  getVoucherMeta,
  hasMedia,
  storeAccount,
  storeAddress,
  storeOffer,
  storeOrder,
  putVoucherMeta,
  storePost,
  storeSignature,
  storeVoucher,
} from '../db.ts';
import {
  collectMediaRefs,
  hashDoc,
  mediaRefHash,
  newUlid,
  offerSideFromOrderSide,
  signDoc,
  validateAccount,
  validateAddress,
  validateOrder,
  validatePost,
  validateSignature,
  validateVoucher,
  verifyDoc,
  verifyPostTree,
  type Offer,
  type Order,
  type Post,
} from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

export async function submitDocs(
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  const docsRaw = params.docs;
  if (!Array.isArray(docsRaw)) {
    throw new RpcError(-32602, 'docs array required');
  }

  const stored: string[] = [];
  const offers: string[] = [];

  // Process docs in dependency order regardless of array order: an Order in
  // the same batch may reference an Account (which may reference a Voucher)
  // that appears after it. Callers shouldn't have to know the topology.
  const typeRank = (t: unknown): number =>
    t === 'voucher' ? 0 : t === 'account' ? 1 : t === 'address' ? 2 : 3;
  const docsOrdered = [...docsRaw].sort((a, b) =>
    typeRank((a as Record<string, unknown>)?.type) - typeRank((b as Record<string, unknown>)?.type));

  for (const raw of docsOrdered) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RpcError(-32600, 'invalid doc');
    }
    const type = (raw as Record<string, unknown>).type;
    switch (type) {
      case 'voucher': {
        const v = validateVoucher(raw, bank.pubkey);
        if (v.bank !== bank.pubkey) {
          throw new RpcError(-32000, 'voucher bank mismatch');
        }
        await verifyOrFail(raw, v.sig, v.pubkey);
        // Images live in the vault, not the doc — the doc only carries refs,
        // and the blobs must already be here (upload precedes the doc, same
        // rule as post media, post-feed.md §5).
        for (const ref of v.images ?? []) {
          if (!(await hasMedia(bank, mediaRefHash(ref)))) {
            throw new RpcError(-32005, `voucher image not stored at this bank: ${ref}`);
          }
        }
        const h = await storeVoucher(bank, v);
        if (!stored.includes(h)) stored.push(h);
        break;
      }
      case 'account': {
        const a = validateAccount(raw);
        await verifyOrFail(raw, a.sig, a.pubkey);
        if (a.pubkey !== sender) {
          throw new RpcError(-32001, 'account must be signed by sender');
        }
        // Type-checked, not just "some doc exists at this hash" — the doc store
        // is one flat namespace, so hasDoc would let any signed doc stand in
        // for a Voucher.
        if (!(await getVoucher(bank, a.voucher))) {
          throw new RpcError(-32005, 'account voucher unknown');
        }
        const h = await storeAccount(bank, a);
        if (!stored.includes(h)) stored.push(h);
        break;
      }
      case 'order': {
        const o = validateOrder(raw);
        await verifyOrFail(raw, o.sig, o.pubkey);
        if (o.pubkey !== sender) {
          throw new RpcError(-32001, 'order must be signed by sender');
        }
        await validateOrderAccounts(bank, o);
        const h = await storeOrder(bank, o);
        if (!stored.includes(h)) stored.push(h);
        break;
      }
      case 'address': {
        const a = validateAddress(raw);
        await verifyOrFail(raw, a.sig, a.pubkey);
        await storeAddress(bank, a);
        const h = hashDoc(a);
        if (!stored.includes(h)) stored.push(h);
        break;
      }
      case 'signature': {
        const s = validateSignature(raw);
        await verifyOrFail(raw, s.sig, s.pubkey);
        const h = await storeSignature(bank, s);
        if (!stored.includes(h)) stored.push(h);
        break;
      }
      case 'post': {
        // post-feed.md §2: validate shape, author signature, that `voucher`
        // resolves to a Voucher THIS bank knows (its own, or one presented to
        // it — so any bank the issuer uses can carry the feed), that every
        // embedded reply_to/repost is itself well-formed and correctly signed,
        // and that referenced media is already stored here (upload precedes
        // the post, §5). Beyond validity, carriage is bank policy.
        const p = validatePost(raw);
        await verifyOrFail(raw, (p as { sig?: string }).sig, p.pubkey);
        if (p.pubkey !== sender) {
          throw new RpcError(-32001, 'post must be signed by sender');
        }
        if (!(await getVoucher(bank, p.voucher))) {
          throw new RpcError(-32005, 'post voucher unknown');
        }
        // Embedded ancestors keep their own signatures; each verifies against
        // its own author, so a forged thread cannot ride in on a valid outer
        // post. Sync check — the tree is already in memory.
        if (!verifyPostTree(p)) {
          throw new RpcError(-32001, 'embedded post signature invalid');
        }
        // Every ref in the WHOLE embedded tree, not just the outer post: a
        // repost/reply carries its ancestors, and serving a thread whose
        // images 404 here would silently break exactly the posts a bank
        // amplifies. This is also what makes cross-bank reposting explicit —
        // the reposting client must copy the blobs over first (§5).
        const treeRefs = collectMediaRefs(p);
        // Per-post media is capped by validatePost; this bounds the whole
        // embedded tree, since checking (and client-side copying) is per-ref
        // work an attacker could otherwise multiply through deep embeds.
        if (treeRefs.length > 64) {
          throw new RpcError(-32000, 'post tree references too many media blobs');
        }
        for (const m of treeRefs) {
          if (!(await hasMedia(bank, mediaRefHash(m)))) {
            throw new RpcError(-32005, `media not stored at this bank: ${m}`);
          }
        }
        // A meta release restyles a LIVE currency. Only the voucher's issuer
        // may do it — otherwise anyone could redefine what someone else's
        // money looks like and says it is, which is a far cheaper attack than
        // forging a balance.
        if (p.voucher_meta === true) {
          const v = await getVoucher(bank, p.voucher);
          if (!v || v.pubkey !== p.pubkey) {
            throw new RpcError(-32001, 'only the voucher issuer may release its meta');
          }
        }
        const h = await storePost(bank, p);
        if (!stored.includes(h)) stored.push(h);
        if (p.voucher_meta === true) {
          // A release that carries artwork defines the look completely; a
          // release that carries NONE is a description update and keeps the
          // current artwork (from the previous release, or the Voucher doc's
          // own images) — otherwise a text-only release would silently strip
          // a live currency of its face.
          const carriesArt = !!(p.icon || p.square || p.icon_svg || p.square_svg);
          const prev = carriesArt ? null : await getVoucherMeta(bank, p.voucher);
          const v = carriesArt ? null : await getVoucher(bank, p.voucher);
          const keepIcon = prev?.icon ?? v?.images?.[0];
          const keepSquare = prev?.square ?? v?.images?.[1];
          await putVoucherMeta(bank, {
            voucher: p.voucher,
            icon: carriesArt ? p.icon : keepIcon,
            square: carriesArt ? p.square : keepSquare,
            icon_svg: carriesArt ? p.icon_svg : prev?.icon_svg,
            square_svg: carriesArt ? p.square_svg : prev?.square_svg,
            // The post's own text becomes the voucher's description.
            description_md: p.body_md || undefined,
            ulid: p.ulid,
            post: h,
            at: Date.now(),
          });
        }
        await bankRepost(bank, p);
        break;
      }
      default:
        throw new RpcError(-32600, `unsupported doc type: ${type}`);
    }
  }

  const publish = params.publish_offers;
  if (Array.isArray(publish)) {
    for (const orderHash of publish) {
      if (typeof orderHash !== 'string') continue;
      const offerHash = await deriveOffer(bank, orderHash, sender);
      if (offerHash && !offers.includes(offerHash)) offers.push(offerHash);
    }
  }

  return { stored, offers };
}

async function verifyOrFail(
  raw: unknown,
  sig: string | undefined,
  pubkey: string,
): Promise<void> {
  if (!sig) throw new RpcError(-32001, 'missing signature');
  if (!verifyDoc(raw, sig, pubkey)) {
    throw new RpcError(-32001, 'invalid signature');
  }
}

async function validateOrderAccounts(bank: Bank, order: Order): Promise<void> {
  const sides: ('debit' | 'credit')[] = ['debit', 'credit'];
  for (const side of sides) {
    const s = order[side];
    if (!s) continue;
    // A bank only needs to verify the account for the side that involves a voucher it issues.
    if (s.bank !== bank.pubkey) continue;
    const accDoc = await getDoc<unknown>(bank, s.account);
    if (!accDoc) {
      throw new RpcError(-32005, `unknown ${side} account`);
    }
    const acc = accDoc as { pubkey: string; voucher: string };
    if (acc.pubkey !== order.pubkey) {
      throw new RpcError(-32000, `${side} account not owned by order signer`);
    }
    if (acc.voucher !== s.voucher) {
      throw new RpcError(-32000, `${side} account voucher mismatch`);
    }
  }
}

export async function deriveOffer(
  bank: Bank,
  orderHash: string,
  sender: string,
): Promise<string | null> {
  const orderDoc = await getDoc<unknown>(bank, orderHash);
  if (!orderDoc) return null;
  const order = orderDoc as Order;
  if (order.pubkey !== sender) return null;
  const offer: Offer = {
    type: 'offer',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    order: orderHash,
    rate: order.rate,
    debit: offerSideFromOrderSide(order.debit),
    credit: offerSideFromOrderSide(order.credit),
    lead: order.lead,
    sig: '',
  };
  offer.sig = signDoc(offer, bank.privateKey);
  return storeOffer(bank, offer);
}

/**
 * The bank reposts every user post it accepts.
 *
 * New users follow their own bank by default, so the bank's feed is what an
 * account with no connections sees on day one — without it, a newcomer's feed
 * is empty and there is nothing to discover. Following the bank is the
 * opt-out: unfollow it and you are back to a pure trust-graph feed.
 *
 * Two things this must not do:
 *   - repost its OWN posts, which would recurse forever;
 *   - fail the user's write. Carriage is bank policy (post-feed.md §2/§6), so
 *     a repost that cannot be minted is the bank's problem, not the author's —
 *     their post is already stored and signed.
 */
async function bankRepost(bank: Bank, post: Post): Promise<void> {
  if (post.pubkey === bank.pubkey) return;
  try {
    const repost: Record<string, unknown> = {
      type: 'post',
      pubkey: bank.pubkey,
      ulid: newUlid(),
      voucher: post.voucher,
      body_md: '',
      repost: post,
    };
    repost.sig = signDoc(repost, bank.privateKey);
    await storePost(bank, repost as unknown as Post);
  } catch (e) {
    console.error('bank repost failed', e);
  }
}
