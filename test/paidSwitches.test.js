'use strict';
// The owner's paid switches outlive a restart (security review item b, 2026-10-15). sl:paid:off already did (review
// OPS-1); agar:paid:off lived in memory only, so the next deploy silently reopened paid agar, and paid Paper had no
// runtime switch at all. Both now use slPaidBoot.createPaidSwitchStore, each with its own file beside the money
// journal: openAg reads agar's at boot (a saved close opens the paid door shut), the server reads Paper's into
// paperArenas.paidOpen, and paperSockets refunds a NEW paid join 'not-open' while it is shut (test/paperShutdown.test.js
// drives that door; test/securityGamesServer.test.js proves the whole restart on the real server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openAg } = require('../server/ag/agBoot');
const { REQUIRED_HOOKS } = require('../server/ag/agMoney');
const { createPaidSwitchStore } = require('../server/slPaid/slPaidBoot');

function logger() {
  const out = [];
  return { out, error: (m) => out.push(String(m)), warn: (m) => out.push(String(m)), log: (m) => out.push(String(m)) };
}

function fakeIo() {
  const spaces = {};
  return { of(name) { spaces[name] = spaces[name] || { on() {}, use() {} }; return spaces[name]; } };
}

const helpers = { socketRL: () => true, sanitizeName: (n) => String(n).slice(0, 20) || 'Player', ops: { get: () => ({}) } };

function money() {
  const hooks = {};
  for (const k of REQUIRED_HOOKS) hooks[k] = () => {};
  return { hooks, door: { consumeAtStake: () => ({ ok: false, worth: 0 }), ledger: null, refund: () => {} } };
}

function store(tag, what) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paidsw-'));
  const lg = logger();
  return { lg, st: createPaidSwitchStore({ file: path.join(dir, 'data', 'x-paid-switch.json'), log: lg, tag, what }) };
}

function boot(env, paidSwitch) {
  const lg = logger();
  const r = openAg({ env: Object.assign({ AG_ENABLED: '1' }, env), io: fakeIo(), helpers, log: lg, autoTick: false,
    money: money(), paidSwitch });
  return { r, lg };
}

test('a saved agar:paid:off opens the paid agar door shut at the next boot; agar:paid:on clears it', () => {
  const { st } = store('[AG]', 'paid agar.io');
  // no file: the code default (open)
  const a = boot({ AG_PAID: '1' }, st);
  assert.equal(a.r.paid, true);
  assert.equal(a.r.arenas.paidOpen, true);
  // the owner closes it (index.js agar:paid:off saves), the server restarts
  assert.deepEqual(st.save(false), { ok: true, why: null });
  const b = boot({ AG_PAID: '1' }, st);
  assert.deepEqual([b.r.paid, b.r.arenas.paidEnabled, b.r.arenas.paidOpen], [true, true, false]);
  const rows = b.r.arenas.boardRows().filter((x) => x.stake > 0);
  assert.ok(rows.length && rows.every((x) => x.state === 'closed'), 'the paid rows say closed: the lobby asks for no money');
  assert.ok(b.lg.out.some((l) => /\[AG\] paid door CLOSED at boot \(owner\): the owner's agar:paid:off outlived the restart/.test(l)));
  // agar:paid:on removes the file: the next boot is open again
  assert.deepEqual(st.save(true), { ok: true, why: null });
  assert.equal(boot({ AG_PAID: '1' }, st).r.arenas.paidOpen, true);
});

test('the agar switch fails closed: an unreadable file or a store that throws opens the paid door shut', () => {
  const { st, lg } = store('[AG]', 'paid agar.io');
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  fs.writeFileSync(st.file, 'garbage');
  assert.equal(boot({ AG_PAID: '1' }, st).r.arenas.paidOpen, false);
  assert.ok(lg.out.some((l) => l.startsWith('[AG] CRITICAL paid switch file is not a switch, paid agar.io starts CLOSED')),
    'the store speaks for its own game');
  const throwing = { closedAtBoot() { throw new Error('boom'); } };
  const t = boot({ AG_PAID: '1' }, throwing);
  assert.equal(t.r.arenas.paidOpen, false);
  assert.ok(t.lg.out.some((l) => /\[AG\] CRITICAL paid switch read threw, the paid door starts CLOSED: boom/.test(l)));
  // AG_PAID off: no paid rungs, the store is never asked
  let asked = 0;
  const off = boot({ AG_PAID: '0' }, { closedAtBoot() { asked++; return { closed: true, why: 'owner' }; } });
  assert.equal(off.r.paid, false);
  assert.equal(asked, 0);
  // no store at all (a caller that predates it): as before
  assert.equal(boot({ AG_PAID: '1' }, undefined).r.arenas.paidOpen, true);
});

test('each game\'s switch store names its own game; paid snake\'s words are unchanged', () => {
  const p = store('[PAPER]', 'paid Paper');
  const ro = createPaidSwitchStore({ file: p.st.file, log: p.lg, tag: '[PAPER]', what: 'paid Paper',
    fsx: Object.assign({}, fs, { existsSync: () => true, readFileSync() { throw new Error('EIO'); } }) });
  assert.deepEqual(ro.closedAtBoot(), { closed: true, why: 'unreadable' });
  assert.ok(p.lg.out.some((l) => l === '[PAPER] CRITICAL paid switch file unreadable, paid Paper starts CLOSED: EIO'));
  const s = store(undefined, undefined);
  const ro2 = createPaidSwitchStore({ file: s.st.file, log: s.lg,
    fsx: Object.assign({}, fs, { existsSync: () => true, readFileSync() { throw new Error('EIO'); } }) });
  ro2.closedAtBoot();
  assert.ok(s.lg.out.some((l) => l === '[SLP] CRITICAL paid switch file unreadable, paid snake on the new engine starts CLOSED: EIO'));
});

test('server/index.js: agar:paid and paper:paid save their switch files, and both are read at boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /'ag-paid-switch\.json'/);
  assert.match(src, /'paper-paid-switch\.json'/);
  const caseOf = (name) => src.slice(src.indexOf("case '" + name + "'"), src.indexOf('\n    }', src.indexOf("case '" + name + "'")));
  assert.match(caseOf('agar:paid:off'), /agArenas\.paidOpen = false;\n\s+const kept = agPaidSwitch\.save\(false\);/);
  assert.match(caseOf('agar:paid:on'), /agArenas\.paidOpen = true;\n\s+const kept = agPaidSwitch\.save\(true\);/);
  assert.match(caseOf('paper:paid:off'), /paperArenas\.paidOpen = false;\n\s+const kept = paperPaidSwitch\.save\(false\);/);
  assert.match(caseOf('paper:paid:on'), /if \(paperArenas\.stopping\) return refuse\('The server is restarting'\);\n\s+paperArenas\.paidOpen = true;\n\s+const kept = paperPaidSwitch\.save\(true\);/);
  assert.match(src, /paidSwitch: agPaidSwitch,/);
  assert.match(src, /c = paperPaidSwitch\.closedAtBoot\(\);/);
  // the owner page lists both commands
  const owner = fs.readFileSync(path.join(__dirname, '..', 'public', 'owner.html'), 'utf8');
  assert.ok(owner.includes("act('paper:paid:off',{})") && owner.includes("act('paper:paid:on',{})"));
});
