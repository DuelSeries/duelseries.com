/* Coinbase Onramp held back while Coinbase caps it (2026-10-16).

   Privy's Add funds sheet shows a row for every funding option in the app's config, and its
   "Transfer from an exchange" row opens Coinbase Onramp. Coinbase lets this app sell at most
   about US$5 a purchase in its current tier: Owen's first try came back with "You can only make
   up to CA$7.09 per transaction in your current app tier" on a CA$24.87 buy, and Confirm &
   Purchase greyed out. That is under MoonPay's C$30 floor too, so a player tapping that row could
   only reach a dead button. Until the tier is raised, this takes Coinbase's entries out of the
   app config as the widget receives it, so the sheet is Pay with card (MoonPay) and Receive funds.
   /api/money-config's coinbaseOnramp (COINBASE_ONRAMP=on on the server) brings the row back.

   Only Privy's own GET of this app's config is touched, only entries whose provider is coinbase
   are dropped, and anything unexpected (another URL, a failed answer, a shape it does not know,
   a throw) passes through exactly as it came. */

export function withoutCoinbase(appConfig) {
  const f = appConfig && appConfig.funding_config;
  if (!f || !Array.isArray(f.options)) return null;              // not a shape we know: leave it
  const kept = f.options.filter((o) => !(o && o.provider === 'coinbase'));
  if (kept.length === f.options.length) return null;            // nothing to take out
  return Object.assign({}, appConfig, { funding_config: Object.assign({}, f, { options: kept }) });
}

/* realFetch: the fetch to wrap. appId: the Privy app. showCoinbase: () => Promise<boolean>. */
export function holdBackCoinbase(realFetch, appId, showCoinbase) {
  const target = 'https://auth.privy.io/api/v1/apps/' + appId;
  const isAppConfig = (input, init) => {
    const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input || ''));
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET') return false;
    try { const u = new URL(url); return u.origin + u.pathname === target; } catch (_) { return false; }
  };
  return async function fetchHoldingCoinbase(input, init) {
    const res = await realFetch(input, init);
    if (!isAppConfig(input, init) || !res || !res.ok) return res;
    try {
      if (await showCoinbase()) return res;
      const trimmed = withoutCoinbase(await res.clone().json());
      if (!trimmed) return res;
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(JSON.stringify(trimmed), { status: res.status, statusText: res.statusText, headers });
    } catch (_) {
      return res;
    }
  };
}
