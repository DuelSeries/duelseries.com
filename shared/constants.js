const CONSTANTS = {
  // Server tick rate
  TICK_RATE: 60,

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
  SNAKE_SPAWN_SEGMENTS: 5,
  MAX_TURN_RATE: 0.08, // radians per tick

  // Food
  FOOD_RADIUS: 3,
  FOOD_EAT_RADIUS: 20,
  FOOD_SPAWN_COUNT: 120,
  FOOD_RESPAWN_INTERVAL: 2000,
  FOOD_PER_GROWTH: 1,
  SEGMENTS_PER_FOOD: 1,

  // Boost
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
