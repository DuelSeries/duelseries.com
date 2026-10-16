'use strict';
/* ─── What a duel's result card says about the money (Knockout, Battleship) ───
   DISPLAY ONLY. The payout is index.js's onSettled hook for each duel, and nothing in here moves,
   decides or records money. This only repeats, for the result card, the split that code pays:

     · the SAME house cut: DUEL_HOUSE_CUT, which index.js reads from here as KO_HOUSE_CUT;
     · on the SAME pot and the SAME per-seat refund (refundBound) the room hands onSettled;
     · under the SAME rule: a winner with a wallet takes the pot less the cut, otherwise every
       staked seat with a wallet gets its refund back.

   In micro-USDC, rounded the way Usdc.toUnits rounds what is sent, so the card quotes the amount
   that goes out. Before this the card showed no money at all, and a client working the payout out
   from the stake would have been a second copy of the rules. Never a wallet address. */

const DUEL_HOUSE_CUT = 0.10;
const micro = (v) => Math.round((Number(v) || 0) * 1e6);

/* { winnerId, pot, seats: [{ id, wallet, worth, refund }] } (the onSettled shape) ->
   null for a free table, else { potMicro, cutMicro, netMicro, refunded, seats: { id: { stakeMicro, refundMicro } } } */
function duelMoney({ winnerId, pot, seats } = {}) {
  if (!(Number(pot) > 0)) return null;
  const list = Array.isArray(seats) ? seats : [];
  const winner = list.find((s) => s.id === winnerId) || null;
  const pays = !!(winner && winner.wallet);
  const cut = pays ? pot * DUEL_HOUSE_CUT : 0;
  const out = {
    potMicro: micro(pot),
    cutMicro: pays ? micro(cut) : 0,
    netMicro: pays ? micro(pot - cut) : 0,
    refunded: !pays,
    seats: {},
  };
  for (const s of list) {
    out.seats[s.id] = {
      stakeMicro: micro(s.worth),
      refundMicro: !pays && s.worth > 0 && s.wallet ? micro(s.refund) : 0,
    };
  }
  return out;
}

module.exports = { DUEL_HOUSE_CUT, duelMoney };
