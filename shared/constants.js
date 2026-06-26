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
  MAX_TURN_RATE: 0.08, // radians per tick at scale 1; degrades with size (see Snake.turnRate)
  // Snake "scale" grows 1 → 6 with length and drives turn heaviness, thickness, zoom & spacing
  // (the slither.io-style size feel). Reaches 6 at SNAKE_MIN_SEGMENTS + 5*SNAKE_SC_SEGS segments.
  SNAKE_SC_SEGS: 80,

  // Food
  FOOD_RADIUS: 3,
  FOOD_EAT_RADIUS: 20,
  FOOD_SPAWN_COUNT: 720,
  FOOD_RESPAWN_INTERVAL: 2000,
  FOOD_PER_GROWTH: 1,
  SEGMENTS_PER_FOOD: 1,
  GROWTH_FALLOFF_LEN: 250, // diminishing growth: around this length, food adds ~half as many segments

  // Boost — boost ramps per-tick speed up toward SNAKE_MAX_SPEED (a fixed cap). Base speed rises
  // with size but the cap doesn't, so the boost *ratio* shrinks as you grow (slither.io feel).
  SNAKE_MAX_SPEED: 6.5,    // boost speed cap, per tick (~2.2x base when small, ~1.4x when huge)
  SNAKE_SPEED_PER_SC: 0.3, // base speed added per unit of scale above 1 (base = SNAKE_BASE_SPEED at scale 1)
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
