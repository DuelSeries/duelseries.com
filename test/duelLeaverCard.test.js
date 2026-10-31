'use strict';
/* THE RESULT CARD OF A SEAT WHOSE RECONNECT GRACE RAN OUT (Air Hockey, Rooftop Snipers; bug sweep 2026-10-31).

   A dropped seat is held five seconds (KnockoutLobby drop / rejoin). Past that the match goes to the player who
   stayed with why 'opponent left', and the page that comes back late is shown that result through <ev>:rejoinfail.
   Its card used to say "They left the match." to the player who had left, blaming the one who stayed. The note is
   for the winner of a walk-out only. Each page's own paintOver() is run as written, with the card captured. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function paintOverOf(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
  const m = /\nfunction paintOver\(\) \{[\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, file + ': paintOver() found');
  return m[0];
}

function cardFor(file, over) {
  let shown = null;
  const ctx = vm.createContext({
    DSEnd: { show: (c) => { shown = c; }, usd: (micro) => '$' + (micro / 1e6).toFixed(2), clock: () => '1:00' },
    lastOver: over, score: [0, 0], myStake: 0, FRAMED: true, restake: null, restakeLine: '',
    TEXT: { lobbyOnly: '', againSlow: '', againAsk: '', againSlowLine: '' },
    playAgain() {}, toLobby() {}, spectate() {},
  });
  vm.runInContext(paintOverOf(file) + '\npaintOver();', ctx, { filename: file });
  return shown;
}

for (const file of ['airhockey.js', 'rooftop.js']) {
  test(file + ': the seat that ran out of reconnect time is not told "They left the match."', () => {
    const c = cardFor(file, { winnerId: 'stayer', winner: 'Alice', why: 'opponent left', me: 'leaver', seat: 1,
      score: [0, 0], ms: 60000, money: null });
    assert.strictEqual(c.verdict, 'Alice wins');
    assert.ok(!c.notes.includes('They left the match.'), JSON.stringify(c.notes));
    assert.ok(c.notes.includes('Your connection dropped, so the match went to them.'), 'the same line as Pool and Crossy');
  });

  test(file + ': the player who stayed still is', () => {
    const c = cardFor(file, { winnerId: 'stayer', winner: 'Alice', why: 'opponent left', me: 'stayer', seat: 0,
      score: [0, 0], ms: 60000, money: null });
    assert.strictEqual(c.verdict, 'You win');
    assert.ok(c.notes.includes('They left the match.'), JSON.stringify(c.notes));
  });
}
