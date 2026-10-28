// 8 Ball Pool's rules: what one shot means. Pure functions over plain data, so the server (server/Pool8Room.js)
// decides every turn with them, the tests can pin every case, and the screens can read the same state.
//
// THE RULES ARE MINICLIP 8 BALL POOL'S as its own help text states them (docs/pool8-reference.md, "Rules"):
// open table after the break, the first legal pot gives you a group, a foul gives the other player the cue ball in
// hand anywhere on the table, you call the pocket for the 8, and potting the 8 early, in the wrong pocket or with
// a foul loses.

(function (root) {
  'use strict';

  var Sim = (typeof module === 'object' && module.exports) ? require('./pool8Sim') : root.P8Sim;

  var RULES = {
    BREAK_IN_HAND: 'kitchen',      // where the breaker may put the cue ball: behind the baulk line
    FOUL_IN_HAND: 'table',         // after a foul: anywhere on the table
    EIGHT_ON_BREAK: 'respot',      // the 8 potted on the break comes back to the foot spot, play on
    TIMEOUTS_TO_LOSE: 3,           // CHOSEN: a third timed-out turn in a row loses the match
  };

  // Who owns a ball: 'solids' 1-7, 'stripes' 9-15.
  var groupOf = Sim.groupOf;

  function newState(breaker) {
    return { turn: breaker === 1 ? 1 : 0, groups: [null, null], broken: false, inHand: RULES.BREAK_IN_HAND,
             shots: 0, timeouts: [0, 0], winner: null, why: '' };
  }

  function other(g) { return g === 'solids' ? 'stripes' : g === 'stripes' ? 'solids' : null; }

  // Balls of a group still on the table.
  function left(balls, g) {
    var n = 0;
    for (var i = 0; i < balls.length; i++) if (balls[i].on && groupOf(balls[i].n) === g) n++;
    return n;
  }

  // Is this side shooting at the 8 (its group cleared) on this table?
  function onEight(st, balls, side) {
    var g = st.groups[side];
    return !!g && left(balls, g) === 0;
  }

  /* What the shooter must hit first: a group name, 'eight', or 'any' (open table; the 8 is never a legal first
     ball on an open table). */
  function target(st, balls, side) {
    if (!st.broken) return 'any';
    var g = st.groups[side];
    if (!g) return 'open';
    return left(balls, g) === 0 ? 'eight' : g;
  }

  /* One shot, judged. `before` is the table before the shot, `r` what pool8Sim.simulate returned, `call` the pocket
     the shooter named for the 8 (0..5) or null. Returns { st, foul, keep, msg, over, respot8 }, where st is the new
     state (the input is not changed), foul a short code or null, keep whether the shooter goes again, over
     { winner, why } when the shot ended the match, and respot8 true when the 8 must go back on the foot spot. */
  function judge(stIn, before, r, call) {
    var st = JSON.parse(JSON.stringify(stIn));
    var side = st.turn, opp = 1 - side;
    var isBreak = !st.broken;
    var tgt = target(st, before, side);
    var wasOnEight = tgt === 'eight';
    var pots = r.potted.filter(function (p) { return p.n !== 0; });
    var eight = null;
    for (var i = 0; i < pots.length; i++) if (pots[i].n === 8) eight = pots[i];
    st.shots++;
    st.broken = true;
    st.timeouts[side] = 0;

    // Fouls, the first that applies.
    var foul = null;
    if (r.first === null) foul = 'nohit';
    else if (r.cuePotted) foul = 'scratch';
    else if (!isBreak) {
      var fg = groupOf(r.first);
      if (tgt === 'open' && fg === 'eight') foul = 'wrongball';
      else if (tgt === 'eight' && fg !== 'eight') foul = 'wrongball';
      else if ((tgt === 'solids' || tgt === 'stripes') && fg !== tgt) foul = 'wrongball';
    }
    if (!foul && r.cuePotted) foul = 'scratch';
    if (!foul && !pots.length && !r.railAfter) foul = 'norail';

    var out = { st: st, foul: foul, keep: false, msg: '', over: null, respot8: false, pots: pots.map(function (p) { return p.n; }) };

    // The 8.
    if (eight) {
      if (isBreak && RULES.EIGHT_ON_BREAK === 'respot') {
        out.respot8 = true;
      } else if (!wasOnEight) {
        return end(out, opp, 'potted the 8 too early');
      } else if (foul) {
        return end(out, opp, foul === 'scratch' ? 'potted the cue ball with the 8' : 'fouled on the 8');
      } else if (call !== eight.p) {
        return end(out, opp, 'potted the 8 in the wrong pocket');
      } else {
        return end(out, side, 'potted the 8');
      }
    }

    // Groups: the first legal pot after the break on an open table (the first ball to drop names it).
    if (!foul && !isBreak && !st.groups[side]) {
      for (i = 0; i < pots.length; i++) {
        var g = groupOf(pots[i].n);
        if (g === 'solids' || g === 'stripes') { st.groups[side] = g; st.groups[opp] = other(g); break; }
      }
    }

    // Going again: a legal shot that potted a ball the shooter may pot.
    if (!foul) {
      var mine = st.groups[side];
      for (i = 0; i < pots.length; i++) {
        var pg = groupOf(pots[i].n);
        if (pg === 'eight') continue;
        if (isBreak || !mine || pg === mine) { out.keep = true; break; }
      }
    }
    if (foul) {
      st.turn = opp;
      st.inHand = RULES.FOUL_IN_HAND;
      out.msg = foulText(foul);
    } else if (out.keep) {
      st.inHand = null;
    } else {
      st.turn = opp;
      st.inHand = null;
    }
    return out;
  }

  /* The shot clock ran out: a foul, the other player gets the cue ball in hand, and the third in a row in a match
     loses it. */
  function timeout(stIn) {
    var st = JSON.parse(JSON.stringify(stIn));
    var side = st.turn, opp = 1 - side;
    st.timeouts[side] = (st.timeouts[side] || 0) + 1;
    var out = { st: st, foul: 'time', keep: false, msg: foulText('time'), over: null, respot8: false, pots: [] };
    if (st.timeouts[side] >= RULES.TIMEOUTS_TO_LOSE) return end(out, opp, 'ran out of time ' + RULES.TIMEOUTS_TO_LOSE + ' turns in a row');
    st.turn = opp;
    st.inHand = st.broken ? RULES.FOUL_IN_HAND : RULES.BREAK_IN_HAND;
    return out;
  }

  function end(out, winner, why) {
    out.over = { winner: winner, why: why };
    out.st.winner = winner;
    out.st.why = why;
    out.keep = false;
    return out;
  }

  function foulText(code) {
    switch (code) {
      case 'nohit': return 'No ball was hit';
      case 'scratch': return 'The cue ball was potted';
      case 'wrongball': return 'The wrong ball was hit first';
      case 'norail': return 'No ball hit a cushion';
      case 'time': return 'Time ran out';
      default: return 'Foul';
    }
  }

  var Rules = { RULES: RULES, newState: newState, judge: judge, timeout: timeout, target: target, onEight: onEight,
                left: left, foulText: foulText, other: other };
  if (typeof module === 'object' && module.exports) module.exports = Rules;
  else root.P8Rules = Rules;
})(typeof self !== 'undefined' ? self : this);
