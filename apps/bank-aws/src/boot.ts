import {
  createBank,
  ensureBankAddress,
  loadBankKeys,
  registerLocalBank,
  type Bank,
  type BankDeps,
} from '@barter.game/bank-core';

/**
 * Build the banks map from BANK_<NAME>_PRIV_KEY env vars — same contract as
 * the Deno host.
 *
 * URL resolution, in order: BANK_<NAME>_URL pins one bank; BANK_BASE_URL
 * pins all of them to "<base>/<name>"; otherwise the URL is derived from the
 * first request's origin. Pinning matters here: the bank SIGNS its own
 * Address doc with the URL it believes it has, so an unpinned bank reachable
 * on more than one hostname will re-sign and republish its Address for
 * whichever host it was last asked on.
 */
export async function bootBanks(
  env: Record<string, string | undefined>,
  deps: BankDeps,
): Promise<Map<string, Bank>> {
  const loaded = loadBankKeys(env);
  if (loaded.length === 0) {
    throw new Error('No banks configured. Set BANK_<NAME>_PRIV_KEY env vars (or BANK_KEYS_SSM_PATH).');
  }
  const banks = new Map<string, Bank>();
  const placeholderPort = env.PORT ?? '8000';
  const baseUrl = env.BANK_BASE_URL?.replace(/\/+$/, '');
  for (const l of loaded) {
    const envUrl = env[`BANK_${l.name.toUpperCase().replace(/-/g, '_')}_URL`]
      ?? (baseUrl ? `${baseUrl}/${l.name}` : undefined);
    // The placeholder is only used until the first request resolves the real
    // origin (x-forwarded-host aware).
    const bank = createBank(l, deps, envUrl ?? `http://localhost:${placeholderPort}/${l.name}`);
    bank.urlPinned = !!envUrl;
    banks.set(l.name, bank);
    registerLocalBank(bank);
    if (envUrl) await ensureBankAddress(bank);
    console.log(`Loaded bank ${l.name} -> ${bank.pubkey} @ ${bank.url}` +
      (envUrl ? ' (pinned)' : ' (host-derived)'));
  }
  return banks;
}
