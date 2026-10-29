'use strict';
/* ─── Player display names: the one cleaner, and the names nobody but the owner may take ────────────────────────────
   Night review 2026-10-29. A real-money site's first scam is a player called "DuelSeries Support", or the owner's own
   name with a zero-width space in it, telling a winner to "verify" a wallet to get their prize. sanitizeName (server/
   index.js) used to remove only < and >, so invisible, bidi and control characters all got through, and every name
   was free.

     cleanName(raw)     the name as shown. Control characters become spaces; zero-width, bidi and other invisible
                        characters go (chatGuard's own set); < and > go; runs of spaces become one; trimmed. Letters
                        are never folded or changed, so a styled or accented name an honest player chose stays as typed.
                        Not a string: ''.
     nameKey(name)      a comparison key, never shown: NFKD with the accents dropped (é is e), the Greek and Cyrillic
                        letters that read as Latin ones folded (NAME_UPPER, NAME_LOWER), lower case, chatGuard's
                        look-alikes undone (0 for o, Cyrillic a for a, ...), l read as i, rn as m, vv as w, and
                        everything but a-z and 0-9 dropped. "D u e l S e r i e s", "DueISeries" and "duel_series"
                        share one key; so do "Owen", "Owén" and Owen with a Cyrillic pe (U+043F) for the n (night
                        review 2026-10-29).
     isReservedName(n)  true for a name that reads as the site or its staff: its key holds duelseries, support,
                        moderator or official anywhere, or starts with admin or owner, or one of its words
                        (split at spaces, symbols and camelCase humps) is admin, owner, staff or mod (or a plural).
                        No bot name trips it (test/playerName.test.js).

   The owner's wallet is exempt where the server knows it is the owner (POST /api/my-name). In-game names come with no
   proof of who sent them, so a reserved one is shown as Player there, the owner's included.
   The slither engine (/sl) cleans names by its own rules and gives a reserved one no name (slNames.seatNick). */

const { unlook, INVISIBLE_RE } = require('./chatGuard');

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Look-alikes chatGuard's LOOK leaves out, for names only so chat is untouched (night review 2026-10-29). Capitals
   first, before lower case loses them: a Greek capital Nu reads as N, while its small letter (LOOK) reads as v. */
const NAME_UPPER = {
  '\u0391': 'a', '\u0392': 'b', '\u0395': 'e', '\u0396': 'z', '\u0397': 'h', '\u0399': 'i', '\u039a': 'k',
  '\u039c': 'm', '\u039d': 'n', '\u039f': 'o', '\u03a1': 'p', '\u03a4': 't', '\u03a5': 'y', '\u03a7': 'x',
  '\u0405': 's', '\u0406': 'i', '\u0408': 'j', '\u0410': 'a', '\u0412': 'b', '\u0415': 'e', '\u041a': 'k',
  '\u041c': 'm', '\u041d': 'h', '\u041e': 'o', '\u0420': 'p', '\u0421': 'c', '\u0422': 't', '\u0425': 'x',
  '\u042c': 'b', '\u04ae': 'y', '\u04c0': 'i', '\u051a': 'q', '\u051c': 'w'
};
const NAME_LOWER = {
  '\u0432': 'b', '\u0433': 'r', '\u043f': 'n', '\u044c': 'b', '\u0461': 'w', '\u0475': 'v', '\u04af': 'y',
  '\u04bb': 'h', '\u0501': 'd', '\u051b': 'q', '\u051d': 'w', '\u03b2': 'b', '\u03b5': 'e', '\u03b7': 'n',
  '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03c9': 'w', '\u03f2': 'c', '\u03f3': 'j', '\u0131': 'i',
  '\u0251': 'a', '\u0261': 'g'
};

function confusables(s) {
  let up = '';
  for (const ch of s) up += NAME_UPPER[ch] || ch;
  let out = '';
  for (const ch of up.toLowerCase()) out += NAME_LOWER[ch] || ch;
  return out;
}

function fold(s) {
  return unlook(confusables(s)).replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/l/g, 'i');
}

// NFKD (folds full-width and styled letters, as NFKC does) with every accent and other mark dropped: "Owén" is Owen.
function bare(name) {
  return cleanName(name).normalize('NFKD').replace(/\p{M}/gu, '');
}

function nameKey(name) {
  return fold(bare(name)).replace(/[^a-z0-9]+/g, '');
}

const ANYWHERE = ['duelseries', 'support', 'moderator', 'official'].map(fold);
const STARTS = ['admin', 'owner'].map(fold);   // not staff: Stafford is a name
const WORDS = new Set(['admin', 'admins', 'owner', 'owners', 'staff', 'mod', 'mods'].map(fold));

function words(name) {
  const out = [];
  for (const hump of bare(name).split(/(?<=\p{Ll})(?=\p{Lu})/u)) {
    for (const w of fold(hump).split(/[^a-z0-9]+/)) if (w) out.push(w);
  }
  return out;
}

function isReservedName(name) {
  const key = nameKey(name);
  if (!key) return false;
  if (ANYWHERE.some((w) => key.includes(w))) return true;
  if (STARTS.some((w) => key.startsWith(w))) return true;
  if (WORDS.has(key)) return true;
  return words(name).some((w) => WORDS.has(w));
}

module.exports = { cleanName, nameKey, isReservedName };
