'use strict';
// Opening the agar.io rooms at boot (server/ag/agBoot.js): the AG_ENABLED switch, the law gate that keeps
// production closed until Owen approves every row, and the dev-only AG_DEV_LAWS table refused in production.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const L = require('../server/ag/agLaws');
const { agSwitch, loadAgLaws, openAg } = require('../server/ag/agBoot');

const FIXTURE_FILE = path.join(__dirname, 'agLawsFixture.js');

function logger() {
  const lines = { error: [], warn: [], log: [] };
  return { lines, error: (m) => lines.error.push(String(m)), warn: (m) => lines.warn.push(String(m)),
    log: (m) => lines.log.push(String(m)) };
}

function fakeIo() {
  const spaces = {};
  return {
    spaces,
    of(name) {
      spaces[name] = spaces[name] || { listeners: {}, on(ev, fn) { this.listeners[ev] = fn; } };
      return spaces[name];
    },
  };
}

const helpers = { socketRL: () => true, sanitizeName: (n) => String(n).slice(0, 20) || 'Player', ops: { get: () => ({}) } };

test('AG_ENABLED is on only for an explicit yes', () => {
  const log = logger();
  for (const v of ['1', 'true', 'ON', ' yes ']) assert.strictEqual(agSwitch(v, log), true, v);
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no']) assert.strictEqual(agSwitch(v, log), false, String(v));
  assert.strictEqual(log.lines.error.length, 0);
  assert.strictEqual(agSwitch('maybe', log), false);
  assert.match(log.lines.error[0], /not a switch value/);
});

test('off by default: nothing opens and no namespace is made', () => {
  const io = fakeIo();
  const r = openAg({ env: {}, io, helpers, log: logger(), autoTick: false });
  assert.deepStrictEqual(r, { arenas: null, why: 'off' });
  assert.deepStrictEqual(Object.keys(io.spaces), []);
});

test('on with the real table: the rooms stay closed until every row is approved', () => {
  let shippable = true;
  try { L.assertShippable(L.LAWS); } catch (e) { shippable = false; }
  const io = fakeIo();
  const log = logger();
  const r = openAg({ env: { AG_ENABLED: '1', NODE_ENV: 'production' }, io, helpers, log, autoTick: false });
  if (shippable) {
    assert.ok(r.arenas);
    r.arenas.stop();
    return;
  }
  assert.strictEqual(r.arenas, null);
  assert.match(r.why, /not shippable/);
  assert.match(log.lines.error.join('\n'), /stays closed/);
  assert.deepStrictEqual(Object.keys(io.spaces), [], 'no namespace listens while closed');
});

test('AG_DEV_LAWS opens on the dev table outside production and is refused in production', () => {
  assert.throws(() => loadAgLaws({ AG_DEV_LAWS: FIXTURE_FILE, NODE_ENV: 'production' }, logger()), /PRODUCTION/);
  const prod = openAg({ env: { AG_ENABLED: '1', AG_DEV_LAWS: FIXTURE_FILE, NODE_ENV: 'production' }, io: fakeIo(),
    helpers, log: logger(), autoTick: false });
  assert.strictEqual(prod.arenas, null);
  assert.match(prod.why, /PRODUCTION/);

  const io = fakeIo();
  const log = logger();
  const dev = openAg({ env: { AG_ENABLED: 'yes', AG_DEV_LAWS: FIXTURE_FILE, NODE_ENV: 'development' }, io, helpers, log,
    autoTick: false });
  assert.ok(dev.arenas, dev.why);
  assert.strictEqual(dev.arenas.all().length, 1);
  assert.strictEqual(L.statusCounts(dev.arenas.laws).FIXTURE, Object.keys(dev.arenas.laws).length);
  assert.ok(typeof io.spaces['/ag'].listeners.connection === 'function', 'sockets attach on the /ag namespace');
  assert.match(log.lines.warn.join('\n'), /Not for production/);
  dev.arenas.stop();

  const bad = openAg({ env: { AG_ENABLED: '1', AG_DEV_LAWS: path.join(__dirname, 'no-such-file.js') }, io: fakeIo(),
    helpers, log: logger(), autoTick: false });
  assert.strictEqual(bad.arenas, null);
});

// Review 2026-10-02, finding 3: NODE_ENV alone does not mark the live box (pm2 on EC2 may not set it), so the dev
// table is also refused wherever an escrow key or a database is configured, like PAPER_DEV_TOKENS.
test('AG_DEV_LAWS is refused with an escrow key or a DATABASE_URL, whatever NODE_ENV says', () => {
  for (const extra of [{ ESCROW_PRIVATE_KEY: 'k3y' }, { DATABASE_URL: 'postgres://u@h/db' }]) {
    const which = Object.keys(extra)[0];
    assert.throws(() => loadAgLaws(Object.assign({ AG_DEV_LAWS: FIXTURE_FILE }, extra), logger()), new RegExp(which));
    const io = fakeIo();
    const log = logger();
    const r = openAg({ env: Object.assign({ AG_ENABLED: '1', AG_DEV_LAWS: FIXTURE_FILE }, extra), io, helpers, log,
      autoTick: false });
    assert.strictEqual(r.arenas, null, which + ' keeps the game closed');
    assert.match(r.why, new RegExp(which));
    assert.doesNotMatch(log.lines.log.join(' '), /DEV law table/);
    assert.deepStrictEqual(Object.keys(io.spaces), [], 'no namespace listens');
  }
  // Blank values are not a configured server (dev-local sets both empty).
  const io = fakeIo();
  const r = openAg({ env: { AG_ENABLED: '1', AG_DEV_LAWS: FIXTURE_FILE, ESCROW_PRIVATE_KEY: '', DATABASE_URL: '  ' }, io,
    helpers, log: logger(), autoTick: false });
  assert.ok(r.arenas, r.why);
  r.arenas.stop();
});
