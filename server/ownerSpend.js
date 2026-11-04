'use strict';
/* ─── What Owen spent today (Control's "Spent today" tab, Owen 2026-11-04) ─────
   DISPLAY ONLY. Nothing here moves, decides or holds money: it writes down, per Toronto day and per game, the Bot
   bank's moves the server itself made (server/botBank.js onMove), so Control can say what the bots cost today:

     staked   stakes and seeds the Bot bank put into play (a paid duel bot's stake, a bounty bot's seed)
     back     what came home to the bank (a stake handed back, an unspent seed, a paid duel bot's win: the pot less
              the house cut)
     net      staked - back: what the bots cost today (below 0 = they brought money in)
     wins / losses / draws   paid duel bots' results
     fees     on-chain transfers between the Bot bank wallet and escrow that landed (each pays the network fee)

   A seed or stake that left one day and came back the next shows on each day it moved, so a day's net is that
   day's moves. Owen's own paid play and the battle royale's house prizes are read from their own records at view
   time (index.js), not kept here.

   One small JSON file beside the bank's (atomic write: temp then rename), the last KEEP_DAYS days. */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 40;
const TZ = 'America/Toronto';
const isMicro = (v) => Number.isSafeInteger(v) && v >= 0;

/* The Toronto calendar day of a time: 'YYYY-MM-DD'. */
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function torontoDay(t) {
  const parts = fmt.formatToParts(new Date(t));
  const v = (k) => (parts.find((p) => p.type === k) || {}).value;
  return v('year') + '-' + v('month') + '-' + v('day');
}

/* Which game a bank label names: 'duel:knockout:0.5' -> 'knockout'; a paid room's lobbyType -> its game. */
function gameOfLabel(label) {
  const l = String(label || '');
  const d = /^duel:([a-z0-9]+):/.exec(l);
  if (d) return d[1];
  if (/^(sl|snake)/i.test(l)) return 'slither';
  if (/^ag/i.test(l)) return 'agar';
  if (/^paper/i.test(l)) return 'paper';
  if (/^chomp/i.test(l)) return 'chomp';
  return l ? 'other' : '';
}

function createOwnerSpend({ file, fsx = fs, now = Date.now, log = console } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('ownerSpend: a file is required');
  let st = { days: {} };
  try {
    const raw = JSON.parse(fsx.readFileSync(file, 'utf8'));
    if (raw && raw.days && typeof raw.days === 'object') st = { days: raw.days };
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) log.error('[SPEND] owner-spend.json unreadable, starting empty: ' + (e && e.message));
  }

  function save() {
    try {
      const keys = Object.keys(st.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete st.days[k];
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify(st) + '\n');
      fsx.renameSync(tmp, file);
    } catch (e) {
      log.error('[SPEND] not saved: ' + (e && e.message));
    }
  }

  function dayRec(t) {
    const d = torontoDay(t);
    if (!st.days[d]) st.days[d] = { games: {}, transfers: 0 };
    return st.days[d];
  }
  function gameRec(day, game) {
    if (!day.games[game]) day.games[game] = { staked: 0, back: 0, wins: 0, losses: 0, draws: 0 };
    return day.games[game];
  }

  /* One saved Bot bank move (botBank onMove). */
  function bank(ev) {
    if (!ev || typeof ev !== 'object') return;
    const t = Number.isFinite(ev.at) ? ev.at : now();
    const day = dayRec(t);
    const micro = isMicro(ev.micro) ? ev.micro : 0;
    if (ev.kind === 'funded' || ev.kind === 'swept') { day.transfers += 1; save(); return; }
    const game = gameOfLabel(ev.label);
    if (!game) return;   // a 'spent' (a bounty bot died: its seed is in play now) names no room and moves nothing
    const g = gameRec(day, game);
    if (ev.kind === 'seed') g.staked += micro;
    else if (ev.kind === 'back') { g.back += micro; if (/^draw/.test(String(ev.why || ''))) g.draws += 1; }
    else if (ev.kind === 'won') { g.back += micro; g.wins += 1; }
    else if (ev.kind === 'lost') g.losses += 1;
    else return;
    save();
  }

  /* One day's figures: { day, games: [{ game, staked, back, net, wins, losses, draws }], staked, back, net, transfers }
     in dollars. which: 'today' | 'yesterday'. */
  function view(which) {
    const t = now() - (which === 'yesterday' ? 86400000 : 0);
    const d = torontoDay(t);
    const rec = st.days[d] || { games: {}, transfers: 0 };
    let staked = 0, back = 0;
    const games = Object.entries(rec.games).map(([game, g]) => {
      staked += g.staked; back += g.back;
      return { game, staked: g.staked / 1e6, back: g.back / 1e6, net: (g.staked - g.back) / 1e6,
        wins: g.wins | 0, losses: g.losses | 0, draws: g.draws | 0 };
    }).sort((a, b) => b.net - a.net || a.game.localeCompare(b.game));
    return { day: d, which: which === 'yesterday' ? 'yesterday' : 'today', games, staked: staked / 1e6, back: back / 1e6,
      net: (staked - back) / 1e6, transfers: rec.transfers | 0 };
  }

  return { bank, view, file, torontoDay };
}

module.exports = { createOwnerSpend, torontoDay, gameOfLabel, TZ };
