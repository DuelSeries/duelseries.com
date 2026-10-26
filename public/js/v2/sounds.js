/* ─── Lobby sounds ────────────────────────────────────────────────────────────
   A short sound for almost everything clicked in the lobby (Owen, 2026-10-16:
   "make a sound effect for pretty much everything you click"), the Glass pack
   he picked, plus a very soft tick when the mouse moves onto a button or card.
   The engine is /js/dsSfx.js (one AudioContext, every sound rendered at load),
   so this file is only what sounds when, and the rules.

   When
     Mouse and pen sound on PRESS (pointerdown), not on release: a click event
     comes only when the button is let go, a tenth of a second later. A finger
     sounds when it lifts without having moved (a swipe that starts on a button
     is not a tap). Enter and Space sound on keydown. A click with no press
     before it (a script's .click()) still sounds, once.
     The sound is picked for whatever was pressed (MAP) before the element's own
     handler runs, so a switch knows its old state. toasts.js, countUp.js and
     swipe.js call DSSound for what is not a click: a card arriving, money
     rolling up, a swipe landing.

   Rules
     Silent while a game is up (the game has its own sounds) and in a hidden tab.
     The same sound twice inside its gap is one sound, and at most 6 play at
     once, so fast clicking never turns into a buzz. Hover is mouse only (never a
     touch screen), once per element, at most every 90 ms.
     Settings > Sound has the switch, the volume and the hover switch, remembered
     per device (dsSnd, dsSndVol, dsSndHover). All on by default.

   DSSound.play(name, {rate, vol})   rate 1.06 is a touch higher (next arrow)
   DSSound.toast(kind, sticky, title) kind is the toast's: ok | money | err | info; a few
                                     titles get their signature sound (SPECIAL)
   DSSound.roll()                    money counting up (only right after a click)
   DSSound.on() / setOn(b)  vol() / setVol(0..1)  hover() / setHover(b) */
(function () {
  'use strict';
  const S = window.DSSfx;
  if (!S) return;
  const { mf, arp, ticks } = S;
  const LS_ON = 'dsSnd', LS_VOL = 'dsSndVol', LS_HOV = 'dsSndHover';
  const FRAMES = ['game-frame', 'agar-frame'];
  const ui = m => Object.fromEntries(Object.entries(m).map(([k, v]) => ['ui.' + k, v]));

  /* ── the pack ───────────────────────────────────────────────────────────────
     A pecking order: ticks for small things, a clear confirm for Play, the
     richest sound for money, a gentle error. Owen picked Glass (2026-10-16) over
     Arcade and Lounge, and the games use the same style (/js/dsSfxGame.js). */
  (() => {
    const play = [].concat(
      arp([72, 76, 79, 84], 0.045, { o: 't', d: 0.34, v: 0.16, e: 0.11 }),
      [{ o: 's', f: [190, 85], d: 0.2, v: 0.32, e: 0.05, g: 0.12 },
       { o: 's', f: mf(96), at: 0.15, d: 0.45, v: 0.045, e: 0.16 }]);
    S.define(ui({
      tap:       [{ o: 's', f: [2100, 1700], d: 0.03, v: 0.16, e: 0.008 }, { o: 'n', d: 0.012, v: 0.04, bp: [4200, 1.2], e: 0.003 }],
      tab:       [{ o: 's', f: [1180, 1320], d: 0.06, v: 0.2, e: 0.018 }, { o: 's', f: 2640, d: 0.04, v: 0.04, e: 0.01 }],
      arrow:     [{ o: 's', f: 1500, d: 0.035, v: 0.15, e: 0.009 }, { o: 'n', d: 0.01, v: 0.03, bp: [5000, 1.5], e: 0.002 }],
      select:    [{ o: 's', f: mf(84), d: 0.05, v: 0.15, e: 0.015 }, { o: 's', f: mf(91), at: 0.035, d: 0.08, v: 0.15, e: 0.02 }],
      card:      [{ o: 's', f: [380, 980], d: 0.1, v: 0.24, e: 0.03, g: 0.045 }, { o: 'n', d: 0.03, v: 0.04, lp: 2500, e: 0.01 }],
      swipe:     [{ o: 'n', d: 0.2, v: 0.2, a: 0.05, e: 0.06, bp: [[600, 2600], 0.9] }],
      open:      [{ o: 's', f: [620, 990], d: 0.13, v: 0.18, a: 0.004, e: 0.04, g: 0.06 }, { o: 's', f: 1980, at: 0.04, d: 0.12, v: 0.045, e: 0.035 }],
      close:     [{ o: 's', f: [980, 560], d: 0.1, v: 0.16, e: 0.035, g: 0.06 }],
      toggleOn:  [{ o: 's', f: mf(88), d: 0.05, v: 0.14, e: 0.015 }, { o: 's', f: mf(95), at: 0.045, d: 0.09, v: 0.14, e: 0.025 }],
      toggleOff: [{ o: 's', f: mf(83), d: 0.05, v: 0.13, e: 0.015 }, { o: 's', f: mf(76), at: 0.045, d: 0.09, v: 0.12, e: 0.025 }],
      copy:      [{ o: 's', f: 2600, d: 0.025, v: 0.1, e: 0.006 }, { o: 's', f: 3300, at: 0.05, d: 0.045, v: 0.1, e: 0.01 }],
      play: play,
      playPaid:  play.concat([{ o: 'fm', f: mf(100), m: 3.5, i: 2, at: 0.16, d: 0.65, v: 0.1, e: 0.18 },
                              { o: 'fm', f: mf(103), m: 3.5, i: 2, at: 0.23, d: 0.7, v: 0.08, e: 0.2 }]),
      spectate:  [{ o: 'n', d: 0.26, v: 0.08, a: 0.06, e: 0.08, bp: [[400, 1800], 1.5] }, { o: 's', f: [520, 780], d: 0.24, v: 0.12, a: 0.03, e: 0.08, g: 0.15 }],
      confirm:   [{ o: 't', f: mf(79), d: 0.12, v: 0.18, e: 0.05 }, { o: 't', f: mf(86), at: 0.07, d: 0.24, v: 0.18, e: 0.08 }],
      buy:       [{ o: 'n', d: 0.02, v: 0.1, hp: 3000, e: 0.005 }, { o: 's', f: [240, 110], d: 0.12, v: 0.22, e: 0.04 },
                  { o: 'fm', f: mf(100), m: 3.5, i: 2.5, at: 0.02, d: 0.75, v: 0.13, e: 0.2 },
                  { o: 'fm', f: mf(105), m: 3.5, i: 2.5, at: 0.1, d: 0.85, v: 0.11, e: 0.25 }],
      money:     arp([84, 88, 91, 96, 100], 0.05, { o: 'fm', m: 3.5, i: 1.6, d: 0.55, v: 0.1, e: 0.16 })
                  .concat([{ o: 's', f: mf(60), d: 0.3, v: 0.12, e: 0.1 }, { o: 'n', at: 0.2, d: 0.4, v: 0.025, hp: 6000, a: 0.05, e: 0.12 }]),
      ok:        [{ o: 's', f: mf(86), d: 0.1, v: 0.13, e: 0.04 }, { o: 's', f: mf(93), at: 0.08, d: 0.26, v: 0.13, e: 0.09 }],
      err:       [{ o: 't', f: mf(69), d: 0.14, v: 0.16, e: 0.05 }, { o: 't', f: mf(65), at: 0.12, d: 0.26, v: 0.16, e: 0.09 }],
      info:      [{ o: 'fm', f: mf(91), m: 2, i: 0.8, d: 0.36, v: 0.1, e: 0.12 }],
      roll:      ticks(16, 0.9, { o: 's', f: 3200, d: 0.016, v: 0.07, e: 0.004 }, 0.04),
      hover:     [{ o: 's', f: [2900, 2700], d: 0.022, v: 0.06, e: 0.005 }],
    }));

    /* Signature sounds for the buttons that matter (Owen 2026-10-16: "add funds or
       withdraw, they'll get their own sound because they're important"). Longer,
       built on chords and a coin clink, so they never sound like an everyday tick. */
    const coin = (at, f, v) => ({ o: 'fm', f: f || 2637, m: 1.41, i: 2.6, at: at, d: 0.5, v: v || 0.07, e: 0.12 });
    const bell = (n, at, d, v, x) => Object.assign({ o: 'fm', f: mf(n), m: 3.5, i: 1.3, at: at, d: d, v: v, e: d / 3 }, x);
    const air = (at, d, v, a, b) => ({ o: 'n', at: at, d: d, v: v, a: d / 3, e: d / 3, bp: [[a, b], 1] });
    const chord = (ns, at, d, v) => ns.map((n, k) => bell(n, at + k * 0.012, d, v, { m: 2, i: 1 }));
    S.define(ui({
      fund:       [coin(0), coin(0.07, 3136, 0.05), { o: 's', f: [200, 95], d: 0.16, v: 0.24, e: 0.05 }]
                    .concat(arp([79, 86], 0.08, { o: 's', at: 0.1, d: 0.4, v: 0.13, e: 0.13 })),
      deposit:    [0, 0.06, 0.12, 0.17, 0.22].map((t, k) => coin(t, 2349 * Math.pow(1.122, k), 0.06))
                    .concat(chord([84, 88, 91], 0.3, 1.0, 0.06), [{ o: 's', f: mf(48), at: 0.28, d: 0.5, v: 0.16, e: 0.16 },
                            { o: 'n', at: 0.32, d: 0.5, v: 0.02, hp: 7000, a: 0.06, e: 0.14 }]),
      withdraw:   [air(0, 0.32, 0.12, 500, 3200), bell(88, 0.14, 0.4, 0.09, { i: 1 }), bell(95, 0.22, 0.45, 0.06, { i: 1 })],
      withdrawGo: chord([67, 71, 74], 0, 0.5, 0.07).concat(chord([72, 76, 79, 84], 0.18, 0.8, 0.07),
                    [{ o: 's', f: [190, 85], at: 0.18, d: 0.2, v: 0.26, e: 0.06 }]),
      sent:       [air(0, 0.4, 0.13, 400, 5000), bell(100, 0.2, 0.6, 0.08, { i: 1.4 }), bell(107, 0.3, 0.7, 0.06, { i: 1.4 }),
                   { o: 'n', at: 0.3, d: 0.5, v: 0.02, hp: 7000, a: 0.05, e: 0.14 }],
      convert:    [{ o: 's', f: [mf(72), mf(79)], d: 0.42, v: 0.12, a: 0.01, e: 0.2, g: 0.3, vib: [7, 0.006] }, bell(91, 0.28, 0.45, 0.06, { i: 1 })],
      convertGo:  [{ o: 's', f: [mf(72), mf(84)], d: 0.5, v: 0.12, a: 0.01, e: 0.25, g: 0.35 }].concat(chord([84, 91], 0.32, 0.6, 0.07)),
      converted:  [{ o: 's', f: [mf(76), mf(83)], d: 0.35, v: 0.1, e: 0.15, g: 0.25 }].concat(chord([83, 88, 95], 0.22, 0.8, 0.06), [coin(0.24, 3520, 0.05)]),
      unlock:     [{ o: 'n', d: 0.45, v: 0.06, a: 0.2, e: 0.12, hp: [2000, 9000] }]
                    .concat(arp([84, 88, 91, 96], 0.06, { o: 'fm', at: 0.3, m: 3.5, i: 1.5, d: 0.6, v: 0.07, e: 0.18 }),
                            chord([72, 79, 84], 0.52, 0.9, 0.05), [coin(0.54, 3951, 0.05)]),
      /* The battle royale's join window opening (brCall.js, Owen 2026-10-25): a rising bell call over a swell of
         air, the loudest thing the lobby says that is not money; and the soft tick of its last 5 seconds. */
      brcall:     [air(0, 0.55, 0.1, 500, 4200)].concat(arp([79, 84, 88, 91], 0.075, { o: 'fm', m: 3.5, i: 1.4, d: 0.6, v: 0.09, e: 0.18 }),
                    chord([84, 91, 96], 0.34, 1.0, 0.05)),
      brtick:     [{ o: 's', f: [1900, 1650], d: 0.045, v: 0.09, e: 0.014 }, { o: 'n', d: 0.012, v: 0.025, bp: [4600, 1.4], e: 0.003 }],
      clip:       [{ o: 'n', d: 0.012, v: 0.3, bp: [3000, 3], e: 0.003 }, { o: 'n', at: 0.05, d: 0.014, v: 0.22, bp: [2200, 3], e: 0.004 },
                   bell(93, 0.08, 0.45, 0.07, { i: 1 })],
    }));
  })();

  /* ── playing ──────────────────────────────────────────────────────────────── */
  const GAP = { tap: 45, arrow: 45, select: 45, tab: 60, roll: 1500, money: 500, buy: 500, err: 250, ok: 250, info: 250, swipe: 120, hover: 0 };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsPut = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  let on = lsGet(LS_ON) !== '0', hov = lsGet(LS_HOV) !== '0';
  let vol = (() => { const v = parseFloat(lsGet(LS_VOL)); return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7; })();
  let lastClick = -1e9;

  const ingame = () => (document.body && document.body.classList.contains('ingame'))
    || FRAMES.some(id => { const f = document.getElementById(id); return !!f && f.style.display === 'block'; });
  S.setLevel(() => (on && !ingame() ? vol : 0));

  function play(name, opt) {
    return S.play('ui.' + name, Object.assign({ gap: GAP[name] == null ? 70 : GAP[name], max: 6 }, opt));
  }

  /* A toast that a click just caused (Copied, Saved) already had its click
     sound; only money and errors speak over it. A busy "working" card is quiet. */
  const SPECIAL = [[/^Withdraw confirmed/, 'sent'], [/^Funds added/, 'deposit'], [/^Unlocked/, 'unlock'],
    [/^Converted/, 'converted'], [/^(Clip sent|Sent for review)/, 'clip'], [/^Battle royale starting/, 'brcall']];
  function toast(kind, sticky, title) {
    if (sticky && kind === 'info') return;
    const sp = typeof title === 'string' && SPECIAL.find(x => x[0].test(title));
    if (sp && kind !== 'err') { play(sp[1]); return; }
    const name = { ok: 'ok', money: 'money', err: 'err', info: 'info' }[kind] || 'ok';
    if ((name === 'ok' || name === 'info') && performance.now() - lastClick < 300) return;
    play(name);
  }
  /* Money counting up sounds only right after a click (opening Wallet, say),
     never for a leaderboard quietly redrawing in the background. */
  function roll() {
    if (performance.now() - lastClick > 1500) return;
    play('roll', { vol: 0.8 });
  }

  /* ── what each press sounds like ──────────────────────────────────────────
     First match wins. A function gets the element and returns a name, or a
     [name, {rate}] pair. Anything clickable that is not listed gets 'tap'. */
  const att = (el, a) => el.getAttribute(a) || '';
  const MAP = [
    ['.sw[role="switch"]', el => att(el, 'aria-checked') === 'true' ? 'toggleOff' : 'toggleOn'],
    ['#gobtn', el => el.classList.contains('paid') ? 'playPaid' : 'play'],
    ['[onclick*="V2Wallet.fund"]', 'fund'],
    ['[onclick*="V2Wallet.cashOut"]', 'withdraw'],
    ['[onclick*="confirmCash"],[onclick*="submitCash"]', 'withdrawGo'],
    ['[onclick*="confirmConvert"]', 'convertGo'],
    ['[onclick*="V2Wallet.convert"]', 'convert'],
    ['#specbtn,#ev-watch,.evwatch,[onclick*="spectate" i]', 'spectate'],
    ['#ev-join,.evgo,.howgo,.enter', 'play'],
    ['#bs-go,[onclick^="confirmBuy"]', 'buy'],
    ['.stk', 'select'],
    ['.card', 'card'],
    ['.ni,.logo,.mewal', el => el.classList.contains('on') ? 'tap' : 'tab'],
    ['[role="tab"]', 'tab'],
    ['#ap-prev,.nb.l,.upnav.prev,[onclick="spin(-1)"],[onclick*="cycleLook(-1)"]', ['arrow', { rate: 0.89 }]],
    ['.ap-arrow,.nb,.upnav,[onclick^="spin"],[onclick^="cycleLook"]', ['arrow', { rate: 1.06 }]],
    ['.ap-save-btn,.acctbtn:not(.out),.clsend:not(.sec),#cl-send', 'confirm'],
    ['.back,.howx,.upx,.lb-x,.earn-x,.bs-no,.ap-back-btn,[onclick^="close"],[onclick*=".close"],[onclick*="cancel"],[onclick*="backCash"],.acctbtn.out,#me-out', 'close'],
    ['.waddr .cp,.jn-ls:has(.jn-cp),[data-copy],.cp', 'copy'],
    ['[onclick^="open"],[onclick*="headerTap"],[onclick*="openUpload"],[onclick*="openSubmit"],#wbtn,.wbtn,#mebtn,.lookrow,.lbrow,.lb-all,.evhow,.allbtn,.mebt,.upcard,.jn-big', 'open'],
    ['.czb,.maxbtn', 'select'],
  ];
  function pick(el) {
    for (const [sel, s] of MAP) {
      let hit = false;
      try { hit = el.matches(sel); } catch (_) {}        // an old browser without :has() just skips that row
      if (hit) return typeof s === 'function' ? s(el) : s;
    }
    return 'tap';
  }
  const CLICKABLE = 'button,a[href],[role="button"],[role="switch"],[role="tab"],[onclick],summary,label,input[type="checkbox"],input[type="radio"]';
  const BACKDROPS = '.howveil,.meveil,#bsheet';
  const HOVERABLE = 'button,a[href],[role="button"],[role="switch"],[role="tab"],.card';
  const TYPING = 'input:not([type="checkbox"]):not([type="radio"]),textarea,select';

  function target(t) {
    const el = t && t.closest ? t.closest(CLICKABLE) : null;
    if (!el) return t && t.matches && t.matches(BACKDROPS) ? { el: t, s: 'close' } : null;   // tapping outside a sheet closes it
    if (el.disabled || att(el, 'aria-disabled') === 'true' || el.matches(TYPING)) return null;
    return { el: el, s: pick(el) };
  }
  let done = null;                   // the element that already sounded for this press, so its click is not a second sound
  function sound(t) {
    const hit = target(t);
    if (!hit) return;
    const [name, opt] = Array.isArray(hit.s) ? hit.s : [hit.s, null];
    play(name, opt);
    lastClick = performance.now();
    done = { el: hit.el, at: lastClick };
  }
  const same = (a, b) => a === b || a.contains(b) || b.contains(a);
  let touch = null;
  window.addEventListener('pointerdown', e => {
    S.wake();
    if (!on || e.button > 0) return;
    if (e.pointerType === 'touch') { touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.target }; return; }
    sound(e.target);
  }, { capture: true, passive: true });
  window.addEventListener('pointerup', e => {
    if (!touch || e.pointerId !== touch.id) return;
    const t = touch; touch = null;
    if (on && Math.abs(e.clientX - t.x) < 10 && Math.abs(e.clientY - t.y) < 10) sound(t.t);
  }, { capture: true, passive: true });
  window.addEventListener('pointercancel', () => { touch = null; }, { capture: true, passive: true });
  window.addEventListener('keydown', e => {
    if (!on || e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
    const a = document.activeElement;
    if (a && a !== document.body && !a.matches(TYPING)) sound(a);
  }, { capture: true, passive: true });
  window.addEventListener('click', e => {
    if (!on || e.button > 0) return;
    const el = e.target && e.target.closest ? (e.target.closest(CLICKABLE) || e.target) : null;
    if (done && el && performance.now() - done.at < 1000 && same(done.el, el)) { done = null; return; }
    sound(e.target);
  }, { capture: true, passive: true });

  /* Hover: mouse only, once per element, never faster than every 90 ms. */
  let hovEl = null, hovAt = -1e9;
  window.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target && e.target.closest ? e.target.closest(HOVERABLE) : null;
    if (el === hovEl) return;
    hovEl = el;
    if (!el || !on || !hov || el.disabled || att(el, 'aria-disabled') === 'true') return;
    const t = performance.now();
    if (t - hovAt < 90) return;
    hovAt = t;
    play('hover', { vol: 0.5 });
  }, { capture: true, passive: true });

  /* A game opening suspends the lobby's audio entirely; it wakes on the way back. */
  const syncGame = () => S.hold(ingame());
  function watchBody() {
    if (!document.body) return;
    new MutationObserver(syncGame).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.body) watchBody(); else document.addEventListener('DOMContentLoaded', watchBody);

  function setOn(b) {
    on = !!b;
    lsPut(LS_ON, on ? '1' : '0');
    if (on) { S.hold(ingame()); play('toggleOn', { gap: 0 }); }
  }
  function setVol(v) {
    vol = Math.max(0, Math.min(1, +v || 0));
    lsPut(LS_VOL, String(vol));
  }
  function setHover(b) { hov = !!b; lsPut(LS_HOV, hov ? '1' : '0'); }

  window.DSSound = {
    play: play, toast: toast, roll: roll,
    on: () => on, setOn: setOn, vol: () => vol, setVol: setVol, hover: () => hov, setHover: setHover,
    names: () => S.names().filter(n => n.startsWith('ui.')).map(n => n.slice(3)),
    _pick: pick,
  };
})();
