import { loadBankKeys, createBank } from './env.ts';
import { handleRpc } from './rpc.ts';
import { handleUiRequest, handlePublicUiRoute, handleBarterLink, handleMedia, cors } from './ui.ts';
import { getAddress, storeAddress } from './db.ts';
import { registerLocalBank } from './local.ts';
import { newUlid, signDoc } from '@barter.game/protocol';
import type { Address } from '@barter.game/protocol';
import type { Bank } from './types.ts';

async function main() {
  const loaded = loadBankKeys();
  if (loaded.length === 0) {
    console.error('No banks configured. Set BANK_<NAME>_PRIV_KEY env vars.');
    Deno.exit(1);
  }

  // BANK_KV_PATH pins the KV database file — used to run several isolated
  // bank processes on one machine (federation testing). Unset on Deno Deploy,
  // where openKv() resolves to the platform KV.
  const kv = await Deno.openKv(Deno.env.get('BANK_KV_PATH') || undefined);
  const banks = new Map<string, Bank>();
  for (const l of loaded) {
    const envUrl = Deno.env.get(
      `BANK_${l.name.toUpperCase().replace(/-/g, '_')}_URL`,
    );
    // When no URL is pinned via env, derive it from the first incoming
    // request's origin (resolveBankUrl) so the deployment is self-describing
    // on any host. The placeholder is only used until the first request.
    const bank = createBank(l, kv, envUrl ?? `http://localhost:8000/${l.name}`);
    bank.urlPinned = !!envUrl;
    banks.set(l.name, bank);
    registerLocalBank(bank);
    if (envUrl) await ensureBankAddress(bank);
    console.log(`Loaded bank ${l.name} -> ${bank.pubkey} @ ${bank.url}` +
      (envUrl ? ' (pinned)' : ' (host-derived)'));
  }

  Deno.serve({ port: parseInt(Deno.env.get('PORT') ?? '8000', 10) }, (request) =>
    route(request, banks),
  );
}

async function route(request: Request, banks: Map<string, Bank>): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) {
    return cors(json({ banks: [...banks.keys()] }));
  }

  const name = parts[0]!;
  const bank = banks.get(name);
  if (!bank) {
    return cors(json({ code: -32005, message: 'bank not found' }, 404));
  }

  // Resolve the bank's canonical URL from the request origin on first contact
  // (unless pinned via BANK_<NAME>_URL). This keeps barter-bank.json and the
  // signed Address doc consistent with where the bank is actually reachable.
  await resolveBankUrl(bank, `${url.protocol}//${url.host}`);

  const rest = parts.slice(1);
  const segment = rest[0];

  try {
    if (segment === 'barter-bank.json' && request.method === 'GET') {
      return cors(json({
        pubkey: bank.pubkey,
        url: bank.url,
        name: bank.name,
        protocol_version: 'barter.game/v1',
      }));
    }

    if (segment === 'rpc' && request.method === 'POST') {
      const res = await handleRpc(bank, request);
      return cors(res);
    }

    if (segment === 'address') {
      // GET /:name/address or /:name/address/:pubkey
      const pubkey = rest[1] ?? bank.pubkey;
      const { registry } = await import('./registry.ts');
      const result = await registry['get_address'](bank, { pubkey }, bank.pubkey);
      return cors(json(result));
    }

    // Media blobs (post-feed.md §5, bank-rpc.md §2.5). Upload is authenticated
    // via the same signed authdoc the rest of the write path uses; download is
    // deliberately UNAUTHENTICATED — blobs are immutable and content-addressed,
    // so whoever knows the hash may fetch the bytes, and responses cache freely.
    if (segment === 'media') {
      return cors(await handleMedia(bank, request, rest[1], `/${name}/media`));
    }

    // Barter Link public routes
    if (['i', 'v', 'q', 'o', 'x'].includes(segment ?? '') && rest.length >= 2) {
      const wantsJson =
        url.searchParams.get('format') === 'json' ||
        url.pathname.endsWith('.json') ||
        request.headers.get('Accept')?.includes('application/barter+json') === true;
      return cors(await handleBarterLink(bank, request, { kind: segment!, value: rest[1]! }, wantsJson));
    }

    // Static SPA assets
    if (segment === 'ui' && rest[1] === 'app' && request.method === 'GET') {
      const assetPath = rest.slice(2).join('/');
      return cors(await serveStaticAsset(assetPath));
    }

    // UI routes
    if (segment === 'ui') {
      const basePath = `/${name}/ui`;
      const publicRes = await handlePublicUiRoute(bank, request, basePath);
      if (publicRes) return cors(publicRes);
      const res = await handleUiRequest(bank, request, basePath);
      return cors(res);
    }

    return cors(json({ code: -32005, message: 'not found' }, 404));
  } catch (e) {
    console.error('route error', e);
    return cors(json({ code: -32603, message: 'internal error' }, 500));
  }
}

async function ensureBankAddress(bank: Bank): Promise<void> {
  const existing = await getAddress(bank, bank.pubkey);
  if (existing && existing.url === bank.url) return;
  const addr = {
    type: 'address',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    url: bank.url,
    sig: '',
  };
  addr.sig = signDoc(addr, bank.privateKey);
  await storeAddress(bank, addr as Address);
}

// Point the bank at the origin it was actually reached on, then make sure the
// stored Address doc reflects it. Skips env-pinned banks and no-ops once the
// URL is stable.
async function resolveBankUrl(bank: Bank, origin: string): Promise<void> {
  if (bank.urlPinned) return;
  const desired = `${origin}/${bank.name}`;
  if (bank.urlResolved && bank.url === desired) return;
  bank.url = desired;
  bank.urlResolved = true;
  await ensureBankAddress(bank);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  // Icons: the browser refuses to use an SVG favicon or a manifest PNG served
  // as application/octet-stream.
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

async function serveStaticAsset(path: string): Promise<Response> {
  const safe = (path || 'index.html').replace(/\.\//g, '').replace(/\.\./g, '');
  try {
    const file = await Deno.readFile(`./apps/web/${safe}`);
    const ext = safe.split('.').pop() ?? '';
    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    };
    // Icons are content-stable and fetched on every install/tab; app code is
    // not (there is no build step, so no content hashes to bust a cache with).
    if (ext === 'png' || ext === 'ico' || ext === 'svg') {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    return new Response(file, { headers });
  } catch {
    return json({ code: -32005, message: 'asset not found' }, 404);
  }
}

main();
