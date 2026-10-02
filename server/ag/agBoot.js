'use strict';
// Opening the agar.io rooms at server boot (server/index.js calls openAg once). Kept here so the switch and the
// law gate are tested without booting the server.
//
//   AG_ENABLED   on only for 1, true, on, yes; unset or 0, false, off, no leaves it off; anything else is not
//                a switch value, says so and leaves it off.
//   AG_DEV_LAWS  a file whose LAWS (or FIXTURE) table replaces the real one, to run the game locally before Owen
//                has approved every row. Refused, and the game then stays closed, wherever it could be the live
//                server: NODE_ENV production, or an ESCROW_PRIVATE_KEY or DATABASE_URL set (the same refusals as
//                PAPER_DEV_TOKENS; the EC2 box runs under pm2 and the repo does not show it setting NODE_ENV).
//
// Without AG_DEV_LAWS the rooms run on server/ag/agLaws.js and refuse to open unless it passes assertShippable,
// so production stays closed until Owen approves the open rows. Any failure leaves the game closed, never the
// server down.

const path = require('path');

function agSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no') {
    (log || console).error('[AG] AG_ENABLED=' + JSON.stringify(String(raw).slice(0, 20)) +
      ' is not a switch value; agar.io stays OFF');
  }
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

// -> { arenas, why }: arenas null when the game is off or closed, why says which.
// opts: { env, io (the socket.io server), region, helpers: { socketRL, sanitizeName, ops }, log, autoTick }
function openAg(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const log = o.log || console;
  if (!agSwitch(env.AG_ENABLED, log)) return { arenas: null, why: 'off' };
  try {
    const { laws, dev } = loadAgLaws(env, log);
    const { AgArenas } = require('./agArenas');
    const { attachAgSockets } = require('./agSockets');
    const arenas = new AgArenas({ region: o.region || 'na', laws, shippableOnly: !dev, log,
      autoTick: o.autoTick !== false });
    attachAgSockets(o.io ? o.io.of('/ag') : null, arenas, Object.assign({ log }, o.helpers));
    log.log('[AG] agar.io rooms open on /ag' + (dev ? ' (DEV law table)' : ''));
    return { arenas, why: null };
  } catch (e) {
    log.error('[AG] agar.io stays closed: ' + (e && e.message));
    return { arenas: null, why: e && e.message };
  }
}

module.exports = { agSwitch, loadAgLaws, openAg };
