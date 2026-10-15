'use strict';
// slither.io free room: opening it at server boot (SERVER-DESIGN 13 items 1 to 3, 15.0; task T11). Kept here so the
// switch, the law gate and the page are tested without booting the server (agar's server/ag/agBoot.js shape).
//
//   SL_ENABLED    OFF BY DEFAULT. 1, true, on, yes: on. Unset, empty, 0, false, off, no: off. Anything else is not a
//                 switch value: it says so and fails CLOSED (off). One copy: server/slRoutes.js slSwitch (task T-1).
//   SL_DEV_LAWS   a file whose LAWS (or FIXTURE) table replaces the real one, to run the game locally on the test
//                 FIXTURE. Refused, and the game then stays closed, wherever it could be the live server: NODE_ENV
//                 production, or an ESCROW_PRIVATE_KEY or DATABASE_URL set (agar's AG_DEV_LAWS rule, agBoot.js:33-50).
//
// With the switch on, openSl runs assertShippable (real table only) and assertRulesBuilt, composes the page and opens
// the room on io.of('/sl'). Any failure keeps the game closed and logs why; it never takes the server down.
//
// The page (SERVER-DESIGN 15.0): public/sl.html stays byte-identical (the parity gate runs its script list).
// composePage(slHtml) inserts SLX_TAIL (the layer's stylesheet link and its scripts, in order) once, right before the
// single </body>, so after slMain.js. It refuses (game closed) when the page has not exactly one </body> or already
// mentions /js/slx/. SLX_TAIL is built at load from the layer files present on disk, in the SERVER-DESIGN 3.2 order
// (slxNet first: every other layer file checks DuelSlither.slx.active, which slxNet sets), any other
// public/js/slx/*.js after them by name; so the layer tasks (T16 to T18) add files without editing this one. With no
// layer file yet the tail is empty and /sl serves the frozen page as it is.
//
// /sl (slPageRoute): the composed page when open; the closed page (503) when the switch is on but the boot failed;
// otherwise the T-1 routes answer (server/slRoutes.js, closed page). No money: openSl gets ONE read function,
// topCashout(since, exclude), for the biggest cash-out box (SERVER-DESIGN 13 item 11), never the database module.

const fs = require('fs');
const path = require('path');
const { slSwitch, CLOSED_PAGE } = require('../slRoutes');
const { createSafeStats, safeEvery } = require('./slSafe');
// slLaws and slPrey (which builds the law table at load, and throws on a malformed row) are required INSIDE openSl's
// try, after the switch check (fixer pass, 2026-10-10): server/index.js requires this file at top level with no try,
// so a bad law row edit must never stop the whole server (paid snake, agar, Paper) at boot, switch on or off.

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// SERVER-DESIGN 3.2, in that table's order, with slxPaid.js right after slxNet.js (PAID-SL-DESIGN 9): slxMain merges
// its handshake fields and asks it before the lobby's auto Play, and slxCard reads its hooks.
const SLX_FILES = Object.freeze(['slxNet.js', 'slxPaid.js', 'slxMain.js', 'slxDirect.js', 'slxCard.js', 'slxTop.js',
  'slxChat.js', 'slxStats.js', 'slxSound.js', 'slxHold.js', 'slxTouch.js', 'slxSkins.js', 'slxCoin.js']);
const SLX_CSS = 'slx.css';

// -> { laws, dev }. Throws when the dev table is asked for where it could be the live server, or does not load.
function loadSlLaws(env, log) {
  const e = env || {};
  if (!e.SL_DEV_LAWS) return { laws: require('./slLaws').LAWS, dev: false };
  if (e.NODE_ENV === 'production') {
    throw new Error('SL_DEV_LAWS is set in PRODUCTION. Refused: the dev law table never runs here');
  }
  if (String(e.ESCROW_PRIVATE_KEY || '').trim()) {
    throw new Error('SL_DEV_LAWS is set on a server holding ESCROW_PRIVATE_KEY. Refused: the dev law table never runs here');
  }
  if (String(e.DATABASE_URL || '').trim()) {
    throw new Error('SL_DEV_LAWS is set with a DATABASE_URL. Refused: the dev law table never runs here');
  }
  const mod = require(path.resolve(String(e.SL_DEV_LAWS)));
  const laws = mod && (mod.LAWS || mod.FIXTURE);
  if (!laws || typeof laws !== 'object') throw new Error('SL_DEV_LAWS: ' + e.SL_DEV_LAWS + ' exports no LAWS table');
  (log || console).warn('[SL] SL_DEV_LAWS: running on the law table in ' + e.SL_DEV_LAWS + '. Not for production.');
  return { laws, dev: true };
}

// The layer tail from the files present under publicDir.
function slxTail(publicDir) {
  const dir = publicDir || PUBLIC_DIR;
  let present = [];
  try {
    present = fs.readdirSync(path.join(dir, 'js', 'slx')).filter((f) => f.endsWith('.js'));
  } catch (e) {
    present = [];
  }
  const ordered = SLX_FILES.filter((f) => present.includes(f))
    .concat(present.filter((f) => !SLX_FILES.includes(f)).sort());
  let tail = '';
  if (fs.existsSync(path.join(dir, 'css', SLX_CSS))) tail += '<link rel="stylesheet" type="text/css" href="/css/' + SLX_CSS + '" />\n';
  for (const f of ordered) tail += '<script src="/js/slx/' + f + '"></script>\n';
  return tail;
}

const SLX_TAIL = slxTail(PUBLIC_DIR);

// sl.html with the layer tail inserted once before its single </body>. Throws (the game stays closed) otherwise.
function composePage(slHtml, tail) {
  const t = tail === undefined ? SLX_TAIL : tail;
  if (typeof slHtml !== 'string') throw new TypeError('slBoot: composePage needs the page text');
  if (typeof t !== 'string') throw new TypeError('slBoot: the layer tail must be text');
  const at = slHtml.indexOf('</body>');
  if (at === -1 || slHtml.indexOf('</body>', at + 1) !== -1) {
    throw new Error('slBoot: public/sl.html must have exactly one </body>');
  }
  if (slHtml.includes('/js/slx/')) throw new Error('slBoot: public/sl.html already mentions /js/slx/');
  return slHtml.slice(0, at) + t + slHtml.slice(at);
}

function sendClosed(res) {
  res.set('Cache-Control', 'no-store');
  res.status(503).type('html').send(CLOSED_PAGE);
}

// The /sl route for server/index.js, declared before the T-1 routes (server/slRoutes.js). opened: openSl's answer.
// Open: the composed page. Switch on but closed (the boot refused): the closed page, never the bare client (its Play
// could not connect). Switch off: next(), so the T-1 closed page answers exactly as before.
function slPageRoute(opened) {
  return (req, res, next) => {
    const o = opened || {};
    if (typeof o.page === 'string' && o.page) {
      res.set('Cache-Control', 'no-store');
      return res.status(200).type('html').send(o.page);
    }
    if (o.why === 'off' || o.why === undefined) return next();
    return sendClosed(res);
  };
}

// -> { arenas, page, why, dev, sockets }: arenas, page and sockets null when the game is off ('off') or closed (why says
// which). sockets is attachSlSockets' handle: the server attaches the paid helper through its setPaid (PAID-SL-DESIGN
// 3.1, task T4), so this file names nothing paid.
// opts: { env, io (the socket.io server), region, helpers: { socketRL, ops, notifyJoin(name), paidLoad(),
//   clientIp }, topCashout(since, exclude) (null: no box), excludeWallets (owner and revenue wallets), log,
//   slHtml (tests; default public/sl.html), slxTail (tests; default SLX_TAIL), laws (tests; a table treated as the
//   real one), autoTick, seed, clock, now, timers, bots, monitor (tests; default perf_hooks.monitorEventLoopDelay at
//   slBots LOOP_RESOLUTION_MS, 1 ms),
//   every (tests) }
function openSl(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const log = o.log || console;
  if (!slSwitch(env.SL_ENABLED, log)) return { arenas: null, page: null, why: 'off', dev: false, sockets: null };
  let arenas = null;
  try {
    const { assertShippable, assertRulesBuilt } = require('./slLaws');
    const { preyNotShippable } = require('./slPrey');
    // o.laws (tests only): a table treated exactly as the real one (assertShippable applies).
    const { laws, dev } = o.laws ? { laws: o.laws, dev: false } : loadSlLaws(env, log);
    if (!dev) assertShippable(laws);
    assertRulesBuilt(laws);
    const html = typeof o.slHtml === 'string' ? o.slHtml : fs.readFileSync(path.join(PUBLIC_DIR, 'sl.html'), 'utf8');
    const page = composePage(html, o.slxTail);
    const prey = preyNotShippable(laws);
    if (prey.length) log.warn('[SL] prey off until these rows are approved: ' + prey.join('; '));
    const { SlArenas } = require('./slArenas');
    const { attachSlSockets } = require('./slSockets');
    const ao = { region: o.region || 'na', shippableOnly: !dev, log, bots: o.bots };
    for (const k of ['autoTick', 'seed', 'clock', 'now', 'timers']) if (o[k] !== undefined) ao[k] = o[k];
    arenas = new SlArenas(laws, ao);
    const helpers = Object.assign({ log }, o.helpers);
    const sockets = attachSlSockets(o.io ? o.io.of('/sl') : null, arenas, helpers);
    const safeStats = createSafeStats();
    const every = typeof o.every === 'function' ? o.every : (fn, ms, label) => safeEvery(fn, ms, label, safeStats, { log });
    let monitor = o.monitor;
    if (monitor === undefined) {
      monitor = require('perf_hooks').monitorEventLoopDelay({ resolution: require('./slBots').LOOP_RESOLUTION_MS });
    }
    arenas.startTimers({ monitor, paidLoad: helpers.paidLoad, every });
    startTop(arenas, o, log, every);
    log.log('[SL] slither.io (new) free room open on /sl' + (dev ? ' (DEV law table)' : ''));
    return { arenas, page, why: null, dev, sockets };
  } catch (e) {
    if (arenas) {
      try { arenas.close(); } catch (_) { /* closing is best effort */ }
    }
    log.error('[SL] slither.io (new) stays closed: ' + (e && e.message));
    return { arenas: null, page: null, why: (e && e.message) || 'refused', dev: false, sockets: null };
  }
}

// The biggest cash-out box (slTopCashout). A fault here never closes the game: the box stays hidden.
function startTop(arenas, o, log, every) {
  if (typeof o.topCashout !== 'function') return null;
  try {
    const { createTopCashout } = require('./slTopCashout');
    const top = createTopCashout({ topCashout: o.topCashout, excludeWallets: o.excludeWallets, log, every });
    top.start((msg) => arenas.setTop(msg));
    arenas.topBox = top;
    arenas.timers.push({ stop: () => top.stop() });
    return top;
  } catch (e) {
    log.error('[SL] biggest cash-out box off: ' + (e && e.message));
    return null;
  }
}

module.exports = { slSwitch, loadSlLaws, slxTail, composePage, SLX_TAIL, SLX_FILES, CLOSED_PAGE, slPageRoute,
  sendClosed, openSl, PUBLIC_DIR };
