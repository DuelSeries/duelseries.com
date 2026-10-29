'use strict';
/* Free-match wins by real people (Owen 2026-10-28: the lobby's Live wins row and the Leaderboards show real
   results only, never made-up ones). A free duel that a person wins (a bot beaten counts, a bot's own win never
   does) is one row of free_wins: the lobby's game id, the name the winner played under, and their wallet when they
   have one (a guest has none). Nothing else is kept. Money never passes through here: a paid table's result is the
   ledger's (server/earnings reads house_revenue), and this is only ever called for a table with no pot.

   The rooms call note(); index.js gives it the database with setSink(). Without one (tests, a local run without
   DATABASE_URL) a note goes nowhere. A failed write is logged and dropped: a result card never waits on it. */

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS free_wins (
  id         BIGSERIAL PRIMARY KEY,
  game       TEXT NOT NULL,
  name       TEXT NOT NULL,
  wallet     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS free_wins_at ON free_wins (created_at DESC);
CREATE INDEX IF NOT EXISTS free_wins_wallet ON free_wins (wallet) WHERE wallet IS NOT NULL;`;
const INSERT_SQL = 'INSERT INTO free_wins (game, name, wallet) VALUES ($1, $2, $3)';

// A duel room's ev (KnockoutRoom's subclasses) to the lobby's game id.
const GAME_OF_EV = Object.freeze({ ko: 'knockout', hs: 'headsoccer', p8: 'pool8', ah: 'airhockey', rt: 'rooftop',
  cr: 'crossy', bs: 'battleship', sw: 'swim' });
const NAME_MAX = 24;
const isBotId = (id) => typeof id === 'string' && id.startsWith('bot_');

let sink = null;
const stats = { noted: 0, failed: 0 };

function setSink(fn) { sink = typeof fn === 'function' ? fn : null; }

function cleanName(n) {
  const s = String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX) : s;
}
function cleanWallet(w) {
  return typeof w === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w) ? w : null;
}

/* A finished free table: game is the lobby's id (else room.ev names it), winnerId the winning seat. Pure checks,
   then one insert. -> true when a row was sent. */
function noteRoom(room, winnerId, pot, game) {
  if (!sink || !room || pot !== 0 || !winnerId || isBotId(winnerId)) return false;
  game = game || GAME_OF_EV[room.ev] || null;
  const p = room.players && typeof room.players.get === 'function' ? room.players.get(winnerId) : null;
  if (!game || !p) return false;
  const name = cleanName(p.name);
  if (!name) return false;
  stats.noted++;
  Promise.resolve()
    .then(() => sink(INSERT_SQL, [game, name, cleanWallet(p.wallet)]))
    .catch((e) => { stats.failed++; console.warn('[FREEWINS] write failed: ' + (e && e.message)); });
  return true;
}

module.exports = { CREATE_SQL, INSERT_SQL, GAME_OF_EV, setSink, noteRoom, cleanName, stats };
