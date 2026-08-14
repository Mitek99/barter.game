// Protocol primitives and document validators for barter.game v1.
// Runs under Bun, Node, and the browser; uses only pure-JS noble + scure libs.
import * as ed from '@noble/ed25519';
import { sha256 as sha256hash, sha512 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import { ulid } from 'ulid';
// @noble/ed25519 sync sign/verify needs sha512 wired up.
ed.hashes.sha512 = sha512;
export function canonicalize(value) {
    return serialize(value);
}
export function canonicalBytes(value) {
    if (typeof value === 'string')
        return new TextEncoder().encode(value);
    return new TextEncoder().encode(canonicalize(value));
}
export function canonicalizeWithoutSig(doc) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        return canonicalize(doc);
    }
    const { sig: _sig, ...rest } = doc;
    return canonicalize(rest);
}
function serialize(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return serializeNumber(value);
    if (typeof value === 'string')
        return serializeString(value);
    if (Array.isArray(value)) {
        return '[' + value.map(serialize).join(',') + ']';
    }
    if (typeof value === 'object') {
        return serializeObject(value);
    }
    throw new TypeError(`canonicalize: unsupported value type: ${typeof value}`);
}
function serializeNumber(n) {
    if (!Number.isFinite(n)) {
        throw new TypeError(`canonicalize: non-finite number: ${n}`);
    }
    if (Object.is(n, -0))
        return '0';
    return String(n);
}
function serializeString(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x22)
            out += '\\"';
        else if (c === 0x5c)
            out += '\\\\';
        else if (c === 0x08)
            out += '\\b';
        else if (c === 0x09)
            out += '\\t';
        else if (c === 0x0a)
            out += '\\n';
        else if (c === 0x0c)
            out += '\\f';
        else if (c === 0x0d)
            out += '\\r';
        else if (c < 0x20) {
            out += '\\u' + c.toString(16).padStart(4, '0');
        }
        else {
            out += s[i];
        }
    }
    out += '"';
    return out;
}
function serializeObject(obj) {
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareUtf16);
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
        if (i > 0)
            out += ',';
        const k = keys[i];
        out += serializeString(k) + ':' + serialize(obj[k]);
    }
    out += '}';
    return out;
}
function compareUtf16(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
// --- crypto ---------------------------------------------------------------
export function genKeyPair() {
    const privateKey = ed.etc.randomBytes(32);
    const publicKey = ed.getPublicKey(privateKey);
    return { privateKey, publicKey, pubkeyBase58: base58.encode(publicKey) };
}
export function publicKeyOf(privateKey) {
    const publicKey = ed.getPublicKey(privateKey);
    return { publicKey, pubkeyBase58: base58.encode(publicKey) };
}
export function signBytes(message, privateKey) {
    return base58.encode(ed.sign(message, privateKey));
}
export function verifyBytes(message, signatureBase58, pubkeyBase58) {
    try {
        const sig = base58.decode(signatureBase58);
        const pub = base58.decode(pubkeyBase58);
        return ed.verify(sig, message, pub);
    }
    catch {
        return false;
    }
}
export function signDoc(doc, privateKey) {
    const bytes = canonicalBytes(canonicalizeWithoutSig(doc));
    const hash = sha256hash(bytes);
    return signBytes(hash, privateKey);
}
export function verifyDoc(doc, signatureBase58, pubkeyBase58) {
    const bytes = canonicalBytes(canonicalizeWithoutSig(doc));
    const hash = sha256hash(bytes);
    return verifyBytes(hash, signatureBase58, pubkeyBase58);
}
// A doc's content hash is taken over the SAME preimage its signature commits
// to: canonical(doc minus the top-level `sig`). So `sig` is a container bolted
// on after the fact, never an input to its own computation — and a doc's
// identity is stable whether or not it has been signed yet (`base.md` §2).
// Only the TOP-LEVEL `sig` is stripped: a nested/embedded signed doc keeps its
// own `sig` inside the preimage, so an embedding author commits to the exact
// signed bytes of what it embeds.
export function hashDoc(doc) {
    return base58.encode(sha256hash(canonicalBytes(canonicalizeWithoutSig(doc))));
}
export function sha256Base58(s) {
    return base58.encode(sha256hash(new TextEncoder().encode(s)));
}
export function newUlid() {
    return ulid();
}
export const base58Encode = (b) => base58.encode(b);
export const base58Decode = (s) => base58.decode(s);
// --- validation utilities -------------------------------------------------
export function isValidBase58(s) {
    try {
        base58.decode(s);
        return true;
    }
    catch {
        return false;
    }
}
export function isValidUlid(s) {
    return typeof s === 'string' && /^[0-9A-Z]{26}$/i.test(s);
}
function assertBaseDoc(d) {
    if (d === null || typeof d !== 'object' || Array.isArray(d))
        return false;
    const o = d;
    return (typeof o.type === 'string' &&
        typeof o.pubkey === 'string' &&
        typeof o.ulid === 'string');
}
function requireFields(o, fields, optional) {
    for (const f of fields) {
        if (!(f in o) || o[f] === undefined) {
            throw new ValidationError(`missing field: ${f}`);
        }
    }
    if (optional) {
        for (const f of optional) {
            if (o[f] !== undefined && o[f] === null) {
                // allow null? protocol says undefined dropped; null might be invalid
            }
        }
    }
}
function assertNumber(n, name) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new ValidationError(`${name} must be a finite number`);
    }
}
function assertPositiveNumber(n, name) {
    assertNumber(n, name);
    if (n <= 0) {
        throw new ValidationError(`${name} must be positive`);
    }
}
function assertNonNegativeNumber(n, name) {
    assertNumber(n, name);
    if (n < 0) {
        throw new ValidationError(`${name} must be non-negative`);
    }
}
function assertBase58(s, name) {
    if (typeof s !== 'string' || !isValidBase58(s)) {
        throw new ValidationError(`${name} must be a base58 string`);
    }
}
function assertUlid(s, name) {
    if (typeof s !== 'string' || !isValidUlid(s)) {
        throw new ValidationError(`${name} must be a ULID`);
    }
}
function assertOrderSide(o, name) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
        throw new ValidationError(`${name} must be an object`);
    }
    const s = o;
    requireFields(s, ['account', 'voucher', 'bank', 'min', 'max']);
    assertBase58(s.account, `${name}.account`);
    assertBase58(s.voucher, `${name}.voucher`);
    assertBase58(s.bank, `${name}.bank`);
    assertNonNegativeNumber(s.min, `${name}.min`);
    assertNonNegativeNumber(s.max, `${name}.max`);
    if (s.min > s.max) {
        throw new ValidationError(`${name}.min must be <= max`);
    }
    return s;
}
export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}
// --- doc validators -------------------------------------------------------
export function validateBaseDoc(d) {
    if (!assertBaseDoc(d)) {
        throw new ValidationError('invalid BaseDoc shape');
    }
    if (!isValidBase58(d.pubkey)) {
        throw new ValidationError('invalid pubkey encoding');
    }
    if (!isValidUlid(d.ulid)) {
        throw new ValidationError('invalid ulid');
    }
    return d;
}
export function validateVoucher(d, bankPubkey) {
    const b = validateBaseDoc(d);
    if (b.type !== 'voucher')
        throw new ValidationError('type must be voucher');
    requireFields(b, ['bank', 'name']);
    assertBase58(b.bank, 'bank');
    if (b.bank !== bankPubkey) {
        throw new ValidationError('voucher bank must match this bank');
    }
    if (typeof b.name !== 'string' || b.name.length === 0) {
        throw new ValidationError('voucher name required');
    }
    if (b.limit !== undefined)
        assertNonNegativeNumber(b.limit, 'limit');
    if (b.integer !== undefined && typeof b.integer !== 'boolean') {
        throw new ValidationError('integer must be boolean');
    }
    if (b.images !== undefined) {
        if (!Array.isArray(b.images)) {
            throw new ValidationError('images must be an array');
        }
        if (b.images.length > MAX_VOUCHER_IMAGES) {
            throw new ValidationError(`images: at most ${MAX_VOUCHER_IMAGES}`);
        }
        b.images.forEach((m, i) => assertMediaRefField(m, `images[${i}]`));
    }
    return d;
}
export function validateAccount(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'account')
        throw new ValidationError('type must be account');
    requireFields(b, ['name', 'voucher']);
    if (typeof b.name !== 'string' || b.name.length === 0) {
        throw new ValidationError('account name required');
    }
    assertBase58(b.voucher, 'voucher');
    return d;
}
export function validateOrder(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'order')
        throw new ValidationError('type must be order');
    requireFields(b, ['rate', 'lead']);
    assertPositiveNumber(b.rate, 'rate');
    if (typeof b.lead !== 'boolean') {
        throw new ValidationError('lead must be boolean');
    }
    if (b.debit === undefined && b.credit === undefined) {
        throw new ValidationError('order must have debit or credit side');
    }
    let hasDebit = false;
    let hasCredit = false;
    if (b.debit !== undefined) {
        assertOrderSide(b.debit, 'debit');
        hasDebit = true;
    }
    if (b.credit !== undefined) {
        assertOrderSide(b.credit, 'credit');
        hasCredit = true;
    }
    for (const f of [
        'debit_order_limit',
        'credit_order_limit',
        'debit_account_limit',
        'credit_account_limit',
    ]) {
        if (b[f] !== undefined)
            assertNonNegativeNumber(b[f], f);
    }
    if (hasDebit && hasCredit) {
        // cross-side min/max sanity: both present is allowed
    }
    return d;
}
export function validateOffer(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'offer')
        throw new ValidationError('type must be offer');
    requireFields(b, ['order', 'rate', 'lead']);
    assertBase58(b.order, 'order');
    assertPositiveNumber(b.rate, 'rate');
    if (typeof b.lead !== 'boolean') {
        throw new ValidationError('lead must be boolean');
    }
    if (b.debit === undefined && b.credit === undefined) {
        throw new ValidationError('offer must have debit or credit side');
    }
    for (const side of ['debit', 'credit']) {
        const s = b[side];
        if (s === undefined)
            continue;
        if (s === null || typeof s !== 'object' || Array.isArray(s)) {
            throw new ValidationError(`${side} must be an object`);
        }
        const so = s;
        requireFields(so, ['voucher', 'bank', 'min', 'max']);
        assertBase58(so.voucher, `${side}.voucher`);
        assertBase58(so.bank, `${side}.bank`);
        assertNonNegativeNumber(so.min, `${side}.min`);
        assertNonNegativeNumber(so.max, `${side}.max`);
        if (so.min > so.max) {
            throw new ValidationError(`${side}.min must be <= max`);
        }
    }
    return d;
}
export function validateRecord(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'credit' && b.type !== 'debit') {
        throw new ValidationError('type must be credit or debit');
    }
    requireFields(b, ['amount', 'order', 'details']);
    assertPositiveNumber(b.amount, 'amount');
    assertBase58(b.order, 'order');
    assertBase58(b.details, 'details');
    return d;
}
export function validateMandate(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'mandate')
        throw new ValidationError('type must be mandate');
    requireFields(b, ['deal_id', 'order', 'bank', 'records']);
    assertUlid(b.deal_id, 'deal_id');
    assertBase58(b.order, 'order');
    assertBase58(b.bank, 'bank');
    if (!Array.isArray(b.records) || b.records.length === 0) {
        throw new ValidationError('records must be a non-empty array');
    }
    for (const r of b.records)
        assertBase58(r, 'records[]');
    return d;
}
export function validateSignature(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'signature') {
        throw new ValidationError('type must be signature');
    }
    if (b.hash !== undefined)
        assertBase58(b.hash, 'hash');
    if (b.action !== undefined) {
        if (!['ready', 'hold', 'settle', 'reject'].includes(b.action)) {
            throw new ValidationError('invalid action');
        }
    }
    if (b.seen !== undefined) {
        if (!Array.isArray(b.seen))
            throw new ValidationError('seen must be array');
        for (const s of b.seen)
            assertBase58(s, 'seen[]');
    }
    return d;
}
export function validateAddress(d) {
    const b = validateBaseDoc(d);
    if (b.type !== 'address')
        throw new ValidationError('type must be address');
    requireFields(b, ['url']);
    if (typeof b.url !== 'string' || !b.url.startsWith('http')) {
        throw new ValidationError('address url must be an http(s) URL');
    }
    return d;
}
/** Extensions a ref may carry, and the Content-Type each one serves as. */
export const MEDIA_EXT_TYPES = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
};
/** Content-Type → canonical extension (the reverse of MEDIA_EXT_TYPES). */
export function extForContentType(ct) {
    const base = ct.split(';')[0].trim().toLowerCase();
    for (const [ext, type] of Object.entries(MEDIA_EXT_TYPES)) {
        if (type === base)
            return ext;
    }
    return null;
}
/**
 * Parse `"<hash>.<ext>"` into its parts, or null when the string is not a
 * well-formed ref (unknown extension, or a hash that is not plausible base58
 * sha256). A bare hash with no extension parses as null — callers that accept
 * the legacy bare form use `mediaRefHash` instead.
 */
export function parseMediaRef(ref) {
    if (typeof ref !== 'string')
        return null;
    const dot = ref.lastIndexOf('.');
    if (dot <= 0 || dot === ref.length - 1)
        return null;
    const hash = ref.slice(0, dot);
    const ext = ref.slice(dot + 1).toLowerCase();
    // Own-key check, not `in`: a plain object inherits Object.prototype, so
    // `in` would bless "constructor" or "__proto__" as extensions.
    if (!Object.hasOwn(MEDIA_EXT_TYPES, ext))
        return null;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(hash))
        return null;
    return { hash, ext };
}
/** The content hash of a ref — or the string itself for a legacy bare hash. */
export function mediaRefHash(ref) {
    const parsed = parseMediaRef(ref);
    return parsed ? parsed.hash : ref;
}
/**
 * Every media ref a post commits to, across its whole embedded
 * `reply_to`/`repost` tree — attachments plus icon/square meta refs,
 * de-duplicated. This is the set a bank checks for presence at intake, and
 * the set a client must copy over before submitting a repost/reply of a post
 * whose blobs live at another bank (post-feed.md §5).
 */
export function collectMediaRefs(post) {
    const out = new Set();
    const walk = (p) => {
        if (!p)
            return;
        for (const m of p.media ?? [])
            out.add(m);
        if (p.icon)
            out.add(p.icon);
        if (p.square)
            out.add(p.square);
        walk(p.reply_to);
        walk(p.repost);
    };
    walk(post);
    return [...out];
}
/**
 * Protocol-level cap on how many images a Voucher doc may carry — enforced by
 * `validateVoucher` at every bank, so it must be documented, not policy
 * (bank-schema.md §1.1).
 */
export const MAX_VOUCHER_IMAGES = 8;
/**
 * Protocol-level cap on `media` entries per post. A repost embeds its whole
 * ancestor tree and the accepting bank checks (and a reposting client copies)
 * every ref in it, so an uncapped list is a copy-amplification lever.
 */
export const MAX_POST_MEDIA = 12;
/**
 * Maximum `reply_to`/`repost` nesting a validator will walk (post-feed.md §6:
 * "banks cap embed depth and total post size at intake"). The cap is a
 * termination guarantee as much as a policy: embeds are recursive and arrive
 * from the network, so an unbounded walk is a denial-of-service vector.
 */
export const MAX_POST_EMBED_DEPTH = 8;
/**
 * Per-field cap on inline SVG, in UTF-16 code units.
 *
 * Deliberately small. A repost EMBEDS the full post it boosts, and a reply
 * embeds its whole ancestor chain, so an icon is copied again at every hop —
 * and a bank that reposts its users duplicates every meta release immediately.
 * Combined with a storage layer whose values cap out at 64 KiB, generous
 * artwork limits turn into unstorable posts several hops downstream.
 */
export const MAX_POST_SVG_CHARS = 8192;
/**
 * Validate a Post and, recursively, every Post it embeds.
 *
 * Shape only — the AUTHOR SIGNATURE OF EMBEDDED POSTS IS NOT CHECKED HERE,
 * because signature verification is async in some runtimes and this validator
 * is sync like its siblings. `verifyPostTree` does that half; a bank MUST call
 * both (post-feed.md §2 requires every embedded post to be "well-formed and
 * correctly signed").
 */
export function validatePost(d, depth = 0) {
    if (depth > MAX_POST_EMBED_DEPTH) {
        throw new ValidationError(`post embed depth exceeds ${MAX_POST_EMBED_DEPTH}`);
    }
    const b = validateBaseDoc(d);
    if (b.type !== 'post')
        throw new ValidationError('type must be post');
    requireFields(b, ['voucher', 'body_md']);
    assertBase58(b.voucher, 'voucher');
    if (typeof b.body_md !== 'string') {
        throw new ValidationError('body_md must be a string');
    }
    if (b.media !== undefined) {
        if (!Array.isArray(b.media)) {
            throw new ValidationError('media must be an array');
        }
        if (b.media.length > MAX_POST_MEDIA) {
            throw new ValidationError(`media: at most ${MAX_POST_MEDIA} per post`);
        }
        // Canonical form is "<hash>.<ext>"; a bare base58 hash remains valid so
        // that posts signed before extensions existed still verify when embedded.
        b.media.forEach((m, i) => {
            if (parseMediaRef(m))
                return;
            assertBase58(m, `media[${i}]`);
        });
    }
    assertMediaRefField(b.icon, 'icon');
    assertMediaRefField(b.square, 'square');
    assertPostSvg(b.icon_svg, 'icon_svg');
    assertPostSvg(b.square_svg, 'square_svg');
    if (b.voucher_meta !== undefined && typeof b.voucher_meta !== 'boolean') {
        throw new ValidationError('voucher_meta must be boolean');
    }
    // An embedded ancestor is a full Post, so it validates by the same rules.
    if (b.reply_to !== undefined)
        validatePost(b.reply_to, depth + 1);
    if (b.repost !== undefined)
        validatePost(b.repost, depth + 1);
    return d;
}
/**
 * Verify the author signature of a Post and of every Post embedded in it.
 *
 * Embedded ancestors keep their own `sig`, so each is verified against its own
 * `pubkey` exactly as a standalone post would be. Returns false on the first
 * bad signature; a missing `sig` anywhere in the tree is a failure.
 */
/**
 * Shape-check an inline SVG field.
 *
 * This is NOT a sanitizer and must not be mistaken for one: an SVG can carry
 * <script>, event handlers and foreignObject, so the rendering side is what
 * keeps it safe (render via a data: URI in <img>, never inline into the DOM).
 * What this enforces is that the value is a bounded string that actually looks
 * like an SVG document, so garbage and oversized blobs never reach storage.
 */
/** An optional field that, when present, must be a well-formed MediaRef. */
function assertMediaRefField(v, name) {
    if (v === undefined)
        return;
    if (!parseMediaRef(v)) {
        throw new ValidationError(`${name} must be a media ref "<hash>.<ext>"`);
    }
}
function assertPostSvg(v, name) {
    if (v === undefined)
        return;
    if (typeof v !== 'string')
        throw new ValidationError(`${name} must be a string`);
    if (v.length > MAX_POST_SVG_CHARS) {
        throw new ValidationError(`${name} exceeds ${MAX_POST_SVG_CHARS} characters`);
    }
    if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(v)) {
        throw new ValidationError(`${name} must be an <svg> document`);
    }
}
export function verifyPostTree(post) {
    const sig = post.sig;
    if (!sig || !verifyDoc(post, sig, post.pubkey))
        return false;
    if (post.reply_to && !verifyPostTree(post.reply_to))
        return false;
    if (post.repost && !verifyPostTree(post.repost))
        return false;
    return true;
}
// --- helpers --------------------------------------------------------------
export function offerSideFromOrderSide(side) {
    if (!side)
        return undefined;
    return { voucher: side.voucher, bank: side.bank, min: side.min, max: side.max };
}
