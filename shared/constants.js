const CONSTANTS = {
  // Server tick rate (simulation). Snapshots are broadcast at SNAPSHOT_RATE, which
  // is lower to halve the data each client must receive — weaker devices on marginal
  // connections (e.g. a phone on a so-so WiFi) couldn't drain a 60Hz stream and
  // backed up. The client interpolates between snapshots so the lower rate is invisible.
  TICK_RATE: 60,
  SNAPSHOT_RATE: 30,

  // World
  BASE_WORLD_RADIUS: 2000,
  WORLD_RADIUS_PER_PLAYER: 200,
  MIN_WORLD_RADIUS: 1200,
  MAX_WORLD_RADIUS: 6000,

  /* Cashing out. Both numbers are the SERVER's: it times the hold and applies
     the slowdown itself, and the client uses the same values only so its own
     prediction and its ring animation line up.

     They are the price of banking a snake in a real-money game — you crawl,
     and everyone can see the ring and come for you. That has to be enforced
     where it cannot be edited out. */
  CASHOUT_HOLD_MS: 3000,
  CASHOUT_MIN_SPEED_MULT: 0.2,

  // Snake
  SNAKE_BASE_SPEED: 3,
  SNAKE_SEGMENT_SPACING: 3,
  SNAKE_HEAD_RADIUS: 10,
  // Min = spawn, exactly like slither.io (its snakes spawn at sct=2 and can never shrink
  // below it — boosting cuts off at spawn size instead of shrinking past it).
  SNAKE_MIN_SEGMENTS: 10,
  SNAKE_SPAWN_SEGMENTS: 10,
  // slither.io's max turn is mamu = .033 rad per 8ms frame = 4.125 rad/s; at our 60Hz
  // tick that is 4.125/60 = .06875 rad/tick. (Was 0.08 — 16% twitchier than slither.)
  MAX_TURN_RATE: 0.06875, // radians per tick at scale 1; degrades with size (see Snake.turnRate)
  // Snake "scale" grows with length and drives turn heaviness, thickness, zoom & spacing.
  // 106 mirrors slither.io exactly: its scale is min(6, 1+(sct-2)/106). With growth hard-capped
  // at GROWTH_MSCPS parts (below), the max reachable scale is 1+409/106 ≈ 4.86 — same as slither,
  // where sct also caps at 411 so a snake never actually reaches scale 6 through length.
  SNAKE_SC_SEGS: 106,

  // Food
  FOOD_RADIUS: 3,
  FOOD_EAT_RADIUS: 20,
  // 5x the original 720. This was held at 1440 for a while because food was
  // costing ~14ms/frame to draw at 800 visible pellets and ~141 bytes/pellet on
  // the wire. Both of those are fixed now, and re-measured at 5x:
  //   render   FoodGL batches the pellets into 3 GPU draw calls — 3000 pellets
  //            cost 5.6ms instead of 60ms (public/js/FoodGL.js)
  //   wire     the snapshot codec packs a pellet into 12 fixed bytes instead of
  //            a ~141-byte JSON object — ~1800 visible pellets is ~23KB per
  //            snapshot, still well under what 1440 used to cost
  //   server   the two loops that scale with TOTAL food (per-tick spatial grid
  //            rebuild, per-snapshot view cull) come to ~2.5% of one core
  FOOD_SPAWN_COUNT: 3600,
  FOOD_RESPAWN_INTERVAL: 2000,
  FOOD_PER_GROWTH: 1,
  SEGMENTS_PER_FOOD: 1,
  // slither.io's exact growth curve: the cost of body part i scales as 1/(1 - i/mscps)^2.25
  // (its fmlts table), i.e. food converts to segments at rate (1 - parts/411)^2.25 — near 1 when
  // small, grinding toward 0, and growth stops entirely at 411 parts (score still accumulates).
  GROWTH_MSCPS: 411,  // slither's mscps — hard cap on body parts
  GROWTH_EXP: 2.25,   // slither's fmlts exponent

  // Boost — boost ramps per-tick speed up toward SNAKE_MAX_SPEED (a fixed cap). Base speed rises
  // with size but the cap doesn't, so the boost *ratio* shrinks as you grow (slither.io feel).
  // Exact slither.io speed curve, scaled into our units (k = 3/4.75, anchoring our base 3 to
  // slither's base nsp1+nsp2 = 4.75): base speed nsp1+nsp2*sc → 4.75..7.25, boost target nsp3 = 12.
  SNAKE_MAX_SPEED: 7.579,     // = 12 * 3/4.75 — boost ratio 2.526x small / 1.655x huge, slither-exact
  SNAKE_SPEED_PER_SC: 0.3158, // = 0.5 * 3/4.75 — base speed ratio 1.526x small→huge, slither-exact
  BOOST_FOOD_COST: 0.05, // food units per tick
  // Boost speed dynamics, slither.io shape: constant-accel ramp UP (its +.3/8ms frame over
  // the base→boost gap ≈ 200ms = 12 ticks), and on release an exponential GLIDE back down
  // (its sp -= (sp-ssp)/20 per 8ms frame = ~160ms time constant) — never an instant stop.
  BOOST_RAMP_TICKS: 12,  // ticks of linear ramp to full boost (~200ms at 60Hz)
  BOOST_DECAY_MS: 160,   // release glide time constant (settles in ~450ms)

  // Border
  BORDER_SHRINK_PER_DEATH: 100,
  BORDER_GROW_PER_JOIN: 200,

  // Hex grid
  HEX_RADIUS: 40,

  // Socket events
  EVENTS: {
    // Client -> Server
    PLAY: 'play',
    INPUT: 'input',
    RESPAWN: 'respawn',
    CHAT: 'chat',          // in-game chat: client sends {text}; server re-broadcasts {name, text} to the room
    WALLET_CONNECT: 'wallet_connect',
    WALLET_DEPOSIT: 'wallet_deposit',
    WALLET_WITHDRAW: 'wallet_withdraw',

    // Server -> Client
    LOBBY_STATE: 'lobby_state',
    GAME_JOINED: 'game_joined',
    SNAPSHOT: 'snapshot',
    PLAYER_DIED: 'player_died',
    PLAYER_KILLED: 'player_killed',
    WALLET_BALANCE: 'wallet_balance',
    ERROR: 'error',
  }
};

if (typeof module !== 'undefined') module.exports = CONSTANTS;
