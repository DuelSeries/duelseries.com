'use strict';
// Opening paid snake on the sl engine at server boot (PAID-SL-DESIGN.md 2, 3.1, 6, 7.1 and 10; task T5). Kept here,
// beside the money modules it wires, so the switch, the fallbacks and the shutdown composite are tested without
// booting the server; server/index.js calls openSlPaid once, after the agar block (the shared journal, agInflight and
// the owner alert exist there; D2-M3). No server/sl file requires this one (critic C-2, slNoMoney): the free room's
// sockets get the paid directory and door through their setPaid.
//
//   SL_PAID   ON BY DEFAULT since the switch-on commit (design 10; BUILD-TASKS T9: flipped once every test, the T8
//             gate and the local page proof passed). Production env is only the box's .env, so this default is what
//             the live server runs. Unset or empty: the default. 1, true, on, yes: on. 0, false, off, no: off.
//             Anything else is not a switch value: it says so and fails CLOSED (off). agar's parser
//             (server/ag/agBoot.js agPaidSwitch), copied.
//
// openSlPaid builds NOTHING when slBoot.openSl gave no sockets (SL_ENABLED off, or the free room refused to open,
// critic C-4): there are then no sl paid rows on /api/live, liveBoard keeps the old snake rows open, and paid snake runs
// on the old engine exactly as before. With sockets, the helper is ALWAYS attached, switch on or off:
//   on      the paid directory (SlPaidArenas: the $0.50 and $1 rungs) on the server's money hooks, and the paid door
//   off     a directory with no rungs (paidOpen false), so the door spends a paid page's token and refunds it
//           'not-open' (design 10: never seated free, never left to expire)
//   broken  the rungs did not build: the same off directory, logged CRITICAL; and if even that or the door does not
//           build, a helper that refuses every paid join 'not-open' without touching its token (the token's expiry
//           refunds it, entryExpiry), so a paid page is never seated in the free room
// Any failure here leaves the server up.
//
// Also here, for the server:
//   composePaidShutdown(dirs, log)   ONE shutdownSettle over every paid directory (agar's and this one), each in its own
//                                    try, so one game's throw never keeps the other's rows from the journal (design
//                                    7.1, D1-m2); index.js hands it to installAgShutdown and installAgCrashLog once
//   createCashoutStatus(opts)        the cash-out status behind GET /api/sl/cashout/:cid (design 6): 'pending' when the
//                                    order goes out, then 'sent' or 'delayed'; keyed by the cash-out id only (a
//                                    lowercase uuid, no wallet), STATUS_TTL_MS each, at most STATUS_MAX
//   isCashoutId(cid)                 the lowercase uuid test the route answers 404 to before it reads the map
//   createOwedLane(opts)             slMoney's onOwed (design 7.4): an emergency or orphan refund's row written once per
//                                    key, and a refused write kept and written again by retry() on the slpaid-sweep
//                                    tick until it lands (review T5-R3)

const { SlPaidArenas } = require('./slPaidArenas');
const { createSlPaidDoor } = require('./slPaidDoor');
const { STATUS_TTL_MS } = require('./slPaidConst');

const SL_PAID_DEFAULT = true;
// design 6: the status map holds at most this many cash-outs (the oldest goes first)
const STATUS_MAX = 5000;
const CID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_STATES = Object.freeze(['pending', 'sent', 'delayed']);

function slPaidSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return SL_PAID_DEFAULT;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  (log || console).error('[SLP] SL_PAID=' + JSON.stringify(String(raw).slice(0, 20)) +
    ' is not a switch value; paid snake on the new engine stays OFF (fails closed)');
  return false;
}

// dirs: paid directories (each with shutdownSettle(why) -> rows), nulls skipped.
function composePaidShutdown(dirs, log) {
  const lg = log || console;
  const list = (dirs || []).filter(Boolean);
  return {
    dirs: list,
    shutdownSettle(why) {
      const rows = [];
      for (const d of list) {
        try {
          const r = d.shutdownSettle(why);
          if (Array.isArray(r)) rows.push(...r);
        } catch (e) {
          try {
            lg.error('[SLP] SHUTDOWN a paid directory\'s settle threw, the others still settle: ' +
              (e && e.stack ? e.stack : e));
          } catch (_) { /* dying anyway */ }
        }
      }
      return rows;
    },
  };
}

function isCashoutId(cid) {
  return typeof cid === 'string' && CID_RE.test(cid);
}

function createCashoutStatus({ ttlMs = STATUS_TTL_MS, max = STATUS_MAX, now = Date.now } = {}) {
  const map = new Map(); // cid -> { state, at }, oldest first (an update keeps its place and its time)
  function prune(t) {
    for (const [cid, e] of map) {
      if (t - e.at < ttlMs && map.size <= max) break;
      map.delete(cid);
    }
  }
  function set(cid, state) {
    if (!isCashoutId(cid) || !STATUS_STATES.includes(state)) return false;
    const t = now();
    const e = map.get(cid);
    if (e) e.state = state;
    else map.set(cid, { state, at: t });
    prune(t);
    return true;
  }
  function get(cid) {
    if (!isCashoutId(cid)) return null;
    prune(now());
    const e = map.get(cid);
    return e ? e.state : null;
  }
  return { set, get, size: () => map.size };
}

// The owed lane's live write (design 7.4). An emergency or orphan close happens mid-run: the room already closed the
// journal with the row's key, so a write the database refuses would otherwise wait for the next boot's replay, which can
// be days away. Such a row is kept here and written again on every retry() (the slpaid-sweep tick) until it answers
// owed or exists; recordOwedOnce takes one row per key, so a retry never pays twice, and the replay stays the backstop
// for a process that dies first. onOwed still rejects on a refused write, so slMoney logs OWED CRITICAL and alerts.
//   write(row)  -> promise of 'owed' or 'exists' (the server: db.recordOwedOnce, in dollars)
//   kick()      the drainer, once per row written
//   track(p)    -> p (agInflight.track: a SIGINT waits for a write in flight)
// -> { onOwed(row), retry() -> promise of the rows still kept, pending() }
function createOwedLane({ write, kick = () => {}, track = (p) => p, log = console } = {}) {
  if (typeof write !== 'function') throw new Error('createOwedLane: write must be a function');
  const kept = new Map(); // key -> { row, busy }
  function attempt(row) {
    return Promise.resolve().then(() => write(row)).then((answer) => {
      kept.delete(row.key);
      try {
        kick();
      } catch (e) {
        log.error('[SLP] OWED drainer kick: ' + (e && e.message));
      }
      return answer;
    });
  }
  function onOwed(row) {
    return track(attempt(row).catch((e) => {
      if (!kept.has(row.key)) kept.set(row.key, { row, busy: false });
      log.error('[SLP] OWED row ' + row.key + ' kept for a retry on the sweep tick (' + row.micro + ' micro)');
      throw e;
    }));
  }
  function retry() {
    const runs = [];
    for (const k of Array.from(kept.values())) {
      if (k.busy) continue;
      k.busy = true;
      runs.push(track(attempt(k.row)).then((answer) => {
        log.log('[SLP] OWED row ' + k.row.key + ' written on retry (' + answer + ', ' + k.row.micro + ' micro)');
      }, (e) => {
        k.busy = false;
        log.error('[SLP] OWED row ' + k.row.key + ' retry failed, kept (' + k.row.micro + ' micro): ' + (e && e.message));
      }));
    }
    return Promise.all(runs).then(() => kept.size);
  }
  return { onOwed, retry, pending: () => kept.size };
}

// The last resort (nothing paid could be built): a paid socket is routed here, never to the free room, and its join is
// refused 'not-open' with its token untouched.
function refusingHelper() {
  const no = () => false;
  return {
    arenas: { leave: no, disconnect: no, input: no, hold: no, vis: no, chat: no, diag: no, roomForKey: () => null,
      roomOf: () => null },
    door: {
      join(socket) {
        try {
          socket.emit('sl:x', [{ t: 'refused', why: 'not-open', refunded: 0 }]);
        } catch (e) { /* closing it is what matters */ }
        try {
          socket.disconnect(true);
        } catch (e) { /* already gone */ }
      },
    },
  };
}

// opts:
//   env       process.env (SL_PAID)
//   sockets   slBoot.openSl's sockets handle (setPaid), or null
//   laws      the free room's law table (slBoot.openSl's arenas.laws); dev: it is the dev table (rooms not shippable)
//   region    'na'
//   hooks     slMoney's server hooks: onCashout, onOwed, onFloor, onHouse, onBreach, onTransfer, journal
//   door      the door's server deps: consumeAtStake(token, stake), ledger, slPayout, journal, ops, recordEntry, alert,
//             track
//   arenas    tests only: more SlPaidArenas options (clock, timers, autoTick, seed, checkEvery, ...)
//   log
// -> { arenas, door, paid, why }: arenas and door null when nothing was built (why says which); paid: the rungs exist.
function openSlPaid(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const log = o.log || console;
  const sockets = o.sockets || null;
  if (!sockets || typeof sockets.setPaid !== 'function') {
    const asked = String(env.SL_PAID == null ? '' : env.SL_PAID).trim() !== '';
    log.log('[SLP] paid snake on the new engine not built: /sl is not open (SL_ENABLED off or refused)' +
      (asked ? ', SL_PAID ignored' : '') + '; paid snake stays on the old engine');
    return { arenas: null, door: null, paid: false, why: 'no-sl' };
  }
  const want = slPaidSwitch(env.SL_PAID, log);
  const base = Object.assign({ region: o.region || 'na', shippableOnly: o.shippableOnly !== false, log }, o.arenas || {});
  let arenas = null;
  let why = want ? null : 'off';
  if (want) {
    try {
      arenas = new SlPaidArenas(o.laws, Object.assign({}, base, { paid: true, moneyHooks: o.hooks }));
    } catch (e) {
      why = (e && e.message) || 'refused';
      log.error('[SLP] CRITICAL paid snake rungs did not build, paid joins are refunded not-open: ' + why);
    }
  }
  if (!arenas) {
    try {
      arenas = new SlPaidArenas(o.laws, Object.assign({}, base, { paid: false, moneyHooks: null }));
    } catch (e) {
      why = (e && e.message) || 'refused';
      log.error('[SLP] CRITICAL paid snake directory did not build: ' + why);
    }
  }
  let door = null;
  if (arenas) {
    try {
      const d = o.door || {};
      door = createSlPaidDoor({
        arenas,
        consumeAtStake: d.consumeAtStake,
        ledger: d.ledger || null,
        slPayout: d.slPayout,
        journal: d.journal,
        ops: d.ops || null,
        recordEntry: d.recordEntry || null,
        alert: d.alert || null,
        track: typeof d.track === 'function' ? d.track : (p) => p,
        log,
      });
    } catch (e) {
      why = (e && e.message) || 'refused';
      log.error('[SLP] CRITICAL paid snake door did not build: ' + why);
    }
  }
  const helper = arenas && door ? { arenas, door } : refusingHelper();
  try {
    sockets.setPaid(helper);
  } catch (e) {
    why = (e && e.message) || 'refused';
    log.error('[SLP] CRITICAL paid helper not attached: ' + why);
    try {
      sockets.setPaid(refusingHelper());
    } catch (e2) {
      log.error('[SLP] CRITICAL the refusing helper was not attached either: ' + (e2 && e2.message));
    }
    return { arenas: null, door: null, paid: false, why };
  }
  const paid = !!(arenas && door && arenas.paidEnabled);
  if (!door) arenas = null;
  log.log('[SLP] paid snake on the new engine ' + (paid ? 'on' : 'OFF') +
    (paid ? ' (/sl paid rungs $0.50 and $1)' : ' (paid /sl joins are refunded not-open)'));
  return { arenas, door, paid, why: paid ? null : why };
}

module.exports = { slPaidSwitch, SL_PAID_DEFAULT, openSlPaid, composePaidShutdown, createCashoutStatus, isCashoutId,
  STATUS_MAX, createOwedLane };
