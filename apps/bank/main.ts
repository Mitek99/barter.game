// Deno host for the shared bank engine (@barter.game/bank-core): wires
// Deno KV, KV-chunked media, and on-disk web assets into the shared router.
// The AWS host (apps/bank-aws) wires the same engine to DynamoDB + S3.
import {
  createBank,
  ensureBankAddress,
  KvMediaStore,
  loadBankKeys,
  registerLocalBank,
  route,
  type AssetReader,
  type Bank,
  type KvStore,
} from '@barter.game/bank-core';

const denoAssets: AssetReader = {
  async read(path: string): Promise<Uint8Array | null> {
    const safe = path.replace(/\.\//g, '').replace(/\.\./g, '');
    try {
      return await Deno.readFile(`./apps/web/${safe}`);
    } catch {
      return null;
    }
  },
};

async function main() {
  const loaded = loadBankKeys(Deno.env.toObject());
  if (loaded.length === 0) {
    console.error('No banks configured. Set BANK_<NAME>_PRIV_KEY env vars.');
    Deno.exit(1);
  }

  // BANK_KV_PATH pins the KV database file — used to run several isolated
  // bank processes on one machine (federation testing). Unset on Deno Deploy,
  // where openKv() resolves to the platform KV.
  const denoKv = await Deno.openKv(Deno.env.get('BANK_KV_PATH') || undefined);
  // Deno.Kv satisfies the KvStore contract by construction (the interface is
  // the subset of Deno KV the bank uses); the cast bridges the wider Deno key
  // types that structural typing cannot see through.
  const kv = denoKv as unknown as KvStore;
  const media = new KvMediaStore(kv);

  const banks = new Map<string, Bank>();
  for (const l of loaded) {
    const envUrl = Deno.env.get(
      `BANK_${l.name.toUpperCase().replace(/-/g, '_')}_URL`,
    );
    // When no URL is pinned via env, derive it from the first incoming
    // request's origin (resolveBankUrl) so the deployment is self-describing
    // on any host. The placeholder is only used until the first request.
    const bank = createBank(
      l,
      { kv, media, assets: denoAssets },
      envUrl ?? `http://localhost:8000/${l.name}`,
    );
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

main();
