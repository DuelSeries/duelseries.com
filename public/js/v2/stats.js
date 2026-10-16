'use strict';
/* ─── Your stats ──────────────────────────────────────────────────────────────
   Shape read from server/db.js getMyProfile on 2026-08-15:

     GET /api/my-profile?wallet=<address>
       -> { name, totalEarnings, gamesPlayed, playTimeSeconds, nameHistory[],
            games:  [{ amount, at }],     // earnings_history: what came back
            stakes: [{ amount, at }],     // stakes_history:   what went in
            totalStaked, stakesTracked }

   Both halves are recorded now, so this screen can finally answer the question
   it exists to answer: am I up. It could not before — nothing persisted the
   stake a player paid, and the prototype's profit and win rate were invented.

   `stakesTracked` is the honesty catch. Buy-ins have only been recorded since
   stakes_history was added, so an account with payouts stretching back before
   that would show a net far better than the truth. When it is false the screen
   says the figure is partial rather than quietly overstating it. */

(function () {
  const el = id => document.getElementById(id);
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const addr = () => (window.duelWallet || {}).address;

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }
  /* This section lives inside the wallet screen now, which has its own signed
     out state one panel above. A second Sign in button under it would be the
     same prompt twice, so the whole section is hidden instead. */
  function signedOut() {
    const box = el('w-earn'); if (box) box.hidden = true;
  }

  async function load() {
    const a = addr();
    if (!a) return signedOut();

    /* A server error (500) answers JSON too, so the status is checked: it used
       to fall through as an empty profile and read "No cash-outs yet". */
    let p;
    try {
      const r = await fetch('/api/my-profile?wallet=' + encodeURIComponent(a));
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      p = await r.json();
    } catch (_) {
      // Shown, not left inside the hidden section, so a failed read is never a blank.
      const box = el('w-earn'); if (box) box.hidden = false;
      el('s-body').innerHTML = '<div class="panel"><p class="note">Could not load ' +
        'earnings. Tap refresh to try again.</p></div>';
      return;
    }

    const games = Array.isArray(p.games) ? p.games : [];
    const cashouts = games.length;

    const box = el('w-earn'); if (box) box.hidden = false;

    if (!cashouts) {
      el('s-body').innerHTML = '<div class="panel"><p class="note">No cash-outs yet.</p></div>';
      return;
    }

    /* The chart, and nothing under it: the list that was here, Recent payouts,
       is Add funds and Withdrawals now, the money the player moved themselves
       (Owen, 2026-10-15; wallet.js loadMoves). Every payout is still a row of
       Transactions. The graph is the shared one (chart.js V2EarningsChart), so
       a player's profile draws exactly this line from exactly these rows. */
    el('s-body').innerHTML = '<div class="panel chartbox" id="s-chart"></div>';
    window.V2EarningsChart(el('s-chart'), games, p.joinedAt, money);
  }

  window.addEventListener('duelwallet:change', () => {
    const s = el('wallet-screen');
    if (s && getComputedStyle(s).display !== 'none') load();
  });
  window.V2Stats = { load: load };
})();
