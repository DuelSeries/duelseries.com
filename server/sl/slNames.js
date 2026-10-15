'use strict';
// slither.io free room: player names by THEIR rules (SERVER-DESIGN 12.3, task T11; OWNER-ANSWERS Q17 "their rules
// exactly (24 chars, their character rules, 7+ digit rule, no swear filter)").
//
// cleanNick(raw) is the name the frozen client itself would send in sl:join: their socket open keeps the name
// asciized, cut to L45 nameMax (24) and with the gameweek2016 code blanked (openNick, public/js/sl/slNet.js:33-40,
// their game.js:8951-8961), then sends it only when gdnm passes (slNet.js:84-90, gdnm at public/js/sl/slApply.js:
// 355-370, their game.js:1744-1783). The server applies the same rules to whatever arrives, so a hand-made client
// gets nothing their client could not have sent. No swear filter, never the old sanitizeName (server/index.js:79).
// One rule of ours on top (security review 2026-10-15): the result loses < > " ' & (MARKUP below).
// test/slNames.test.js runs the frozen openNick and gdnm in a vm against cleanNick on 50,000 fuzz names.
//
// Names reach pages only through their client's own escaping and the layer's textContent; the owner console and the
// phone push escape them (SERVER-DESIGN 12.3). A paid name also reaches accounts.name, hence MARKUP.
//
// BOT_NAMES is slBots' list (one copy, BUILD-DECISIONS T12); every one passes cleanNick unchanged (tested).

const { LAWS, assertLawsComplete } = require('./slLaws');
const { BOT_NAMES } = require('./slBots');

const NAME_LAW_IDS = Object.freeze(['L45']);

// Their client's own constants, each cited (client code, not server laws):
const ASCII_LO = 32;               // asciize: a char below 32 becomes a space (slNet.js:20, game.js:9076-9096)
const ASCII_HI = 127;              // asciize: a char above 127 becomes a space (same lines)
const OPEN_CODE = 'gameweek2016';  // blanked in any case at socket open (slNet.js:38, game.js:8958)
const DIGIT_RUN = 7;               // gdnm: 7 digits with no letter between them fail (slApply.js:362, game.js:1744-1783)

// Their asciize (public/js/sl/slNet.js:17-31): any char below 32 or above 127 becomes a space.
function asciize(s) {
  let fix = false;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i);
    if (v < ASCII_LO || v > ASCII_HI) { fix = true; break; }
  }
  if (!fix) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i);
    out += v < ASCII_LO || v > ASCII_HI ? ' ' : String.fromCharCode(v);
  }
  return out;
}

// Their gdnm without the admin bypass (slApply.js:357-370): false when 7 digits come with no letter between them;
// spaces and punctuation neither count nor reset.
function gdnm(s) {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i);
    if (v >= 48 && v <= 57) {
      run++;
      if (run >= DIGIT_RUN) return false;
    } else if ((v >= 65 && v <= 90) || (v >= 97 && v <= 122)) {
      run = 0;
    }
  }
  return true;
}

// L45 nameMax from a law table (24 on the real one).
function nameMax(laws) {
  assertLawsComplete(laws, NAME_LAW_IDS);
  const v = laws.L45.value;
  const m = v && v.nameMax;
  if (!Number.isInteger(m) || m <= 0) throw new Error('slNames: law L45 nameMax must be a whole number above 0');
  return m;
}

const DEFAULT_MAX = nameMax(LAWS);

// Characters a name never keeps (ours, not their client's: security review 2026-10-15). Their client escapes a
// name on draw, but a paid snake's name is written to accounts.name (the cash-out's recordEarnings), which the
// lobby's boards and profiles read, and a name holding markup or a quote is one missed escape, or one quoted
// attribute, away from running on the lobby origin. Stripped LAST, from what their rules left, so the name is
// exactly their client's own name minus these characters.
const MARKUP = /[<>"'&]/g;

// The name a seat gets. raw: what sl:join carried (a string; a number is turned into its text as their String(raw)
// would; anything else is an empty name, never a call to an object's toString). laws: optional table (default the
// real one).
function cleanNick(raw, laws) {
  const max = laws ? nameMax(laws) : DEFAULT_MAX;
  let s = typeof raw === 'string' ? raw : (typeof raw === 'number' ? String(raw) : '');
  s = asciize(s);
  if (s.length > max) s = s.substr(0, max);
  if (s.toLowerCase() === OPEN_CODE) s = '';
  return gdnm(s) ? s.replace(MARKUP, '') : '';
}

module.exports = { NAME_LAW_IDS, asciize, gdnm, nameMax, cleanNick, BOT_NAMES };
