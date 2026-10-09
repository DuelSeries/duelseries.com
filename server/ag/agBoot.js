'use strict';
// Opening the agar.io rooms at server boot (server/index.js calls openAg once). Kept here so the switch and the
// law gate are tested without booting the server.
//
//   AG_ENABLED   ON BY DEFAULT since 2026-10-07 (the real table is shippable, and production env lives only in the
//                box's .env, so the default is what the live server runs). Unset, empty, 1, true, on, yes: on.
//                0, false, off, no: off (the explicit off switch). Anything else is not a switch value: it says so
//                and fails CLOSED (off). The free room is the lobby's agar.io card; the paid rungs are behind AG_PAID
//                below (on by default since 2026-10-09), and their money flows only through the hooks the server
//                passes in.
//   AG_DEV_LAWS  a file whose LAWS (or FIXTURE) table replaces the real one, to run the game locally on another
//                table (the test FIXTURE). Refused, and the game then stays closed, wherever it could be the live
//                server: NODE_ENV production, or an ESCROW_PRIVATE_KEY or DATABASE_URL set (the same refusals as
//                PAPER_DEV_TOKENS; the EC2 box runs under pm2 and the repo does not show it setting NODE_ENV).
//
// Without AG_DEV_LAWS the rooms run on server/ag/agLaws.js and refuse to open unless it passes assertShippable
// and the sim has built every rule it names. Since 2026-10-02 it passes both (Owen approved every row, and the sim
// builds L6 'linearRamp', L29 'equalPieces' and L32 'whileUneaten'), so the game opens unless switched off. Any
// failure leaves the game closed, never the server down.

const path = require('path');

function agSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  (log || console).error('[AG] AG_ENABLED=' + JSON.stringify(String(raw).slice(0, 20)) +
    ' is not a switch value; agar.io stays OFF (fails closed)');
  return false;
}

// -> { laws, dev }. Throws when the dev table is asked for in production or does not load.
function loadAgLaws(env, log) {
  const e = env || {};
  if (!e.AG_DEV_LAWS) return { laws: require('./agLaws').LAWS, dev: false };
  if (e.NODE_ENV === 'production') {
    throw new Error('AG_DEV_LAWS is set in PRODUCTION. Refused: the dev law table never runs here');
  }
  if (String(e.ESCROW_PRIVATE_KEY || '').trim()) {
    throw new Error('AG_DEV_LAWS is set on a server holding ESCROW_PRIVATE_KEY. Refused: the dev law table never runs here');
  }
  if (String(e.DATABASE_URL || '').trim()) {
    throw new Error('AG_DEV_LAWS is set with a DATABASE_URL. Refused: the dev law table never runs here');
  }
  const mod = require(path.resolve(String(e.AG_DEV_LAWS)));
  const laws = mod && (mod.LAWS || mod.FIXTURE);
  if (!laws || typeof laws !== 'object') throw new Error('AG_DEV_LAWS: ' + e.AG_DEV_LAWS + ' exports no LAWS table');
  (log || console).warn('[AG] AG_DEV_LAWS: running on the law table in ' + e.AG_DEV_LAWS + '. Not for production.');
  return { laws, dev: true };
}

// AG_PAID (PAID-AGAR-DESIGN.md 5.7, 10): the paid rungs ($0.10, $1.00). ON BY DEFAULT since 2026-10-09 (Phase C,
// Owen Q7: switched on once every test and the local money proof passed, the proof run through the real lobby and
// /ag page; production env lives only in the box's .env, which no deploy touches, so the default is what the live
// server runs, as fcadf0f did for Paper). Unset, empty, 1, true, on, yes: on. 0, false, off, no: off (the explicit
// off switch, plus a restart). Anything else: off, and it says so (fails CLOSED). The instant off switch needs no
// restart: the owner console's agar:paid:off (new joins refunded at the door, seated players finish). The paid rungs
// also need the money wiring (opts.money) and AG_ENABLED; without either they stay off.
const AG_PAID_DEFAULT = true;
function agPaidSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return AG_PAID_DEFAULT;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  (log || console).error('[AG] AG_PAID=' + JSON.stringify(String(raw).slice(0, 20)) +
    ' is not a switch value; paid agar.io stays OFF (fails closed)');
  return false;
}

// -> { arenas, why, paid? }: arenas null when the game is off or closed, why says which; paid (open only): the paid
// rungs exist.
// opts: { env, io (the socket.io server), region, helpers: { socketRL, sanitizeName, ops }, log, autoTick,
//   money: { hooks (agMoney's payout hooks, see AgArenas), door: { consumeAtStake, ledger, refund } } }
function openAg(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const log = o.log || console;
  if (!agSwitch(env.AG_ENABLED, log)) return { arenas: null, why: 'off' };
  try {
    const { laws, dev } = loadAgLaws(env, log);
    const { AgArenas } = require('./agArenas');
    const { attachAgSockets } = require('./agSockets');
    const m = o.money || null;
    const paid = agPaidSwitch(env.AG_PAID, log) && !!(m && m.hooks && m.door);
    const arenas = new AgArenas({ region: o.region || 'na', laws, shippableOnly: !dev, log,
      autoTick: o.autoTick !== false, paid, moneyHooks: paid ? m.hooks : null });
    const helpers = Object.assign({ log }, o.helpers);
    // The door is attached whenever the money is wired, paid rungs on or not: with them off it refunds every token it
    // is handed ('not-open') rather than leaving it to expire.
    if (m && m.door) helpers.paidDoor = m.door;
    attachAgSockets(o.io ? o.io.of('/ag') : null, arenas, helpers);
    log.log('[AG] agar.io rooms open on /ag' + (dev ? ' (DEV law table)' : ''));
    log.log('[AG] paid rungs ' + (paid ? 'on' : 'OFF'));
    return { arenas, why: null, paid };
  } catch (e) {
    log.error('[AG] agar.io stays closed: ' + (e && e.message));
    return { arenas: null, why: e && e.message };
  }
}

module.exports = { agSwitch, agPaidSwitch, AG_PAID_DEFAULT, loadAgLaws, openAg };
