/* A signed-in player with no wallet gets one (2026-10-18, the first outside sign-up stuck on
   "Creating your wallet").

   Privy's own on-login screen runs its create once, right after login, and only if Privy's wallet
   frame has finished loading by then; when it has not, it does nothing at all: "Creating your
   wallet, Please wait..." forever, no error, no second try. Privy's login() is a no-op for a
   session that is already signed in, so from then on Sign in did nothing either. The widget turns
   that screen off (createOnLogin 'off') and makes the wallet here with Privy's public
   createWallet, which does wait for the frame.

   One setup at a time, shared by every caller; never a second createWallet while one is still
   out (no chance of two wallets); a create that fails fast (frame still loading, network) is
   tried again until the deadline; then a plain failure the widget turns into Try again. */

const msgOf = (e) => String((e && e.message) || e || '');

export function makeWalletSetup({ createWallet, hasWallet, refreshUser, sleep, now, deadlineMs = 30000, retryMs = 1500 }) {
  let inflight = null; // the createWallet() not yet settled
  let running = null;  // the setup every caller shares

  const startCreate = () => {
    if (!inflight) {
      const p = Promise.resolve().then(() => createWallet());
      inflight = p;
      const clear = () => { if (inflight === p) inflight = null; };
      p.then(clear, clear);
    }
    return inflight;
  };

  async function attempt() {
    const end = now() + deadlineMs;
    let last = null;
    for (;;) {
      if (hasWallet()) return { ok: true };
      const left = end - now();
      if (left <= 0) return { ok: false, error: last || new Error('Wallet setup timed out') };
      const r = await Promise.race([
        startCreate().then(() => ({ done: true }), (e) => ({ err: e })),
        sleep(left).then(() => ({ timeout: true })),
      ]);
      if (r.done) return { ok: true };
      if (r.timeout) return { ok: false, error: last || new Error('Wallet setup timed out') };
      last = r.err;
      // A wallet made by an earlier try (or another tab) that this page has not heard about yet.
      if (/already/i.test(msgOf(r.err))) {
        try { await refreshUser(); } catch (_) {}
        if (hasWallet()) return { ok: true };
      }
      await sleep(Math.max(0, Math.min(retryMs, end - now())));
    }
  }

  return {
    ensure() {
      if (!running) {
        const p = attempt();
        running = p;
        const clear = () => { if (running === p) running = null; };
        p.then(clear, clear);
      }
      return running;
    },
    busy: () => !!running,
  };
}
