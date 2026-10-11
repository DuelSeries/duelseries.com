'use strict';
// slNoMoney (SERVER-DESIGN 13 item 11, 18.1; SERVER-BUILD-BRIEF D13; task T11): the free room holds no money. No file
// in server/sl reaches money.js, Usdc.js, Wallet.js, paperPayout.js, stakeLedger.js, entryStore.js or db.js through
// ANY chain of requires (walked transitively from every server/sl file), and the free door never reads a token: a
// money field in sl:join is refused by its presence alone, and the handshake gives only a skin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { rig } = require('./slSockFakes');

const ROOT = path.join(__dirname, '..');
const SL_DIR = path.join(ROOT, 'server', 'sl');
const MONEY = ['money.js', 'Usdc.js', 'Wallet.js', 'paperPayout.js', 'stakeLedger.js', 'entryStore.js', 'db.js'];

function requiresOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[2]);
  return out;
}

function resolveLocal(from, spec) {
  if (!spec.startsWith('.')) return null; // a package (socket.io, perf_hooks, ...)
  const base = path.resolve(path.dirname(from), spec);
  for (const f of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  throw new Error(path.relative(ROOT, from) + ' requires ' + spec + ', which does not resolve');
}

test('no server/sl file reaches a money or database module, directly or through any require chain', () => {
  const files = fs.readdirSync(SL_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(SL_DIR, f));
  assert.ok(files.length >= 20, 'every server/sl file is walked (' + files.length + ')');
  const seen = new Map(); // file -> the chain that reached it
  const queue = files.map((f) => [f, [path.relative(ROOT, f)]]);
  while (queue.length) {
    const [f, chain] = queue.shift();
    if (seen.has(f)) continue;
    seen.set(f, chain);
    const name = path.basename(f);
    assert.ok(!MONEY.includes(name), 'money module reached: ' + chain.join(' -> '));
    for (const spec of requiresOf(f)) {
      assert.ok(!MONEY.includes(path.basename(spec)) && !MONEY.includes(path.basename(spec) + '.js'),
        path.relative(ROOT, f) + ' requires ' + spec);
      const next = resolveLocal(f, spec);
      if (next && !seen.has(next)) queue.push([next, chain.concat(path.relative(ROOT, next))]);
    }
  }
  assert.ok(seen.has(path.join(ROOT, 'server', 'botPopulation.js')), 'the walk follows chains out of server/sl');
  // and nothing in server/sl names the money words of the old engine's door
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const word of ['consumePaidEntry', 'consumeAtStake', 'recordHouseRevenue', 'payCashout', 'ESCROW_PRIVATE_KEY']) {
      if (path.basename(f) === 'slBoot.js' && word === 'ESCROW_PRIVATE_KEY') continue; // the dev-law refusal reads it
      assert.ok(!src.includes(word), path.basename(f) + ' mentions ' + word);
    }
  }
});

test('the free door never reads a token: refused by presence; the handshake is read for cv only', () => {
  const r = rig();
  const touched = [];
  const auth = { cv: 5 };
  for (const k of ['entryToken', 'token', 'wallet', 'stake', 'resumeKey', 'paid']) {
    Object.defineProperty(auth, k, { enumerable: true, get() { touched.push('auth.' + k); return 'x'; } });
  }
  const s = r.sock({ auth });
  const msg = { nick: 'n' };
  for (const k of ['entryToken', 'stake', 'resumeKey']) {
    Object.defineProperty(msg, k, { enumerable: true, get() { touched.push('join.' + k); return 'x'; } });
  }
  s.fire('sl:join', msg);
  assert.deepStrictEqual(touched, []);
  assert.strictEqual(s.disconnected, true);
  const s2 = r.sock({ auth });
  s2.fire('sl:join', { nick: 'ok' });
  assert.deepStrictEqual(touched, []);
  assert.strictEqual(r.room().seatOf(s2.id).cv, 5);
  for (const v of r.room().snakes.values()) assert.strictEqual(v.worth, 0);
});
