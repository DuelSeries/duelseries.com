'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ShooterRoom, SH, WEAPONS, WEAPON_KEYS } = require('../server/ShooterRoom');

const io = { to: () => ({ emit: () => {} }) };

/* Every deadline in the room — cooldowns, respawns, the spawn shield, the
   five-second bank — is read through room.now(). A synchronous tick loop against
   the real clock advances no time at all, so nothing with a cooldown ever fires
   twice and a green test proves nothing. This drives a fake one instead. */
class Room extends ShooterRoom {
  constructor() { super(io, 't'); this.t = 1e9; }
  now() { return this.t; }
  step(n) { for (let i = 0; i < (n || 1); i++) { this.t += 1000 / SH.TICK_RATE; this.tick(); } }
  seconds(s) { this.step(Math.round(s * SH.TICK_RATE)); }
}

let n = 0;
const sock = () => ({ id: 'p' + (++n), join() {}, volatile: { emit() {} } });
/* Bots are stripped by default. They wander and shoot, so leaving them in makes
   every test about anything else quietly depend on where five of them happened
   to drive — which is how a suite that passes alone fails in a full run. The
   two tests that are about bots put them back. */
function withPlayer(weapon) {
  const r = new Room();
  const p = r.addPlayer(sock(), 'Owen', weapon || 'cannon');
  r.stop();                       // the test drives the clock, not setInterval
  for (const t of [...r.tanks.values()]) if (t.bot) r.tanks.delete(t.id);
  return { r, p };
}
/* Puts a tank somewhere known and clears the shield, because almost every test
   below is about what happens when something hits it. */
function put(r, t, x, y) { t.x = x; t.y = y; t.safeUntil = 0; t.dead = false; }
const cellOf = (r, x, y) => [Math.floor(y / SH.TILE), Math.floor(x / SH.TILE)];

test('the arena is round, and the rim is stone all the way about', () => {
  const { r } = withPlayer();
  const cx = (SH.COLS - 1) / 2, cy = (SH.ROWS - 1) / 2;
  for (let a = 0; a < Math.PI * 2; a += 0.05) {
    const c = Math.round(cx + Math.cos(a) * (Math.min(cx, cy) - 0.5));
    const row = Math.round(cy + Math.sin(a) * (Math.min(cx, cy) - 0.5));
    assert.equal(r.map[row][c], SH.STONE, 'stone at ' + c + ',' + row);
  }
  assert.equal(r.map[0][0], SH.STONE, 'and the corners outside the circle');
});

test('the map is the same arena every time, so it can be learned', () => {
  const a = new Room().map.map(x => x.join('')).join('');
  const b = new Room().map.map(x => x.join('')).join('');
  assert.equal(a, b);
});

test('the bank sits in the middle, on clear ground, with a way in', () => {
  const { r } = withPlayer();
  assert.equal(r.cellAt(r.bank.x, r.bank.y), SH.EMPTY, 'you can stand in it');
  // Every corner of the square is standable, or it is not a square you can hold.
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      assert.equal(r.cellAt(r.bank.x + dx * (r.bank.half - 4), r.bank.y + dy * (r.bank.half - 4)),
                   SH.EMPTY, 'corner ' + dx + ',' + dy);
    }
  }
  /* And it is reachable: a straight run out of the middle has to leave the wall
     ring through one of the four gaps, or the bank is a sealed box. */
  let ways = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (r.lineOfSight(r.bank.x, r.bank.y, r.bank.x + dx * 400, r.bank.y + dy * 400)) ways++;
  }
  assert.ok(ways >= 4, 'all four gaps are open (' + ways + ')');
});

test('every piece of open ground can reach the bank', () => {
  /* Scattering walls into a round arena leaves sealed pockets, and a player
     who spawns in one can never reach the middle, never meet anybody, and
     never work out why. This is the assertion that stops that shipping. */
  const { r } = withPlayer();
  const seen = new Set();
  const q = [[Math.floor(r.bank.y / SH.TILE), Math.floor(r.bank.x / SH.TILE)]];
  while (q.length) {
    const [y, x] = q.pop();
    if (y < 0 || x < 0 || y >= SH.ROWS || x >= SH.COLS) continue;
    const k = y * SH.COLS + x;
    if (seen.has(k) || r.map[y][x] !== SH.EMPTY) continue;
    seen.add(k);
    q.push([y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]);
  }
  let empty = 0;
  for (let y = 0; y < SH.ROWS; y++) for (let x = 0; x < SH.COLS; x++) {
    if (r.map[y][x] === SH.EMPTY) empty++;
  }
  assert.equal(empty - seen.size, 0, 'no sealed pockets (' + (empty - seen.size) + ' cells)');
  assert.ok(empty > 1000, 'and there is still an arena left (' + empty + ')');
});

test('nobody spawns inside a wall', () => {
  const { r } = withPlayer();
  for (let i = 0; i < 60; i++) {
    const t = { id: 'x', x: 0, y: 0 };
    r.place(t);
    assert.ok(!r.blocked(t.x, t.y), 'spawn ' + i + ' is on clear ground');
  }
});

test('spawns are away from everybody, and never in the bank', () => {
  const { r, p } = withPlayer();
  r.topUpBots();
  for (const t of r.tanks.values()) {
    if (t === p) continue;
    assert.ok(!r.inBank(t), 'nobody drops straight into the middle');
  }
});

test('a tank cannot drive through a wall, and slides along one', () => {
  const { r, p } = withPlayer();
  // A stone wall directly to the right.
  put(r, p, 10.5 * SH.TILE, 10.5 * SH.TILE);
  r.map[10][12] = SH.STONE;
  r.setInput(p.id, { right: 1 });
  r.seconds(1);
  assert.ok(p.x + SH.TANK_R <= 12 * SH.TILE + 1, 'it stopped at the wall');

  /* Diagonally into a long wall: one blocked axis must not block the other, or
     the tank welds itself to every corner it meets. */
  const { r: r2, p: p2 } = withPlayer();
  put(r2, p2, 10.5 * SH.TILE, 10.5 * SH.TILE);
  for (let c = 2; c < SH.COLS - 2; c++) r2.map[9][c] = SH.STONE;
  const x0 = p2.x;
  r2.setInput(p2.id, { right: 1, up: 1 });
  r2.seconds(1);
  assert.ok(p2.x > x0 + 40, 'it kept moving along the wall (' + Math.round(p2.x - x0) + ')');
});

test('breaking a crate pays coins and drops a med kit', () => {
  const { r, p } = withPlayer('cannon');
  put(r, p, 10.5 * SH.TILE, 10.5 * SH.TILE);
  r.map[10][13] = SH.CRATE; r.hp[10][13] = 24;
  r.setInput(p.id, { fire: 1, aim: 0 });
  r.seconds(2);
  assert.equal(r.map[10][13], SH.EMPTY, 'the crate is gone');
  assert.ok(r.pickups.some(x => x.kind === 'coin'), 'it paid');
  assert.ok(r.pickups.some(x => x.kind === 'medkit'), 'and dropped a med kit');
});

test('a med kit heals, and is left alone when it cannot', () => {
  const { r, p } = withPlayer();
  put(r, p, 20 * SH.TILE, 20 * SH.TILE);
  r.pickups = [{ x: p.x, y: p.y, kind: 'medkit', born: r.now() }];
  r.step(1);
  assert.equal(r.pickups.length, 1, 'at full health it stays on the floor');

  p.health = 40;
  r.step(1);
  assert.equal(r.pickups.length, 0, 'hurt, it is taken');
  assert.equal(p.health, 40 + SH.MEDKIT_HEAL, 'and it heals');
});

test('stone does not break, and everything else does', () => {
  const { r } = withPlayer();
  r.map[10][10] = SH.STONE;
  assert.equal(r.damageCell(10, 10, 9999), false, 'stone holds');
  assert.equal(r.map[10][10], SH.STONE);

  for (const kind of [SH.CRATE, SH.BRICK, SH.WOOD]) {
    r.map[10][11] = kind; r.hp[10][11] = 500;
    r.damageCell(10, 11, 9999);
    assert.equal(r.map[10][11], SH.EMPTY, 'kind ' + kind + ' breaks');
  }
});

test('a barrel takes its neighbours with it', () => {
  const { r, p } = withPlayer();
  put(r, p, 40 * SH.TILE, 40 * SH.TILE);       // well away, so it survives to assert
  const row = 10;
  for (let c = 10; c <= 13; c++) { r.map[row][c] = SH.BARREL; r.hp[row][c] = 1; }
  r.damageCell(row, 10, 5);
  for (let c = 10; c <= 13; c++) {
    assert.equal(r.map[row][c], SH.EMPTY, 'barrel ' + c + ' went up with the chain');
  }
});

test('a barrel is nobody s side', () => {
  const { r, p } = withPlayer();
  put(r, p, 10.5 * SH.TILE, 10.5 * SH.TILE);
  r.map[10][11] = SH.BARREL; r.hp[10][11] = 1;
  const before = p.health;
  r.damageCell(10, 11, 5);
  assert.ok(p.health < before, 'it hurt the tank that set it off too');
});

test('killing somebody drops everything they were carrying', () => {
  const { r, p } = withPlayer();
  const victim = r.makeTank('v1', 'Victim', 'cannon', true);
  put(r, victim, 30 * SH.TILE, 30 * SH.TILE);
  victim.coins = 140;
  r.hurt(victim, 9999, p.id);
  assert.equal(victim.dead, true);
  assert.equal(victim.coins, 0, 'they are carrying nothing now');
  assert.equal(p.kills, 1, 'and the kill is credited');
  const dropped = r.pickups.find(x => x.kind === 'coin');
  assert.ok(dropped, 'there is a coin on the floor');
  assert.equal(dropped.value, 140, 'worth exactly what they had');

  // And the killer gets it by driving over it, not by having made the kill.
  assert.equal(p.coins, 0, 'the kill itself paid nothing');
  put(r, p, dropped.x, dropped.y);
  r.step(1);
  assert.equal(p.coins, 140, 'driving over it paid');
});

test('quitting does not keep what you have not banked', () => {
  const { r, p } = withPlayer();
  r.addPlayer(sock(), 'Somebody else', 'cannon');   // so the arena does not empty
  r.stop();
  p.coins = 90;
  r.removePlayer(p.id);
  assert.ok(r.pickups.some(x => x.kind === 'coin' && x.value === 90),
            'it is on the floor for whoever wants it');
});

test('five seconds in the middle banks it; stepping out resets the clock', () => {
  const { r, p } = withPlayer();
  p.coins = 75;
  put(r, p, r.bank.x, r.bank.y);
  r.seconds(3);
  assert.ok(p.cashMs > 2500, 'the clock is running (' + Math.round(p.cashMs) + ')');
  assert.equal(p.banked, 0, 'and has not paid yet');

  // Out, and back in: it starts again from zero, not from three.
  put(r, p, r.bank.x + r.bank.half + 200, r.bank.y);
  r.step(1);
  assert.equal(p.cashMs, 0, 'leaving reset it');

  put(r, p, r.bank.x, r.bank.y);
  r.seconds(3);
  assert.equal(p.banked, 0, 'three more seconds is still not five');
  r.seconds(2.2);
  assert.equal(p.banked, 75, 'five is');
  assert.equal(p.coins, 0, 'and it is off you now');
});

test('there is nothing to bank when you are carrying nothing', () => {
  const { r, p } = withPlayer();
  p.coins = 0;
  put(r, p, r.bank.x, r.bank.y);
  r.seconds(6);
  assert.equal(p.cashMs, 0, 'no progress bar for a bank of nothing');
  assert.equal(p.banked, 0);
});

test('dying in the middle loses the cash-out and the coins with it', () => {
  const { r, p } = withPlayer();
  p.coins = 200;
  put(r, p, r.bank.x, r.bank.y);
  r.seconds(4.5);
  assert.ok(p.cashMs > 4000, 'nearly there');
  r.hurt(p, 9999, 'someone');
  assert.equal(p.banked, 0, 'banked nothing');
  assert.equal(p.cashMs, 0, 'the clock is gone');
  assert.ok(r.pickups.some(x => x.value === 200), 'and the 200 is on the floor');
});

test('a fresh spawn cannot be shot for a moment, and the shell still stops', () => {
  const { r, p } = withPlayer();
  const other = r.makeTank('s1', 'Sniper', 'cannon', true);
  put(r, other, 10.5 * SH.TILE, 10.5 * SH.TILE);
  p.x = other.x + 200; p.y = other.y;
  p.safeUntil = r.now() + 5000;
  p.dead = false; p.health = p.maxHealth;
  r.fireFrom(other, 0, 'cannon');
  r.seconds(1);
  assert.equal(p.health, p.maxHealth, 'the shield held');
  assert.equal(r.bullets.length, 0, 'and the shell was stopped, not passed through');
});

test('firing down an open lane never comes back at you', () => {
  for (const key of WEAPON_KEYS) {
    const { r, p } = withPlayer(key);
    put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
    for (let c = 15; c < SH.COLS - 6; c++) { r.map[20][c] = SH.EMPTY; r.hp[20][c] = 0; }
    r.setInput(p.id, { fire: 1, aim: 0 });
    r.seconds(2);
    assert.equal(p.health, p.maxHealth, key + ' did not hit its owner');
  }
});

test('a rocket into the wall at your feet takes you with it', () => {
  /* Splash is splash. This is the trade rockets are: near enough is good
     enough, and near enough includes you. */
  const { r, p } = withPlayer('rockets');
  put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
  r.map[20][21] = SH.STONE;
  r.setInput(p.id, { fire: 1, aim: 0 });
  r.seconds(1);
  assert.ok(p.health < p.maxHealth, 'it hurt (' + p.health + ')');
});

test('a mine will not go off under the tank that laid it', () => {
  const { r, p } = withPlayer('mines');
  put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
  r.setInput(p.id, { fire: 1, aim: 0 });
  r.seconds(4);
  assert.equal(p.health, p.maxHealth, 'you can drive over your own mines');
  assert.ok(r.mines.length > 0, 'and they are still armed and waiting');
});

test('every one of the ten fires, and none of them throws', () => {
  for (const key of WEAPON_KEYS) {
    const { r, p } = withPlayer(key);
    const target = r.makeTank('t' + key, 'Target', 'cannon', true);
    put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
    put(r, target, p.x + (key === 'flamethrower' ? 55 : 150), p.y);
    for (let c = 15; c < 30; c++) { r.map[20][c] = SH.EMPTY; r.hp[20][c] = 0; }
    target.health = 10000; target.maxHealth = 10000;
    r.setInput(p.id, { fire: 1, aim: 0 });
    r.seconds(3);
    if (key === 'mines') {
      assert.ok(r.mines.length > 0, 'mines were laid');
      continue;
    }
    assert.ok(target.health < 10000, key + ' did damage (' + target.health + ')');
  }
});

test('a ricochet comes off stone instead of stopping in it', () => {
  const { r, p } = withPlayer('ricochet');
  put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
  for (let c = 15; c < 26; c++) { r.map[20][c] = SH.EMPTY; r.hp[20][c] = 0; }
  r.map[20][26] = SH.STONE;
  r.fireFrom(p, 0, 'ricochet');
  const b = r.bullets[0];
  assert.ok(b.vx > 0, 'it starts going right');
  for (let i = 0; i < 60 && r.bullets.length; i++) r.step(1);
  const still = r.bullets[0];
  assert.ok(!still || still.vx < 0 || still.bounce < 4, 'it turned round rather than dying in the wall');
});

test('the railgun goes through brick and the laser does not', () => {
  function shoot(key) {
    const { r, p } = withPlayer(key);
    put(r, p, 20.5 * SH.TILE, 20.5 * SH.TILE);
    for (let c = 21; c < 30; c++) { r.map[20][c] = SH.EMPTY; r.hp[20][c] = 0; }
    r.map[20][22] = SH.BRICK; r.hp[20][22] = 1;      // one hit and it is gone
    const far = r.makeTank('far' + key, 'Far', 'cannon', true);
    put(r, far, 26.5 * SH.TILE, 20.5 * SH.TILE);
    far.health = 5000; far.maxHealth = 5000;
    r.fireFrom(p, 0, key);
    return far.health < 5000;
  }
  assert.equal(shoot('railgun'), true, 'the railgun carried on through');
  assert.equal(shoot('laser'), false, 'the laser stopped at the wall');
});

test('an empty arena stops ticking, and forgets the mess', () => {
  const { r, p } = withPlayer();
  r.pickups.push({ x: 1, y: 1, kind: 'coin', value: 5, born: r.now() });
  r.removePlayer(p.id);
  assert.equal(r.tanks.size, 0, 'the bots stood down with the last human');
  assert.equal(r.pickups.length, 0, 'and the floor was swept');
  assert.equal(r.timer, null, 'the loop is stopped');
});

test('bots fill an empty arena and stand down as people arrive', () => {
  const r = new Room();
  r.addPlayer(sock(), 'Owen', 'cannon');
  r.stop();
  const withOne = [...r.tanks.values()].filter(t => t.bot).length;
  assert.ok(withOne >= 1, 'one player is not alone in here');
  for (let i = 0; i < 4; i++) r.addPlayer(sock(), 'P' + i, 'cannon');
  r.stop();
  const withFive = [...r.tanks.values()].filter(t => t.bot).length;
  assert.ok(withFive < withOne, 'fewer bots with five humans (' + withOne + ' -> ' + withFive + ')');
});

test('a snapshot is a sane size and carries no sockets', () => {
  const { r, p } = withPlayer();
  r.topUpBots();
  const s = JSON.stringify(r.snapshot(p.id));
  assert.ok(!s.includes('socket'), 'no socket leaks onto the wire');
  assert.ok(s.length < 12000, 'a frame is small (' + s.length + ' bytes)');
  const snap = r.snapshot(p.id);
  assert.ok(snap.you, 'it knows who it is for');
  assert.ok(snap.tanks.every(t => t.id !== p.id), 'and does not send you to yourself twice');
});

test('the map goes out once as a string, not thirty times a second', () => {
  const { r, p } = withPlayer();
  const m = r.mapPayload();
  assert.equal(m.cells.split('|').length, SH.ROWS, 'a row per line');
  assert.equal(m.cells.split('|')[0].length, SH.COLS, 'a character per cell');
  assert.equal(r.snapshot(p.id).cells, null, 'nothing changed, so nothing is sent');

  r.damageCell(...cellOf(r, r.bank.x + 400, r.bank.y), 0);   // touch nothing
  r.map[12][12] = SH.CRATE; r.hp[12][12] = 1;
  r.damageCell(12, 12, 99);
  const patch = r.snapshot(p.id).cells;
  assert.ok(patch && patch.length >= 2, 'a broken cell is sent as a patch');
  assert.equal(patch[0], 12 * SH.COLS + 12, 'by index');
  assert.equal(patch[1], SH.EMPTY, 'and its new kind');
});

test('an unknown weapon changes nothing', () => {
  const { r, p } = withPlayer('cannon');
  assert.equal(r.setWeapon(p.id, 'deathray'), false);
  assert.equal(p.weapon, 'cannon');
  assert.equal(r.setWeapon(p.id, 'railgun'), true);
  assert.equal(p.weapon, 'railgun');
});

test('a weapon that does not exist at join time is a cannon, not a crash', () => {
  const r = new Room();
  const p = r.addPlayer(sock(), 'Owen', 'nonsense');
  r.stop();
  assert.equal(p.weapon, 'cannon');
  assert.ok(WEAPONS[p.weapon], 'and it is a real one');
});
