'use strict';
// Tick timing for a room that runs its own fixed-step clock (the agar.io room today). It answers, on the live
// server, the questions smoothness work has to measure before and after every change: how late did each timer
// wake come (a late wake means something else held the shared event loop), how many steps did it run, how long
// did each step take, when did each step's bundles finish going out, and how much backlog did a long stall drop.
// GET /api/debug/tick reads it (server/debugTick.js).
//
// Recording allocates nothing: counts live in fixed arrays and the recent ticks in preallocated typed arrays
// (ring buffers), so the instrument cannot add the GC churn it is there to measure. Everything that needs a
// sort or an object (percentiles, the JSON rows) is built only when the endpoint is read.
//
// Times: the room's monotonic clock drives every duration. Absolute times (for lining ticks up against a client
// recording) are the monotonic time plus an offset to the wall clock, taken at the first wake and moved only when
// the two clocks drift apart by more than a millisecond, so consecutive absolute times keep sub-millisecond spacing.

// Bucket edges in ms, read as [0, e0), [e0, e1), ..., [eLast, infinity).
// Wake lateness: FIX-PLAN S1's own buckets (0-1, 1-2, 2-5, 5-10, 10-20, 20-50, 50+ ms).
const LATE_EDGES_MS = Object.freeze([1, 2, 5, 10, 20, 50]);
// CHOSEN (PARITY-LOG 2026-10-08, S1): step cost and wake-to-emit use the same edges, so the three read alike.
const COST_EDGES_MS = LATE_EDGES_MS;
// CHOSEN (PARITY-LOG 2026-10-08, S1): send-interval edges. 35-45 brackets the agar tick (law L1, 40.014 ms); 60-80,
// over 60 and over 100 are the bands of FIX-PLAN S5's acceptance bar (CR-2), so the server's own send gaps read
// directly against the client-side netprobe bands.
const SEND_EDGES_MS = Object.freeze([20, 35, 45, 60, 80, 100, 200]);
// CHOSEN (PARITY-LOG 2026-10-08, S1): the recent-tick ring holds 60 s of ticks, the length of one
// critic/netprobe.js run (its default --secs 60), so one read covers a whole probe run.
const RING_SECONDS = 60;
// A wake later than this is logged with its absolute time: the 20 ms GameRoom.tick already counts as a late tick
// (server/GameRoom.js, `over > 20`) and FIX-PLAN S5's "wake lateness over 20 ms".
const LATE_WAKE_MS = 20;
// The late-wake log keeps the last 600 (FIX-PLAN S1: recent stall logs get "a cap of about 600").
const LATE_LOG_CAP = 600;
// CHOSEN (PARITY-LOG 2026-10-08, S1): raw recent ticks per room in one read unless ?recent= asks for more (the
// percentiles always cover the whole ring); keeps a routine read small.
const DEFAULT_RECENT = 50;
// The bands reported from the ring's send intervals (FIX-PLAN S5 acceptance, CR-2), defined exactly as the client
// probe defines them (polish critic/theirs-ffa.js: band 60-80 is over 60 and at most 80, over 60, over 100).
const BAND_LO_MS = 60;
const BAND_HI_MS = 80;
const BAND_OVER_MS = 100;

const TIMING = Object.freeze({
  LATE_EDGES_MS, COST_EDGES_MS, SEND_EDGES_MS, RING_SECONDS, LATE_WAKE_MS, LATE_LOG_CAP, DEFAULT_RECENT,
});

function makeHist(edges) {
  return { edges, counts: new Float64Array(edges.length + 1), n: 0, sum: 0, max: 0 };
}

function addHist(h, v) {
  const x = v > 0 ? v : 0;
  let i = 0;
  while (i < h.edges.length && x >= h.edges[i]) i++;
  h.counts[i]++;
  h.n++;
  h.sum += x;
  if (x > h.max) h.max = x;
}

function r1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
function r3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

function histOut(h) {
  const buckets = {};
  let lo = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const label = i < h.edges.length ? lo + '-' + h.edges[i] : lo + '+';
    buckets[label] = h.counts[i];
    if (i < h.edges.length) lo = h.edges[i];
  }
  return { buckets, n: h.n, meanMs: h.n ? r3(h.sum / h.n) : null, maxMs: r3(h.max) };
}

// Linear-interpolation quantile on a sorted array (the same definition as the polish probes' stats.js).
function quantile(s, p) {
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function dist(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  let sum = 0;
  for (const v of s) sum += v;
  return { n: s.length, mean: r3(sum / s.length), p50: r3(quantile(s, 0.5)), p95: r3(quantile(s, 0.95)),
    p99: r3(quantile(s, 0.99)), max: r3(s[s.length - 1]) };
}

class TickTimer {
  // periodMs: one step's length; maxSteps: the most steps one wake may run (the steps-per-wake histogram's top);
  // clock: monotonic ms; now: wall ms (Date.now).
  constructor({ periodMs, maxSteps, clock, now = Date.now } = {}) {
    if (!(periodMs > 0)) throw new Error('tickTimer: periodMs must be above 0');
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('tickTimer: maxSteps must be a whole number');
    if (typeof clock !== 'function') throw new Error('tickTimer: clock must be a function');
    this.periodMs = periodMs;
    this.clock = clock;
    this.now = now;
    this.off = NaN;                     // wall minus monotonic, see the header
    this.wakes = 0;
    this.early = 0;                     // timer wakes that came before their due time (counted in the 0-1 bucket)
    this.worstLate = 0;
    this.worstLateAt = NaN;
    this.lateHist = makeHist(LATE_EDGES_MS);
    this.stepsPerWake = new Float64Array(maxSteps + 1);
    this.tickHist = makeHist(COST_EDGES_MS);
    this.emitHist = makeHist(COST_EDGES_MS);
    this.sendHist = makeHist(SEND_EDGES_MS);
    this.droppedBacklog = 0;            // wakes that dropped backlog (a stall longer than maxSteps steps)
    this.droppedSteps = 0;
    this.droppedMs = 0;
    this.steps = 0;
    // The wake in progress.
    this._wakeStart = NaN;
    this._wakeLate = NaN;
    this._lastSend = NaN;               // the last step's send end in this run (NaN after idle)
    this._wakeSendEnd = NaN;
    // Recent ticks (absolute ms): due, start, send end, end.
    const n = Math.max(1, Math.ceil((RING_SECONDS * 1000) / periodMs));
    this.ringSize = n;
    this.rDue = new Float64Array(n);
    this.rStart = new Float64Array(n);
    this.rSend = new Float64Array(n);
    this.rEnd = new Float64Array(n);
    this.rPos = 0;
    this.rLen = 0;
    // Recent wakes (absolute ms): start, lateness, steps run, wake-to-emit.
    this.wAt = new Float64Array(n);
    this.wLate = new Float64Array(n);
    this.wSteps = new Float64Array(n);
    this.wEmit = new Float64Array(n);
    this.wPos = 0;
    this.wLen = 0;
    // Late wakes (over LATE_WAKE_MS): absolute start, lateness, steps run.
    this.lAt = new Float64Array(LATE_LOG_CAP);
    this.lLate = new Float64Array(LATE_LOG_CAP);
    this.lSteps = new Float64Array(LATE_LOG_CAP);
    this.lPos = 0;
    this.lLen = 0;
  }

  _abs(mono) {
    return mono + this.off;
  }

  // Keeps the wall offset within a millisecond of the wall clock without moving it on every read.
  _anchor(mono) {
    const s = this.now() - mono;
    if (!(Math.abs(s - this.off) <= 1)) this.off = s;
  }

  // A wake starts at monotonic `mono`; `dueMono` is when its armed timer's step was due (NaN when the wake did not
  // come from an armed timer, for example a test calling wake() by hand: no lateness is recorded then).
  wakeBegin(mono, dueMono) {
    this._anchor(mono);
    this.wakes++;
    this._wakeStart = mono;
    this._wakeSendEnd = NaN;
    this._wakeLate = NaN;
    if (Number.isFinite(dueMono)) {
      const late = mono - dueMono;
      this._wakeLate = late;
      if (late < 0) this.early++;
      addHist(this.lateHist, late);
      if (late > this.worstLate) {
        this.worstLate = late;
        this.worstLateAt = this._abs(mono);
      }
    }
  }

  // A long stall dropped `steps` due steps (`ms` of room time) instead of running them.
  dropped(steps, ms) {
    this.droppedBacklog++;
    this.droppedSteps += steps;
    this.droppedMs += ms;
  }

  // One step that completed: when it was due (NaN outside a wake), when it started, when its last bundle went
  // out, when it ended (monotonic ms).
  step(dueMono, startMono, sendEndMono, endMono) {
    if (!Number.isFinite(this.off)) this._anchor(startMono);
    this.steps++;
    addHist(this.tickHist, endMono - startMono);
    const sendEnd = Number.isFinite(sendEndMono) ? sendEndMono : endMono;
    if (Number.isFinite(this._lastSend)) addHist(this.sendHist, sendEnd - this._lastSend);
    this._lastSend = sendEnd;
    this._wakeSendEnd = sendEnd;
    const i = this.rPos;
    this.rDue[i] = Number.isFinite(dueMono) ? this._abs(dueMono) : NaN;
    this.rStart[i] = this._abs(startMono);
    this.rSend[i] = this._abs(sendEnd);
    this.rEnd[i] = this._abs(endMono);
    this.rPos = (i + 1) % this.ringSize;
    if (this.rLen < this.ringSize) this.rLen++;
  }

  // The wake ends after running `ran` steps.
  wakeEnd(ran) {
    const top = this.stepsPerWake.length - 1;
    this.stepsPerWake[ran < top ? ran : top]++;
    const emit = ran > 0 && Number.isFinite(this._wakeSendEnd) ? this._wakeSendEnd - this._wakeStart : NaN;
    if (Number.isFinite(emit)) addHist(this.emitHist, emit);
    const i = this.wPos;
    this.wAt[i] = this._abs(this._wakeStart);
    this.wLate[i] = this._wakeLate;
    this.wSteps[i] = ran;
    this.wEmit[i] = emit;
    this.wPos = (i + 1) % this.ringSize;
    if (this.wLen < this.ringSize) this.wLen++;
    if (this._wakeLate > LATE_WAKE_MS) {
      const j = this.lPos;
      this.lAt[j] = this.wAt[i];
      this.lLate[j] = this._wakeLate;
      this.lSteps[j] = ran;
      this.lPos = (j + 1) % LATE_LOG_CAP;
      if (this.lLen < LATE_LOG_CAP) this.lLen++;
    }
  }

  // The room went to sleep (no seat): the next send after it wakes is not a gap.
  idle() {
    this._lastSend = NaN;
  }

  // Ring entries oldest first: calls fn(index) for each of the last `len` entries of a ring.
  static _each(pos, len, size, fn) {
    for (let k = 0; k < len; k++) fn((pos - len + k + size) % size);
  }

  // The JSON row. recent: how many raw recent ticks to include ('all' for the whole ring).
  report({ recent = DEFAULT_RECENT } = {}) {
    const ticks = { due: [], start: [], send: [], end: [] };
    TickTimer._each(this.rPos, this.rLen, this.ringSize, (i) => {
      ticks.due.push(this.rDue[i]);
      ticks.start.push(this.rStart[i]);
      ticks.send.push(this.rSend[i]);
      ticks.end.push(this.rEnd[i]);
    });
    const tickMs = [];
    const stepLate = [];
    const startGap = [];
    const sendGap = [];
    let band = 0;
    let over60 = 0;
    let over100 = 0;
    for (let k = 0; k < ticks.start.length; k++) {
      tickMs.push(ticks.end[k] - ticks.start[k]);
      if (Number.isFinite(ticks.due[k])) stepLate.push(ticks.start[k] - ticks.due[k]);
      if (k > 0) {
        startGap.push(ticks.start[k] - ticks.start[k - 1]);
        const g = ticks.send[k] - ticks.send[k - 1];
        sendGap.push(g);
        if (g > BAND_LO_MS) over60++;
        if (g > BAND_LO_MS && g <= BAND_HI_MS) band++;
        if (g > BAND_OVER_MS) over100++;
      }
    }
    const wakeLate = [];
    const wakeEmit = [];
    let wakesInRing = 0;
    let multi = 0;
    TickTimer._each(this.wPos, this.wLen, this.ringSize, (i) => {
      wakesInRing++;
      if (Number.isFinite(this.wLate[i])) wakeLate.push(this.wLate[i]);
      if (Number.isFinite(this.wEmit[i])) wakeEmit.push(this.wEmit[i]);
      if (this.wSteps[i] > 1) multi++;
    });
    const pct = (a, n) => (n ? r3((100 * a) / n) : null);
    const span = ticks.start.length > 1 ? ticks.start[ticks.start.length - 1] - ticks.start[0] : 0;
    const late = [];
    TickTimer._each(this.lPos, this.lLen, LATE_LOG_CAP, (i) => {
      late.push({ at: r1(this.lAt[i]), ms: r1(this.lLate[i]), steps: this.lSteps[i] });
    });
    const want = recent === 'all' ? ticks.start.length : Math.max(0, Math.min(ticks.start.length, Math.floor(+recent) || 0));
    const rows = [];
    for (let k = ticks.start.length - want; k < ticks.start.length; k++) {
      rows.push({ due: r1(ticks.due[k]), start: r1(ticks.start[k]), sendEnd: r1(ticks.send[k]), end: r1(ticks.end[k]) });
    }
    return {
      periodMs: this.periodMs,
      steps: this.steps,
      wakes: this.wakes,
      lateHist: histOut(this.lateHist),
      earlyWakes: this.early,
      worstLateMs: r3(this.worstLate),
      worstLateAt: r1(this.worstLateAt),
      stepsPerWake: Array.from(this.stepsPerWake),
      tickMsHist: histOut(this.tickHist),
      wakeToEmitHist: histOut(this.emitHist),
      sendIntervalHist: histOut(this.sendHist),
      droppedBacklog: this.droppedBacklog,
      droppedSteps: this.droppedSteps,
      droppedMs: r3(this.droppedMs),
      // The last RING_SECONDS of ticks and wakes, exact (not bucketed).
      window: {
        ticks: ticks.start.length,
        wakes: wakesInRing,
        secs: r3(span / 1000),
        from: r1(ticks.start[0]),
        to: r1(ticks.start[ticks.start.length - 1]),
        tickMs: dist(tickMs),
        tickInterval: dist(startGap),
        stepLateMs: dist(stepLate),
        sendInterval: Object.assign(dist(sendGap), {
          over60Pct: pct(over60, sendGap.length), band60to80Pct: pct(band, sendGap.length),
          over100Pct: pct(over100, sendGap.length),
        }),
        wakeLateMs: dist(wakeLate),
        wakeToEmitMs: dist(wakeEmit),
        multiStepWakePct: pct(multi, wakesInRing),
      },
      lateWakes: late,
      recent: rows,
    };
  }
}

module.exports = { TickTimer, TIMING, quantile, dist };
