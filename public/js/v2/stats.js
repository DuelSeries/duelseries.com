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
    el('s-tiles').innerHTML = '';
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
    const best = games.reduce((m, g) => Math.max(m, Number(g.amount) || 0), 0);
    const staked = Number(p.totalStaked) || 0;
    const tracked = !!p.stakesTracked;
    const net = Number(p.totalEarnings || 0) - staked;
    const signed = n => (n > 0 ? '+' : n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);

    el('s-sub').innerHTML = p.gamesPlayed
      ? '<span class="num">' + p.gamesPlayed + '</span> games played.'
      : 'No games played yet.';

    const tiles = [
      ['Total earnings', money(p.totalEarnings), 'paid to your wallet'],
      ['Buy-ins', money(staked), tracked ? 'what you have put in' : 'not recorded yet'],
      ['Cash-outs', String(cashouts), cashouts ? 'games you left ahead' : 'none yet'],
      ['Biggest cash-out', money(best), 'single game'],
    ];
    /* Profit is only shown once there is something to subtract. Showing
       earnings-minus-nothing would read as pure profit and be wrong. */
    if (tracked) {
      tiles.unshift(['Net profit', signed(net),
        'earnings minus buy-ins' + (net < 0 ? ', currently down' : '')]);
    }
    el('s-tiles').innerHTML = tiles.map(t =>
      '<div class="tile"><div class="k">' + t[0] + '</div>' +
      '<div class="v num"' + (t[0] === 'Net profit' ? ' style="color:var(--money)"' : '') + '>' +
      t[1] + '</div><div class="f">' + t[2] + '</div></div>').join('');

    if (!cashouts) {
      el('s-body').innerHTML = '<div class="panel"><p class="note">No cash-outs yet. ' +
        'Leave a game ahead and it shows up here.</p></div>';
      return;
    }

    let run = 0;
    const pts = games.map(g => ({ d: g.at, cum: (run += Number(g.amount) || 0) }));

    el('s-body').innerHTML =
      '<div class="head"><div><h2>Earnings over time</h2>' +
        '<div class="sub">Your running total from every cash-out.</div></div></div>' +
      '<div class="panel chartbox">' + window.V2Chart(pts, money) + '</div>' +
      '<div class="head"><div><h2>Cash-outs</h2>' +
        '<div class="sub">Newest first.</div></div></div>' +
      '<div class="tbl">' +
        '<div class="tr hd"><span>Date</span><span>Result</span><span class="r">Paid out</span></div>' +
        games.slice().reverse().slice(0, 20).map(g =>
          '<div class="tr"><span class="num">' + when(g.at) + '</span>' +
          '<span><span class="tag">Cashed out</span></span>' +
          '<span class="r num pos">' + money(g.amount) + '</span></div>').join('') +
      '</div>' +
      /* Said plainly rather than left as a silent absence, because the obvious
         question looking at this screen is "am I up overall". */
      (tracked
        ? '<p class="note" style="margin-top:22px">Buy-ins have only been ' +
          'recorded since this was added, so any games before that count their ' +
          'payout but not what you paid to enter.</p>'
        : '<p class="note" style="margin-top:22px">These are payouts. Your ' +
          'buy-ins are not recorded yet, so this is what you have taken out, ' +
          'not profit after what you put in.</p>');
    if (window.V2ChartWire) window.V2ChartWire(el('s-body').querySelector('.chartbox'), money);
  }

  window.addEventListener('duelwallet:change', () => {
    const s = el('stats-screen');
    if (s && getComputedStyle(s).display !== 'none') load();
  });
  window.V2Stats = { load: load };
})();
