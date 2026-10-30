'use strict';
/* Swim capacity client (scripts/capacity, the live 150-player test 2026-10-29).

   One simulated player doing what /swim (public/js/swim/swimMain.js) does on the main socket.io namespace, FREE only:
     connect -> 5 x sw:ping 120 ms apart (pingBurst) -> sw:queue { name, v, car }        (at opts.queueAt if set)
     <- sw:queued (resumeKey; busy: true while the free tables are full) ... <- sw:start (seats, traffic so far)
     <- sw:seat (rejoin key) <- sw:go, then <- sw:s 20/s (volatile, both cars) and <- sw:cars 4/s (new traffic)
     -> sw:in { t, k } every other tick (about 30/s, volatile) and sw:ping every 2 s, as the page's frame loop does
     <- sw:over -> ~3 s on the result card -> sw:leave + sw:queue again (Play again)
   The page also sends stake: 0, wallet: null (a guest) and entryToken: null; those are left out here (the server's free
   path is the same without them). Never a stake, token, wallet, chat or HTTP call.

   The car is predicted locally with the real step (shared/swimSim.js) on the traffic the server sent, and corrected
   from the server's own row for it in sw:s, exactly as the page does; so the inputs land on the server's ticks and
   every update is really decoded. The driver below stands in for a person at the keys. */

const S = require('../../../shared/swimSim');
const { openSocket, countBytes, pingLoop } = require('../lib');

const R = 1024;                    // ticks of input and state kept for replay (the page's R)
const FRAME_MS = 16;               // the page's requestAnimationFrame
const SW_PING_MS = 2000;           // the page's sw:ping while a race is on
const AGAIN_MS = 3000;             // the result card, then Play again
const REFUSED_MS = 5000;
const RECONNECT_MS = 2000;
const CARS = ['supercar', 'muscle', 'hatch'];   // shared/swimLooks.js, all free, looks only
const HL = S.CAR.HL;

const now = () => performance.now();

function nearestLane(x) {
  let best = 0, bd = Infinity;
  for (let l = 0; l < S.LANES; l++) { const d = Math.abs(x - S.laneX(l)); if (d < bd) { bd = d; best = l; } }
  return best;
}

/* A PERSON AT THE KEYS. Every `react` ticks (133 to 200 ms) it looks down each lane at the first car, reads the time
   until it would reach it (with an error that grows as the road gets faster), and keeps to or moves for the lane with
   the most time that it can get across to. Gas held all the way; the brake only when boxed in. Now and then it looks
   away for a moment. Tuned offline on the real step and traffic (80 races each): two of these race a median 45 s
   (p10 21 s, p90 85 s), against the free-table bot a median 48 s; races end mostly in a crash, some by 200 m. */
const LAPSE = 0.01, LAPSE_MIN = 20, LAPSE_SPREAD = 40;   // looks away on 1% of looks, for 20 to 60 ticks
class Driver {
  constructor(rand) {
    this.rand = rand;
    this.react = 8 + Math.floor(rand() * 5);
    this.err = 0.05 + 0.07 * rand();
    this.lapse = LAPSE;
    this.reset();
  }
  reset() { this.nextLook = 0; this.lane = -1; this.pedal = 1; this.offset = 0; }

  /* Seconds until the car reaches the first car in `lane` (99: nothing close), or -1: something alongside, or
     coming up from behind fast enough to hit it. */
  timeIn(traffic, lane, car, tick, noise) {
    let best = 99;
    for (let k = lane - 1; k <= lane + 1; k++) {
      if (k < 0 || k >= S.LANES) continue;
      const list = traffic.lanes[k];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!S.occupies(r, lane, tick)) continue;
        const hl = S.TYPES[r[2]].hl, rv = S.LANE_V[r[1]], c = S.zAt(r, tick);
        if (c + hl < car.z - HL - 1.5) {
          const gain = rv - car.v;
          if (gain > 0.5 && (car.z - HL - c - hl) / gain < 1.3) return -1;
          continue;
        }
        if (c - hl < car.z + HL + 1.5) return -1;
        const close = car.v - rv;
        if (close > 0.5) { const t = (c - hl - car.z - HL) / close; if (t < best) best = t; }
        break;
      }
    }
    return best >= 99 ? 99 : best * (1 + noise * (this.rand() * 2 - 1));
  }

  look(car, traffic, tick) {
    const secs = tick * S.DT, late = secs / (secs + 150);
    const noise = this.err * (1 + 2 * late);
    const here = nearestLane(car.x);
    if (this.lane < 0) this.lane = here;
    const tt = [];
    for (let l = 0; l < S.LANES; l++) tt.push(this.timeIn(traffic, l, car, tick, noise));
    const side = Math.max(1, S.vxMax(car.v));
    const canReach = (l) => {
      const dir = l > here ? 1 : -1;
      for (let k = here + dir; k !== l + dir; k += dir) {
        const cross = (Math.abs(S.laneX(k) - car.x) + (k === l ? 0 : S.LANE_W / 2)) / side + 0.2;
        if (tt[k] < 0 || tt[k] < cross + 0.45) return false;
      }
      return true;
    };
    let pick = here, best = -Infinity;
    for (let l = 0; l < S.LANES; l++) {
      if (l !== here && !canReach(l)) continue;
      const score = (tt[l] < 0 ? -1 : Math.min(tt[l], 6)) - 0.35 * Math.abs(l - here) + (l === this.lane ? 0.4 : 0);
      if (score > best) { best = score; pick = l; }
    }
    if (here === this.lane && tt[here] > 2.4 && this.rand() > 0.04) pick = here;
    if (pick !== this.lane) this.offset = (this.rand() * 2 - 1) * 0.25;
    this.lane = pick;
    const ahead = tt[pick] < 0 ? 0 : tt[pick];
    this.pedal = (tt[here] >= 0 && tt[here] < 0.75) || ahead < 1.1 ? -1 : 1;
  }

  /* The packed input (shared/swimSim.js packInput) for the car as it is now. */
  input(car, traffic, tick) {
    if (!car.alive) return S.NEUTRAL;
    if (tick >= this.nextLook) {
      this.look(car, traffic, tick);
      this.nextLook = tick + this.react + (this.rand() < this.lapse ? LAPSE_MIN + Math.floor(this.rand() * LAPSE_SPREAD) : 0);
    }
    const e = S.laneX(this.lane) + this.offset - car.x;
    const reach = S.vxMax(car.v);
    let steer = 0;
    if (reach > 0 && !(Math.abs(e) < 0.04 && Math.abs(car.vx) < 0.3)) {
      const want = Math.sign(e) * Math.min(reach, Math.sqrt(2 * 0.85 * S.vxAcc(car.v) * Math.abs(e)));
      steer = Math.max(-1, Math.min(1, (want - car.vx * 0.25) / reach));
    }
    return S.packInput(steer, this.pedal);
  }
}

function rowCar(row) {
  return { tick: row[1], z: row[2], x: row[3], v: row[4], vx: row[5], alive: !!row[6],
           crashTick: row[6] ? -1 : row[1], hit: -1, wall: row[7] || 0, cool: row[8] || 0, close: -1 };
}

function start(ctx) {
  const { base, ip, name, stats } = ctx;
  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random;
  const opts = ctx.opts || {};
  const car = CARS[Math.floor(rand() * CARS.length)];
  const driver = new Driver(rand);

  let stopped = false;
  let socket = null;
  let stopPing = null;
  /* idle: should queue as soon as connected; wait: a timer will queue (first press, Play again, retry);
     queued: in the queue; race: seated. */
  let phase = 'wait';
  let resumeKey = null, seatKey = null;
  let race = null;
  let lastSwPing = 0;
  const timers = new Set();
  const clock = { off: null, want: null, samples: [], rtt: 0 };

  const later = (fn, ms) => {
    const h = setTimeout(() => { timers.delete(h); if (!stopped) fn(); }, Math.max(0, ms));
    timers.add(h);
    return h;
  };
  const live = () => !!socket && socket.connected;
  const serverNow = () => now() + (clock.off === null ? 0 : clock.off);
  const tickNow = () => (race ? (serverNow() - race.goAt) / S.TICK_MS : 0);

  function swPing() { if (live()) socket.emit('sw:ping', { c: now() }); }
  function pingBurst() { for (let i = 0; i < 5; i++) later(swPing, i * 120); }
  function slewClock() {
    if (clock.want === null || clock.off === null) return;
    const d = clock.want - clock.off;
    clock.off += Math.abs(d) > 250 ? d : Math.max(-0.5, Math.min(0.5, d));
  }

  /* sw:queue, as the page's queue() sends it for a free guest seat. */
  function queueNow(resume) {
    if (stopped) return;
    if (!live()) { phase = 'idle'; return; }
    const msg = { name, v: S.VERSION, car };
    if (resume) msg.resume = resume;
    phase = 'queued';
    socket.emit('sw:queue', msg);
    stats.note(resume ? 'resumed' : 'queued');
  }
  function retry(ms) { phase = 'wait'; resumeKey = null; later(() => queueNow(), ms); }

  /* ── the race (the page's newRace / takeRow / reconcile / drive) ───────── */
  function newRace(m, side) {
    const traffic = new S.Traffic();
    for (const rec of m.cars || []) traffic.add(rec);
    const r = { id: m.id, side, vsBot: !!m.vsBot, goAt: Number(m.goAt) || 0, state: 'countdown', traffic,
                me: S.newCar(side), inputs: new Int16Array(R), hist: new Array(R).fill(null), sentTo: -1,
                rows: [null, null], overShown: false };
    r.hist[0] = S.copyCar(r.me);
    for (const row of m.p || []) takeRow(r, row);
    if (clock.off === null && Number.isFinite(m.now)) clock.off = m.now - now();
    driver.reset();
    return r;
  }
  function takeRow(r, row) {
    if (!Array.isArray(row) || row.length < 8) return;
    const side = row[0];
    if (side !== 0 && side !== 1) return;
    const prev = r.rows[side];
    if (prev && prev[1] > row[1]) return;
    r.rows[side] = row;
    if (side === r.side) reconcile(r, row);
  }
  function reconcile(r, row) {
    const me = r.me;
    if (!me) return;
    const t = row[1];
    if (t > me.tick) { r.me = rowCar(row); r.hist[t % R] = S.copyCar(r.me); return; }
    const h = r.hist[t % R];
    if (!h || h.tick !== t) return;
    if (h.alive === !!row[6] && h.z === row[2] && h.x === row[3] && h.v === row[4] && h.vx === row[5]
        && h.cool === (row[8] || 0)) return;
    const c = rowCar(row);
    r.hist[t % R] = S.copyCar(c);
    for (let k = t; k < me.tick; k++) {
      S.step(c, r.inputs[k % R], r.traffic);
      r.hist[(k + 1) % R] = S.copyCar(c);
    }
    r.me = c;
  }
  function drive(r) {
    const target = Math.floor(tickNow()) + 1;
    if (target - r.me.tick > 30) { if (r.rows[r.side]) r.me = rowCar(r.rows[r.side]); return; }
    const offline = !live();     // the server drives a dropped seat straight with no pedal; so does the page
    const code = offline ? S.NEUTRAL : driver.input(r.me, r.traffic, r.me.tick);
    while (r.me.tick < target) {
      const c = r.me;
      r.inputs[c.tick % R] = code;
      S.step(c, code, r.traffic);
      r.hist[c.tick % R] = S.copyCar(c, r.hist[c.tick % R] || undefined);
    }
    const last = r.me.tick - 1;
    if (!offline && r.me.alive && last >= 0 && last - r.sentTo >= 2) {
      const from = Math.max(0, last - 11, Math.min(r.sentTo + 1, last - 5));
      const k = [];
      for (let t = from; t <= last; t++) k.push(r.inputs[t % R]);
      socket.volatile.emit('sw:in', { t: last, k });
      r.sentTo = last;
    }
  }
  function frame() {
    const r = race;
    if (stopped || !r || r.state === 'over') return;
    slewClock();
    const t = now();
    if (t - lastSwPing >= SW_PING_MS) { lastSwPing = t; swPing(); }
    const tickF = tickNow();
    if (r.state === 'countdown' && tickF >= 0) r.state = 'racing';
    if (r.state === 'racing') drive(r);
    const other = r.rows[1 - r.side];
    r.traffic.prune(Math.min(r.me.z, other ? other[2] : r.me.z) - 120, Math.floor(tickF));
  }
  const frameTimer = setInterval(frame, FRAME_MS);

  /* The race is over for this seat (sw:over, or a rejoin that came back with the result or too late). */
  function ended(why) {
    if (!race || race.overShown) return;
    race.overShown = true;
    race.state = 'over';
    seatKey = null;
    stats.dead();
    stats.note('end:' + (why || '?'));
    phase = 'wait';
    later(() => {
      if (live()) socket.emit('sw:leave');
      race = null;
      queueNow();
    }, AGAIN_MS + Math.floor(rand() * 1000));
  }

  /* ── the socket ────────────────────────────────────────────────────────── */
  function connect() {
    if (stopped) return;
    const s = openSocket(base, '/', ip);
    socket = s;
    countBytes(s, stats);
    const on = (ev, fn) => s.on(ev, (...a) => {
      if (stopped || s !== socket) return;
      try { fn(...a); } catch (e) { stats.error('handler ' + ev + ': ' + (e && e.message)); }
    });
    const lost = () => {
      if (stopPing) { stopPing(); stopPing = null; }
      socket = null;
      try { s.removeAllListeners(); s.close(); } catch (_) {}
    };

    on('connect', () => {
      stats.connectedNow();
      stopPing = pingLoop(s, stats);
      pingBurst();
      if (phase === 'race' && race && race.state !== 'over') {
        /* Mid-race: the seat is held five seconds and its key takes it back (sw:rejoined). */
        if (seatKey) { s.emit('sw:rejoin', { key: seatKey, v: S.VERSION }); return; }
        ended('connection lost');
        return;
      }
      if (phase === 'queued') { queueNow(resumeKey); return; }
      if (phase === 'idle') queueNow();
    });
    on('connect_error', (err) => {
      const why = (err && err.message) || 'error';
      stats.connectError(why);
      lost();
      later(connect, /too many|limit/i.test(why) ? REFUSED_MS : RECONNECT_MS);
    });
    on('disconnect', (reason) => {
      stats.dropped(reason);
      lost();
      later(connect, RECONNECT_MS);
    });

    on('sw:pong', ({ c, s: sv } = {}) => {
      const r = now(), rtt = r - c;
      if (!(rtt >= 0) || rtt > 4000 || !Number.isFinite(sv)) return;
      stats.gamePing(Math.round(rtt));
      clock.samples.push({ rtt, off: sv - (c + r) / 2 });
      if (clock.samples.length > 12) clock.samples.shift();
      const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      clock.want = best.off; clock.rtt = best.rtt;
      if (clock.off === null) clock.off = best.off;
    });
    on('sw:queued', (q = {}) => {
      if (phase !== 'queued') return;
      if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
      if (q.busy) stats.note('held (tables full)');
    });
    on('sw:start', (m) => {
      if (!m) return;
      const me = (m.players || []).find(p => p.id === s.id);
      if (!me) return;
      if (race && race.state !== 'over') { stats.unseated(); stats.note('rescued from bot'); }
      stats.note(m.vsBot ? 'vsBot' : 'matched');
      race = newRace(m, me.side);
      phase = 'race';
      resumeKey = null; seatKey = null;
      pingBurst();
    });
    on('sw:seat', (m) => { if (m && typeof m.key === 'string') seatKey = m.key; });
    on('sw:go', () => { if (race && race.state !== 'over') stats.joined(); });
    on('sw:s', (m) => {
      if (!race || !m || !Array.isArray(m.p)) return;
      stats.snap();
      if (Number.isInteger(m.T) && race.goAt && clock.off !== null) {
        const ahead = serverNow() - (race.goAt + m.T * S.TICK_MS);
        if (ahead > (clock.rtt || 0) + 150 || ahead < -40) {
          clock.off -= ahead - (clock.rtt || 0) / 2; clock.want = clock.off; clock.samples = [];
        }
      }
      for (const row of m.p) takeRow(race, row);
    });
    on('sw:cars', (m) => {
      if (!race || !m || !Array.isArray(m.add)) return;
      for (const rec of m.add) race.traffic.add(rec);
    });
    on('sw:over', (m) => { ended((m && m.why) || '?'); });
    on('sw:rejoined', (m) => {
      if (!m || !race || race.state === 'over' || (m.side !== 0 && m.side !== 1)) return;
      race = newRace(m, m.side);
      race.state = m.state === 'racing' ? 'racing' : 'countdown';
      stats.joined();
      stats.note('rejoined');
      pingBurst();
    });
    on('sw:rejoinfail', (m) => {
      if (!race || race.state === 'over') return;
      stats.note('rejoin failed');
      ended(m && m.over && m.over.why ? m.over.why : 'connection lost');
    });
    on('sw:unqueued', ({ why } = {}) => {
      if (phase !== 'queued' || why !== 'the match could not start') return;
      stats.error('the match could not start');
      retry(REFUSED_MS);
    });
    on('sw:refused', ({ why } = {}) => {
      if (phase === 'race') return;
      stats.refused(why || 'refused');
      retry(REFUSED_MS);
    });
    on('maintenance', () => {
      if (phase === 'race') return;
      stats.refused('maintenance');
      retry(REFUSED_MS);
    });
  }

  /* The first press: at queueAt (every player of a --sync level presses at once), else as soon as connected. */
  const queueAt = Number(opts.queueAt) || 0;
  if (queueAt > Date.now()) later(() => queueNow(), queueAt - Date.now());
  else phase = 'idle';
  connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const h of timers) clearTimeout(h);
      timers.clear();
      clearInterval(frameTimer);
      if (stopPing) { stopPing(); stopPing = null; }
      const s = socket;
      socket = null;
      if (s) {
        /* The leave first, the close a moment later: socket.io dispatches an event on the next tick and drops it if
           the socket closed meanwhile, so a leave read in the same batch as the close is lost and the seat is held
           its five seconds (seen locally with 100 stopping at once). */
        const close = () => { try { s.disconnect(); } catch (_) {} };
        if (s.connected) {
          try { s.emit(phase === 'queued' ? 'sw:unqueue' : 'sw:leave'); } catch (_) {}
          setTimeout(close, 250);
        } else close();
      }
      stats.closed();
    },
  };
}

module.exports = { id: 'swim', start, Driver };
