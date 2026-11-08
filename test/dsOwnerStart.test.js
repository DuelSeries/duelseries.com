'use strict';
/* The owner's Start now helper (public/js/shared/dsOwnerStart.js, Owen 2026-11-08), run in a stand-in game frame:
   - who sees the button: a device signed into Control (/api/owner/session), or a lobby wallet the server says is the
     owner's (/api/br/owner), asked again when the lobby's wallet changes; anyone else is never told yes;
   - the press: Control's action to /api/owner/do, the owner session cookie first (nothing signed), then the lobby's
     wallet signs it over the duel:signaction bridge with the Privy token alongside, and the server's answer comes
     back as text. The server's own check of every press is test/ownerStartNow.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared', 'dsOwnerStart.js'), 'utf8');
const OWNER = 'Own3r111111111111111111111111111111111111111';
const PLAYER = 'P1ayer11111111111111111111111111111111111111';
const ORIGIN = 'https://duelseries.com';
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

// A game frame inside a lobby. o.session: the Control cookie answer; o.wallet: the lobby's signed-in wallet;
// o.sign: what the lobby's bridge answers ('proof' | 'error' | 'none'); o.token: the lobby's Privy tokens;
// o.do(body, headers): /api/owner/do's answer.
function frame(o) {
  const asked = [];
  const listeners = {};
  const posted = [];
  const lobbyListeners = {};
  const lobby = {
    duelWallet: o.wallet ? { ready: true, authenticated: true, address: o.wallet } : { ready: true, authenticated: false },
    addEventListener(t, fn) { lobbyListeners[t] = fn; },
    removeEventListener(t) { delete lobbyListeners[t]; },
    postMessage(msg, origin) {
      posted.push({ msg, origin });
      if (o.sign === 'none') return;
      const data = o.sign === 'error'
        ? { type: 'duel:signaction:error', id: msg.id, message: 'no' }
        : { type: 'duel:signaction:done', id: msg.id, proof: { action: msg.action, args: msg.args, wallet: o.wallet, ts: 1, sig: 'S1G' } };
      setImmediate(() => { for (const fn of listeners.message || []) fn({ source: lobby, origin: ORIGIN, data }); });
    },
  };
  if (o.token) lobby.duelWalletToken = () => Promise.resolve(o.token);
  const win = {
    location: { origin: ORIGIN },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)), clearTimeout,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fetch(url, opt) {
      opt = opt || {};
      asked.push({ url, opt });
      if (url === '/api/owner/session') return reply(200, { signedIn: !!o.session });
      if (url === '/api/br/owner') return reply(200, { isOwner: JSON.parse(opt.body).wallet === OWNER });
      if (url === '/api/owner/do') return o.do(JSON.parse(opt.body), opt.headers || {}, opt);
      return reply(404, {});
    },
    parent: lobby,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'dsOwnerStart.js' });
  return { win, lobby, asked, posted, lobbyListeners, D: win.DSOwnerStart };
}

test('watch: no owner, no yes; a Control device or the owner wallet, yes', async () => {
  // a player: no Control cookie and a wallet that is not the owner's
  const seen = [];
  const p = frame({ session: false, wallet: PLAYER });
  p.D.watch((v) => seen.push(v));
  await flush();
  assert.deepStrictEqual(seen, [], 'never told anything, so nothing is drawn');
  assert.ok(p.asked.some((a) => a.url === '/api/owner/session'));
  assert.deepStrictEqual(JSON.parse(p.asked.find((a) => a.url === '/api/br/owner').opt.body), { wallet: PLAYER });
  // signed out of the lobby: not even the wallet question
  const q = frame({ session: false });
  const qs = [];
  q.D.watch((v) => qs.push(v));
  await flush();
  assert.deepStrictEqual(qs, []);
  assert.ok(!q.asked.some((a) => a.url === '/api/br/owner'));

  // a device signed into Control
  const c = frame({ session: true });
  const cs = [];
  c.D.watch((v) => cs.push(v));
  await flush();
  assert.deepStrictEqual(cs, [true]);
  assert.strictEqual(c.asked[0].opt.credentials, 'same-origin');

  // the owner's wallet in the lobby, and gone again when it signs out or another wallet signs in
  const w = frame({ session: false, wallet: OWNER });
  const ws = [];
  w.D.watch((v) => ws.push(v));
  await flush();
  assert.deepStrictEqual(ws, [true]);
  w.lobby.duelWallet = { ready: true, authenticated: true, address: PLAYER };
  w.lobbyListeners['duelwallet:change']();
  await flush();
  assert.deepStrictEqual(ws, [true, false], 'another wallet: no button');
  w.lobby.duelWallet = { ready: true, authenticated: true, address: OWNER };
  w.lobbyListeners['duelwallet:change']();
  await flush();
  assert.deepStrictEqual(ws, [true, false, true]);
});

test('start: the Control cookie first, with nothing to sign', async () => {
  const bodies = [];
  const p = frame({ session: true, wallet: OWNER, sign: 'proof',
    do: (b, h, opt) => { bodies.push({ b, h, opt }); return reply(200, { ok: true, note: 'Started with 1 player(s) and 7 bot(s)' }); } });
  p.D.watch(() => {});
  await flush();
  const r = await p.D.start('br:start', {});
  assert.deepStrictEqual({ ok: r.ok, text: r.text }, { ok: true, text: 'Started with 1 player(s) and 7 bot(s)' });
  assert.strictEqual(bodies.length, 1);
  assert.deepStrictEqual(bodies[0].b, { action: 'br:start', args: {} }, 'no signature in the body');
  assert.strictEqual(bodies[0].opt.credentials, 'same-origin');
  assert.strictEqual(bodies[0].h['X-DS-Owner'], '1');
  assert.strictEqual(p.posted.length, 0, 'the wallet is never asked');
});

test('start: no cookie (or a lapsed one), the lobby wallet signs it, the Privy token alongside', async () => {
  for (const lapsed of [false, true]) {
    const bodies = [];
    const p = frame({ session: lapsed, wallet: OWNER, sign: 'proof', token: { access: 'ACC', identity: 'IDT' },
      do: (b, h) => {
        bodies.push({ b, h });
        if (!b.sig) return reply(403, { error: 'Not an owner' });   // the cookie alone is no longer enough
        return reply(200, { ok: true, note: 'Swim Race starting in 15 seconds' });
      } });
    p.D.watch(() => {});
    await flush();
    const r = await p.D.start('se:start', {});
    assert.strictEqual(r.text, 'Swim Race starting in 15 seconds', lapsed ? 'a lapsed cookie' : 'no cookie');
    assert.strictEqual(bodies.length, lapsed ? 2 : 1);
    const last = bodies[bodies.length - 1];
    assert.deepStrictEqual({ action: last.b.action, wallet: last.b.wallet, sig: last.b.sig }, { action: 'se:start', wallet: OWNER, sig: 'S1G' });
    assert.strictEqual(last.h.Authorization, 'Bearer ACC');
    assert.strictEqual(last.h['privy-id-token'], 'IDT');
    assert.deepStrictEqual(p.posted.map((x) => [x.msg.type, x.msg.action, x.origin]), [['duel:signaction', 'se:start', ORIGIN]]);
  }
});

test('start: the wallet will not sign, so the Privy token alone; neither, and nothing is sent', async () => {
  const bodies = [];
  const p = frame({ session: false, wallet: OWNER, sign: 'error', token: { access: 'ACC' },
    do: (b, h) => { bodies.push({ b, h }); return reply(200, { ok: true, note: 'Started' }); } });
  const r = await p.D.start('br:start', {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(bodies[0].b, { action: 'br:start', args: {} });
  assert.strictEqual(bodies[0].h.Authorization, 'Bearer ACC');

  const q = frame({ session: false, wallet: OWNER, sign: 'error', do: () => { throw new Error('nothing to send'); } });
  const s = await q.D.start('br:start', {});
  assert.deepStrictEqual({ ok: s.ok, text: s.text }, { ok: false, text: 'The wallet did not sign.' });
  assert.ok(!q.asked.some((a) => a.url === '/api/owner/do'));
});

test('start: the server\'s refusal comes back as its reason', async () => {
  const p = frame({ session: true, do: (b) => (b.action === 'br:start'
    ? reply(409, { error: 'A match is already running. You can start the next one once a single snake is left.' })
    : reply(403, { error: 'Not an owner' })) });
  p.D.watch(() => {});
  await flush();
  const r = await p.D.start('br:start', {});
  assert.deepStrictEqual({ ok: r.ok, status: r.status }, { ok: false, status: 409 });
  assert.match(r.text, /already running/);
  const q = frame({ session: false, wallet: PLAYER, sign: 'proof', do: () => reply(403, { error: 'Not an owner' }) });
  const s = await q.D.start('br:start', {});
  assert.deepStrictEqual({ ok: s.ok, text: s.text }, { ok: false, text: 'Not an owner' });
});
