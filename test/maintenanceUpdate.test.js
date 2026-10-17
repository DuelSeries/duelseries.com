'use strict';
/* One-click Maintenance for an update (Owen 2026-10-17): the update flag rides
   in the saved close, a plain close never carries it, opening clears it, and
   the wiring (console action, announce, boot reopen, lobby gate) is in place. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fresh = () => { delete require.cache[require.resolve('../server/ops')]; return require('../server/ops'); };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-maint-')), 'maintenance.json');
const quiet = { warn() {}, error() {} };

test('an update close is saved with update and read back on boot', () => {
  const file = tmp();
  let ops = fresh();
  ops.persist({ file, log: quiet });
  ops.set({ on: true, message: 'Updating, back in a few minutes', update: true });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).update, true);
  ops = fresh();
  const r = ops.persist({ file, log: quiet });
  assert.strictEqual(r.on, true);
  assert.strictEqual(r.update, true);
  assert.strictEqual(ops.get().update, true);
  assert.strictEqual(ops.get().message, 'Updating, back in a few minutes');
  ops.set({ on: false });
  assert.strictEqual(ops.get().update, false);
  assert.strictEqual(fs.existsSync(file), false);
});

test('a plain close and an unreadable file are never update closes', () => {
  const file = tmp();
  let ops = fresh();
  ops.persist({ file, log: quiet });
  ops.set({ on: true, message: 'Back shortly.' });
  ops = fresh();
  assert.strictEqual(ops.persist({ file, log: quiet }).update, false);
  fs.writeFileSync(file, 'not json');
  ops = fresh();
  const r = ops.persist({ file, log: quiet });
  assert.strictEqual(r.on, true);
  assert.strictEqual(r.update, false);
  // update must be exactly true, not truthy
  ops.set({ on: true, update: 'yes' });
  assert.strictEqual(ops.get().update, false);
});

test('the server wires the console action, the boot reopen and the lobby gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const act = src.slice(src.indexOf("case 'maintenance:update':"));
  assert.match(act.slice(0, 900), /ops\.set\(\{ on: true, message: UPDATE_BANNER, update: true \}\)/);
  assert.match(act.slice(0, 900), /io\.emit\('announce', msg\)/);
  assert.match(src, /const UPDATE_ANNOUNCE = 'Update coming, finish up or cash out\.';/);
  assert.match(src, /out\.maintenance = mt\.maintenance \? \{ on: true, message: mt\.message \} : \{ on: false \};/);
  assert.match(src, /server\.listen\(PORT, \(\) => \{[\s\S]{0,120}reopenAfterUpdate\(\);/);
  const play = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'v2', 'play.js'), 'utf8');
  assert.match(play, /if \(window\.V2Maint && window\.V2Maint\.on\(\)\) \{\s*say\(window\.V2Maint\.message\(\)\);\s*return;/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8');
  assert.ok(html.indexOf('/js/v2/maint.js') > html.indexOf('/js/v2/toasts.js'));
  assert.ok(html.indexOf('/js/v2/maint.js') < html.indexOf('/js/v2/board.js'));
});
