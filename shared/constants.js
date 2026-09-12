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

  /* Snake speed.
     What matters for the look is speed measured against the SCREEN, not against
     world units, because our camera is zoomed in tighter than theirs: we show
     about 970 world units across, slither shows about 1296. Measured on their
     live game, their snake covers 0.137 of the view width per second. At 3 we
     covered 0.186 — 35% too fast, which is also why our turn felt wide, since
     the turn circle is speed divided by turn rate and our turn rate already
     matches theirs exactly. Scaling all three speeds by 0.74 puts us on their
     0.137 and pulls the turn circle in by the same 26%. */
  SNAKE_BASE_SPEED: 2.22,
  /* Body point spacing, and it SCALES WITH THE SNAKE — this is why our snakes
     got fat without getting long, and why circling made one open ring instead of
     a coil. Both complaints are the same bug.

     Their spacing grows with size (7 per unit of scale against a 14.5 body
     radius, a ratio of 0.483), so their body length grows with the SQUARE of
     scale. Ours was a flat 3, so length grew only linearly and the snake got
     thick far faster than it got long. Matching their ratio against our own
     10-unit radius gives 4.83 per unit of scale.

     What that does to circling, counting how many times the body wraps its own
     minimum turn circle:
                    scale 2        scale 3
       flat 3       1.2 wraps      1.5 wraps     <- one open ring, never a coil
       4.83 * sc    4.0 wraps      7.1 wraps
       slither      3.9 wraps      7.7 wraps
     A spiral is just having enough body to go round more than once. Ours never
     did. Segment COUNT is untouched, so score, boost fuel and bandwidth are
     exactly as they were — only the distance between points changes.

     SNAKE_SEGMENT_SPACING stays as the scale-1 value for spawn layout. */
  SNAKE_SEGMENT_SPACING: 3,
  SNAKE_SEP_PER_SC: 4.83,

  /* HOW COARSE THE STORED BODY IS, AND HOW HARD IT CUTS CORNERS.
     Together these two are the coil.

     Corner-cutting drift is proportional to the GAP between stored points, at
     roughly 0.77 * gap of inward movement per lap. That is why every earlier
     attempt failed: they all changed the pull and left the gap alone.

     Measured off a live slither snake at scale 2.29: stored points sat a mean of
     22 units apart against a body radius of 33.2, a ratio of 0.663. Ours were
     2.4 apart against a radius of 20, a ratio of 0.12. Five times finer, so the
     same 0.43 pull moved the body a fifth as far and the coil was invisible.

     With their ratio and their pull the drift comes out at 0.26 body widths per
     lap, which is a coil you can see. Their body is about 100 stored points; the
     fine version was about 720 for the same length. The draw-time spline makes a
     coarse polyline look smooth, which is how theirs reads right on 100 points,
     and it cuts the wire data too. */
  SNAKE_STORED_GAP_PER_R: 0.663,   // stored gap / body radius, measured off their snake

  /* Their cst. Each stored point is pulled this far toward the point ahead, once
     per point laid, eased in over the first four so the neck stays loose. This
     is the corner cutting, and it is what makes a held turn wind inward. */
  SNAKE_BODY_PULL: 0.43,

  /* The pull also COMPRESSES the stored gaps, so points have to be laid further
     apart than they end up. Theirs settle to 22 from a 42 insert, a factor of
     0.52. This is measured against our own sim rather than assumed: see the
     settled-gap figure in the body-model harness. */
  SNAKE_INSERT_COMPENSATION: 1.375,  // tuned to the measurement: 1.276 gave 0.590, 1.35 gave 0.626, 1.43 gave 0.743, target 0.663
  /* Half the snake's width. Measured on their live snake this is 14.5 per unit
     of scale in THEIR world units — but it was wrong to copy that number across,
     because our camera is zoomed in tighter than theirs. What has to match is
     how much of the SCREEN the snake takes up, and on that measure 10 was
     already right: their body is 0.0112 of their view width, ours at 10 is
     0.0103, ours at 14.5 was 0.0149 — a third too fat, which is exactly the
     "insanely massive" snake. The turn-circle problem 14.5 was meant to fix is
     really a speed problem and is fixed above instead. */
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
  /* How far past the border food is allowed to sit, in an ordinary room.
     The red zone is somewhere you can briefly be, so food out there is
     reachable and worth having. A battle royale passes 0 instead: outside its
     circle is instant death, so a pellet there is bait nobody can take. */
  FOOD_SPAWN_MARGIN: 1600,
  /* THE TARGET IS A DENSITY, NOT A HEADCOUNT.

     It used to be a headcount, and in a battle royale that is the bug: refill
     asked `FOOD_SPAWN_COUNT - items.size`, and once the circle had shrunk away
     from three thousand pellets stranded out in the red zone, the answer was
     zero. Measured on the real room, the playable zone held literally NO food
     from about 165s onward while the global count sat at 3711. The food was
     never eaten; it was left behind.

     Calibrated so an ordinary room is unchanged: a free room sits at
     BASE_WORLD_RADIUS with a FOOD_SPAWN_MARGIN skirt, and that disc holding
     FOOD_SPAWN_COUNT pellets IS this number. Every other room is then the same
     arena per unit of area rather than the same arena per room.

     This is our own measured density, not a slither constant. Their food is
     per-sector (sector_size 480, world grd 16384, every pellet carries fo.sx
     /fo.sy) — that architecture is read from their client and is what this
     copies. The per-sector COUNT is server-side and not in their client, so it
     is deliberately not guessed at here. */
  get FOOD_DENSITY() {
    const r = this.BASE_WORLD_RADIUS + this.FOOD_SPAWN_MARGIN;
    return this.FOOD_SPAWN_COUNT / (Math.PI * r * r);
  },
  FOOD_RESPAWN_INTERVAL: 2000,
  FOOD_PER_GROWTH: 1,
  SEGMENTS_PER_FOOD: 1,
  // slither.io's exact growth curve: the cost of body part i scales as 1/(1 - i/mscps)^2.25
  // (its fmlts table), i.e. food converts to segments at rate (1 - parts/411)^2.25 — near 1 when
  // small, grinding toward 0, and growth stops entirely at 411 parts (score still accumulates).
  GROWTH_MSCPS: 411,  // slither's mscps — hard cap on body parts
  GROWTH_EXP: 2.25,   // slither's fmlts exponent

  /* How much of a snake's mass its corpse is worth.

     A corpse used to be worth a fixed amount PER SEGMENT, which has nothing
     to do with what the snake ate: measured, a spawn-size snake dropped 4.85x
     its own mass, so dying at minimum size and eating your own body made you
     several times bigger than you started. The same formula gave a 411-part
     snake 0.03x, because real mass explodes near the cap while segment count
     does not.

     Below 1 is what makes dying a loss rather than a move: eating your entire
     corpse returns this share of what you had, and you respawn at spawn size,
     so suicide can never be a gain at any size.

     THIS IS THE ONE NUMBER HERE NOT READ OUT OF SLITHER'S CODE. Their growth
     curve, their part cap and their mass function are all theirs, taken from
     their live bundle. The corpse share is decided on their SERVER and their
     client never sees it — the client is told its fullness, never the value
     of what it ate — so there was nothing to read. */
  CORPSE_DROP_RATIO: 0.6,

  // Boost — boost ramps per-tick speed up toward SNAKE_MAX_SPEED (a fixed cap). Base speed rises
  // with size but the cap doesn't, so the boost *ratio* shrinks as you grow (slither.io feel).
  // Exact slither.io speed curve, scaled into our units (k = 3/4.75, anchoring our base 3 to
  // slither's base nsp1+nsp2 = 4.75): base speed nsp1+nsp2*sc → 4.75..7.25, boost target nsp3 = 12.
  // Both scaled by the same 0.74 as SNAKE_BASE_SPEED, so every speed ratio
  // (boost multiplier, growth of base speed with size) is exactly as it was.
  SNAKE_MAX_SPEED: 5.609,     // boost ratio 2.526x small / 1.655x huge, slither-exact
  SNAKE_SPEED_PER_SC: 0.2337, // base speed ratio 1.526x small→huge, slither-exact
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
  },

  /* The lobby types that cost nothing to enter.

     This exists because the string 'free' kept being used to MEAN "costs
     nothing", in four separate places, and every one of them broke the day a
     second free lobby existed: the fee table refused to price it, the entry
     check demanded a paid token for it, the wallet widget tried to stake into
     it, and the game client treated it as a paid room and refused to respawn.
     Four bugs, one assumption. It is a list now, and it is shared. */
  FREE_LOBBY_TYPES: ['free', 'br'],

  /* How many snakes a FREE room is kept topped up to, bots included.

     A lobby you can walk into and find empty is the cold start the whole
     product is fighting, and bots existed here already: what was missing was
     anything to keep them coming. They were added by hand from the owner
     console, they died, and nothing replaced them, so the room drained back
     to empty on its own.

     ONLY EVER APPLIED TO A FREE ROOM. See GameRoom.botsAllowed, and the
     comment on it, which is the one rule that matters here. */
  BOT_FLOOR_FREE: 20,
  /* HOW BUSY A FREE ROOM LOOKS, and it is a range rather than a number.

     It was a flat 20, forever. Anyone who opened the lobby twice in one day saw
     exactly twenty both times, and twenty at four in the morning is not a
     figure a real game produces — a constant is the tell. The target now walks a
     daily curve between these two, quiet before dawn and busiest in the evening
     beside the nightly event. See server/botPopulation.js.

     ⚠️ THE TOP OF THIS RANGE COSTS CPU. Every bot is a snake the server
     simulates and ships. Raising BOT_MAX is not free; it is the one number here
     that can put a room near the measured per-lobby ceiling. */
  BOT_MIN: 22,
  /* MEASURED, not chosen. Swept on the real room with one viewer, after the
     per-snapshot snake cap below:

       bots | tick    | KB/s per player
         20 | 1.51ms  | 212
         40 | 2.49ms  | 301
         55 | 2.87ms  | 336     <- the knee
         70 | 3.93ms  | 623
        101 | 4.59ms  | 757

     The step between 55 and 70 is where per-player bandwidth nearly doubles.
     101 also spent a quarter of the tick budget on bots alone before a single
     real player had joined, and a late tick is exactly what is felt as lag.

     55 still swings two and a half times across a day, which is the point of
     having a range at all — nobody mistakes 22-at-dawn / 55-at-nine for a
     constant. Raise it knowing what it costs; the table above is the price. */
  BOT_MAX: 55,
  /* HOW MANY SNAKE BODIES ANY ONE PLAYER IS SENT PER SNAPSHOT.

     The per-cell region is the cell plus a full view radius, which on a world
     twelve thousand units across is most of the map — so before this, every
     snake in the room went into every payload. Harmless at twenty. Measured at
     a hundred, on the real room with one viewer:

       20 bots   6.3KB/snapshot   185 KB/s per player   1.6ms/tick
      101 bots  29.7KB/snapshot   869 KB/s per player   6.7ms/tick

     Bodies are the expensive part and the only part that needs range: a snake
     far enough away to be cut is one you cannot see. The minimap is unaffected
     — `mm` carries every head in the room separately and is tiny — so a busy
     room still looks busy.

     Raise it if snakes ever pop in at the edge of a crowded screen; that is the
     one symptom this can cause. */
  SNAKES_PER_SNAPSHOT: 28,
};

if (typeof module !== 'undefined') module.exports = CONSTANTS;
