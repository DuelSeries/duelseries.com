'use strict';
/* ─── Names the code that blocks the event loop ───────────────────────────────
   Five fixes have been aimed at a once-a-minute hitch and none of them landed.
   Every one was reasoned backwards from a symptom: the network, the adapter,
   the body-thinning step, the periodic jobs, the collector. The measurements
   ruled each out in turn, and the last one ruled out the collector too — the
   stall is a single ~217ms block, and the largest collection inside that window
   was 55ms, so twelve small pauses cannot add up to one long gap.

   What is left is that something runs for a sixth of a second and nothing here
   knows its name. Tick lag says WHEN the thread died. Job timers say it was not
   any job. Neither says WHAT was on the stack, which is the only fact that ends
   this.

   V8's sampling profiler answers exactly that. Its sampler runs on its own
   thread and interrupts the main one, so a JS function that blocks for 217ms is
   not invisible to it — it collects ~200 samples all pointing at the culprit,
   which is precisely the signature being looked for.

   Profiling continuously and keeping everything would be wasteful, so this runs
   in windows: profile for WINDOW_MS, and keep a window only if a stall happened
   during it. Quiet windows are discarded. What survives is a profile guaranteed
   to contain the stall, and the hottest function in it is the answer.

   ── COST, learned the hard way ────────────────────────────────────────────
   Sampling itself is cheap. Ending a window is not: Profiler.stop() serializes
   the whole node tree on the main thread, and summarise() then walks and sorts
   it. Left running during play, that landed in the client trace as a snapshot
   gap every 15 seconds — the window boundary, exactly — and the windows it
   kept were the three biggest gaps of the session, because recording a stall
   triggers the summarise that causes a longer one.

   So this is a diagnostic instrument, not a monitor. It is OFF unless
   PROFILER=on, and it should be switched on to answer a specific question and
   switched off again, never left running while anyone is playing. */

const inspector = require('inspector');

const WINDOW_MS       = 15000;  // profile length; long enough to catch a 60s-cycle stall across a few windows
const SAMPLE_US       = 1000;   // 1ms
const STALL_MS        = 90;     // a window is worth keeping if the loop died for at least this long

let session   = null;
let running   = false;   // a profile is currently being collected
let enabled   = false;
let windowWorst = 0;     // worst stall seen during the CURRENT window
let kept      = null;    // the aggregated profile from the worst window so far

/* Reported by whatever notices the thread died — GameRoom's tick lag. Recording
   it here is what marks the current window as interesting. */
function noteStall(ms) {
  if (ms > windowWorst) windowWorst = ms;
}

/* A profile is a flat node list plus a sample count per node. Self time is
   simply how many samples landed IN a function rather than in something it
   called, which is the number that names a blocker. */
function summarise(profile, stallMs) {
  const perSample = SAMPLE_US / 1000;
  const rows = [];
  let totalHits = 0;
  for (const n of profile.nodes || []) totalHits += n.hitCount || 0;
  for (const n of profile.nodes || []) {
    if (!n.hitCount) continue;
    const f = n.callFrame || {};
    // A mostly-quiet server is mostly idle, and "(idle) 97%" would push the
    // twenty rows that matter off the end of the report.
    if (f.functionName === '(idle)' || f.functionName === '(program)') continue;
    let where = f.url || '';
    // Trim to something readable: the repo-relative path, not the absolute one.
    const cut = where.lastIndexOf('slither-clone');
    if (cut >= 0) where = where.slice(cut + 'slither-clone'.length + 1);
    where = where.replace(/^file:\/+/, '');
    rows.push({
      fn: f.functionName || '(anonymous)',
      at: where ? `${where}:${(f.lineNumber || 0) + 1}` : '(native)',
      selfMs: Math.round(n.hitCount * perSample),
      pct: totalHits ? +((n.hitCount / totalHits) * 100).toFixed(1) : 0,
    });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  return {
    stallMs: Math.round(stallMs),
    at: Date.now(),
    windowMs: WINDOW_MS,
    totalSampledMs: Math.round(totalHits * perSample),
    top: rows.slice(0, 20),
  };
}

function cycle() {
  if (!enabled || !session) return;
  session.post('Profiler.stop', (err, res) => {
    running = false;
    if (!err && res && res.profile && windowWorst >= STALL_MS) {
      // Keep the worst window seen, so a later quiet stall can't overwrite the
      // evidence from a bad one.
      if (!kept || windowWorst > kept.stallMs) {
        try { kept = summarise(res.profile, windowWorst); } catch (_) {}
      }
    }
    windowWorst = 0;
    begin();
  });
}

function begin() {
  if (!enabled || !session || running) return;
  session.post('Profiler.start', (err) => {
    if (err) return;
    running = true;
    setTimeout(cycle, WINDOW_MS).unref?.();
  });
}

function start() {
  if (enabled) return;
  try {
    session = new inspector.Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
    enabled = true;
    begin();
    console.log(`[PROFILER] on — ${WINDOW_MS / 1000}s windows at ${SAMPLE_US / 1000}ms, keeping any window with a stall >= ${STALL_MS}ms`);
  } catch (e) {
    console.error('[PROFILER] could not start:', e.message);
    enabled = false;
  }
}

function report() {
  return {
    enabled,
    stallThresholdMs: STALL_MS,
    currentWindowWorstMs: Math.round(windowWorst),
    worstWindow: kept,   // null until a stall has actually been caught
  };
}

module.exports = { start, noteStall, report };
