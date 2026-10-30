'use strict';
/* ─── Crossy Road, plugged into the server ────────────────────────────────────
   Everything index.js needs for Crossy Road in one place, so index.js only
   gains a line at each spot every duel is wired into (the owner console, the
   paid door, /api/live, the restart refunds, the sockets, the disconnect).

   THE QUEUE AND THE PAID DOOR ARE HEAD SOCCER'S, line for line (index.js
   hs:queue): a paid seat is proved by its one-time entry token, never claimed;
   the rung is the ladder's own number; the owner's door (cr:paid:off) is
   checked before the token is touched; a durable stake is claimed before it is
   seated (enterPaid); a prize or refund goes to the wallet that paid.

   THE MONEY IS KNOCKOUT'S, exactly: the room (a KnockoutRoom underneath)
   decides who won, once; settled() pays the winner the pot less the same 10%
   cut through the same koSend, or hands every seat its own stake back on a
   draw. Keyed by room id so nothing pays twice. */

const path = require('path');
const { CrossyLobby } = require('./CrossyLobby');
const S = require('../../shared/crossySim');
const LOOKS = require('../../shared/crossyLooks');

/* deps (from index.js): io, koSend, trackEarning, sweepRake, houseCut, region, createPaidSwitchStore, journalDir. */
function create(deps) {
  const { io, koSend, trackEarning, sweepRake, houseCut, region } = deps;
  const lobby = new CrossyLobby(io);
  const paidRooms = new Set();

  lobby.onSettled = ({ roomId, winnerId, why, pot, seats }) => {
    if (!roomId || !(pot > 0) || paidRooms.has(roomId)) return;
    paidRooms.add(roomId);
    const winner = seats.find(s => s.id === winnerId) || null;
    if (!winner || !winner.wallet) {
      for (const s of seats) {
        if (!(s.worth > 0) || !s.wallet) continue;
        koSend(s.wallet, s.refund, s.name, 'crossy refund (' + (why || 'no winner') + ')');
      }
      console.log('[CR] ' + roomId + ' refunded ' + pot.toFixed(2) + ' - ' + (why || 'no winner'));
      return;
    }
    const cut = pot * houseCut;
    const prize = pot - cut;
    trackEarning({
      source: 'game_rake', game: 'crossy', amountUsdc: cut,
      wallet: winner.wallet, name: winner.name, lobbyType: 'crossy', region,
    });
    sweepRake(cut, 'crossy');
    koSend(winner.wallet, prize, winner.name, 'crossy ' + roomId);
    console.log('[CR] ' + roomId + ' pot ' + pot.toFixed(2) + ' -> ' + winner.name
      + ' ' + prize.toFixed(2) + ' (cut ' + cut.toFixed(2) + ')');
  };
  lobby.onRefund = ({ wallet, name, amount, why }) => {
    if (!wallet || !(amount > 0)) return;
    console.log('[CR] refunding ' + amount.toFixed(2) + ' to ' + name + ' - ' + why);
    koSend(wallet, amount, name, 'crossy refund');
  };

  /* Paid Crossy Road: PAID_ON is the build switch (paid rungs exist at all), cr:paid:off the owner's door on top of
     it, saved across restarts like hs:paid:off. */
  const PAID_ON = true;
  const paidSwitch = deps.createPaidSwitchStore({
    file: process.env.CR_PAID_SWITCH_PATH || path.join(deps.journalDir, 'cr-paid-switch.json'),
    tag: '[CR]', what: 'paid Crossy Road',
  });
  let paidOpen = PAID_ON && !paidSwitch.closedAtBoot().closed;
  if (PAID_ON && !paidOpen) console.warn("[CR] paid door CLOSED at boot: the owner's cr:paid:off outlived the restart");

  /* The owner console's door (cr:paid:off / cr:paid:on): the sentence the console shows. */
  function setPaid(on) {
    paidOpen = PAID_ON && on;
    const kept = paidSwitch.save(on);
    console.warn('[CR] owner console: paid door ' + (on ? 'OPEN' : 'CLOSED')
      + (kept.ok ? (on ? '' : ' (saved)') : ' (NOT saved: ' + kept.why + ')'));
    if (on) return 'Paid Crossy Road open.' + (kept.ok ? ''
      : ' The saved close could not be cleared (' + kept.why + '), so the next restart opens it closed again.');
    return 'Paid Crossy Road closed to new players. Seated and queued players finish. '
      + (kept.ok ? 'It stays closed across restarts and deploys until you press Open.'
        : 'The close could not be saved (' + kept.why + '), so it lasts only until the next restart.');
  }

  function consoleRow(ownerConsole, duelStatus) {
    return { id: 'crossy', name: S.NAME, duel: true,
      paid: ownerConsole.paidDoor({ enabled: PAID_ON, open: paidOpen, stopping: false }, paidSwitch.saved(), 'cr:paid'),
      rungs: ownerConsole.duelRows(duelStatus) };
  }

  /* The sockets. `h` is index.js's own helpers (see the call there). */
  function sockets(socket, on, h) {
    on('cr:queue', ({ name, wallet, stake, entryToken, resume, v, look } = {}) => {
      if (!h.socketRL(socket, 'crq', 1000)) return;
      if (h.ops.get().maintenance) { socket.emit('maintenance', h.ops.get()); return; }
      // A page running another version of the step would predict a different game from the one judged here.
      if (v !== S.VERSION) { socket.emit('cr:refused', { why: 'the game was updated, reload the page' }); return; }
      /* Already at a table that is still being played: a second seat from the same socket would leave the first
         table with a seat nobody can leave or reach. Refused before any token is touched. */
      const seated = lobby.roomOf(socket.id);
      if (seated && seated.state !== 'over') { socket.emit('cr:refused', { why: 'You are in a match already.' }); return; }

      /* A RECONNECT WHILE WAITING takes its seat back by the key only that seat was sent (duelQueue resumeSeat). A free
         seat whose key would carry it past this address's free seats stays where it is (index.js freeMoveOk, night
         review 2026-10-29). */
      const back = lobby.resume(socket, resume, typeof h.freeMoveOk === 'function' ? h.freeMoveOk(socket, lobby) : undefined);
      if (back && back.refused) { socket.emit('cr:refused', { why: h.FREE_DUELS_BUSY }); return; }
      if (back && back.resumed) {
        const e = back.resumed;
        if (e.worth > 0 && e.wallet) socket._walletAddress = e.wallet;
        socket.emit('cr:queued', {
          waitingMs: Date.now() - e.since, stake: e.stake, worth: e.worth, resumeKey: e.resumeKey,
          waitMs: e.stake > 0 ? CrossyLobby.PAID_WAIT_MS : CrossyLobby.FREE_WAIT_MS,
          botAfterMs: e.stake > 0 ? 0 : CrossyLobby.FREE_WAIT_MS,
          paidWaitMs: e.stake > 0 ? CrossyLobby.PAID_WAIT_MS : 0,
        });
        return;
      }
      if (back && back.refunded) { socket.emit('cr:unqueued', { refunded: true, why: 'connection dropped' }); return; }

      /* A PAID SEAT IS PROVED, NOT CLAIMED: the worth is what the server recorded when it verified the on-chain
         transfer and minted a one-time token. A number or a string only: Number() on a client-built object can
         throw. The ladder's own rung, never the client's number. */
      const wants = (typeof stake === 'number' || typeof stake === 'string') ? Number(stake) || 0 : 0;
      const want = wants > 0 ? h.rungOf(wants) : 0;
      const seat = (entry) => {
        // The door shut while this stake row's claim was in flight: not seated, so enterPaid refunds it once.
        if (entry && entry.stakeSig && !paidOpen) return false;
        let worth = 0, rung = 0, paid, payTo = null;
        if (entry) {
          worth = entry.worth;
          rung = want;
          paid = entry.paid;               // what landed: bounds a refund (stakeRules.refundBound)
          payTo = entry.walletAddress || null;
          if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
        }
        let took;
        try {
          took = lobby.enqueue(socket, h.sanitizeName(name),
            worth > 0 ? payTo : (h.strOr(wallet, null) || socket._walletAddress || null), rung, worth, undefined, paid,
            LOOKS.byId(look) ? look : null);   // a listed free critter only (shared/crossyLooks.js); none = the seat's own
        } catch (e) {
          console.error('[CR] queue threw:', e && e.stack ? e.stack : e);
          took = lobby.holds(socket.id);
        }
        if (took === false) {
          if (!entry) socket.emit('cr:refused', { why: 'the game is restarting for an update, try again in a minute' });
          return false;
        }
        const waited = lobby.queuedFor(socket.id);
        if (waited !== null) {
          socket.emit('cr:queued', {
            waitingMs: waited,
            stake: rung, worth,
            resumeKey: lobby.resumeKeyOf(socket.id),   // to this socket only: a reconnect's proof
            waitMs: rung > 0 ? CrossyLobby.PAID_WAIT_MS : CrossyLobby.FREE_WAIT_MS,
            botAfterMs: rung > 0 ? 0 : CrossyLobby.FREE_WAIT_MS,
            paidWaitMs: rung > 0 ? CrossyLobby.PAID_WAIT_MS : 0,
          });
        }
        h.joinAlerts.joined({ game: 'crossy', stake: rung, name: h.sanitizeName(name), wallet: payTo, queued: true, socket });
      };
      if (!(wants > 0)) {
        // The address already holds enough free duel seats (index.js freeDuelRefused, night review 2026-10-29).
        if (typeof h.freeDuelRefused === 'function' && h.freeDuelRefused(socket, lobby, 'cr')) return;
        return seat(null);
      }
      if (!want) { socket.emit('cr:refused', { why: h.RETIRED_BUYIN }); return; }
      // The owner's paid door, before the token is touched: the player keeps it unspent.
      if (!paidOpen) { socket.emit('cr:refused', { why: h.DUEL_PAID_CLOSED }); return; }
      h.enterPaid(socket, 'crossy', h.consumePaidEntryAtStake(entryToken, want, 'crossy'), seat, (why) => {
        socket.emit('cr:refused', { why: h.ENTRY_REFUSED[why] || 'that buy-in was not paid for' });
      });
    });

    on('cr:unqueue', () => lobby.leave(socket.id));   // leave(): a paid seat is refunded, once
    on('cr:leave', () => lobby.leave(socket.id));

    /* A reconnect mid-match takes its seat back with the key only that seat was sent (cr:seat), inside the five
       seconds a dropped seat is held (KnockoutLobby.drop / rejoin, index.js p8:rejoin). The seat keeps its wallet. */
    on('cr:rejoin', ({ key } = {}) => {
      if (!h.socketRL(socket, 'crrejoin', 1000)) return;
      try {
        const r = lobby.rejoin(socket, key, Date.now(), typeof h.freeMoveOk === 'function' ? h.freeMoveOk(socket, lobby) : undefined);
        if (r && r.ok && r.worth > 0 && r.wallet) socket._walletAddress = r.wallet;
      } catch (e) {
        console.error('[CR] rejoin threw:', e && e.stack ? e.stack : e);
        socket.emit('cr:rejoinfail', {});
      }
    });

    /* Hops, a few ticks a packet: only ever this socket's own hopper (CrossyRoom.input checks everything). A flood
       past 40 in half a second is dropped. */
    on('cr:in', (msg) => {
      const now = Date.now();
      if (!socket._crIn || now - socket._crIn.at > 500) socket._crIn = { at: now, n: 0 };
      if (++socket._crIn.n > 40) return;
      const room = lobby.roomOf(socket.id);
      try { if (room) room.input(socket.id, msg); } catch (e) { console.error('[CR] input refused:', e.message); }
    });

    on('cr:chat', ({ text } = {}) => {
      const room = lobby.roomOf(socket.id);
      if (!room) return;
      const r = room.chat(socket.id, text, h.chatGuard, Date.now());
      if (!r.ok && r.note) socket.emit('cr:chatnote', { text: r.note });
    });

    on('cr:watch', (msg) => {
      try {
        if (!h.socketRL(socket, 'crwatch', 100)) return;
        const after = msg && typeof msg.after === 'string' && msg.after.length <= 40 ? msg.after : null;
        const stake = msg && typeof msg.stake === 'number' && h.isStake(msg.stake) ? msg.stake : undefined;
        const dir = msg && msg.dir === 'prev' ? 'prev' : 'next';
        lobby.watch(socket, { after, stake, dir });
      } catch (e) { console.error('[CR] watch failed:', e.message); }
    });
    on('cr:unwatch', () => {
      try { lobby.unwatch(socket.id); } catch (e) { console.error('[CR] unwatch failed:', e.message); }
    });
  }

  /* A closed tab: out of the queue (a paid seat refunded), a watcher forgotten, and a seat mid-match held five
     seconds for its reconnect (KnockoutLobby.drop) before it forfeits as it always did. */
  function disconnect(socketId) {
    lobby.drop(socketId);
    lobby.unwatch(socketId);
  }

  return { lobby, setPaid, paidOpen: () => paidOpen, consoleRow, sockets, disconnect, PAID_ON };
}

module.exports = { create };
