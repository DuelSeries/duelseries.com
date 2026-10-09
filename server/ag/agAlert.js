'use strict';
// The owner alert for paid agar.io money events (a ledger breach, a zombie account, an emergency close, a refused
// share, accounts a killed process left open). The ntfy topic is public, so the push carries the kind, the room and
// amounts only, never a wallet; the owner's socket gets the same.
//
// One alert (push and log line) per room per kind per windowMs; the first one after the window says how many it held
// back (repeats), so a second breach in the same room days later still pages Owen (review fix: the old latch was for
// the life of the process, and it also hid the log line).

const AG_ALERT_WINDOW_MS = 10 * 60 * 1000;   // CHOSEN (PARITY-LOG): a storm pages once per 10 minutes per room and kind
const SAFE_KEYS = Object.freeze(['micro', 'accounts', 'totalMicro', 'inMicro', 'outMicro', 'ceiling', 'phase', 'was']);

// push(text, safe): the phone push; toOwner(safe): the owner's socket (both may throw: logged, never rethrown)
function createAgOwnerAlert({ push = () => {}, toOwner = () => {}, log = console, now = Date.now,
  windowMs = AG_ALERT_WINDOW_MS } = {}) {
  const latched = new Map();   // room|kind -> { until, held }
  function alert(info) {
    try {
      const i = info || {};
      const kind = String(i.kind || 'breach');
      const room = String(i.lobbyType || '');
      const key = room + '|' + kind;
      const t = now();
      const was = latched.get(key);
      if (was && t < was.until) {
        was.held++;
        return false;
      }
      latched.set(key, { until: t + windowMs, held: 0 });
      const safe = { kind, lobbyType: room };
      if (was && was.held > 0) safe.repeats = was.held;
      for (const k of SAFE_KEYS) {
        if (i[k] !== undefined && (typeof i[k] === 'number' || typeof i[k] === 'string')) safe[k] = i[k];
      }
      log.error('[AG] MONEY ALERT ' + JSON.stringify(safe));
      try {
        toOwner(safe);
      } catch (e) {
        log.error('[AG] owner alert socket', e && e.message);
      }
      try {
        push(`${kind} in ${room}: ${JSON.stringify(safe)}`, safe);
      } catch (e) {
        log.error('[AG] owner alert push', e && e.message);
      }
      return true;
    } catch (e) {
      log.error('[AG] owner alert', e && e.message);
      return false;
    }
  }
  return alert;
}

module.exports = { createAgOwnerAlert, AG_ALERT_WINDOW_MS, SAFE_KEYS };
