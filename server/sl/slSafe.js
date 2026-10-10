'use strict';
// slither.io free room: safe timers and promises (SERVER-DESIGN 3.1, 13 item 8, 17; task T9).
//
// The process has no uncaughtException handler (server/index.js:88-93): one throw out of a timer, or one rejected
// promise nobody caught, "used to end every live game on the box, paid ones included". So every timer and every
// promise in server/sl goes through these wrappers. They catch, count and log; they never rethrow.
//
//   safeCall(fn, label, stats)              runs fn now; a throw is caught and counted; returns fn's value or
//                                           undefined; a returned promise gets a catch too
//   safeAsync(promiseFn, label, stats)      runs promiseFn now; returns a promise that never rejects (the value,
//                                           or undefined when promiseFn threw or its promise rejected)
//   safeEvery(fn, ms, label, stats, opts)   fn every ms (a chain of timeouts, so a slow fn never stacks calls);
//                                           returns { stop() }
//   safeTimeout(fn, ms, label, stats, opts) fn once after ms; returns { stop() }
//   safeImmediate(fn, label, stats, opts)   fn on the next check phase; returns { stop() }
//
// stats: an object from createSafeStats() (or any object; the fields are made on first use). Each failure adds 1 to
// stats.total and to stats.byLabel[label], and keeps the last one in stats.last ({ label, message, at }).
// opts.timers: { setTimeout, clearTimeout, setImmediate, clearImmediate } (tests pass a fake clock; default: the
// real ones). opts.log: { error(...) } (default console). Timers are unref'd when the timer object allows it, so an
// sl timer never keeps the process alive by itself.

const REAL_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setImmediate: (fn) => setImmediate(fn),
  clearImmediate: (t) => clearImmediate(t),
});

function createSafeStats() {
  return { total: 0, byLabel: {}, last: null };
}

function labelOf(label) {
  return typeof label === 'string' && label ? label : 'sl';
}

function note(stats, label, err, log) {
  const l = labelOf(label);
  const msg = err && err.message ? err.message : String(err);
  if (stats && typeof stats === 'object') {
    stats.total = (stats.total || 0) + 1;
    if (!stats.byLabel || typeof stats.byLabel !== 'object') stats.byLabel = {};
    stats.byLabel[l] = (stats.byLabel[l] || 0) + 1;
    stats.last = { label: l, message: msg, at: Date.now() };
  }
  try {
    const out = log && typeof log.error === 'function' ? log : console;
    out.error('[SL] ' + l + ' failed:', err && err.stack ? err.stack : msg);
  } catch (e) {
    // a broken logger must not throw out of the wrapper either
  }
}

function isThenable(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

function safeCall(fn, label, stats, opts) {
  const log = opts && opts.log;
  try {
    const v = fn();
    if (isThenable(v)) {
      v.then(null, (err) => note(stats, label, err, log));
    }
    return v;
  } catch (err) {
    note(stats, label, err, log);
    return undefined;
  }
}

function safeAsync(promiseFn, label, stats, opts) {
  const log = opts && opts.log;
  let p;
  try {
    p = promiseFn();
  } catch (err) {
    note(stats, label, err, log);
    return Promise.resolve(undefined);
  }
  return Promise.resolve(p).then((v) => v, (err) => {
    note(stats, label, err, log);
    return undefined;
  });
}

function timersOf(opts) {
  return opts && opts.timers ? opts.timers : REAL_TIMERS;
}

function unref(t) {
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

function needMs(ms, what) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new RangeError('slSafe: ' + what + ' must be a finite number >= 0');
  return ms;
}

function needFn(fn) {
  if (typeof fn !== 'function') throw new TypeError('slSafe: fn must be a function');
  return fn;
}

// fn every ms. The next call is armed before fn runs, so a throw can never stop the chain.
function safeEvery(fn, ms, label, stats, opts) {
  needFn(fn);
  needMs(ms, 'period');
  const T = timersOf(opts);
  let timer = null;
  let stopped = false;
  const tickFn = () => {
    timer = null;
    if (stopped) return;
    timer = unref(T.setTimeout(tickFn, ms));
    safeCall(fn, label, stats, opts);
  };
  timer = unref(T.setTimeout(tickFn, ms));
  return {
    stop() {
      stopped = true;
      if (timer !== null) T.clearTimeout(timer);
      timer = null;
    },
    get active() {
      return !stopped;
    },
  };
}

function safeTimeout(fn, ms, label, stats, opts) {
  needFn(fn);
  needMs(ms, 'delay');
  const T = timersOf(opts);
  let timer = null;
  let done = false;
  timer = unref(T.setTimeout(() => {
    timer = null;
    if (done) return;
    done = true;
    safeCall(fn, label, stats, opts);
  }, ms));
  return {
    stop() {
      done = true;
      if (timer !== null) T.clearTimeout(timer);
      timer = null;
    },
    get active() {
      return !done;
    },
  };
}

function safeImmediate(fn, label, stats, opts) {
  needFn(fn);
  const T = timersOf(opts);
  let done = false;
  let handle = T.setImmediate(() => {
    handle = null;
    if (done) return;
    done = true;
    safeCall(fn, label, stats, opts);
  });
  return {
    stop() {
      done = true;
      if (handle !== null && typeof T.clearImmediate === 'function') T.clearImmediate(handle);
      handle = null;
    },
    get active() {
      return !done;
    },
  };
}

module.exports = {
  REAL_TIMERS,
  createSafeStats,
  safeCall,
  safeAsync,
  safeEvery,
  safeTimeout,
  safeImmediate,
};
