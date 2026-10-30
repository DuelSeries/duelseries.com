'use strict';
/* The main server's link to the slither process (server/split/slLink.js; server split spec 5, 8.3, 8.4, 14.1 #4), on
   a fake child (an EventEmitter that records what it is sent) and a fake clock.

   - single mode: the inert link does nothing and says nothing (debug undefined, ownsCommand false)
   - hello -> init with every mirror (the free door the owner last set included) and the fork's options
   - a snapshot is taken only from the child running now and only with a rising seq; fresh for 5 s of this clock
   - commands: the reply resolves (its snapshot applied first), 5 s without one is the "may still have done it"
     answer, nothing is ever sent twice, a child that is not ready or has exited answers "restarting"
   - the supervisor: refork after 1, 2, 5, 10, 30 s, back to 1 s after a child lived 120 s, more than 10 exits in 10
     minutes is the end (one push, no fork); a goodbye exit is not counted; the hang watchdog kills a silent child
   - load: only when a field changed or the paid slice is above 0, never while sends are queued
   - the battle royale across a child death (spec 8.4): an exit with a live match voids it once (voidCutOffBr lifted
     from server/index.js on a real brJournal); br.decided twice, the snapshot's decided block and the 10 s backstop
     pay ONE prize (payBattleRoyaleWinner and _brPaid lifted the way test/brPeople.test.js does); br.live reaches a
     real brJournal in order
   - a free join with the owner's session cookie is silenced by a real createOwnerSessions and joinAlerts; without it
     one push */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const L = require('../server/split/slLink');
const { createBrJournal } = require('../server/slBr/brJournal');
const { createJoinAlerts } = require('../server/joinAlerts');
const { createOwnerSessions, CREATE_ACTION } = require('../server/ownerSession');
const ownerAuth = require('../server/ownerAuth');

const QUIET = { log() {}, warn() {}, error() {} };
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function fakeClock(start) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const h = { id: ++seq, unref() { return h; } };
    const p = Math.max(1, Number(ms) || 0);
    timers.set(h, { at: t + p, fn, every: every ? p : 0, seq: h.id });
    return h;
  };
  return {
    now: () => t,
    timers: { setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: (h) => timers.delete(h),
      setInterval: (fn, ms) => add(fn, ms, true), clearInterval: (h) => timers.delete(h) },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [h, x] of timers) {
          if (x.at <= end && (!best || x.at < best[1].at || (x.at === best[1].at && x.seq < best[1].seq))) best = [h, x];
        }
        if (!best) break;
        const [h, x] = best;
        t = x.at;
        if (x.every) x.at += x.every; else timers.delete(h);
        x.fn();
      }
      t = end;
    },
  };
}

// fork() as the link calls it, making fake children that record what they are sent.
function fakeFork() {
  const kids = [];
  const fork = (file, args, opts) => {
    const c = new EventEmitter();
    Object.assign(c, { pid: 4000 + kids.length, connected: true, exitCode: null, signalCode: null, sent: [], kills: [],
      file, args, opts });
    c.send = (m, cb) => {
      c.sent.push(JSON.parse(JSON.stringify(m)));
      if (cb) cb(null);
      return true;
    };
    c.kill = (sig) => { c.kills.push(sig); c.die(null, sig); return true; };
    c.die = (code, sig) => {
      if (c.exitCode !== null || c.signalCode !== null) return;
      c.exitCode = code;
      c.signalCode = sig || null;
      c.connected = false;
      c.emit('exit', code, sig || null);
      c.emit('close', code, sig || null);
    };
    c.say = (m) => c.emit('message', JSON.parse(JSON.stringify(Object.assign({ v: 1 }, m))));
    c.of = (t) => c.sent.filter((m) => m.t === t);
    kids.push(c);
    return c;
  };
  return { fork, kids };
}

const roomRow = (lobbyType, kind) => ({ lobbyType, kind, index: 0, playerCount: 1, botCount: 5, humans: 1,
  botsAllowed: true, botTarget: null, botAim: null, botsHeld: null, pausedUntil: 0 });
function snapMsg(boot, seq, o) {
  return Object.assign({ t: 'snap', boot, seq, at: 0, proc: { pid: 1, rssMb: 80, heapMb: 30, elu: 0.1, loopP99Ms: 2 },
    gov: { engaged: false, mult: 1 }, smooth: true, door: true,
    free: { rows: [{ id: 'sl:na:s0', game: 'snake', region: 'na', stake: 0, players: 1, bots: 5, capacity: null,
      state: 'open' }], rowsErr: null, live: true, humans: 1 },
    rooms: [roomRow('sl_na_s0', 'free'), roomRow('sl_na_br', 'br')],
    br: { open: true, room: 'sl_na_br', humans: 1, decided: null,
      match: { matchId: null, state: 'waiting', public: { engine: 'sl', state: 'waiting', humans: 1 }, canStart: true,
        accepting: true, humanLiving: 1, livingCount: 6 } } }, o || {});
}

// A started link with its fake child said hello and ready. o: create's options and start's hooks.
function rig(o) {
  const opt = o || {};
  const clock = fakeClock(1.7e12);
  const ff = fakeFork();
  const logs = [];
  const log = { log: (s) => logs.push(s), warn: (s) => logs.push(s), error: (s) => logs.push(s) };
  const pushes = [];
  const opsState = { maintenance: false, message: '' };
  const link = L.create(Object.assign({ enabled: true, port: 3001, ops: { get: () => opsState },
    notify: { pushOwner: (text, meta) => pushes.push({ text, meta }) }, log, now: clock.now, timers: clock.timers,
    fork: ff.fork, childPath: '/x/slChild.js' }, opt.create || {}));
  const hooks = Object.assign({ init: () => ({ region: 'na', owners: ['OWNER'], ops: opsState, smooth: true,
    door: true, brOnNew: true, podiumFile: '/tmp/p.json', botsPauseMs: 900000, load: null }), brOnSl: () => true },
  opt.hooks || {});
  if (opt.start !== false) link.start(hooks);
  const kid = () => ff.kids[ff.kids.length - 1];
  let bootN = 0;
  const greet = (c) => {
    const k = c || kid();
    const boot = 'B' + (++bootN);
    k.say({ t: 'hello', boot, pid: k.pid, node: 'v20.20.2' });
    k.say({ t: 'ready', boot, port: 3001, dev: false });
    k.boot = boot;
    return boot;
  };
  return { clock, ff, link, logs, pushes, opsState, hooks, kid, greet };
}

test('single mode: the inert link does nothing, owns nothing and adds nothing to /api/debug/tick', async () => {
  const link = L.create({ enabled: false, port: 3001 });
  assert.strictEqual(link.remote, false);
  assert.strictEqual(link.port, 3001);
  assert.strictEqual(link.ownsCommand('br:start', {}), false);
  assert.strictEqual(link.ownsCommand('bots:add', { room: 'sl_na_s0' }), false);
  assert.strictEqual(link.debug(), undefined);
  assert.strictEqual(link.send({ t: 'smooth', on: true }), false);
  assert.strictEqual(link.emit('maintenance', {}), undefined);
  assert.strictEqual(link.start({}), undefined);
  assert.strictEqual(link.stop(), undefined);
  assert.strictEqual(link.freeProxy({}), null);
  assert.strictEqual(link.brProxy(), null);
  assert.strictEqual((await link.call('bots:add', {})).ok, false);
  assert.strictEqual(L.create({}).remote, false, 'off unless enabled');
  assert.strictEqual(L.create({ enabled: false }).port, Number(process.env.PORT || 3000) + 1, 'PORT + 1 by default');
});

test('fork options and hello -> init with every mirror, the owner\'s last door included', () => {
  const r = rig({ start: false });
  const free = r.link.freeProxy({ laws: {}, shippableOnly: true, governor: r.link.mirrorGovernor() });
  assert.strictEqual(free.door(false), false, 'set before the child exists');
  assert.strictEqual(r.link.doorWanted(), false);
  r.link.useHelpers({ paidLoad: () => ({ paidPlayers: 2, paid: [] }) });
  r.opsState.maintenance = true;
  r.link.start(r.hooks);
  const c = r.kid();
  assert.strictEqual(c.file, '/x/slChild.js');
  assert.strictEqual(c.opts.serialization, 'json');
  assert.deepStrictEqual(c.opts.stdio, ['ignore', 'inherit', 'inherit', 'ipc']);
  assert.deepStrictEqual(c.opts.execArgv, ['--max-old-space-size=192', '--inspect-port=127.0.0.1:9230']);
  assert.strictEqual(c.opts.env.SL_CHILD_PORT, '3001');
  assert.strictEqual(c.opts.env.PATH, process.env.PATH, 'the whole environment');
  assert.strictEqual(c.sent.length, 0, 'nothing before hello');
  c.say({ t: 'hello', boot: 'B1', pid: c.pid, node: 'v20' });
  const init = c.of('init');
  assert.strictEqual(init.length, 1);
  assert.deepStrictEqual(init[0], { v: 1, t: 'init', region: 'na', owners: ['OWNER'], ops: { maintenance: true, message: '' },
    smooth: true, door: false, brOnNew: true, podiumFile: '/tmp/p.json', botsPauseMs: 900000,
    load: { paidPlayers: 2, extraSliceMs: 0, maintenance: true } });
  assert.strictEqual(r.link.fresh(), false, 'hello is not a snapshot');
  assert.strictEqual(r.link.debug().ready, false);
  c.say({ t: 'ready', boot: 'B1', port: 3001, dev: false });
  assert.strictEqual(r.link.debug().ready, true);
  assert.ok(r.logs.some((s) => /serves \/sl-io\/ on 127\.0\.0\.1:3001/.test(s)));
});

test('snapshots: only from the child running now, only with a rising seq; fresh for 5 s of this process\'s clock', () => {
  const r = rig();
  const c = r.kid();
  const boot = r.greet();
  c.say(snapMsg('OTHER', 1));
  assert.strictEqual(r.link.fresh(), false, 'another boot\'s snapshot is not taken');
  assert.strictEqual(r.link.snap(), null);
  c.say(snapMsg(boot, 5));
  assert.strictEqual(r.link.fresh(), true);
  assert.strictEqual(r.link.snap().seq, 5);
  c.say(snapMsg(boot, 5, { door: false }));
  c.say(snapMsg(boot, 4, { door: false }));
  assert.strictEqual(r.link.snap().door, true, 'an old or repeated seq is not taken');
  r.clock.advance(4999);
  assert.strictEqual(r.link.fresh(), true);
  r.clock.advance(1);
  assert.strictEqual(r.link.fresh(), false, 'stale at 5 s');
  assert.strictEqual(r.link.stale(), true);
  assert.strictEqual(r.link.ageMs(), 5000);
  c.say(snapMsg(boot, 6));
  assert.strictEqual(r.link.fresh(), true);
  // the child dies: stale at once, the last snapshot kept
  c.die(1, null);
  assert.strictEqual(r.link.fresh(), false);
  assert.strictEqual(r.link.snap().seq, 6);
  // its successor starts its seq again: taken once its own hello came
  r.clock.advance(1000);
  const c2 = r.kid();
  assert.notStrictEqual(c2, c);
  c2.say(snapMsg(boot, 7));
  assert.strictEqual(r.link.fresh(), false, 'the dead child\'s boot is not this one\'s');
  const boot2 = r.greet(c2);
  c2.say(snapMsg(boot2, 1));
  assert.strictEqual(r.link.fresh(), true);
});

test('commands: answered with the reply (its snapshot first), 5 s is "may still have done it", never sent twice', async () => {
  const r = rig();
  const c = r.kid();
  assert.deepStrictEqual(await r.link.call('bots:add', { room: 'sl_na_s0', count: 3 }), { ok: false, why: L.WHY_RESTARTING },
    'before ready');
  const boot = r.greet();
  c.say(snapMsg(boot, 1));
  const p = r.link.call('bots:add', { room: 'sl_na_s0', count: 3 });
  const cmd = c.of('cmd');
  assert.strictEqual(cmd.length, 1);
  assert.deepStrictEqual(cmd[0], { v: 1, t: 'cmd', id: 1, op: 'bots:add', args: { room: 'sl_na_s0', count: 3 } });
  c.say({ t: 'reply', re: 1, ok: true, result: { made: 3 }, snap: snapMsg(boot, 2, { door: false }) });
  assert.deepStrictEqual(await p, { ok: true, note: undefined, why: undefined, result: { made: 3 } });
  assert.strictEqual(r.link.snap().door, false, 'the reply\'s snapshot was taken');
  // a refusal without words still says no
  const q = r.link.call('br:stop', {});
  c.say({ t: 'reply', re: 2, ok: false });
  assert.strictEqual((await q).ok, false);
  assert.ok((await q).why);
  // no answer: 5 s, the honest text, and nothing sent again
  const t = r.link.call('br:start', { force: false });
  r.clock.advance(4999);
  let settled = false;
  t.then(() => { settled = true; });
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(settled, false);
  r.clock.advance(1);
  assert.deepStrictEqual(await t, { ok: false, why: L.WHY_TIMEOUT });
  assert.strictEqual(L.WHY_TIMEOUT, 'The slither process did not answer in time; it may still have done it, check the console');
  for (let i = 2; i < 14; i++) {   // a live, reporting child for another minute
    c.say(snapMsg(boot, i + 1));
    r.clock.advance(5000);
  }
  assert.strictEqual(c.of('cmd').filter((m) => m.op === 'br:start').length, 1, 'never retried');
  assert.deepStrictEqual(c.kills, [], 'still the same child');
  c.say({ t: 'reply', re: 3, ok: true, note: 'late' });   // a late reply is dropped quietly
  // pending at an exit: answered restarting
  const d = r.link.call('bots:set', { room: 'sl_na_s0', count: 5 });
  c.die(null, 'SIGKILL');
  assert.deepStrictEqual(await d, { ok: false, why: L.WHY_RESTARTING });
  assert.deepStrictEqual(await r.link.call('bots:set', {}), { ok: false, why: L.WHY_RESTARTING });
  // an op the child does not run is refused here, not sent
  r.clock.advance(1000);
  r.greet();
  assert.match((await r.link.call('rm -rf', {})).why, /cannot take that/);
});

test('supervisor: refork after 1, 2, 5, 10, 30 s; back to 1 s after 120 s up; more than 10 exits in 10 min ends it', () => {
  const r = rig({ create: { hangMs: 3600000 } });   // these children never report; the watchdog has its own test
  const exits = [];
  r.hooks.onExit = () => exits.push(r.clock.now());
  const forkAt = [];
  const waits = [];
  for (let i = 0; i < 6; i++) {
    const c = r.kid();
    forkAt.push(r.clock.now());
    c.die(1, null);
    const before = r.ff.kids.length;
    let waited = 0;
    while (r.ff.kids.length === before && waited < 60000) { r.clock.advance(100); waited += 100; }
    waits.push(waited);
  }
  assert.deepStrictEqual(waits, [1000, 2000, 5000, 10000, 30000, 30000]);
  assert.strictEqual(exits.length, 6, 'onExit once per exit');
  // a child that lived 120 s: back to 1 s
  r.clock.advance(120000);
  r.kid().die(1, null);
  const n = r.ff.kids.length;
  r.clock.advance(1000);
  assert.strictEqual(r.ff.kids.length, n + 1, 'reset after 120 s up');
  // a goodbye (the child was told to stop by someone else) is reforked and not counted
  const g = r.kid();
  r.greet(g);
  g.say({ t: 'bye', why: 'SIGTERM' });
  g.die(0, null);
  r.clock.advance(1000);
  assert.strictEqual(r.ff.kids.length, n + 2);
  assert.strictEqual(r.link.debug().gaveUp, false);
  // now crash fast: the 11th counted exit inside 10 minutes gives up, pushes once, forks no more
  for (let i = 0; i < 20 && !r.link.debug().gaveUp; i++) {
    r.kid().die(1, null);
    r.clock.advance(30000);
  }
  assert.strictEqual(r.link.debug().gaveUp, true);
  const forks = r.ff.kids.length;
  r.clock.advance(3600000);
  assert.strictEqual(r.ff.kids.length, forks, 'no fork after giving up');
  assert.strictEqual(r.pushes.length, 1);
  assert.strictEqual(r.pushes[0].text, L.GAVE_UP_TEXT);
  assert.match(r.pushes[0].text, /scripts\/sl-split\.sh off/);
  assert.ok(r.logs.some((s) => /\[SPLIT\] gave up/.test(s)));
});

test('hang watchdog: a ready child silent for 30 s is killed (SIGKILL) and forked again; so is one never ready', () => {
  const r = rig();
  const c = r.kid();
  const boot = r.greet();
  c.say(snapMsg(boot, 1));
  r.clock.advance(25000);
  assert.deepStrictEqual(c.kills, []);
  c.say(snapMsg(boot, 2));
  r.clock.advance(29000);
  assert.deepStrictEqual(c.kills, [], 'a snapshot resets it');
  r.clock.advance(6000);
  assert.deepStrictEqual(c.kills, ['SIGKILL']);
  r.clock.advance(1000);
  const c2 = r.kid();
  assert.notStrictEqual(c2, c, 'forked again');
  r.clock.advance(35000);
  assert.deepStrictEqual(c2.kills, ['SIGKILL'], 'never said hello: killed too');
  // SL_CHILD_HANG_MS
  const q = rig({ create: { hangMs: 10000 } });
  q.greet();
  q.clock.advance(9999);
  assert.deepStrictEqual(q.ff.kids[0].kills, []);
  q.clock.advance(5001);
  assert.deepStrictEqual(q.ff.kids[0].kills, ['SIGKILL'], 'killed at the first watch after 10 s');
});

test('load: sent when a field changes or the paid slice is above 0, never while sends are queued', () => {
  const r = rig({ start: false });
  let paid = 0;
  let slice = 0;
  let reads = 0;
  r.link.useHelpers({ paidLoad: () => ({ paidPlayers: paid, paid: [] }) });
  r.link.freeProxy({}).setExtraLoad(() => { reads++; const x = slice; slice = 0; return x; });
  r.link.start(r.hooks);
  const c = r.kid();
  r.greet();
  r.clock.advance(3000);
  assert.deepStrictEqual(c.of('load'), [], 'nothing changed since init');
  paid = 1;
  r.clock.advance(1000);
  assert.deepStrictEqual(c.of('load').map((m) => [m.paidPlayers, m.extraSliceMs, m.maintenance]), [[1, 0, false]]);
  r.clock.advance(2000);
  assert.strictEqual(c.of('load').length, 1, 'the same again is not sent');
  slice = 12.5;
  r.clock.advance(1000);
  assert.deepStrictEqual(c.of('load')[1], { v: 1, t: 'load', paidPlayers: 1, extraSliceMs: 12.5, maintenance: false });
  r.opsState.maintenance = true;
  r.clock.advance(1000);
  assert.strictEqual(c.of('load')[2].maintenance, true, 'maintenance rides on load too');
  // a channel that is backed up: no load, and the slice is not read (so not lost)
  const realSend = c.send;
  const held = [];
  c.send = (m, cb) => { c.sent.push(JSON.parse(JSON.stringify(m))); held.push(cb); return false; };
  r.link.send({ t: 'smooth', on: false });
  const readsBefore = reads;
  slice = 7;
  r.clock.advance(3000);
  assert.strictEqual(c.of('load').length, 3);
  assert.strictEqual(reads, readsBefore, 'the slice waits');
  for (const cb of held) cb(null);
  c.send = realSend;
  r.clock.advance(1000);
  assert.strictEqual(c.of('load')[3].extraSliceMs, 7);
});

// ---------------------------------------------------------------------------------------------------------------
// The battle royale across the link, on the real code of server/index.js

function lift(name) {
  const m = new RegExp('^(async )?function ' + name + '\\(', 'm').exec(INDEX);
  assert.ok(m, 'server/index.js still has ' + name);
  const open = INDEX.indexOf('{', INDEX.indexOf(')', m.index));
  let depth = 0;
  for (let j = open; j < INDEX.length; j++) {
    if (INDEX[j] === '{') depth++;
    else if (INDEX[j] === '}' && --depth === 0) return INDEX.slice(m.index, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// index.js's prize and void code on a real brJournal (a temp file), stub money and notify, and X20's hooks as written
// there (pinned below).
function prizeRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sllink-'));
  const journal = createBrJournal({ file: path.join(dir, 'br-journal.json'), log: QUIET });
  const pushes = [];
  const sends = [];
  const tracked = [];
  const ctx = {
    console: QUIET,
    Date,
    _brPaid: new Set(),
    BR_PRIZE_USDC: 20,
    BR_PRIZE_COOLDOWN_DAYS: 7,
    brPrizeRule: require('../server/slBr/brPrizeRule'),
    notify: { pushOwner: (msg, meta) => pushes.push({ msg, title: meta && meta.title }) },
    brJournal: journal,
    agInflight: { track: (p) => { tracked.push(p); return p; } },
    money: { withdraw: async (wallet, amount) => { sends.push({ wallet, amount }); return 'SIG' + sends.length; } },
    db: { walletsWithStakes: async (ws) => new Set(ws), recordEarnings: async () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext([lift('payBattleRoyaleWinner'), lift('startBattleRoyalePrize'), lift('sendBattleRoyalePrize'),
    lift('voidCutOffBr'), 'this.pay = payBattleRoyaleWinner; this.voidCutOffBr = voidCutOffBr;'].join('\n'), ctx);
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.all(tracked.slice()); };
  return { ctx, journal, pushes, sends, settle };
}

test('index.js wires the link\'s hooks as these tests run them', () => {
  const x20 = INDEX.slice(INDEX.indexOf('if (slLink.remote && slArenas) {'), INDEX.indexOf('server.listen(PORT, () => {'));
  assert.match(x20, /onLive: \(rec\) => brJournal\.setLive\(rec\),/);
  assert.match(x20, /const cut = brJournal\.live\(\);\n\s+if \(cut && cut\.matchId === d\.matchId\) brJournal\.setLive\(null\);\n\s+payBattleRoyaleWinner\(slLink\.decisionProxy\(d\)\)\.catch/);
  assert.match(x20, /onExit: \(\) => \{ if \(brJournal\.live\(\)\) voidCutOffBr\('the slither process stopping'\); \},/);
  assert.match(x20, /onPush: \(p\) => notify\.pushOwner\(p\.text, \{ title: p\.title, priority: p\.priority \}\),/);
  assert.match(x20, /joinAlerts\.joined\(\{ game: m\.where === 'br' \? 'br' : 'sl', stake: 0, name: m\.name, socket \}\);/);
  assert.match(x20, /process\.prependOnceListener\(sig, \(\) => slLink\.stop\(\)\)/);
  assert.match(x20, /\} else if \(slArenas\) ioOpts\.aliasListener\(server, slLink\.port, console\);/);
  // the backstop still reads slBr.match, which in split mode is the link's match proxy
  assert.match(INDEX, /for \(const r of \[gameRooms\[REGION\] && gameRooms\[REGION\]\.br, slBr && slBr\.match\]\) \{/);
});

// X20's hooks, as index.js has them, over the lifted code.
const hooksOver = (p, link) => ({
  onLive: (rec) => p.journal.setLive(rec),
  onDecided: (d) => {
    const cut = p.journal.live();
    if (cut && cut.matchId === d.matchId) p.journal.setLive(null);
    p.ctx.pay(link.decisionProxy(d)).catch(() => {});
  },
  onExit: () => { if (p.journal.live()) p.ctx.voidCutOffBr('the slither process stopping'); },
});
const LIVE = { matchId: 'br_live1', startedAt: '2026-10-30T18:00:00.000Z', seats: 3, wallets: 2, people: ['Ann', 'Ben', 'Cy'] };

test('a child that dies with a match live: void once, Owen told who was in it; br.live reaches the journal in order', () => {
  const p = prizeRig();
  const r = rig({ start: false });
  r.link.start(Object.assign({}, r.hooks, hooksOver(p, r.link)));
  const c = r.kid();
  r.greet();
  c.say({ t: 'br.live', rec: Object.assign({}, LIVE, { matchId: 'br_first' }) });
  c.say({ t: 'br.live', rec: null });
  c.say({ t: 'br.live', rec: LIVE });
  assert.strictEqual(p.journal.live().matchId, 'br_live1', 'last wins, in order');
  c.die(null, 'SIGKILL');
  assert.strictEqual(p.journal.live(), null, 'voided');
  assert.strictEqual(p.pushes.length, 1);
  assert.match(p.pushes[0].msg, /^Battle royale br_live1 was cut off by the slither process stopping with 3 player\(s\) \(Ann, Ben, Cy\)\. No winner, no prize\.$/);
  assert.strictEqual(p.pushes[0].title, 'Battle Royale voided');
  // the next child dies with nothing live: no push
  r.clock.advance(1000);
  r.greet();
  r.kid().die(1, null);
  assert.strictEqual(p.pushes.length, 1);
  assert.deepStrictEqual(p.sends, []);
  // a push from the child (a room replaced mid-match) reaches the hook as sent
  const pushed = [];
  const q = rig({ hooks: { onPush: (m) => pushed.push([m.text, m.title]) } });
  q.greet();
  q.kid().say({ t: 'push', text: 'Battle royale br_x was cut off (the room was replaced) with 2 player(s). No winner, no prize.',
    title: 'Battle Royale voided' });
  assert.strictEqual(pushed.length, 1);
});

test('br.decided twice, the snapshot\'s decided block and the 10 s backstop: ONE prize; the decision clears the live record', async () => {
  const p = prizeRig();
  const r = rig({ start: false });
  r.link.start(Object.assign({}, r.hooks, hooksOver(p, r.link)));
  const br = r.link.brProxy();
  const c = r.kid();
  const boot = r.greet();
  c.say(snapMsg(boot, 1));
  c.say({ t: 'br.live', rec: LIVE });
  const d = { matchId: 'br_live1', winner: { id: 7, name: 'Ann', wallet: 'WA', bot: false }, soloRun: false,
    prizeHeld: false, startedPeople: 2, startedWith: 3, seats: [{ wallet: 'WA', net: '1.1.1.1' }, { wallet: 'WB', net: '2.2.2.2' }] };
  // the slither process sends the decision before it clears its record; then dies before the clear
  c.say({ t: 'br.decided', d });
  assert.strictEqual(p.journal.live(), null, 'decided: the live record is cleared here');
  c.say({ t: 'br.decided', d });
  c.say(snapMsg(boot, 2, { br: Object.assign(snapMsg(boot, 2).br, { decided: d }) }));
  const backstop = () => {
    for (const m of [null, br && br.match]) {
      if (m && m.winner && m.matchId && !p.ctx._brPaid.has(m.matchId)) p.ctx.pay(m).catch(() => {});
    }
  };
  backstop();
  c.die(null, 'SIGKILL');
  backstop();
  await p.settle();
  assert.deepStrictEqual(p.sends, [{ wallet: 'WA', amount: 20 }], 'paid once');
  assert.strictEqual(p.journal.prize('br_live1').state, 'paid');
  assert.ok(!p.pushes.some((x) => /cut off/.test(x.msg)), 'a decided match is not voided by the exit');
  assert.strictEqual(br.match.matchId, 'br_live1', 'the decision is kept after the child died');
  // a lost message: only the snapshot carries the decision; the snapshot path pays it, once
  const p2 = prizeRig();
  const r2 = rig({ start: false });
  r2.link.start(Object.assign({}, r2.hooks, hooksOver(p2, r2.link)));
  const c2 = r2.kid();
  const b2 = r2.greet();
  const d2 = Object.assign({}, d, { matchId: 'br_snaponly' });
  for (let s = 1; s <= 3; s++) c2.say(snapMsg(b2, s, { br: Object.assign(snapMsg(b2, s).br, { decided: d2 }) }));
  await p2.settle();
  assert.deepStrictEqual(p2.sends, [{ wallet: 'WA', amount: 20 }]);
  // a fresh snapshot with no decision clears it (the next match)
  c2.say(snapMsg(b2, 4));
  assert.strictEqual(r2.link.brProxy().match.winner, null);
});

test('a decision whose prizeHeld is not a boolean is held for Owen, never sent', async () => {
  const p = prizeRig();
  const r = rig({ start: false });
  r.link.start(Object.assign({}, r.hooks, hooksOver(p, r.link)));
  const c = r.kid();
  r.greet();
  c.say({ t: 'br.decided', d: { matchId: 'br_odd', winner: { id: 1, name: 'Ann', wallet: 'WA', bot: false }, soloRun: false,
    prizeHeld: 'maybe', startedPeople: 2, startedWith: 2, seats: [{ wallet: 'WA', net: '1.1.1.1' }, { wallet: 'WB', net: '2.2.2.2' }] } });
  await p.settle();
  assert.deepStrictEqual(p.sends, []);
  assert.strictEqual(p.pushes.length, 1);
  assert.match(p.pushes[0].msg, /was not paid/);
  assert.ok(p.ctx._brPaid.has('br_odd'));
});

// A real owner session cookie for host, through the sign-in's own two steps.
function ownerCookie(sessions, host, key, wallet) {
  const headers = { host, origin: 'http://' + host, 'x-ds-owner': '1', 'content-type': 'application/json' };
  const ch = sessions.challenge({ method: 'GET', headers: { host } });
  const chv = ch.cookie.split(';')[0];
  const ts = Date.now();
  const args = { nonce: ch.nonce, host, label: 'Test PC' };
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage(CREATE_ACTION, args, wallet, ts)), key));
  const res = sessions.login({ method: 'POST', headers: Object.assign({ cookie: chv }, headers),
    body: { action: CREATE_ACTION, args, wallet, ts, sig } });
  assert.ok(res.ok, JSON.stringify(res));
  return res.cookie.split(';')[0];
}

test('join: the owner\'s own free join (his session cookie, through the link) is silenced; a player\'s pushes once', () => {
  const key = ed25519.utils.randomPrivateKey();
  const wallet = bs58.encode(ed25519.getPublicKey(key));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sllink-own-'));
  const sessions = createOwnerSessions({ file: path.join(dir, 'owner-sessions.json'), key: 'k'.repeat(48),
    isOwner: (w) => w === wallet, verifyProof: (b) => ownerAuth.walletForAction(b), log: QUIET });
  const host = 'localhost:4409';
  const cookie = ownerCookie(sessions, host, key, wallet);
  const pushes = [];
  const alerts = createJoinAlerts({ push: (m) => pushes.push(m), region: 'na', env: {}, log: QUIET,
    isOwner: (w) => w === wallet, ownerSocket: (s) => sessions.ownerDevice(s.request) });
  // X20's onJoin
  const r = rig({ hooks: { onJoin: (m) => {
    const socket = { request: { method: 'GET', headers: m.h } };
    alerts.joined({ game: m.where === 'br' ? 'br' : 'sl', stake: 0, name: m.name, socket });
  } } });
  r.greet();
  const c = r.kid();
  c.say({ t: 'join', name: 'Owen', where: 'free', h: { host, origin: 'http://' + host, 'sec-fetch-site': 'same-origin', cookie } });
  assert.deepStrictEqual(pushes, [], 'his own join never reaches his phone');
  c.say({ t: 'join', name: 'Player1', where: 'br', h: { host, origin: 'http://' + host } });
  c.say({ t: 'join', name: 'Player1', where: 'br', h: { host, origin: 'http://' + host } });
  assert.strictEqual(pushes.length, 1, 'once: the main server\'s own gate');
  assert.match(pushes[0], /^Player1 joined Battle Royale Free in NA/);
  c.say({ t: 'join', name: 'Owen', where: 'free', h: { host, origin: 'https://evil.example', cookie } });
  assert.strictEqual(pushes.length, 2, 'a cookie from another site is a player');
});

test('stop: shutdown, SIGTERM 300 ms later if it is still there, and no refork', () => {
  const r = rig();
  const c = r.kid();
  r.greet();
  r.link.stop();
  assert.deepStrictEqual(c.of('shutdown').map((m) => m.why), ['the main server is stopping']);
  r.clock.advance(299);
  assert.deepStrictEqual(c.kills, []);
  r.clock.advance(1);
  assert.deepStrictEqual(c.kills, ['SIGTERM']);
  r.clock.advance(120000);
  assert.strictEqual(r.ff.kids.length, 1, 'no refork after stop');
  r.link.stop();
  assert.strictEqual(c.of('shutdown').length, 1, 'once');
});

test('ownsCommand: Start and Stop while the event is on the sl engine; bots on a room the child reported', () => {
  let onSl = true;
  const r = rig({ hooks: { brOnSl: () => onSl } });
  assert.strictEqual(r.link.ownsCommand('bots:add', { room: 'sl_na_s0' }), false, 'no snapshot yet');
  const boot = r.greet();
  r.kid().say(snapMsg(boot, 1));
  assert.strictEqual(r.link.ownsCommand('br:start', {}), true);
  assert.strictEqual(r.link.ownsCommand('br:stop', {}), true);
  for (const a of ['bots:add', 'bots:clear', 'bots:set']) {
    assert.strictEqual(r.link.ownsCommand(a, { room: 'sl_na_s0' }), true, a);
    assert.strictEqual(r.link.ownsCommand(a, { room: 'sl_na_br' }), true, a);
    assert.strictEqual(r.link.ownsCommand(a, { room: 'sl_na_s0_5' }), false, 'a paid room is the main server\'s');
    assert.strictEqual(r.link.ownsCommand(a, { room: 'paidbots:sl:0.5' }), false);
    assert.strictEqual(r.link.ownsCommand(a, {}), false);
  }
  for (const a of ['maintenance:on', 'sl:door:off', 'br:engine:old', 'sl:paid:off', 'announce']) assert.strictEqual(r.link.ownsCommand(a, {}), false, a);
  onSl = false;
  assert.strictEqual(r.link.ownsCommand('br:start', {}), false, 'the old engine\'s event is the main server\'s');
  // the room names stay known while the child restarts (the owner hears "restarting", not "no room")
  r.kid().die(1, null);
  assert.strictEqual(r.link.ownsCommand('bots:add', { room: 'sl_na_s0' }), true);
});

test('debug, emit and smooth; a bad message from the child is dropped and logged, never handed on', () => {
  const seen = [];
  const r = rig({ hooks: { onLive: (x) => seen.push(x), onJoin: (x) => seen.push(x) } });
  const c = r.kid();
  const boot = r.greet();
  c.say(snapMsg(boot, 1));
  assert.deepStrictEqual(r.link.debug(), { mode: 'split', fresh: true, ready: true, ageMs: 0, pid: c.pid, rssMb: 80,
    heapMb: 30, elu: 0.1, loopP99Ms: 2, restarts: 0, gaveUp: false });
  r.link.emit('announce', { text: 'hi', at: 1 });
  r.link.emit('maintenance', { maintenance: true, message: 'x' });
  r.link.send({ t: 'smooth', on: false });
  assert.deepStrictEqual(c.sent.filter((m) => m.t === 'emit' || m.t === 'smooth').map((m) => [m.t, m.ev || m.on]),
    [['emit', 'announce'], ['emit', 'maintenance'], ['smooth', false]]);
  assert.strictEqual(r.link.emit('nope', {}), false, 'not a known event: not sent');
  c.say({ t: 'br.live', rec: 'not a record' });
  c.say({ t: 'join', name: 'x', where: 'paid', h: {} });
  c.say({ t: 'whatever' });
  c.emit('message', null);
  c.emit('message', { v: 9, t: 'snap' });
  assert.deepStrictEqual(seen, []);
  assert.ok(r.logs.some((s) => /\[SPLIT\] dropped a br\.live message \(bad rec\)/.test(s)));
  const k = r.ff.kids.length;
  assert.strictEqual(r.link.fresh(), true, 'nothing thrown, nothing broken');
  assert.strictEqual(r.ff.kids.length, k);
});
