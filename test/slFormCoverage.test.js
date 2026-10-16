'use strict';
// slFormCoverage (SERVER-DESIGN 18.2 item 7, 17 "a form or order the frozen client was never proven on"; DO 8;
// SERVER-BUILD-BRIEF P1; task T10).
//
// Every (event type, flag set, form) our server emits must appear in test/slGoldenStreams.json.gz, the streams the
// frozen client was proven on (the gate's seeded goldens; their reference twins were IDENTICAL to their client).
// The bundles come from the mirror rig (test/slMirrorRig.js): our room with the FIXTURE table and prey on, a seat
// with a plain stall and a resync stall (a leave, a death and a cash-out inside it), and 24 scripted seats steering,
// boosting, turning with the arrow form and dying, 3 seeds x 3000 ticks; every bundle of every seat is decoded.
// The form key (slMirrorRig.formKey) names exactly what the frozen client branches on for one record.
//
// A form outside the golden streams passes only through EXEMPT below, and only with its proof named there; each
// exempt form must still be emitted (a stale entry fails), and its proof runs in slMirror on every life.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const W = require('../shared/slWire.js');
const { runRig, formKey, goldenForms } = require('./slMirrorRig.js');

const EXEMPT = {
  // OUR init is THEIR L6 init: pv 19, realSid, the current border radius (fluxGrd), gameMode 1 and extraB 0 (all six
  // optional fields, a prefix). The gate's synthetic streams carry pv 15 inits with two or three of them. Proof:
  // the client applies each optional field by its own presence test (public/js/sl/slApply.js:533-545); pv 19 takes
  // every pv 15 branch (the pv test below: no pinned file compares the version with anything above 15); slMirror
  // checks on every life that the client's pv, flux_grd, real_flux_grd, real_sid, team_mode and default_msl after
  // this init are the server's.
  'init pv+defaultMsl+realSid+fluxGrd+gameMode+extraB': 'slMirror init check, slApply.js:533-545',
};

// A rotation record's flag set outside the goldens is covered by its parts when the goldens hold the SAME field set
// for the other variant and EVERY one of its fields for this variant: the client applies dir, ang, wang and sp each
// by its own test (public/js/sl/slApply.js:556-574) and the variant only picks the snake (554) and skips one eang line
// for the own snake (569). Returns null when covered, else why not.
function rotByParts(k, gold) {
  const m = /^snake_rot (own|other) (\S+)$/.exec(k);
  if (!m) return 'not a rotation';
  const other = m[1] === 'own' ? 'other' : 'own';
  if (!gold.has('snake_rot ' + other + ' ' + m[2])) return 'no ' + other + ' ' + m[2] + ' in the goldens';
  for (const f of m[2].split('+')) {
    let seen = false;
    for (const g of gold.keys()) {
      const n = /^snake_rot (own|other) (\S+)$/.exec(g);
      if (n && n[1] === m[1] && n[2].split('+').indexOf(f) >= 0) seen = true;
    }
    if (!seen) return 'no ' + m[1] + ' record with ' + f;
  }
  return null;
}

test('the golden form set decodes cleanly and holds the forms the client was proven on', () => {
  const g = goldenForms();
  assert.ok(!g.has('wire_error'), 'a golden bundle failed to decode');
  for (const k of ['snake_move G own iang', 'snake_move g other', 'snake_move = own iang+xx', 'snake_rot own dir+wang',
    'snake_add first deltas iang', 'snake_remove kill1', 'food_eat < sLast', 'pong', 'init pv+defaultMsl']) {
    assert.ok(g.has(k), 'golden streams have no ' + k);
  }
});

test('the rotation parts rule: covered only with the other variant set and each field of this variant', () => {
  const gold = goldenForms();
  assert.strictEqual(rotByParts('snake_rot own dir+ang+wang+sp', gold), null);
  assert.match(String(rotByParts('snake_rot own dir+sp', gold)), /no other dir\+sp/);
  const g2 = new Map([['snake_rot other dir+ang+wang+sp', 1], ['snake_rot own dir+wang', 1]]);
  assert.match(String(rotByParts('snake_rot own dir+ang+wang+sp', g2)), /no own record with ang/);
});

test('pv 19 takes every pv 15 branch: no pinned client file compares the version with anything above 15', () => {
  const root = path.join(__dirname, '..');
  const files = ['shared/slCore.js'].concat(fs.readdirSync(path.join(root, 'public/js/sl')).map((f) => 'public/js/sl/' + f));
  const found = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/(\bpv|protocol_version)\s*(>=|<=|===|!==|==|!=|>|<)\s*(\d+)/g)) found.push([f, m[0], +m[3]]);
  }
  assert.ok(found.length >= 8, 'the scan found the version tests (' + found.length + ')');
  for (const [f, what, n] of found) assert.ok(n <= 15, f + ': ' + what + ' splits the versions above 15');
  // and the init itself is the only place the client reads the version from the server (slApply.js:533)
  const apply = fs.readFileSync(path.join(root, 'public/js/sl/slApply.js'), 'utf8');
  assert.strictEqual((apply.match(/S\.protocol_version = /g) || []).length, 2, 'the load default and the init');
});

test('every form our server emits (3 seeds x 3000 ticks, every seat) appears in the golden streams', () => {
  const gold = goldenForms();
  const ours = new Map();
  const take = (bytes) => {
    for (const e of W.decodeBundle(bytes)) {
      assert.notStrictEqual(e.type, 'wire_error', 'our bundle failed to decode');
      const k = formKey(e);
      ours.set(k, (ours.get(k) || 0) + 1);
    }
  };
  let resyncs = 0;
  // seeds 1, 9, 10: prey is eaten in 2 of 10 seeds' 3000 ticks with the piece path (2026-10-16), 5 of 10 before;
  // the soak counts the same prey eats either way (seeds 7 to 9, 12,000 ticks: 44 before, 41 after)
  for (const seed of [1, 9, 10]) {
    const r = runRig({
      seed, ticks: 3000, client: false, others: 24, cap: 8192,
      stalls: [{ at: 30000, ms: 2000 }, { at: 70000, ms: 9000, resync: true }],
      onBundle(b) { take(b.bytes); },
      onOther(bytes) { take(bytes); },
    });
    assert.deepStrictEqual(r.errors, [], 'room errors, seed ' + seed);
    if (r.resyncAt !== null) resyncs++;
  }
  assert.strictEqual(resyncs, 3, 'every seed resynced its stalled seat');
  const uncovered = [];
  const byParts = [];
  for (const k of ours.keys()) {
    if (gold.has(k) || EXEMPT[k]) continue;
    if (k.startsWith('snake_rot ') && rotByParts(k, gold) === null) { byParts.push(k); continue; }
    uncovered.push(k + ' (' + ours.get(k) + ')');
  }
  assert.deepStrictEqual(uncovered, [], 'forms the frozen client was never proven on');
  for (const k of Object.keys(EXEMPT)) assert.ok(ours.has(k), 'stale exemption, never emitted: ' + k);
  // the run reached the forms that matter (a wide stream, not a quiet one)
  assert.ok(ours.size >= 35, 'only ' + ours.size + ' forms emitted');
  // the own echo is dir+ang+wang (their form 3 or 5; task T14: their own records never carry dir+wang without ang)
  for (const k of ['snake_move = own iang+xx', 'snake_move N own iang', 'snake_move n other', 'snake_rot own dir+ang+wang',
    'snake_rot other dir+ang+wang+sp', 'snake_tail fam', 'snake_remove kill0', 'snake_remove kill1', 'dead 0',
    'kill_count', 'prey_add', 'prey_eaten', 'prey_remove', 'food_eat <', 'sector_remove', 'minimap M', 'leaderboard rows',
    'flux', 'pong']) {
    assert.ok(ours.has(k), 'the run never emitted ' + k);
  }
});
