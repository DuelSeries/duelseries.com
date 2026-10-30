/* The tracking plan: EVERY product event DuelSeries sends to PostHog, with the properties each one may carry
   (Owen 2026-10-29: "track absolutely everything", kept organized). One list, read by the browser helper
   (public/js/shared/dsTrack.js) and the server (server/analytics.js), so a game cannot invent its own name or
   spell a property its own way: an event not listed here is dropped with a warning, and a property not listed
   for its event is dropped too. test/trackPlan.test.js checks every call site in the code names a listed event.
   The readable copy for Owen is "Claude Code Test/DuelSeries tracking plan.html".

   who:  'client' (the browser sends it), 'server' (only the server may, because it moved money or decided a
         paid result), 'both' (free from the browser, paid from the server: game_started and game_ended).
   Money is in dollars (amount, stake, net, price), as the games count; amount_sol where SOL itself moved.
   Never a key, a signature, a token, an email or a balance.

   Loaded as a plain script it lands on window.DSTrackPlan; required, it is module.exports. */
(function (root) {
  'use strict';

  /* Every game, by the one id dashboards break down on. Aliases fold the many spellings the code uses
     (the lobby's 'snake', the page '/sl', agar.io's 'ag', Pac-Man's 'chomp') into it. */
  var GAMES = ['slither', 'br', 'paper', 'agar', 'chomp', 'knockout', 'battleship', 'swim', 'headsoccer', 'pool8',
    'airhockey', 'rooftop', 'crossy', 'tanks', 'shooter'];
  var GAME_ALIAS = { snake: 'slither', sl: 'slither', slx: 'slither', 'slither.io': 'slither', ag: 'agar',
    'agar.io': 'agar', 'paper-arena': 'paper', 'paper.io': 'paper', pacman: 'chomp', 'pac-man': 'chomp',
    battle_royale: 'br', battleroyale: 'br', 'slbr': 'br', ko: 'knockout', bs: 'battleship', hs: 'headsoccer',
    'head-soccer': 'headsoccer', pool: 'pool8', '8ball': 'pool8', ah: 'airhockey', 'air-hockey': 'airhockey',
    rt: 'rooftop', 'rooftop-snipers': 'rooftop', 'crossy-road': 'crossy', omg: 'shooter', omgshooter: 'shooter' };

  // How a game ended for the player. The server decides it for every paid game.
  var RESULTS = ['won', 'lost', 'draw', 'died', 'cashed_out', 'left', 'refunded', 'ended'];

  // Where a player is when they leave a game page.
  var STAGES = ['loading', 'queue', 'playing', 'end_card', 'spectating'];

  /* Property types: 'str' (trimmed, at most 120 characters), 'num' (finite, else dropped), 'bool',
     'game' (folded to GAMES), 'result' (one of RESULTS), 'stage' (one of STAGES). */
  var PROPS = {
    game: 'game', paid: 'bool', stake: 'num', mode: 'str', room: 'str', region: 'str', vs_bot: 'bool', guest: 'bool',
    engine: 'str', result: 'result', duration_s: 'num', score: 'num', amount: 'num', amount_sol: 'num', net: 'num',
    place: 'num', players: 'num', reason: 'str', stage: 'stage', wait_s: 'num', tab: 'str', where: 'str',
    method: 'str', new_user: 'bool', step: 'str', error: 'str', how: 'str', action: 'str', item: 'str',
    price: 'num', asset: 'str', verified: 'bool', wallet_app: 'str', fps_avg: 'num', fps_p10: 'num',
    fps_min: 'num', ping_avg: 'num', ping_p50: 'num', ping_p90: 'num', ping_max: 'num', samples: 'num',
    disconnects: 'num', reconnects: 'num', down_s: 'num', hidden_s: 'num', kind: 'str'
  };

  var G = ['game', 'paid', 'stake', 'mode', 'room', 'region', 'vs_bot', 'guest', 'engine', 'players'];
  function plus(a, b) { return a.concat(b); }

  var EVENTS = {
    // ── Traffic and the lobby (where people go, what they click) ──
    lobby_tab_viewed:  { who: 'client', props: ['tab'], about: 'A lobby tab opened (Play, Events, Wallet, Shop, ...)' },
    game_card_clicked: { who: 'client', props: ['game', 'where'], about: 'A game card tapped in the lobby' },
    play_clicked:      { who: 'client', props: ['game', 'paid', 'stake', 'mode', 'guest', 'engine'], about: 'Play pressed on a game (before any stake or load)' },
    invite_copied:     { who: 'client', props: ['game'], about: 'An invite link copied' },
    invite_opened:     { who: 'client', props: ['game'], about: 'Someone arrived on a /play/<game> invite link' },
    score_shared:      { who: 'client', props: ['game', 'how'], about: 'A score shared from an end card' },
    support:           { who: 'client', props: ['action'], about: 'The support panel used' },
    shop_viewed:       { who: 'client', props: ['tab', 'game'], about: 'The Shop opened (or a shop section)' },
    customize_opened:  { who: 'client', props: ['game'], about: 'Customize opened for a game' },
    skin_buy_started:  { who: 'client', props: ['game', 'item', 'price'], about: 'Buy pressed on a paid skin' },
    spectate_started:  { who: 'client', props: ['game', 'paid', 'stake'], about: 'Started watching a live game' },

    // ── Signing in (and where people give up) ──
    signin_opened:     { who: 'client', props: ['where'], about: 'Sign in pressed (the Privy window opens)' },
    signed_in:         { who: 'client', props: ['method', 'new_user', 'wallet_app'], about: 'Signed in; the person is identified by wallet from here on' },
    signin_abandoned:  { who: 'client', props: ['step'], about: 'The sign-in window closed without signing in' },
    signin_failed:     { who: 'client', props: ['step', 'error'], about: 'Sign in went wrong' },
    wallet_setup_failed: { who: 'client', props: ['error'], about: 'Signed in, but the game wallet could not be made' },
    wallet_linked:     { who: 'client', props: ['wallet_app'], about: 'A browser wallet linked to the account' },
    signed_out:        { who: 'client', props: [], about: 'Signed out (PostHog starts a new anonymous visitor)' },

    // ── Every game, start to end (same names and properties in every game) ──
    game_opened:       { who: 'client', props: G, about: 'A game page loaded' },
    queue_joined:      { who: 'client', props: G, about: 'Joined a duel queue (waiting for an opponent)' },
    queue_left:        { who: 'client', props: plus(G, ['wait_s', 'reason']), about: 'Left a duel queue before a match' },
    game_started:      { who: 'both', props: G, about: 'In a game: a seat in an arena or a matched duel. Paid ones come from the server' },
    game_ended:        { who: 'both', props: plus(G, ['result', 'duration_s', 'score', 'amount', 'net', 'place', 'reason']),
                         about: 'A game over for this player. Paid ones (result and money) come from the server' },
    game_quit:         { who: 'client', props: plus(G, ['stage', 'duration_s']), about: 'Left the game page before the game ended' },

    // ── Lag, errors and dropped connections (one summary per game, never per frame) ──
    game_perf:         { who: 'client', props: plus(G, ['duration_s', 'fps_avg', 'fps_p10', 'fps_min', 'ping_avg', 'ping_p50',
                         'ping_p90', 'ping_max', 'samples', 'disconnects', 'reconnects', 'hidden_s']), about: 'FPS and ping summary for one game page visit' },
    game_disconnected: { who: 'client', props: plus(G, ['reason', 'stage']), about: 'The game connection dropped' },
    game_reconnected:  { who: 'client', props: plus(G, ['down_s']), about: 'The game connection came back' },

    // ── Money steps (anything that moved money is sent by the server) ──
    add_funds_opened:  { who: 'client', props: ['where', 'method'], about: 'Add funds opened (method: card, crypto, linked, or any)' },
    funded:            { who: 'both', props: ['amount', 'amount_sol', 'method', 'verified'], about: 'Money arrived in the wallet. Linked-wallet adds come from the server (verified); card and crypto from the lobby seeing the balance rise' },
    withdraw_opened:   { who: 'client', props: ['where'], about: 'Withdraw opened' },
    withdraw_failed:   { who: 'client', props: ['error', 'asset'], about: 'A withdraw did not go through' },
    withdraw_sent:     { who: 'server', props: ['amount', 'amount_sol', 'asset'], about: 'A withdraw left the wallet (relayed and confirmed by the server)' },
    stake_paid:        { who: 'server', props: ['stake', 'amount_sol'], about: 'A buy-in landed in escrow (before the seat)' },
    stake_refunded:    { who: 'server', props: ['game', 'stake', 'amount', 'reason'], about: 'A buy-in handed back (no seat, no match, a draw)' },
    house_earning:     { who: 'server', props: ['source', 'amount', 'revenue', 'game', 'lobby_type', 'region'], about: 'House money: rake, skins, bot costs (signed)' }
  };
  // house_earning predates the plan; its own three properties are listed here so the server can keep sending them.
  PROPS.source = 'str'; PROPS.revenue = 'num'; PROPS.lobby_type = 'str';

  // Added to every event by the helpers, never by a call site.
  var SUPER = ['is_owner', 'page', 'device', 'ft_source', 'ft_medium', 'ft_campaign', 'ft_content', 'ft_term',
    'ft_click', 'ft_referrer', 'ft_landing', 'ft_invite', 'ft_at'];

  function game(v) {
    if (v == null) return null;
    var s = String(v).trim().toLowerCase().replace(/^\//, '');
    if (GAMES.indexOf(s) >= 0) return s;
    return Object.prototype.hasOwnProperty.call(GAME_ALIAS, s) ? GAME_ALIAS[s] : null;
  }

  function cast(type, v) {
    if (v === undefined || v === null || v === '') return undefined;
    switch (type) {
      case 'num': { var n = typeof v === 'number' ? v : Number(v); return isFinite(n) ? Math.round(n * 1e6) / 1e6 : undefined; }
      case 'bool': return v === true || v === 1 || v === 'true' ? true : v === false || v === 0 || v === 'false' ? false : undefined;
      case 'game': return game(v) || undefined;
      case 'result': return RESULTS.indexOf(String(v)) >= 0 ? String(v) : undefined;
      case 'stage': return STAGES.indexOf(String(v)) >= 0 ? String(v) : undefined;
      default: return typeof v === 'object' ? undefined : String(v).trim().slice(0, 120);
    }
  }

  /* The checked copy of one event's properties: { ok, props, dropped }. ok is false for a name not in the plan
     (the event must not be sent). PostHog's own events ($pageview, $exception, ...) pass through untouched. */
  function clean(name, props) {
    var out = {}, dropped = [];
    props = props && typeof props === 'object' ? props : {};
    if (typeof name === 'string' && name.charAt(0) === '$') {
      for (var k0 in props) if (Object.prototype.hasOwnProperty.call(props, k0)) out[k0] = props[k0];
      return { ok: true, props: out, dropped: dropped };
    }
    var ev = Object.prototype.hasOwnProperty.call(EVENTS, name) ? EVENTS[name] : null;
    if (!ev) return { ok: false, props: out, dropped: Object.keys(props) };
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      if (ev.props.indexOf(k) < 0 || !PROPS[k]) { if (SUPER.indexOf(k) < 0) dropped.push(k); else out[k] = props[k]; continue; }
      var v = cast(PROPS[k], props[k]);
      if (v === undefined) { if (props[k] !== undefined && props[k] !== null && props[k] !== '') dropped.push(k); continue; }
      out[k] = v;
    }
    return { ok: true, props: out, dropped: dropped };
  }

  var PLAN = { EVENTS: EVENTS, PROPS: PROPS, GAMES: GAMES, GAME_ALIAS: GAME_ALIAS, RESULTS: RESULTS, STAGES: STAGES,
    SUPER: SUPER, game: game, clean: clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = PLAN;
  if (root) root.DSTrackPlan = PLAN;
})(typeof window !== 'undefined' ? window : null);
