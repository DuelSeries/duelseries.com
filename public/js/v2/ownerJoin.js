'use strict';
/* ─── Join from Control (the owner console's Live tab, public/js/ownerLive.js) ──────
   Control's Join opens this lobby as /?ownerjoin=<game>&stake=<rung>&do=play|watch, in one reused tab. This opens
   that game's screen on that rung and then does what a person would do there:
     play, Free (or a duel's Free, or the battle royale)   presses Play, once the wallet says who is signed in
     play, a paid rung                                     only picks the rung: the stake waits for Owen's own Play
     watch                                                 presses Spectate on that rung (or watches the event)
   It names no room id and carries no money: everything after is the lobby's own Play and Spectate, unchanged, and
   anybody who opens such a link gets exactly what pressing those buttons gives them. */
(function () {
  const m = /[?&]ownerjoin=([a-z0-9]{1,16})/.exec(location.search);
  if (!m) return;
  const q = new URLSearchParams(location.search);
  const game = m[1];
  const stake = Number(q.get('stake')) > 0 ? Math.round(Number(q.get('stake')) * 100) / 100 : 0;
  const act = q.get('do') === 'watch' ? 'watch' : 'play';
  /* The lobby is the lobby again: a reload or Back is home, not a second join. */
  try { history.replaceState(history.state, '', '/'); } catch (_) {}

  const READY_MS = 4000;   // Privy not ready by then: Play anyway (a free room plays as a guest)
  const BOARD_MS = 5000;   // the rungs come from the board: wait this long for it at most
  const say = (title, detail) => { if (window.DSToast) DSToast.show({ kind: 'info', title: title, detail: detail }); };
  const boardIn = () => !!(window.V2Board && Array.isArray(V2Board.lobbies) && V2Board.lobbies.length);
  const walletReady = () => !!(window.duelWallet && (window.duelWallet.ready || window.duelWallet.authenticated));

  function when(test, ms, then) {
    const t0 = Date.now();
    const tick = () => { if (test() || Date.now() - t0 >= ms) then(); else setTimeout(tick, 100); };
    tick();
  }

  function event() {
    if (!window.V2Play) return;
    if (act === 'watch') { V2Play.spectateEvent(); return; }
    when(walletReady, READY_MS, () => V2Play.launch('snake', { lobbyType: 'br' }));
  }

  function room() {
    if (typeof window.open_ !== 'function' || typeof window.pickStake !== 'function') return;
    if (window.V2_IS_SOON && window.V2_IS_SOON(game)) { say('That game is not open yet'); return; }
    try { window.open_(game, 'owner'); } catch (_) { return; }
    let i = -1;
    try { i = typeof STEPS !== 'undefined' ? STEPS.indexOf(stake) : -1; } catch (_) { i = -1; }
    if (i < 0) { say('That rung is not open right now', 'The game is on screen: pick a rung and press Play.'); return; }
    window.pickStake(i);
    const onIt = () => !!(window.V2Detail && V2Detail.game === game && Number(V2Detail.stake) === stake);
    if (act === 'watch') {
      if (typeof window.spectateFromDetail === 'function' && onIt()) window.spectateFromDetail();
      return;
    }
    if (stake > 0) { say('Press Play to join at $' + stake.toFixed(2)); return; }
    let gaveUp = false;
    document.addEventListener('pointerdown', () => { gaveUp = true; }, { once: true, capture: true });
    when(walletReady, READY_MS, () => {
      if (!gaveUp && onIt() && typeof window.startFromDetail === 'function') window.startFromDetail();
    });
  }

  function start() {
    if (game === 'br') { when(boardIn, BOARD_MS, event); return; }
    when(boardIn, BOARD_MS, room);
  }
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', start, { once: true });
})();
