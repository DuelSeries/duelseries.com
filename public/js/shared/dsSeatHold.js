// The duels' five second seat hold, page side (server/KnockoutLobby.js drop / rejoin; Swim's grace, Owen 2026-10-27).
// A connection that blinks mid-match no longer loses the match: the server keeps the match running, holds the seat for
// five seconds, and gives it back to a reconnect that shows the seat's key. The key comes to this page's own socket
// only (<ev>:seat), is new after every rejoin, and is kept in memory here and nowhere else. Used by Rooftop Snipers,
// Crossy Road, Air Hockey and 8 Ball Pool.
//
// This file keeps the key, says "Reconnecting..." while this page's link is down, asks for the seat back on a
// reconnect, and says when the other player's link is down ("<name> is reconnecting..."; watchers too). The page
// itself redraws the match from <ev>:rejoined and decides what <ev>:rejoinfail means.
//
//   const hold = DSSeatHold.create({
//     socket, ev: 'rt', watch: WATCH,
//     pill: $('botNote'),            // the players' small line (its own words come back when it is hidden)
//     line: $('watchLine'),          // the watchers' line
//     live: () => !!match && !overShown,
//     nameOf: (side) => match && match.names[side],
//     mySeat: () => mySeat,
//   });
//   hold.rejoin()  in the page's connect handler: true when it asked for the seat back (wait for rejoined/rejoinfail)
//   hold.back()    the seat is back on this socket (<ev>:rejoined): the line goes
//   hold.done()    a new match, a result, or the match is gone: the key is forgotten and the line goes
(function (root) {
  'use strict';
  var KEY = /^[0-9a-f]{32}$/;
  var WORDS = { mine: 'Reconnecting...', theirs: ' is reconnecting...', them: 'Your opponent', someone: 'A player' };

  function create(o) {
    var socket = o.socket, ev = o.ev, watch = !!o.watch;
    var key = null;
    var shown = '';                 // what this file put on the line, so it only ever takes down its own words
    var theirs = -1;                // the seat whose link is down, as the server said
    var el = watch ? o.line : o.pill;
    var own = el ? el.textContent : '';

    function show(text) {
      if (!el) return;
      el.textContent = text;
      el.hidden = false;
      shown = text;
    }
    function hide() {
      if (!el || !shown) return;
      if (el.textContent === shown) {
        el.hidden = true;
        el.textContent = watch ? '' : own;
      }
      shown = '';
    }
    function live() { try { return !!o.live(); } catch (_) { return false; } }
    function nameOf(side) {
      var n = '';
      try { n = String((o.nameOf && o.nameOf(side)) || '').trim(); } catch (_) { n = ''; }
      return n || (watch ? WORDS.someone : WORDS.them);
    }

    socket.on(ev + ':seat', function (m) {
      if (watch || !m || typeof m.key !== 'string' || !KEY.test(m.key)) return;
      key = m.key;
    });
    socket.on('disconnect', function () {
      theirs = -1;
      if (!watch && key && live()) show(WORDS.mine);
    });
    socket.on(ev + ':away', function (m) {
      if (!m || (m.side !== 0 && m.side !== 1) || !live()) return;
      if (!watch && m.side === o.mySeat()) return;
      theirs = m.side;
      show(nameOf(m.side) + WORDS.theirs);
    });
    socket.on(ev + ':back', function (m) {
      if (!m || m.side !== theirs) return;
      theirs = -1;
      hide();
    });

    return {
      rejoin: function () {
        if (watch || !key || !live()) return false;
        socket.emit(ev + ':rejoin', { key: key });
        return true;
      },
      back: function () { hide(); },
      done: function () { key = null; theirs = -1; hide(); },
      // For headless checks: whether a key is held and what the line says.
      state: function () { return { key: !!key, shown: shown, theirs: theirs }; },
    };
  }

  root.DSSeatHold = { create: create, WORDS: WORDS };
})(typeof window !== 'undefined' ? window : globalThis);
