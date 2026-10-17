'use strict';
// Names for the house bots in every free room (Owen 2026-10-16: "make them look like real players").
//
// One pool and one generator, shared by the slither.io bots (server/sl/slBots.js), the agar.io bots
// (server/ag/agBots.js) and the stand-in opponents of free Knockout and Battleship tables. A short fixed list was the
// loudest tell there was: agar.io had 20 names for 53 bots, so every leaderboard showed the same word two or three
// times, and the duel opponents were called "Sergeant Bot" and "Commodore Bot". Real rooms show plain first names,
// handles with a couple of digits on the end, lower case, the odd xX_name_Xx, so the generator makes those from a few
// hundred base names.
//
// Every name it can make (checked for the whole pool when this file loads, and for generated names by the tests):
//   3 to maxLen characters, printable ASCII (32 to 126), no space at either end, none of < > " ' & (the slither name
//   cleaner strips them, server/sl/slNames.js MARKUP), never 7 digits with no letter between them (their gdnm, the
//   same rule), never the word "bot" and never the slither.io brand.
//
// makeName(u, maxLen) takes ONE uniform number u in [0, 1): the base name comes from the whole part of
// u x BASE_NAMES.length and the style and digits from what is left over, so every caller keeps exactly one random
// draw per name (the slither bot spec is pinned at four draws, test/slBots.test.js).
// pickName(u, {maxLen, taken}) the same, stepping on to the next base name while taken(lower case name) says that
// name is already in the room, so two live snakes never share one and a bot never wears a seated person's name.

// Base names, all CHOSEN and ours. Each is 3 to 15 characters (agar.io's L37 name cap is 15), so every one fits every
// game; the generator only decorates when the result still fits the caller's cap.
const BASE_NAMES = Object.freeze([
  // first names, typed the way people type them
  'jake', 'Emma', 'lucas', 'mia', 'Noah', 'olivia', 'ethan', 'Ava', 'liam', 'Sophia', 'mason', 'Isabella', 'logan',
  'chloe', 'tyler', 'Grace', 'Ryan', 'zoe', 'kevin', 'nathan', 'hannah', 'dylan', 'Lily', 'caleb', 'max', 'Leo',
  'sam', 'alex', 'ben', 'jack', 'Daniel', 'matt', 'chris', 'josh', 'Tom', 'Anna', 'sarah', 'kyle', 'eric', 'jay',
  'Maria', 'Carlos', 'Diego', 'Luca', 'Mateo', 'Hugo', 'Lukas', 'Felix', 'Marco', 'Pedro', 'Ivan', 'Yuki', 'Kenji',
  'Omar', 'Sven', 'Jonas', 'Elias', 'aiden', 'Brandon', 'austin', 'Jordan', 'cameron', 'connor', 'gavin', 'Evan',
  'isaac', 'jason', 'justin', 'aaron', 'Adam', 'brian', 'cody', 'Derek', 'gabe', 'Henry', 'ian', 'jesse', 'joel',
  'Kai', 'marcus', 'nick', 'Oscar', 'patrick', 'quinn', 'Riley', 'sean', 'Theo', 'victor', 'wyatt', 'Xavier', 'zach',
  'abby', 'Bella', 'cora', 'daisy', 'Ella', 'fiona', 'gia', 'holly', 'Iris', 'kate', 'Lena', 'maya', 'Nora',
  'paige', 'rosa', 'Sofia', 'tara', 'Vera', 'willow', 'Yara', 'zara', 'Amir', 'arjun', 'Rohan', 'priya', 'Ananya',
  'Wei', 'ming', 'Jin', 'hiro', 'Sora', 'Minh', 'bao', 'Kofi', 'Amara', 'chidi', 'Tariq', 'yusuf', 'Ali', 'fatima',
  'Leila', 'nadia', 'Mehmet', 'emre', 'Pavel', 'dmitri', 'Olga', 'katya', 'Mikko', 'lars', 'Nils', 'Bjorn',
  'pierre', 'Louis', 'jules', 'Camille', 'matteo', 'Giulia', 'enzo', 'Joao', 'thiago', 'Rafa', 'bruno', 'gabi',
  'Ines', 'lucia', 'Pablo', 'javi', 'Nico', 'santi', 'Tomas', 'andres', 'Sebastian', 'Mohammed', 'ahmed', 'Hassan',
  'yasmin', 'Sara', 'noor', 'Ravi', 'vikram', 'Sanjay', 'deepak', 'Hana', 'Mei', 'chen', 'Kim', 'Jun', 'Minho',
  'Mila', 'Ivy', 'eli', 'Ezra', 'asher', 'Miles', 'Silas', 'jude', 'Rowan', 'finn', 'Axel', 'Ryder', 'colt', 'beau',
  'Knox', 'Cole', 'Brody', 'Blake', 'Reid', 'Troy', 'Shane', 'dante', 'Rocco', 'Gino', 'Marek', 'piotr', 'Kuba',
  'Ingrid', 'freya', 'Astrid', 'Erik', 'Magnus', 'Anders', 'timo', 'Jannik', 'Lea', 'Mats', 'Bram', 'Daan',
  'Lotte', 'Fenna', 'Kees', 'Zayn', 'Malik', 'Jamal', 'Tre', 'Andre', 'Darius', 'Keisha', 'Aaliyah', 'Imani',
  'Tyrone', 'Marcel', 'Remy', 'Bastien', 'Anouk', 'Saskia', 'Joon', 'Hyun', 'Daichi', 'Ren', 'Aoi', 'Haruto',
  // handles and gamer tags
  'aidan6969', 'quantum', 'Mr-1221z', 'xX_snake_Xx', 'noodleman', 'cobrakai99', 'bigworm42', 'snek_lord', 'viper0011',
  'hisssss', 'eaturdust', 'n00bslayer', 'wormhole_', 'slurpmaster', 'gg_no_re', 'tryhard99', 'just_a_worm',
  'toxic_snek', 'GigaWorm', 'boostgang', 'curvy_boi', 'nomnom_snek', 'deathcoil', 'zoomzoom22', 'slimy_steve',
  'wiggleking', 'ouroboros_', 'snekattack', 'longneck', 'ratboi420', 'fastaf_boii', 'lmaosnek', 'noobmaster_',
  'wormy_mcworm', 'danger_noodle', 'mr_slithers', 'shadowfox', 'NightOwl', 'darkknight', 'TheLegend', 'NoScope',
  'Phantom', 'Reaper', 'Viper', 'Blaze', 'Storm', 'Frost', 'Venom', 'Ace', 'Bolt', 'Dash', 'Turbo', 'Rocket',
  'Comet', 'Nova', 'Titan', 'Atlas', 'Luna', 'Sky', 'River', 'Shadow', 'Ninja', 'Phoenix', 'Thunder', 'Rex',
  'kingpin', 'savage', 'toxic', 'tryhard', 'sweaty', 'clutch', 'goat', 'legend', 'beast', 'menace', 'chaos', 'havoc',
  'lurker', 'sneaky', 'silent', 'sniper', 'striker', 'raider', 'rogue', 'outlaw', 'bandit', 'pirate', 'Captain',
  'Major', 'chief', 'boss', 'champ', 'king', 'Queen', 'prince', 'duke', 'Lord', 'doc', 'Wolf', 'Fox', 'Hawk',
  'Eagle', 'Falcon', 'Raven', 'Cobra', 'Python', 'Mamba', 'Anaconda', 'rattler', 'sidewinder', 'Medusa', 'Hydra',
  'Ghost', 'Spectre', 'Wraith', 'Zombie', 'Vampire', 'Angel', 'Saint', 'Joker', 'Jester', 'Wizard', 'Mage', 'Druid',
  'Knight', 'Paladin', 'Samurai', 'Ronin', 'Shogun', 'Viking', 'Spartan', 'Gladiator', 'Warrior', 'Ranger', 'Scout',
  'Sarge', 'Rookie', 'Veteran', 'Elite', 'Alpha', 'Omega', 'Delta', 'Sigma', 'Apex', 'Vortex', 'Nitro', 'Zoom',
  'Flash', 'Speedy', 'Rapid', 'Swift', 'Glitch', 'Pixel', 'Byte', 'Laser', 'Cyber', 'Neon', 'Chrome', 'Steel',
  'Iron', 'Gold', 'Silver', 'Onyx', 'Jade', 'Ruby', 'Opal', 'Crystal', 'Diamond', 'Ember', 'Inferno', 'Magma',
  'Lava', 'Volcano', 'Tsunami', 'Cyclone', 'Tornado', 'Blizzard', 'Avalanche', 'Quake', 'Meteor', 'Galaxy',
  'Cosmos', 'Orbit', 'Nebula', 'Quasar', 'Pulsar', 'Zenith', 'Eclipse', 'Solar', 'Lunar', 'Stellar',
  'PixelDrifter', 'MossyBoots', 'TurboSnail', 'QuietComet', 'LuckyPebble', 'NeonOtter', 'CosmicToast', 'WobblyKite',
  'BraveNoodle', 'SleepyFalcon', 'SunnyBadger', 'FrostyMango', 'MellowYeti', 'GiddyPenguin', 'CleverMoth',
  'DizzyLlama', 'BouncyFern', 'MightyPickle', 'SilentWaffle', 'ZippyTurnip', 'CozyDragon', 'FuzzyRocket',
  'NimbleGoose', 'PlaidPanda', 'RustyLantern', 'CrispyCloud', 'BoldRaccoon', 'TinyThunder', 'MintyWhale',
  'DapperMole', 'PepperWolf', 'NoodleNinja', 'LaserTurtle', 'MuffinRaider', 'PuddleJumper', 'HyperMuffin',
  'JellyBandit', 'BubbleWizard', 'quiet_storm', 'lazy_river', 'tiny_titan', 'moon_gazer', 'sky_pirate', 'pixel_pony',
  'soft_thunder', 'late_bloomer', 'night_baker', 'salty_pretzel', 'cosmic_clam', 'fuzzy_logic', 'velvet_fog',
  'paper_tiger', 'happy_camper', 'swift_current', 'frozen_ember', 'river_stone', 'candy_comet', 'turbo_turtle',
  'grumpy_cactus', 'witty_walrus', 'sleepy_sloth', 'lost_sock', 'north_wind', 'plain_bagel', 'extra_cheese',
  'zero_gravity', 'second_wind', 'half_moon', 'full_tilt', 'side_quest', 'spare_key', 'loose_change', 'hard_mode',
  'save_point', 'bonus_round', 'speed_run', 'low_battery', 'no_signal',
  // words, food, places and the things people type instead of a name
  'pro gamer', 'BigSnake', 'the snake', 'snakey', 'Slinky', 'Spaghetti', 'noodle', 'Wormy', 'Mr Snake', 'pizza',
  'taco', 'Banana', 'potato', 'cookie', 'Pickle', 'Waffle', 'nugget', 'Mango', 'Kiwi', 'lol', 'lmao', 'bruh', 'yeet',
  'oof', 'nope', 'hmm', 'idk', 'pls', 'help me', 'dont kill me', 'im new', 'friendly', 'follow me', 'just vibing',
  'chill', 'hungry', 'snack time', 'zzz', 'hello world', 'Mom', 'Dad', 'grandma', 'the king', 'no u', 'trust me',
  'free hugs', 'peace', 'happy', 'sleepy', 'bored', 'at school', 'on my phone', 'first time', 'carry me', 'solo',
  'afk', 'brb', 'be nice', 'sorry', 'oops', 'why me', 'catch me', 'nom nom', 'yum', 'cheese', 'bacon', 'sushi',
  'ramen', 'burrito', 'nacho', 'donut', 'pancake', 'muffin', 'cupcake', 'brownie', 'pretzel', 'popcorn', 'avocado',
  'broccoli', 'carrot', 'Canada', 'Brasil', 'Mexico', 'Italia', 'Polska', 'Japan', 'Korea', 'Peru', 'Chile',
  'Norway', 'Sweden', 'Finland', 'Ireland', 'Texas', 'Ohio', 'Florida', 'Toronto', 'London', 'Paris', 'Berlin',
  'Tokyo', 'Seoul', 'Manila', 'Lagos', 'Cairo',
]);

// The decorations, as shares of 100 slots (CHOSEN, from what real lobbies show: most names plain or lower case, a
// good share with two digits on the end, a few birth years and xX wrappers).
const STYLE_SLOTS = 100;
const STYLES = Object.freeze([
  // [slots, style]
  [40, 'plain'],
  [14, 'lower'],
  [16, 'twoDigits'],
  [6, 'oneDigit'],
  [5, 'year'],
  [3, 'upper'],
  [3, 'underscoreDigits'],
  [2, 'xX'],
  [2, 'xXunderscore'],
  [2, 'ttv'],
  [2, 'yt'],
  [2, 'mr'],
  [2, 'its'],
  [1, 'x'],
]);
// Birth years people put on a name: 1990 to 2013 (CHOSEN).
const YEAR_FROM = 1990;
const YEAR_SPAN = 24;
// Longest name the slither engine takes (L45 nameMax, server/sl/slLaws.js; slNames.cleanNick cuts there).
const MAX_LEN = 24;
const MIN_LEN = 3;
// An upper-case name is only for short ones; a long name in capitals reads as shouting, not a person.
const UPPER_MAX = 10;
// Their gdnm: 7 digits with no letter between them fail (server/sl/slNames.js DIGIT_RUN).
const DIGIT_RUN = 7;

(function checkStyles() {
  let n = 0;
  for (const [slots] of STYLES) n += slots;
  if (n !== STYLE_SLOTS) throw new Error('botNames: the style slots must add up to ' + STYLE_SLOTS);
})();

// True when s is a name a bot may wear in a room whose names hold at most maxLen characters.
function isBotName(s, maxLen) {
  const cap = maxLen === undefined ? MAX_LEN : maxLen;
  if (typeof s !== 'string' || s.length < MIN_LEN || s.length > cap) return false;
  if (s.trim() !== s) return false;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i);
    if (v < 32 || v > 126) return false;
    if (v >= 48 && v <= 57) {
      run++;
      if (run >= DIGIT_RUN) return false;
    } else if ((v >= 65 && v <= 90) || (v >= 97 && v <= 122)) {
      run = 0;
    }
  }
  if (/[<>"'&]/.test(s)) return false;
  if (/bot/i.test(s) || /slither\s*\.?\s*io/i.test(s)) return false;
  return true;
}

(function checkPool() {
  const seen = new Set();
  for (const n of BASE_NAMES) {
    if (!isBotName(n, 15)) throw new Error('botNames: base name ' + JSON.stringify(n) + ' breaks the name rules');
    const lc = n.toLowerCase();
    if (seen.has(lc)) throw new Error('botNames: base name ' + JSON.stringify(n) + ' is listed twice');
    seen.add(lc);
  }
})();

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function endsInDigit(s) {
  const v = s.charCodeAt(s.length - 1);
  return v >= 48 && v <= 57;
}

// The style that f in [0, 1) falls on, and what is left of f for the digits.
function styleOf(f) {
  let slot = Math.floor(f * STYLE_SLOTS);
  if (slot >= STYLE_SLOTS) slot = STYLE_SLOTS - 1;
  let rest = f * STYLE_SLOTS - slot;
  if (!(rest >= 0 && rest < 1)) rest = 0;
  let acc = 0;
  for (const [slots, style] of STYLES) {
    acc += slots;
    if (slot < acc) return { style, rest };
  }
  return { style: 'plain', rest };
}

// Base name i in a style; the plain base when the decorated one would not fit or breaks a rule.
function nameAt(i, f, maxLen) {
  const base = BASE_NAMES[i];
  const { style, rest } = styleOf(f);
  const word = base.indexOf(' ') < 0;
  // digits go on single words only: "follow me68" is nobody's name
  const digitsOk = word && !endsInDigit(base);
  let s = base;
  switch (style) {
    case 'lower': s = base.toLowerCase(); break;
    case 'twoDigits': if (digitsOk) s = base + String(10 + Math.floor(rest * 90)); break;
    case 'oneDigit': if (digitsOk) s = base + String(1 + Math.floor(rest * 9)); break;
    case 'year': if (digitsOk) s = base + String(YEAR_FROM + Math.floor(rest * YEAR_SPAN)); break;
    case 'upper': if (base.length <= UPPER_MAX) s = base.toUpperCase(); break;
    case 'underscoreDigits': if (digitsOk) s = base + '_' + String(10 + Math.floor(rest * 90)); break;
    case 'xX': if (word) s = 'xX' + base + 'Xx'; break;
    case 'xXunderscore': if (word) s = 'xX_' + base + '_Xx'; break;
    case 'ttv': if (word) s = 'ttv_' + base; break;
    case 'yt': if (word) s = base + 'YT'; break;
    case 'mr': if (word) s = 'Mr' + capitalise(base); break;
    case 'its': if (word) s = 'its' + base; break;
    case 'x': if (word) s = base + 'x'; break;
    default: break;
  }
  return s.length <= maxLen && isBotName(s, maxLen) ? s : base;
}

function capOf(maxLen) {
  const cap = maxLen === undefined ? MAX_LEN : maxLen;
  if (!Number.isInteger(cap) || cap < MIN_LEN) throw new RangeError('botNames: maxLen must be a whole number of at least ' + MIN_LEN);
  return cap;
}

function split(u) {
  if (typeof u !== 'number' || !(u >= 0 && u < 1)) throw new RangeError('botNames: u must be a number in [0, 1)');
  const x = u * BASE_NAMES.length;
  let i = Math.floor(x);
  if (i >= BASE_NAMES.length) i = BASE_NAMES.length - 1;
  return { i, f: x - i };
}

// One name from one uniform draw u in [0, 1).
function makeName(u, maxLen) {
  const cap = capOf(maxLen);
  const { i, f } = split(u);
  return nameAt(i, f, cap);
}

// One name from one uniform draw, skipping every name taken(lowerCaseName) calls in use. With every base name taken
// (more live snakes than base names, never the case: rooms hold at most a few hundred) the first candidate stays.
function pickName(u, opts) {
  const o = opts || {};
  const cap = capOf(o.maxLen);
  const taken = typeof o.taken === 'function' ? o.taken : null;
  const { i, f } = split(u);
  const first = nameAt(i, f, cap);
  if (taken === null || !taken(first.toLowerCase())) return first;
  for (let k = 1; k < BASE_NAMES.length; k++) {
    const s = nameAt((i + k) % BASE_NAMES.length, f, cap);
    if (!taken(s.toLowerCase())) return s;
  }
  return first;
}

module.exports = { BASE_NAMES, MAX_LEN, MIN_LEN, isBotName, makeName, pickName };
