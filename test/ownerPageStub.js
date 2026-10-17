'use strict';
// A stand-in server for looking at the owner console (public/owner.html) in a real browser without the game server:
// it serves public/ as it is, and fakes every /api/owner/* route of the owner session contract (session, challenge,
// login, sessions, revoke, logout, ticket, state v2, do) with a made-up state that the actions really change. The
// socket.io client and the wallet widget are replaced by small fakes, so nothing reaches Privy or a socket server:
// the fake widget signs in on its first login call and "signs" with a dummy signature, and the fake socket fires
// 'connect' and lets a test push an alert with window.__fire(event, payload).
//
// Every POST that arrives without the X-DS-Owner header is refused 403 and recorded in log.missingHeader, which is how
// a browser check proves the page sends it on every write. log.requests keeps method, path, header and body of all.
//
// Nothing runs when this file is executed on its own (npm test runs every .js under test/): start it by hand with
//   node test/ownerPageStub.js --serve [port] [--signed-in] [--alerts=ticket]
// or require it and call createOwnerPageStub().
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

// The fake socket.io client: one socket per io() call, connected a moment later.
const FAKE_IO = `(function () {
  window.io = function () {
    var handlers = {};
    var sock = {
      connected: false,
      on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      emit: function (ev, p) { (window.__emits = window.__emits || []).push([ev, p]); return sock; },
      disconnect: function () { sock.connected = false; (handlers.disconnect || []).forEach(function (f) { f(); }); return sock; }
    };
    window.__fire = function (ev, p) { (handlers[ev] || []).forEach(function (f) { f(p); }); };
    setTimeout(function () { sock.connected = true; (handlers.connect || []).forEach(function (f) { f(); }); }, 30);
    return sock;
  };
})();`;

// The fake wallet widget. It throws if the page did not run the node-global shim first or has no #wallet-root,
// the two things the real widget needs before it can mount.
const FAKE_WIDGET = `(function () {
  if (!window.global || !window.process || !window.process.env) throw new Error('fake widget: node-global shim missing');
  if (!document.getElementById('wallet-root')) throw new Error('fake widget: #wallet-root missing');
  window.__widgetLoaded = (window.__widgetLoaded || 0) + 1;
  function emit() { window.dispatchEvent(new CustomEvent('duelwallet:change', { detail: window.duelWallet })); }
  window.duelWallet = { ready: false, authenticated: false, address: null };
  setTimeout(function () { window.duelWallet = Object.assign({}, window.duelWallet, { ready: true }); emit(); }, 40);
  window.duelWalletLogin = function () {
    setTimeout(function () {
      window.duelWallet = Object.assign({}, window.duelWallet, { authenticated: true, address: 'OwnerWa11etFake1111111111111111111111111111' });
      emit();
    }, 60);
  };
  window.duelWalletSignAction = function (action, args) {
    return Promise.resolve({ action: action, args: args || {}, wallet: window.duelWallet.address, ts: Date.now(), sig: 'fake-signature' });
  };
})();`;

// A ticket-mode owner alerts module for checking the page's ticket path before the real one supports it.
const FAKE_ALERTS = `(function () {
  window.OwnerAlerts = { connectOwnerAlerts: function (o) {
    var socket = o.io();
    socket.on('connect', function () {
      Promise.resolve(o.ticket ? o.ticket() : null).then(function (t) {
        if (!t) return o.onState('unsigned');
        socket.emit('lobby:join', { ownerTicket: t });
        o.onState('listening');
      });
    });
    socket.on('disconnect', function () { o.onState('offline'); });
    socket.on('admin:solvency_alert', function (p) {
      o.onAlert({ kind: 'solvency', title: 'Escrow short', text: 'Escrow ' + p.escrowSol + ' is below the live stakes.', at: Date.now() });
    });
    return socket;
  } };
})();`;

function todayAt(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function baseState() {
  const held = 'Paid duels stay people only: a bot would win or lose a real stake';
  const now = Date.now();
  return {
    v: 2, region: 'na', uptimeSec: 3 * 3600 + 12 * 60, now,
    open: true, maintenance: { on: false, message: '', since: null, saved: false },
    drain: { safe: false, reason: '1 person has $1.85 on the table', people: 4, paidPeople: 1, moneyInPlay: 2.35, floor: 0, pending: 0, duels: 0 },
    escrow: { usdc: 512.4, owed: 2.35, surplus: 510.05, ok: true, at: now - 40000 },
    bots: 0,
    games: [
      { id: 'slither', name: 'Slither', duel: false, paid: { enabled: true, open: true, stopping: false, saved: false, action: 'sl:paid' },
        rungs: [
          { rung: 0, room: 'sl_na_s0', people: 2, bots: 12, money: 0, botTarget: null, botsAllowed: true, botsNote: null },
          { rung: 0.5, room: 'sl_na_s0.5', people: 1, bots: 0, money: 1.85, botTarget: null, botsAllowed: false, botsNote: held },
          { rung: 1, room: 'sl_na_s1', people: 0, bots: 0, money: 0.5, botTarget: null, botsAllowed: false, botsNote: held },
        ] },
      { id: 'agar', name: 'agar.io', duel: false, paid: { enabled: true, open: false, stopping: false, saved: true, action: 'agar:paid' },
        rungs: [
          { rung: 0, room: 'ag_na_free', people: 0, bots: 8, money: 0, botTarget: 8, botsAllowed: true, botsNote: null },
          { rung: 0.5, room: 'ag_na_s0.5', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: held },
          { rung: 1, room: 'ag_na_s1', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: held },
        ] },
      { id: 'paper', name: 'Paper.io', duel: false, paid: { enabled: true, open: true, stopping: false, saved: false, action: 'paper:paid' },
        rungs: [
          { rung: 0, room: 'paper_na_free', people: 1, bots: 6, money: 0, botTarget: null, botsAllowed: true, botsNote: null },
          { rung: 0.5, room: 'paper_na_s0.5', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: held },
          { rung: 1, room: null, people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: held },
        ] },
      { id: 'knockout', name: 'Knockout', duel: true, paid: { enabled: true, open: true, stopping: false, saved: false, action: 'ko:paid' },
        rungs: [
          { rung: 0, room: 'ko_na_free', people: 1, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: 'A bot joins after 15 s' },
          { rung: 0.5, room: 'ko_na_s0.5', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: 'People only' },
          { rung: 1, room: 'ko_na_s1', people: 2, bots: 0, money: 2, botTarget: null, botsAllowed: false, botsNote: 'People only' },
        ] },
      { id: 'battleship', name: 'Battleship', duel: true, paid: { enabled: false, open: false, stopping: false, saved: false, action: 'bs:paid' },
        rungs: [
          { rung: 0, room: 'bs_na_free', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: 'A bot joins after 15 s' },
          { rung: 0.5, room: 'bs_na_s0.5', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: 'People only' },
          { rung: 1, room: 'bs_na_s1', people: 0, bots: 0, money: 0, botTarget: null, botsAllowed: false, botsNote: 'People only' },
        ] },
    ],
    battleRoyale: { state: 'waiting', phase: 'waiting', humans: 3, bots: 5, alive: 8, minPlayers: 1, canStart: true, canForce: true,
      countdownMs: 0, nextStartAt: todayAt(20, 5), prize: 20, prizeHeld: false, engine: 'sl', room: 'sl_na_br', botTarget: null, winner: null },
    earnings: { shown: true, configShow: true },
    smooth: { on: true },
    audit: [
      { at: now - 120000, action: 'bots:set', note: 'Slither $0.50 bots 0 to 4', ok: true, who: 'Chrome on Windows' },
      { at: now - 240000, action: 'agar:paid:off', note: 'Paid agar.io closed', ok: true, who: 'Chrome on Windows' },
      // A note that is markup: the page must show it as text.
      { at: now - 300000, action: 'bots:set', note: '<img src=x onerror="window.__xss=1">Unknown room', ok: false, who: 'Chrome on Windows' },
      { at: now - 360000, action: 'owner:session:create', note: 'Signed in on this PC', ok: true, who: 'Chrome on Windows' },
    ],
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createOwnerPageStub(opts = {}) {
  const log = { requests: [], missingHeader: [], actions: [] };
  let state = baseState();
  const sessions = new Map();          // sid -> { id, device, createdAt, lastSeen, exp }
  const challenges = new Set();
  const YEAR = 365 * 24 * 3600 * 1000;
  const newSession = (device) => {
    const sid = crypto.randomBytes(12).toString('hex');
    const now = Date.now();
    sessions.set(sid, { id: sid.slice(-6), device: String(device || 'Unknown').slice(0, 40), createdAt: now, lastSeen: now, exp: now + YEAR });
    return sid;
  };
  // Another device, so the Devices panel has more than one row.
  newSession('Safari on iPhone');
  let presetSid = opts.signedIn ? newSession('Chrome on Windows') : null;

  const totalBots = () => {
    let n = state.battleRoyale ? state.battleRoyale.bots : 0;
    for (const g of state.games) for (const r of g.rungs) n += r.bots || 0;
    return n;
  };
  const snapshot = (sid) => {
    const s = sessions.get(sid);
    state.now = Date.now();
    state.uptimeSec += 0;
    state.bots = totalBots();
    state.auth = { via: 'session', device: s ? s.device : 'unknown', exp: s ? s.exp : 0 };
    return JSON.parse(JSON.stringify(state));
  };
  const audit = (action, note, ok) => {
    state.audit.unshift({ at: Date.now(), action, note, ok, who: 'Chrome on Windows' });
    state.audit.length = Math.min(state.audit.length, 25);
  };
  const findRoom = (room) => {
    if (state.battleRoyale && state.battleRoyale.room === room) return { r: state.battleRoyale, label: 'Battle royale', br: true };
    for (const g of state.games) for (const r of g.rungs) {
      if (r.room === room) return { r, label: g.name + ' ' + (r.rung === 0 ? 'Free' : '$' + r.rung.toFixed(2)) };
    }
    return null;
  };

  // action -> [ok, note]
  function doAction(action, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (action === 'bots:set') {
      const f = findRoom(a.room);
      if (!f) return [false, 'Unknown room'];
      if (!f.br && f.r.botsAllowed === false) return [false, f.r.botsNote || 'This room takes no bots'];
      const before = f.r.bots;
      if (a.auto === true) { f.r.botTarget = null; return [true, f.label + ' bots back to automatic']; }
      const n = Number(a.count);
      if (!Number.isInteger(n) || n < 0 || n > 200) return [false, 'Bot count must be 0 to 200'];
      f.r.botTarget = n; f.r.bots = n;
      return [true, f.label + ' bots ' + before + ' to ' + n];
    }
    if (action === 'maintenance:on') { state.open = false; state.maintenance = { on: true, message: a.message || 'Back shortly.', since: Date.now(), saved: false }; return [true, 'New games closed']; }
    if (action === 'maintenance:off') { state.open = true; state.maintenance = { on: false, message: '', since: null, saved: false }; return [true, 'New games open']; }
    const door = /^(.+:paid):(on|off)$/.exec(action);
    if (door) {
      const g = state.games.find((x) => x.paid && x.paid.action === door[1]);
      if (!g) return [false, 'Unknown action'];
      if (!g.paid.enabled) return [false, 'Paid ' + g.name + ' is off on this server'];
      g.paid.open = door[2] === 'on'; g.paid.saved = !g.paid.open;
      return [true, 'Paid ' + g.name + (g.paid.open ? ' open' : ' closed')];
    }
    const br = state.battleRoyale;
    if (action === 'br:start') {
      if (br.state !== 'waiting') return [false, 'A match is already under way'];
      Object.assign(br, { state: 'countdown', phase: 'countdown', countdownMs: 10000, canStart: false, canForce: false });
      return [true, a.force ? 'Started alone' : 'Countdown started'];
    }
    if (action === 'br:stop') {
      if (br.state !== 'countdown' && br.state !== 'running') return [false, 'Nothing to stop'];
      Object.assign(br, { state: 'waiting', phase: 'waiting', countdownMs: 0, canStart: true, canForce: true });
      return [true, 'Match stopped, no prize paid'];
    }
    if (action === 'br:engine:sl' || action === 'br:engine:old') { br.engine = action === 'br:engine:sl' ? 'sl' : 'old'; return [true, 'Battle royale on the ' + (br.engine === 'sl' ? 'new' : 'old') + ' engine']; }
    if (action === 'earnings:on' || action === 'earnings:off') { state.earnings.shown = action === 'earnings:on'; return [true, 'Cashed-out strip ' + (state.earnings.shown ? 'shown' : 'hidden')]; }
    if (action === 'sl:smooth:on' || action === 'sl:smooth:off') { state.smooth.on = action === 'sl:smooth:on'; return [true, 'Smooth turning ' + (state.smooth.on ? 'on' : 'off')]; }
    if (action === 'announce') return String(a.text || '').trim() ? [true, 'Sent to everyone playing'] : [false, 'Nothing to send'];
    return [false, 'Unknown action'];
  }

  const send = (res, code, body, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (_) { body = {}; }
      const hasHeader = req.headers['x-ds-owner'] === '1';
      if (p.startsWith('/api/')) log.requests.push({ method: req.method, path: p, header: hasHeader, body });

      if (p === '/socket.io/socket.io.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(FAKE_IO); }
      if (p === '/wallet/widget.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(FAKE_WIDGET); }
      if (p === '/js/ownerAlerts.js' && opts.alerts === 'ticket') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(FAKE_ALERTS); }

      if (p.startsWith('/api/owner/')) {
        if (req.method === 'POST' && !hasHeader) { log.missingHeader.push(p); return send(res, 403, { error: 'Missing X-DS-Owner' }); }
        const cookies = parseCookies(req);
        let sid = cookies.ds_owner && sessions.has(cookies.ds_owner) ? cookies.ds_owner : null;
        if (!sid && presetSid && opts.signedIn && !cookies.ds_out) sid = presetSid;
        if (sid) sessions.get(sid).lastSeen = Date.now();
        const cookie = (v) => ({ 'Set-Cookie': 'ds_owner=' + v + '; Path=/; HttpOnly; SameSite=Strict' + (v ? '' : '; Max-Age=0') });

        if (p === '/api/owner/session' && req.method === 'GET') {
          if (!sid) return send(res, 200, { signedIn: false });
          const s = sessions.get(sid);
          return send(res, 200, { signedIn: true, device: s.device, createdAt: s.createdAt, exp: s.exp });
        }
        if (p === '/api/owner/session/challenge' && req.method === 'GET') {
          const nonce = crypto.randomBytes(16).toString('hex');
          challenges.add(nonce);
          return send(res, 200, { nonce, host: req.headers.host }, { 'Set-Cookie': 'ds_ch=' + nonce + '; Path=/api/owner/session; HttpOnly; SameSite=Strict; Max-Age=300' });
        }
        if (p === '/api/owner/session/login' && req.method === 'POST') {
          const a = body.args || {};
          if (body.action !== 'owner:session:create' || !challenges.has(a.nonce) || cookies.ds_ch !== a.nonce || a.host !== req.headers.host || !body.sig) {
            return send(res, 403, { error: 'That sign-in did not check out' });
          }
          challenges.delete(a.nonce);
          const nsid = newSession(a.label);
          const s = sessions.get(nsid);
          audit('owner:session:create', 'Signed in: ' + s.device, true);
          return send(res, 200, { ok: true, device: s.device, exp: s.exp }, cookie(nsid));
        }
        if (!sid) return send(res, 401, { error: 'Not signed in' });
        if (p === '/api/owner/sessions' && req.method === 'GET') {
          return send(res, 200, { sessions: [...sessions.entries()].map(([k, s]) => Object.assign({}, s, { current: k === sid })) });
        }
        if (p === '/api/owner/session/revoke' && req.method === 'POST') {
          for (const [k, s] of [...sessions.entries()]) {
            if (body.all || (body.others && k !== sid) || (body.id && s.id === body.id)) sessions.delete(k);
          }
          if (!sessions.has(sid) && sid === presetSid) presetSid = null;
          return send(res, 200, { ok: true });
        }
        if (p === '/api/owner/session/logout' && req.method === 'POST') {
          sessions.delete(sid);
          if (sid === presetSid) presetSid = null;
          return send(res, 200, { ok: true }, cookie(''));
        }
        if (p === '/api/owner/ticket' && req.method === 'POST') return send(res, 200, { ticket: crypto.randomBytes(16).toString('hex') });
        if (p === '/api/owner/state' && req.method === 'POST') return send(res, 200, snapshot(sid));
        if (p === '/api/owner/do' && req.method === 'POST') {
          log.actions.push({ action: body.action, args: body.args });
          const [ok, note] = doAction(String(body.action || ''), body.args);
          audit(String(body.action || ''), note, ok);
          return ok ? send(res, 200, { ok: true, note, state: snapshot(sid) }) : send(res, 409, { error: note, state: snapshot(sid) });
        }
        return send(res, 404, { error: 'No such route' });
      }

      let file = p === '/owner' ? '/owner.html' : p;
      file = path.normalize(path.join(PUBLIC, decodeURIComponent(file)));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
  });

  return {
    server, log,
    get state() { return state; },
    reset() { state = baseState(); log.requests.length = 0; log.missingHeader.length = 0; log.actions.length = 0; },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() { return new Promise((resolve) => server.close(() => resolve())); },
  };
}

module.exports = { createOwnerPageStub, baseState };

if (require.main === module && process.argv.includes('--serve')) {
  const portArg = process.argv.find((a) => /^\d+$/.test(a));
  const stub = createOwnerPageStub({ signedIn: process.argv.includes('--signed-in'),
    alerts: process.argv.includes('--alerts=ticket') ? 'ticket' : 'real' });
  stub.listen(Number(portArg) || 4180).then((port) => console.log('owner page stub on http://127.0.0.1:' + port + '/owner'));
}
