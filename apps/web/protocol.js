// Protocol primitives and document validators for barter.game v1.
// Runs under Deno Deploy; uses only pure-JS noble + scure libs.
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
/**
 * Maximum `reply_to`/`repost` nesting a validator will walk (post-feed.md §6:
 * "banks cap embed depth and total post size at intake"). The cap is a
 * termination guarantee as much as a policy: embeds are recursive and arrive
 * from the network, so an unbounded walk is a denial-of-service vector.
 */
export const MAX_POST_EMBED_DEPTH = 8;
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
        b.media.forEach((m, i) => assertBase58(m, `media[${i}]`));
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
