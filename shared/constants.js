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

  // Snake
  SNAKE_BASE_SPEED: 3,
  SNAKE_BOOST_SPEED: 9,
  SNAKE_SEGMENT_SPACING: 3,
  SNAKE_HEAD_RADIUS: 10,
  SNAKE_MIN_SEGMENTS: 3,
  SNAKE_SPAWN_SEGMENTS: 10,
  MAX_TURN_RATE: 0.08, // radians per tick
  // Turning "heaviness": big snakes turn wider — the slither.io heavy-giant feel.
  TURN_PENALTY_MAX: 0.62,  // max fraction of turn rate lost at full size (was 0.55)
  TURN_PENALTY_SEGS: 460,  // segment span over which the penalty ramps to its max

  // Food
  FOOD_RADIUS: 3,
  FOOD_EAT_RADIUS: 20,
  FOOD_SPAWN_COUNT: 720,
  FOOD_RESPAWN_INTERVAL: 2000,
  FOOD_PER_GROWTH: 1,
  SEGMENTS_PER_FOOD: 1,

  // Boost
  BOOST_MULT: 2,         // top boost speed as a multiple of base (slither.io is ~2x; was effectively 3x)
  BOOST_FOOD_COST: 0.05, // food units per tick
  BOOST_MIN_LENGTH: 12,  // minimum length to boost

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
