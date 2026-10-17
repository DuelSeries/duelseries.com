'use strict';
/* ─── Bowmasters (tanks): the sound ──────────────────────────────────────────
   The house Glass sounds (dsSfx.js engine, dsSfxGame.js library), picked by
   name. No files. tanks.js calls four small hooks, all guarded:
   state() when the match state changes, shot() when a shell is let go, land()
   when it comes down, over() with the result.

     match found     g.join                your turn   g.turn, then g.tick for the last 3 s
     a shell fired   g.shoot (g.shootHeavy at high power), either side, panned to the shooter
     it lands        g.explode; a tank hit also g.hit (you hit them) or g.hurt (they hit you);
                     low health g.danger; a shell that flies off the map is quiet
     result          g.win / g.lose, after the last shell has landed

   Power is read back from the shell's first step (the server flies it at
   speed = power x 5.2 over 3 steps of 1/120 s), so their shot sounds like its
   strength too. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const play = (name, opt) => S.play(name, opt);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => (root.performance ? root.performance.now() : Date.now());

  const WORLD_W = 1400;
  let matchId = null, wasMine = false, myHp = 100;
  let clocks = [], busyUntil = 0;
  let pendingOver = null, overTimer = 0, flying = false;

  const panOf = (x) => clamp((x / WORLD_W - 0.5) * 1.2, -0.6, 0.6);
  function later(ms, fn) { return root.setTimeout(fn, Math.max(0, ms)); }
  function stopClocks() { clocks.forEach(root.clearTimeout); clocks = []; }

  /* After a landing the next chime waits for it. */
  const afterBusy = (extra, fn) => later(busyUntil - now() + extra, fn);

  /* A new state arrived: a new match, a turn that is now yours, your health. */
  function state(st, myId) {
    if (!st) return;
    if (st.id !== matchId) { matchId = st.id; wasMine = false; myHp = 100; pendingOver = null; stopClocks(); play('g.join'); busyUntil = now() + 500; }
    const me = (st.players || []).find(p => p.id === myId);
    if (me) myHp = me.health;
    const mine = st.state === 'playing' && st.turn === myId;
    stopClocks();
    if (mine) {
      if (!wasMine) afterBusy(150, () => play('g.turn'));
      /* The last three seconds of a turn. turnMsLeft is how long was left when this state was sent. */
      const left = st.turnMsLeft || 0;
      [3, 2, 1].forEach(sec => {
        const ms = left - sec * 1000;
        if (ms > 0) clocks.push(later(ms, () => play('g.tick', { vol: 0.8, rate: 0.85, gap: 300 })));
      });
    }
    wasMine = mine;
  }

  /* A shell has been fired (by either side) and is about to be replayed. */
  function shot(result, myId) {
    flying = true;
    stopClocks();
    const path = (result && result.path) || [];
    if (path.length < 2) return;
    const d = Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]);
    const power = clamp(d * 40 / 5.2, 10, 100);                  // 3 steps of 1/120 s at power x 5.2
    const mine = result.by === myId;
    play(power >= 75 ? 'g.shootHeavy' : 'g.shoot', {
      vol: (mine ? 1 : 0.85) * (0.55 + 0.45 * power / 100), rate: 1.1 - 0.3 * power / 100,
      pan: panOf(path[0][0]), gap: 0,
    });
  }

  /* The shell came down. */
  function land(result, myId) {
    const end = (result && result.hit) || {};
    const dmg = (result && result.damage) || [];
    if (end.type !== 'out') {
      const tank = end.type === 'tank';
      play('g.explode', { vol: tank ? 0.75 : 0.5, rate: tank ? 1 : 1.12, pan: panOf(end.x || WORLD_W / 2), gap: 0 });
      const meD = dmg.find(d => d.id === myId), foeD = dmg.find(d => d.id !== myId);
      if (foeD && result.by === myId) later(90, () => play('g.hit', { vol: clamp(0.5 + foeD.amount / 46, 0.5, 1), gap: 0 }));
      if (meD) {
        later(90, () => play('g.hurt', { vol: clamp(0.5 + meD.amount / 46, 0.5, 1), gap: 0 }));
        if (meD.health > 0 && meD.health <= 30) later(650, () => play('g.danger', { vol: 0.7 }));
      }
      busyUntil = now() + 700;
    }
    flying = false;
    if (pendingOver !== null) { const r = pendingOver; pendingOver = null; root.clearTimeout(overTimer); afterBusy(350, () => result_(r)); }
  }

  function result_(won) { play(won ? 'g.win' : 'g.lose'); }

  /* The result arrives before the killing shell does, so it waits for that shell
     to land. With no shell (they left) it plays after a short beat. */
  function over(won) {
    stopClocks();
    pendingOver = !!won;
    root.clearTimeout(overTimer);
    overTimer = later(900, () => {
      if (pendingOver === null || flying) return;
      const r = pendingOver; pendingOver = null; result_(r);
    });
  }

  root.TanksSound = { state: state, shot: shot, land: land, over: over };
})(window);
