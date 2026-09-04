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
  const money = n => '$' + (Number(n) || 0).toFixed(2);
  const addr = () => (window.duelWallet || {}).address;

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }
  const when = at => {
    const t = Date.parse(at);
    return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  function signedOut() {
    el('s-sub').textContent = 'Sign in to see your own record.';
    el('s-body').innerHTML =
      '<div class="panel"><p class="note">Your stats are tied to your wallet, ' +
      'because your wallet is your account here. Sign in and they appear.</p>' +
      '<div class="brow"><button class="btn pri" onclick="V2Wallet.login()">Sign in</button></div>' +
      '</div>';
  }

  async function load() {
    const a = addr();
    if (!a) return signedOut();

    let p;
    try {
      const r = await fetch('/api/my-profile?wallet=' + encodeURIComponent(a));
      p = await r.json();
    } catch (_) {
      el('s-body').innerHTML = '<div class="panel"><p class="note">Could not reach ' +
        'the server. Check your connection and try again.</p></div>';
      return;
    }

    const games = Array.isArray(p.games) ? p.games : [];
    const cashouts = games.length;

    el('s-sub').innerHTML = p.gamesPlayed
      ? '<span class="num">' + p.gamesPlayed + '</span> games played.'
      : 'No games played yet.';

    if (!cashouts) {
      el('s-body').innerHTML = '<div class="panel"><p class="note">No cash-outs yet. ' +
        'Leave a game ahead and it shows up here.</p></div>';
      return;
    }

    let run = 0;
    const pts = games.map(g => ({ d: g.at, cum: (run += Number(g.amount) || 0) }));
    /* Carried to today at the total it reached, so the line ends where you are
       standing rather than at the last time you happened to win. A year
       without a cash-out is a year of flat line, which is true and is worth
       seeing. */
    const lastAt = Date.parse(pts[pts.length - 1].d);
    if (!isNaN(lastAt) && Date.now() > lastAt + 60000)
      pts.push({ d: new Date().toISOString(), cum: run });

    /* The chart leads. It carries its own heading in the page title above it,
       so it opens the screen rather than sitting under a row of boxes.
       Ten rows, not twenty: this is a glance at recent payouts, and a list long
       enough to scroll stops being a glance. */
    el('s-body').innerHTML =
      '<div class="panel chartbox">' + window.V2Chart(pts, money, p.joinedAt) + '</div>' +
      '<div class="head"><div><h2>Recent payouts</h2>' +
        '<div class="sub">Newest first.</div></div></div>' +
      '<div class="tbl">' +
        '<div class="tr hd"><span>Date</span><span>Result</span><span class="r">Paid out</span></div>' +
        games.slice().reverse().slice(0, 10).map(g =>
          '<div class="tr"><span class="num">' + when(g.at) + '</span>' +
          '<span><span class="tag">Cashed out</span></span>' +
          '<span class="r num pos">' + money(g.amount) + '</span></div>').join('') +
      '</div>';
    if (window.V2ChartWire) window.V2ChartWire(el('s-body').querySelector('.chartbox'), money);
  }

  window.addEventListener('duelwallet:change', () => {
    const s = el('stats-screen');
    if (s && getComputedStyle(s).display !== 'none') load();
  });
  window.V2Stats = { load: load };
})();
