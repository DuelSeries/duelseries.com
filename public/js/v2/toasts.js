/* The lobby's one notification: a small tinted card that says what just
   happened (Owen's pick C, 2026-10-15). Green for done, gold for money, red for
   wrong, bone for a step still running. The colour carries the outcome and the
   icon repeats it, so neither depends on telling two colours apart.

     DSToast.show({ kind, title, amount, detail, code, ms, sticky, game })
       kind    'ok' | 'money' | 'err' | 'info'
       amount  shown first, in the money gold ('+$5.00 USDC')
       detail  plain words after it
       code    an address, last, in the mono face
       sticky  stays until updated (a send still confirming), 90 s at most
       game    may show over a running game (an entry or a payout); anything
               else waits until the player is back in the lobby
     returns { update(o), close() }

   Where: bottom right on a PC; above the bottom bar on a phone; top centre while
   a game frame is open, where a game keeps none of its controls. Three at most
   (two on a short phone, one in a game), so a burst never reaches the Play
   button. Hover holds one; a tap or click puts it away.

   What it listens to is only what this page already hears: the wallet widget's
   duelwallet:change, the lobby's own duel:play, the frames opening and closing.
   It moves nothing and asks the chain nothing. */
(function () {
  'use strict';
  const FRAMES = ['game-frame', 'agar-frame'];
  const ICON = { ok: '✓', money: '$', err: '✕', info: 'i' };
  const STAY = { ok: 3400, money: 4000, info: 3400, err: 4800 };
  const $ = id => document.getElementById(id);
  const frameOpen = () => FRAMES.some(id => { const f = $(id); return !!f && f.style.display === 'block'; });

  const live = [];      // cards on screen, oldest first
  const later = [];     // shown once the game closes

  function most() {
    if (frameOpen()) return 1;
    const h = window.innerHeight;
    if (h < 500) return 1;                         // a sideways phone
    if (h < 760) return 2;                         // a short screen: a third card would reach Play
    return 3;
  }
  const keyOf = o => [o.kind, o.title, o.amount, o.detail, o.code].join('|');

  function fill(t, o) {
    const kind = ICON.hasOwnProperty(o.kind) ? o.kind : 'ok';
    t.className = 'toast ' + kind + (t.classList.contains('on') ? ' on' : '');
    t.textContent = '';
    const ic = document.createElement('span');
    const busy = kind === 'info' && !!o.sticky;     // still running: a turning ring, not a letter
    ic.className = 't-ic' + (busy ? ' spin' : '');
    ic.setAttribute('aria-hidden', 'true');
    ic.textContent = busy ? '' : ICON[kind];
    const body = document.createElement('div');
    body.className = 't-body';
    if (o.title) {
      const b = document.createElement('b');
      b.className = 't-title'; b.textContent = o.title;
      body.appendChild(b);
    }
    if (o.amount || o.detail || o.code) {
      const d = document.createElement('span');
      d.className = 't-line';
      const part = (cls, text) => {
        if (!text) return;
        if (d.childNodes.length) d.appendChild(document.createTextNode(' '));
        const s = document.createElement('span');
        if (cls) s.className = cls;
        s.textContent = text;
        d.appendChild(s);
      };
      part('t-amt', o.amount); part('', o.detail); part('t-addr', o.code);
      body.appendChild(d);
    }
    t.appendChild(ic); t.appendChild(body);
  }

  function arm(c, ms) {
    clearTimeout(c.timer);
    c.left = ms;
    c.since = Date.now();
    c.timer = setTimeout(() => close(c), ms);
  }
  function stayFor(o) {
    if (o.sticky) return 90000;
    if (o.ms) return o.ms;
    return STAY[o.kind] || STAY.ok;
  }

  function close(c) {
    const i = live.indexOf(c);
    if (i < 0) return;
    live.splice(i, 1);
    clearTimeout(c.timer);
    c.node.classList.remove('on');
    c.node.classList.add('out');
    setTimeout(() => c.node.remove(), 260);         // after it has faded
  }

  function place() {
    const box = $('toasts'); if (!box) return;
    const open = frameOpen();
    box.classList.toggle('top', open);
    // A game opening takes the lobby's cards with it; they never follow the player in.
    if (open) live.filter(c => !c.o.game).forEach(close);
    while (live.length > most()) close(live[0]);
  }

  function put(o) {
    const box = $('toasts'); if (!box) return null;
    const key = keyOf(o);
    const same = live.find(c => c.key === key);
    if (same) { arm(same, stayFor(o)); return same; }   // the same thing twice is one card, read longer
    const t = document.createElement('div');
    fill(t, o);
    const c = { node: t, key: key, o: o, timer: 0, left: 0, since: 0 };
    t.addEventListener('click', () => close(c));
    // A pointer resting on it holds it; leaving gives back what was left, never less than a moment.
    t.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || !live.includes(c)) return;
      clearTimeout(c.timer);
      c.left = Math.max(0, c.left - (Date.now() - c.since));
    });
    t.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse' || !live.includes(c)) return;
      arm(c, Math.max(1200, c.left));
    });
    box.classList.toggle('top', frameOpen());
    box.appendChild(t);
    live.push(c);
    arm(c, stayFor(o));
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('on')));   // so the slide runs
    while (live.length > most()) close(live[0]);
    return c;
  }

  function show(o) {
    o = Object.assign({ kind: 'ok' }, o || {});
    if (!o.title && !o.detail && !o.amount) return { update() {}, close() {} };
    // Over a running game only what belongs there; the rest waits for the lobby.
    if (frameOpen() && !o.game) {
      const q = { o: o };
      later.push(q);
      if (later.length > 3) later.shift();
      return { update(n) { q.o = Object.assign({}, q.o, { sticky: false, ms: 0 }, n); },
               close() { const i = later.indexOf(q); if (i >= 0) later.splice(i, 1); } };
    }
    let c = put(o);
    return {
      update(n) {
        const next = Object.assign({}, c ? c.o : o, { sticky: false, ms: 0 }, n);
        if (!c || !live.includes(c)) { c = put(next); return; }
        c.o = next; c.key = keyOf(next);
        fill(c.node, next);
        arm(c, stayFor(next));
      },
      close() { if (c) close(c); },
    };
  }

  /* The old one-line call (V2Play.toast(text, good)) still works: the sentence
     is the title. A long one is given the time it takes to read. */
  function line(text, good) {
    if (!text) return;
    const s = String(text);
    show({ kind: good ? 'ok' : 'err', title: s,
           ms: Math.max(STAY[good ? 'ok' : 'err'], Math.min(9000, 1600 + s.length * 55)) });
  }

  /* The frames opening and closing: placement follows them, and what waited
     for the lobby shows when the player is back in it. */
  function frameChanged() {
    place();
    if (frameOpen() || !later.length) return;
    later.splice(0).forEach(q => show(q.o));
  }
  function watchFrames() {
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(() => { frameChanged(); entered(); });
    FRAMES.forEach(id => { const f = $(id); if (f) mo.observe(f, { attributes: true, attributeFilter: ['style'] }); });
  }
  window.addEventListener('resize', place);

  // ---- money the lobby can see -------------------------------------------
  const unitOf = () => ((window.duelWallet || {}).unit === 'SOL' ? 'SOL' : 'USDC');
  function amount(n, sign) {
    const v = Math.abs(Number(n) || 0);
    const s = unitOf() === 'SOL'
      ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' SOL'
      : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC';
    return (sign ? '+' : '') + s;
  }

  /* A paid seat (or the event, whose prize is real) opened from this lobby.
     The lobby asks for the room (duel:play); the widget stakes and opens the
     frame, writing the hand-off it opened with into this tab's
     sessionStorage. Both are read here, never written. */
  const ss = k => { try { return sessionStorage.getItem(k) || ''; } catch (_) { return ''; } };
  let asked = null;          // { at, paid, br, token } from the last duel:play
  let payoutUntil = 0;       // money arriving before then is a game's payout
  let wasOpen = false;
  window.addEventListener('duel:play', (e) => {
    const d = (e && e.detail) || {};
    asked = { at: Date.now(), paid: Number(d.stake) > 0 || (!!d.lobbyType && d.lobbyType !== 'free' && d.lobbyType !== 'br'),
              br: d.lobbyType === 'br', token: ss('entryToken') };
  });
  function entered() {
    const open = frameOpen();
    if (open === wasOpen) return;
    wasOpen = open;
    if (!open) { if (payoutUntil === Infinity) payoutUntil = Date.now() + 15 * 60 * 1000; return; }
    const a = asked; asked = null;
    const fresh = a && Date.now() - a.at < 3 * 60 * 1000;
    if (ss('slBr') === 'play' || (fresh && a.br)) { payoutUntil = Infinity; return; }
    if (!fresh || !a.paid) return;
    const worth = Number(ss('stake')) || Number(ss('entrySol'));
    // A token written for THIS launch: one left over from an earlier paid seat is not a new entry.
    if (!ss('entryToken') || ss('entryToken') === a.token || !(worth > 0)) return;
    payoutUntil = Infinity;               // until the game closes, then 15 minutes
    show({ kind: 'money', title: 'Entry paid', amount: amount(worth), game: true, ms: 2600 });
  }

  /* The balance going up. The widget reads it every 15 s and after a game or a
     send. Up while a paid game is open, or soon after one, is that game paying
     out (a cash-out, or an entry handed back): both are money from the game,
     so it says that and the amount, which is what actually landed. Any other
     rise is money that was added. A fall says nothing: every fall this page
     causes (a stake, a withdraw) has its own card already. */
  let seen = { addr: null, bal: null };
  window.addEventListener('duelwallet:change', () => {
    const w = window.duelWallet || {};
    const addr = w.authenticated && w.address ? w.address : null;
    const bal = typeof w.balance === 'number' && isFinite(w.balance) ? w.balance : null;
    if (!addr) { seen = { addr: null, bal: null }; return; }
    if (addr !== seen.addr) { seen = { addr: addr, bal: bal }; return; }   // a sign-in is not money arriving
    if (bal === null) return;                                              // a failed read keeps the last one
    const before = seen.bal;
    seen.bal = bal;
    if (before === null) return;
    const up = bal - before;
    if (up < (unitOf() === 'SOL' ? 0.0005 : 0.005)) return;
    if (Date.now() < payoutUntil) {
      show({ kind: 'money', title: 'Payout received', amount: amount(up, true), detail: 'from your game', game: true });
    } else {
      show({ kind: 'money', title: 'Funds added', amount: amount(up, true), detail: 'is in your wallet' });
    }
  });

  /* An in-game Play again asks the lobby's wallet for a new entry. Reading the
     balance first means a payout that has already landed is counted before
     the new stake comes off it, instead of the two cancelling out unseen. */
  window.addEventListener('message', (e) => {
    // From one of our game frames, on our own origin, as every other listener here checks.
    if (!e || e.origin !== window.location.origin) return;
    const f = FRAMES.map($).find(x => !!x && !!x.contentWindow && x.contentWindow === e.source);
    if (!f || e.source !== f.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'duel:restake') return;
    if (window.duelWalletRefresh) { try { window.duelWalletRefresh(); } catch (_) {} }
  });

  const shortAddr = a => !a ? '' : a.length <= 12 ? a : a.slice(0, 4) + '…' + a.slice(-4);

  window.DSToast = { show: show, line: line, amount: amount, short: shortAddr };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchFrames);
  else watchFrames();
})();
