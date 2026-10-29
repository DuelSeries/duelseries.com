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
     nameKey(name)      a comparison key, never shown: NFKC, lower case, chatGuard's look-alikes undone (0 for o,
                        Cyrillic a for a, ...), l read as i, rn as m, vv as w, and everything but a-z and 0-9 dropped.
                        "D u e l S e r i e s", "DueISeries" and "duel_series" share one key.
     isReservedName(n)  true for a name that reads as the site or its staff: its key holds duelseries, support,
                        moderator or official anywhere, or starts with admin or owner, or one of its words
                        (split at spaces, symbols and camelCase humps) is admin, owner, staff or mod (or a plural).
                        No bot name trips it (test/playerName.test.js).

   The owner's wallet is exempt where the server knows it is the owner (POST /api/my-name). In-game names come with no
   proof of who sent them, so a reserved one is shown as Player there, the owner's included. */

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

function fold(s) {
  return unlook(s).replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/l/g, 'i');
}

function nameKey(name) {
  return fold(cleanName(name).normalize('NFKC')).replace(/[^a-z0-9]+/g, '');
}

const ANYWHERE = ['duelseries', 'support', 'moderator', 'official'].map(fold);
const STARTS = ['admin', 'owner'].map(fold);   // not staff: Stafford is a name
const WORDS = new Set(['admin', 'admins', 'owner', 'owners', 'staff', 'mod', 'mods'].map(fold));

function words(name) {
  const out = [];
  for (const hump of cleanName(name).normalize('NFKC').split(/(?<=\p{Ll})(?=\p{Lu})/u)) {
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
