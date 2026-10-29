'use strict';
/* Night review 2026-10-29, fourth pass on findings 1, 2 and 22 (review problem 0, high): with PUBLIC_RPC_URL unset (the
   default, and production today) the only limit on what strangers spend of the money key's credits was the per-second
   rates. The reviewer ran the module on a fake clock for a day: one address about 155.6k calls, four or more about
   449k (public 259k, history 173k, blockhash 17k), Helius Free's 1M a month gone in about two days, then every stake,
   verify and payout refused until it renews.

   Now (server/rpcBudget.js createDayCap and persistDayCap, server/rpcDay.js): while the public reads share the money
   key, the public budget and history take from one day of RPC_READS_PER_DAY (10k), refilling over 24 h, kept in a file
   across restarts. These tests show a rebuilt day does not refill, what a month of flood can cost with restarts and
   crashes, that honest traffic at today's size stays well under it, that each address has a share and a reserve stays
   for the rest, and that the day exists only on the shared key. All on fake clocks and temp files. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { createDayCap, dayShare, readDayFile, persistDayCap, createBudget, callerShare, UNMETERED } = require('../server/rpcBudget');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcday-'));
const HOUR = 3_600_000, DAY = 24 * HOUR;
// A process to hand persistDayCap: signals are emitted by hand, exit is recorded, never real.
function fakeProc() {
  const p = new EventEmitter();
  p.exits = [];
  p.exit = (code) => { p.exits.push(code); };
  return p;
}
const noTimer = () => ({ unref() {} });
// A file system in memory, for the tests that save thousands of times.
function memFs() {
  const files = new Map();
  return {
    mkdirSync() {}, writeFileSync(f, d) { files.set(f, String(d)); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    readFileSync(f) { if (!files.has(f)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(f); },
  };
}
// The two public budgets exactly as index.js and Usdc.js build them at their defaults, on one day.
function budgets(day, now) {
  const pubCfg = { perSec: 3, burst: 40 };
  return {
    pub: createBudget(Object.assign({}, pubCfg, { perKey: callerShare(pubCfg), day, now })),
    hist: createBudget({ perSec: 2, burst: 60, perKey: { perSec: 1, burst: 60 }, day, now }),
  };
}

test('a day: past it a take or a reserve is refused at once, every call is counted, the owner is neither', () => {
  let t = 0;
  const day = createDayCap({ perDay: 100, now: () => t });
  const pub = createBudget({ perSec: 1000, burst: 1000, day, now: () => t });
  const hist = createBudget({ perSec: 1000, burst: 1000, day, now: () => t });
  for (let i = 0; i < 25; i++) assert.strictEqual(pub.take(2, 'A' + i), null);
  for (let i = 0; i < 50; i++) assert.deepStrictEqual(hist.reserve(1, 15_000, 'B' + i), { wait: 0 });
  assert.strictEqual(Math.round(day.left()), 0, 'the two budgets spend the one day');
  assert.strictEqual(pub.take(2, 'C'), 'day');
  assert.deepStrictEqual(hist.reserve(1, 15_000, 'C'), { refused: 'day' }, 'never waited for: a day is not seconds away');
  const v = day.version();
  assert.strictEqual(pub.take(2, UNMETERED), null, 'the owner\'s own session is never refused by it');
  assert.deepStrictEqual(hist.reserve(1, 15_000, UNMETERED), { wait: 0 });
  assert.strictEqual(day.version(), v, 'and never counted in it');
  // It refills over 24 h: an hour gives back a twenty-fourth.
  t += HOUR;
  assert.ok(Math.abs(day.left() - 100 / 24) < 1e-9, String(day.left()));
  assert.strictEqual(pub.take(2, 'C'), null);
  assert.strictEqual(pub.take(2, 'C'), null);
  assert.strictEqual(pub.take(2, 'C'), 'day');
  t += 30 * DAY;
  assert.strictEqual(day.left(), 100, 'never more than a day saved up');
});

test('each address has an eighth of the day, and past it may not touch the quarter kept for everyone else', () => {
  let t = 0;
  const day = createDayCap({ perDay: 800, perKey: dayShare(800), now: () => t });
  assert.deepStrictEqual(dayShare(800), { perDay: 100, reserve: 200 });
  const pub = createBudget({ perSec: 1e6, burst: 1e6, day, now: () => t });
  let flood = 0;
  while (pub.take(2, '203.0.113.9') === null) flood += 2;
  assert.strictEqual(flood, 600, 'one address alone takes the day down to the reserve and no further');
  assert.strictEqual(pub.take(2, '203.0.113.9'), 'day');
  // A player who just came is inside their share: the reserve is theirs, up to their own share of the day.
  for (let i = 0; i < 50; i++) assert.strictEqual(pub.take(2, '198.51.100.7'), null, 'poll ' + i);
  assert.strictEqual(pub.take(2, '198.51.100.7'), 'day', 'past their own share now, the rest of the reserve is not theirs either');
  for (let i = 0; i < 50; i++) assert.strictEqual(pub.take(2, '198.51.100.8'), null, 'another player\'s poll ' + i);
  assert.strictEqual(Math.round(day.left()), 0, 'eight shares are the whole day: enough addresses can spend it all');
  // Shares refill with the day: three hours on, the flooding address has an eighth of three hours of its share back
  // (12.5), so that much of the refilled 100, then it is past its share again and the rest waits for others.
  t += 3 * HOUR;
  assert.strictEqual(Math.round(day.left()), 100);
  let again = 0;
  while (pub.take(2, '203.0.113.9') === null) again += 2;
  assert.strictEqual(again, 12);
  assert.strictEqual(pub.take(2, '198.51.100.9'), null, 'a new player still gets a balance');
});

test('a restart rebuilds the day from its file as spent as it was: it never refills (the reviewer\'s ask)', () => {
  let t = 5 * DAY;
  const file = path.join(TMP, 'restart.json');
  const share = dayShare(10000);
  const proc = fakeProc();
  let day = createDayCap({ perDay: 10000, perKey: share, now: () => t, saved: readDayFile(file) });
  assert.strictEqual(day.left(), 10000, 'no file yet: a fresh day');
  persistDayCap(day, { file, proc, every: noTimer });
  let b = budgets(day, () => t);
  // Sixteen addresses flood both budgets until the day refuses them.
  const ips = Array.from({ length: 16 }, (_, i) => '203.0.113.' + i);
  let spent = 0;
  for (let s = 0; s < 4 * 3600; s++) {
    t += 1000;
    for (const ip of ips) {
      if (b.pub.take(2, ip) === null) spent += 2;
      if (b.hist.reserve(1, 15_000, ip).wait !== undefined) spent++;
    }
  }
  assert.ok(day.left() < 2, 'spent: ' + day.left() + ' left');
  assert.ok(spent <= 10000 + 4 * 3600 * 10000 / 86400 + 2, spent + ' calls in 4 hours: the day and what refilled');
  // pm2's restart: SIGINT, the listener saves, the next boot reads the file. Same clock: nothing came back.
  proc.emit('SIGINT');
  assert.deepStrictEqual(proc.exits, [130], 'alone here, it ends the process as the signal would have');
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /203\.0\.113/, 'addresses are saved as hashes, never as they are');
  day = createDayCap({ perDay: 10000, perKey: share, now: () => t, saved: readDayFile(file) });
  assert.ok(day.left() < 2, 'rebuilt as spent as it was: ' + day.left());
  b = budgets(day, () => t);
  assert.strictEqual(b.pub.take(2, '198.51.100.7'), 'day', 'a new boot hands a flood nothing');
  assert.deepStrictEqual(b.hist.reserve(1, 15_000, '198.51.100.7'), { refused: 'day' });
  // The time it is down refills as it would have, and only that: an hour is a twenty-fourth of the day.
  const left0 = day.left();
  t += HOUR;
  assert.ok(Math.abs(day.left() - (left0 + 10000 / 24)) < 1e-6, String(day.left()));
});

test('each address\'s share of the day survives a restart too, so a flooder cannot reach the reserve by redeploys', () => {
  let t = 0;
  const file = path.join(TMP, 'shares.json');
  const share = dayShare(800);
  const proc = fakeProc();
  let day = createDayCap({ perDay: 800, perKey: share, now: () => t });
  persistDayCap(day, { file, proc, every: noTimer });
  let pub = createBudget({ perSec: 1e6, burst: 1e6, day, now: () => t });
  while (pub.take(2, '203.0.113.9') === null);
  assert.strictEqual(Math.round(day.left()), 200, 'one address took the day down to the reserve');
  proc.emit('SIGINT');
  day = createDayCap({ perDay: 800, perKey: share, now: () => t, saved: readDayFile(file) });
  pub = createBudget({ perSec: 1e6, burst: 1e6, day, now: () => t });
  assert.strictEqual(pub.take(2, '203.0.113.9'), 'day', 'after the restart it is still past its share: the reserve is not its');
  assert.strictEqual(pub.take(2, '198.51.100.7'), null, 'a player inside theirs still gets a balance');
  // Without the shares in the file, the restart would have handed it a fresh share of the reserve.
  const forgot = createDayCap({ perDay: 800, perKey: share, now: () => t, saved: Object.assign(readDayFile(file), { keys: [] }) });
  assert.strictEqual(forgot.refusal(2, '203.0.113.9'), null);
});

test('the reviewer\'s month: a flood on 4 addresses (the rates\' most) with a restart every 12 minutes (or a crash) costs the day, no more', () => {
  /* At the defaults: the public budget (3 a second) and history (2 a second), each address flooding both as fast as
     its share allows, for 2 days. Rates alone: 5 x 86,400 x 2 = 864k calls. With the day, a span of N days costs
     about N + 1 days of it (the first day full, then what refills), restarts or not. A crash (no SIGINT) loses only
     what was counted since the last 30 s save, which once the day is spent is what refilled in those 30 s. */
  for (const crash of [false, true]) {
    let t = 0;
    const file = path.join(TMP, 'month-' + crash + '.json');
    const share = dayShare(10000);
    let proc = fakeProc(), tick = null;
    const mem = memFs();                                 // 5760 saves: in memory, the disk is persistDayCap's own test
    const boot = () => {
      const day = createDayCap({ perDay: 10000, perKey: share, now: () => t, saved: readDayFile(file, { fs: mem }) });
      proc = fakeProc();
      persistDayCap(day, { file, fs: mem, proc, everyMs: 30_000, every: (fn, ms) => { tick = fn; assert.strictEqual(ms, 30_000); return { unref() {} }; } });
      return Object.assign(budgets(day, () => t), { day });
    };
    let b = boot();
    const ips = Array.from({ length: 4 }, (_, i) => '203.0.113.' + i);
    let spent = 0, restarts = 0;
    for (let s = 30; s <= 2 * 86400; s += 30) {
      t = s * 1000;
      // Every 12 minutes: a restart right after a save, or a crash right before one (30 s of counting lost).
      if (s % 720 === (crash ? 690 : 0)) {
        if (!crash) proc.emit('SIGINT');
        restarts++;
        b = boot();
      }
      tick();                                            // the 30 s save
      for (const ip of ips) {
        for (let i = 0; i < 12; i++) if (b.pub.take(2, ip) === null) spent += 2;
        for (let i = 0; i < 48; i++) if (b.hist.reserve(1, 15_000, ip).wait !== undefined) spent++;
      }
    }
    assert.strictEqual(restarts, 240);
    assert.ok(spent >= 25000, spent + ': the flood did spend what it could');
    // A crash loses what the day let through in the 30 s before it: what refilled (about 3.5 calls) once it is spent,
    // and at most 30 s of the two rates (150) before that.
    const most = 3 * 10000 + 2 + (crash ? restarts * 30 * 10000 / 86400 + 30 * 5 : 0);
    assert.ok(spent <= most, (crash ? 'crashing' : 'restarting') + ': ' + spent + ' calls in 2 days (at most ' +
      Math.round(most) + '), against 864k with the rates alone');
  }
});

test('honest traffic at today\'s size stays well under the day: nothing refused', () => {
  /* Today: the owner (his session is never counted) with a tab in view all day, and three testers who each have the
     lobby in view an hour (a balance, two calls, every 15 s), hidden two hours (once a minute) and open the Wallet tab
     twice (its history, 60 reads at most each). */
  let t = 0;
  const day = createDayCap({ perDay: 10000, perKey: dayShare(10000), now: () => t });
  const b = budgets(day, () => t);
  let asked = 0, refused = 0;
  const ask = (r) => { asked++; if (r !== null && !(r && r.wait !== undefined)) refused++; };
  for (let ms = 0; ms < DAY; ms += 15_000) {
    t = ms;
    ask(b.pub.take(2, UNMETERED));
    for (let i = 0; i < 3; i++) {
      const ip = '198.51.100.' + i, h = ms / HOUR;
      if (h >= 9 + i && h < 10 + i) ask(b.pub.take(2, ip));                             // in view
      else if (h >= 18 + i && h < 20 + i && ms % 60_000 === 0) ask(b.pub.take(2, ip));  // hidden
      if (ms === (12 + i) * HOUR || ms === (21 + i) * HOUR) for (let k = 0; k < 60; k++) ask(b.hist.reserve(1, 15_000, ip));
    }
  }
  assert.strictEqual(refused, 0, refused + ' of ' + asked + ' refused');
  const used = 10000 - day.left();
  assert.ok(used < 3000, 'a day of it uses ' + Math.round(used) + ' of 10000 (refilling as it goes)');
});

test('persistDayCap: written every 30-60 s while it changed, and on SIGINT, SIGTERM and exit; others still decide the end', () => {
  let t = 0;
  const file = path.join(TMP, 'persist', 'day.json');
  const day = createDayCap({ perDay: 100, perKey: dayShare(100), now: () => t });
  const proc = fakeProc();
  let tick = null, every = null;
  const save = persistDayCap(day, { file, proc, every: (fn, ms) => { tick = fn; every = ms; return { unref() {} }; } });
  assert.ok(every >= 30_000 && every <= 60_000, String(every));
  tick();
  assert.ok(!fs.existsSync(file), 'nothing spent, nothing written');
  day.commit(3, 'A');
  tick();
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([s.v, s.perDay, s.spent, s.share, s.keys.length], [1, 100, 3, 12.5, 1]);
  assert.ok(!fs.existsSync(file + '.tmp'), 'written whole, then renamed over the last');
  assert.strictEqual(save(), false, 'unchanged since: not written again');
  // The leaderboard's flush listens in production and keeps the process for pm2's kill: ours saves and leaves it be.
  const order = [];
  const flush = () => order.push('leaderboard');
  proc.on('SIGTERM', flush);
  day.commit(2, 'B');
  proc.emit('SIGTERM');
  assert.deepStrictEqual(order, ['leaderboard']);
  assert.deepStrictEqual(proc.exits, [], 'someone else listens: they decide when it ends, as before');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).spent, 5, 'saved before anything else ran');
  // Paid agar.io's settle (agShutdown.js) is a once-listener that counts the listeners left to decide whether to exit:
  // ours went first and is gone, so it sees what it saw before this pass.
  let seen = null;
  proc.once('SIGINT', () => { seen = proc.listenerCount('SIGINT'); });
  day.commit(1, 'C');
  proc.emit('SIGINT');
  assert.strictEqual(seen, 0, 'the settle still finds itself alone, and exits after its writes, as before');
  assert.deepStrictEqual(proc.exits, [], 'ours did not end it under the settle');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).spent, 6);
  // process.exit from anywhere: saved on the way out.
  day.commit(1, 'C');
  proc.emit('exit', 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).spent, 7);
  // A file it cannot write: said once, never thrown, the next good write goes through.
  const lines = [];
  const bad = createDayCap({ perDay: 100, now: () => t });
  const badFs = { mkdirSync() {}, writeFileSync() { throw new Error('EACCES'); }, renameSync() {} };
  const badSave = persistDayCap(bad, { file, fs: badFs, proc: fakeProc(), every: noTimer, log: (x) => lines.push(x) });
  bad.commit(1); assert.strictEqual(badSave(), false);
  bad.commit(1); assert.strictEqual(badSave(), false);
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\[RPC-DAY\] could not save .*EACCES/);
});

test('readDayFile and the rebuild: no file is a fresh day, a file not ours is said once, a clock behind is no gift', () => {
  const lines = [];
  const log = (x) => lines.push(x);
  assert.strictEqual(readDayFile(path.join(TMP, 'none.json'), { log }), null);
  assert.deepStrictEqual(lines, [], 'no file yet is said nothing');
  const junk = path.join(TMP, 'junk.json');
  fs.writeFileSync(junk, '{not json');
  assert.strictEqual(readDayFile(junk, { log }), null);
  assert.match(lines[0], /^\[RPC-DAY\] .*junk\.json is not a day we wrote/);
  let t = 1000 * DAY;
  for (const saved of [{ v: 2, at: t, spent: 9000 }, { v: 1, at: 'x', spent: 9000 }, { v: 1, at: t, spent: -5 }, [], 'x']) {
    assert.strictEqual(createDayCap({ perDay: 10000, now: () => t, saved }).left(), 10000, JSON.stringify(saved));
  }
  // Saved "in the future" (the clock was set back): counted from now, so the gap refills nothing.
  const ahead = createDayCap({ perDay: 10000, now: () => t, saved: { v: 1, at: t + DAY, spent: 10000 } });
  assert.strictEqual(ahead.left(), 0);
  // A bigger day in .env: what was spent carries over, the rest is new room.
  const bigger = createDayCap({ perDay: 20000, now: () => t, saved: { v: 1, at: t, spent: 9000 } });
  assert.strictEqual(bigger.left(), 11000);
  // Old enough, it refilled while the server was down.
  const old = createDayCap({ perDay: 10000, now: () => t, saved: { v: 1, at: t - 2 * DAY, spent: 10000 } });
  assert.strictEqual(old.left(), 10000);
});

test('the hourly usage line says what is left of the shared key\'s day', () => {
  const { usageLog } = require('../server/rpcBudget');
  let t = 0;
  const day = createDayCap({ perDay: 10000, now: () => t });
  const b = createBudget({ perSec: 100, burst: 100, day, now: () => t });
  const lines = [];
  let tick = null;
  usageLog('public RPC reads', b, { day, log: (x) => lines.push(x), every: (fn) => { tick = fn; return { unref() {} }; } });
  b.take(2, 'A'); b.take(2, 'B');
  tick();
  assert.deepStrictEqual(lines, ['[RPC-USAGE] public RPC reads: 4 provider calls in the last 60 min (the shared key\'s day: 9996 of 10000 left)']);
});

test('server/rpcDay.js: a day only while the public reads share the money key, kept in RPC_DAY_PATH across a real restart', () => {
  const ROOT = path.join(__dirname, '..');
  const file = path.join(TMP, 'proc', 'rpc-day.json');
  const run = (env, code) => {
    const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 30_000,
      env: Object.assign({}, process.env, { RPC_DAY_PATH: file, PUBLIC_RPC_URL: '', RPC_READS_PER_DAY: '' }, env) });
    return { status: r.status, out: (r.stdout || '').trim().split('\n').pop(), err: r.stderr };
  };
  const key = 'https://money.invalid/?api-key=m';
  // Unset: the day exists, spends, and SIGINT (pm2's restart) saves it and ends the process as the signal would.
  let r = run({ RPC_URL: key }, `
    const d = require('./server/rpcDay'); console.log = (x) => process.stdout.write(String(x) + '\\n');
    const b = require('./server/rpcBudget').createBudget({ perSec: 1e6, burst: 1e6, day: d.day });
    let n = 0; while (b.take(2, '203.0.113.' + (n % 50)) === null) n++;
    console.log(Math.floor(d.day.left())); process.emit('SIGINT'); setTimeout(() => console.log('still here'), 50);`);
  assert.strictEqual(r.status, 130, r.err);
  assert.strictEqual(r.out, '0', 'spent to nothing (and nothing ran after the signal)');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).spent >= 9998, true);
  // The next boot: as spent as it was.
  r = run({ RPC_URL: key }, `const d = require('./server/rpcDay'); process.stdout.write(Math.floor(d.day.left()) + ' ' + d.day.perDay + '\\n');`);
  assert.strictEqual(r.out, '0 10000', r.err);
  // The same key named twice is still the shared key.
  r = run({ RPC_URL: key, PUBLIC_RPC_URL: key }, `process.stdout.write(String(require('./server/rpcDay').day !== null) + '\\n');`);
  assert.strictEqual(r.out, 'true');
  // A key of their own: no day at all (strangers can only spend that key), and nothing read or written.
  fs.rmSync(file);
  r = run({ RPC_URL: key, PUBLIC_RPC_URL: 'https://public.invalid/?api-key=p' },
    `process.stdout.write(String(require('./server/rpcDay').day) + '\\n'); process.exit(0);`);
  assert.strictEqual(r.out, 'null');
  assert.ok(!fs.existsSync(file));
  // RPC_READS_PER_DAY sizes it.
  r = run({ RPC_URL: key, RPC_READS_PER_DAY: '25000' }, `process.stdout.write(require('./server/rpcDay').day.perDay + '\\n');`);
  assert.strictEqual(r.out, '25000');
  // Where it lives: server/data/rpc-day.json on a server (nothing spent, so nothing written here); in memory under
  // node --test with no RPC_DAY_PATH, so the suite never reads or spends a checkout's day.
  const where = `const d = require('./server/rpcDay'); process.stdout.write(String(d.FILE) + ' ' + Math.floor(d.day.left()) + '\\n');`;
  r = run({ RPC_URL: key, RPC_DAY_PATH: '', NODE_TEST_CONTEXT: '' }, where);
  assert.strictEqual(r.out, path.join(ROOT, 'server', 'data', 'rpc-day.json') + ' ' + 10000);
  r = run({ RPC_URL: key, RPC_DAY_PATH: '', NODE_TEST_CONTEXT: 'child-v8' }, where);
  assert.strictEqual(r.out, 'null 10000');
});
