/* Product analytics for every paid duel (server/analytics.js), wrapped around each lobby's own settle and refund so
   the money code in server/index.js is unchanged: the money runs first, then the result is recorded, and recording
   never throws into a settle, a refund or a match.

   wrap(lobby, game), once per lobby, after its onSettled and onRefund are assigned:
   - onMatchStart({ roomId, seats: [{ id, wallet, worth }], vsBot }) is assigned here and called by the lobby when a
     match begins (KnockoutLobby / BattleshipLobby / SwimLobby matchStarted): each paid seat's game starts then (a
     queue is not a game; free seats, worth 0, are the page's to send).
   - onSettled: each paid seat's game_ended. The winner's amount is the pot less houseCut, the same split the settle
     paid; a settle with no winner hands every seat its own stake back ('draw', amount = its refund); the others
     'lost', or 'left' when why says the match ended because they walked out. A room deletes a player who walks out
     BEFORE it settles, so the settle's seats hold only who stayed: a seat the match started with that is missing from
     them left ('left', paid 0), matched by wallet (a reconnect changes the socket id). Each room is recorded once.
   - onRefund: stake_refunded (a paid table that never found an opponent). */
const LEFT_WHY = /forfeit|left|leave|disconnect|quit|abandon|resign/i;

function createDuelTrack({ analytics, houseCut }) {
  const tracked = new Set();      // game:roomId already recorded
  const starters = new Map();     // game:roomId -> [{ wallet, worth }] the paid seats a match started with

  function started(game, o) {
    try {
      const seats = o && Array.isArray(o.seats) ? o.seats : [];
      const vsBot = o && o.vsBot != null ? !!o.vsBot : seats.some(s => !s || !s.wallet);
      const paid = [];
      for (const s of seats) {
        if (!s || !s.wallet || !(s.worth > 0)) continue;
        paid.push({ wallet: s.wallet, worth: s.worth });
        analytics.gameStarted({ wallet: s.wallet, game, stake: s.worth, room: o.roomId, vsBot, players: seats.length });
      }
      if (paid.length && o.roomId) {
        if (starters.size >= 5000) starters.delete(starters.keys().next().value);
        starters.set(game + ':' + o.roomId, paid);
      }
    } catch (_) { /* analytics never breaks a match */ }
  }

  function settled(game, o) {
    try {
      if (!o || !o.roomId || !(o.pot > 0)) return;
      const key = game + ':' + o.roomId;
      if (tracked.has(key)) return;
      if (tracked.size >= 50000) tracked.clear();
      tracked.add(key);
      const began = starters.get(key) || [];
      starters.delete(key);
      const seats = Array.isArray(o.seats) ? o.seats : [];
      const winner = seats.find(s => s && s.id === o.winnerId) || null;
      const prize = winner && winner.wallet ? o.pot - o.pot * houseCut : null;
      const quit = LEFT_WHY.test(String(o.why || ''));
      const vsBot = seats.some(s => !s || !s.wallet);
      const players = Math.max(seats.length, began.length);
      for (const s of seats) {
        if (!s || !s.wallet || !(s.worth > 0)) continue;
        const result = prize == null ? 'draw' : s === winner ? 'won' : quit ? 'left' : 'lost';
        const amount = prize == null ? s.refund : s === winner ? prize : 0;
        analytics.gameEnded({ wallet: s.wallet, game, result, stake: s.worth, amount, room: o.roomId,
          reason: o.why || undefined, players, vsBot });
      }
      for (const b of began) {
        if (seats.some(s => s && s.wallet === b.wallet)) continue;
        analytics.gameEnded({ wallet: b.wallet, game, result: 'left', stake: b.worth, amount: 0, room: o.roomId,
          reason: o.why || undefined, players, vsBot });
      }
    } catch (_) { /* analytics never breaks a settle */ }
  }

  function wrap(lobby, game) {
    const settle = lobby.onSettled, refund = lobby.onRefund;
    if (typeof settle === 'function') {
      lobby.onSettled = (o) => { const r = settle(o); settled(game, o); return r; };
    }
    if (typeof refund === 'function') {
      lobby.onRefund = (o) => {
        const r = refund(o);
        try {
          if (o && o.wallet && o.amount > 0) analytics.track('stake_refunded', o.wallet, { game, amount: o.amount, reason: o.why });
        } catch (_) { /* analytics never breaks a refund */ }
        return r;
      };
    }
    lobby.onMatchStart = (o) => started(game, o);
  }

  return { wrap, started, settled };
}

module.exports = { createDuelTrack, LEFT_WHY };
