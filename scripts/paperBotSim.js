'use strict';
// Headless Paper bot behaviour sim (Owen 2026-10-28: "a lot of them just spin in circles"). One free arena, one
// scripted human (Owen's setup: 1 person + bots) and the bots, stepped on the server's fixed tick with no sockets.
// Prints, over all bots: the share of bot time spent spinning (a full turn of heading inside SPIN_WINDOW_S with the
// square ending near where it started), territory gained per bot-minute, captures per bot-minute, mean captured
// area, loop sizes, and deaths by reason. Usage: node scripts/paperBotSim.js [minutes=10] [seed=1] [--paid]
//   PAPER_SIM_SEEDS=1,2,3 runs several seeds and sums them; PAPER_SIM_JSON=1 prints JSON only.
const { PaperRoom } = require('../server/paper/PaperRoom');
const { REASON, P, MP } = require('../server/paper/ArenaGame');

const SPIN_WINDOW_S = 2;
const SPIN_RADIUS = 45;
const TAU = Math.PI * 2;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REASON_NAME = {};
for (const k of Object.keys(REASON)) REASON_NAME[REASON[k]] = k;

function runOne(minutes, seed, opts) {
  const realRandom = Math.random;
  const rnd = mulberry32(seed);
  Math.random = mulberry32(seed ^ 0x9e3779b9);
  let now = 1e12;
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  try {
    const room = new PaperRoom({ stake: 0, hooks, autoTick: false, seed: rnd(), now: () => now, clock: () => now });
    const g = room.game;
    const C = g.border.center;
    const per = new Map(); // bot -> stats
    const deaths = {};
    let humanDeaths = 0;
    const od = room.onDeath.bind(room);
    room.onDeath = (victim, killer, reason, at) => {
      if (victim.isHuman) humanDeaths++;
      else {
        const k = REASON_NAME[reason] || String(reason);
        const st = per.get(victim);
        const own = killer === victim || reason === REASON.SELF_CROSS;
        deaths[k + (own ? '' : killer && killer.isHuman ? '_byHuman' : killer ? '_byBot' : '')] =
          (deaths[k + (own ? '' : killer && killer.isHuman ? '_byHuman' : killer ? '_byBot' : '')] || 0) + 1;
        if (st) st.dead = true;
      }
      return od(victim, killer, reason, at);
    };

    // the human: Owen's way of playing, short loops out of home and back, a few lengths
    const sock = { id: 'sim-h1', join() {}, leave() {}, emit() {} };
    let seat = null;
    let h = null;
    function join() {
      const spot = room.findSpawn();
      if (!spot) return;
      seat = room.addHuman(sock, { name: 'Owen', micro: 0, wallet: null, spot });
      h = { u: seat.unit, state: 'home', heading: 0, until: 0, maxLen: 0, seq: 0, turn: 0 };
    }
    function homeAngle(u) {
      let best = null;
      let bestD = Infinity;
      for (const s of u.base.polygon.segments) {
        const d = s.start.distanceSq(u.position);
        if (d < bestD) { bestD = d; best = s.start; }
      }
      return Math.atan2(best.y - u.position.y, best.x - u.position.x);
    }
    function steer() {
      const u = h.u;
      const home = u.in === u.base;
      if (h.state === 'home') {
        if (!home) return homeAngle(u);
        h.state = 'out';
        h.heading = Math.atan2(u.position.y - C.y, u.position.x - C.x) + (rnd() - 0.5) * 2.5;
        h.until = g.tick + 90 + Math.floor(rnd() * 180);
        h.maxLen = 300 + rnd() * 900;
        h.turn = (rnd() < 0.5 ? 1 : -1) * (0.012 + rnd() * 0.02);
      }
      if (g.tick >= h.until || u.track.length > h.maxLen) {
        h.state = 'home';
        return homeAngle(u);
      }
      h.heading += h.turn;
      return h.heading;
    }

    // warm the arena up the way the boot does (bots out claiming before anyone comes)
    for (let i = 0; i < 600; i++) {
      now += MP.STEP_MS;
      room.tickOnce();
    }
    join();

    const ticks = Math.round((minutes * 60 * 1000) / MP.STEP_MS);
    const winTicks = Math.round((SPIN_WINDOW_S * 1000) / MP.STEP_MS);
    let botTicks = 0;
    let spinTicks = 0;
    let gained = 0;
    let captures = 0;
    const loopAreas = [];
    const loopLens = [];
    let tightTicks = 0;
    for (let t = 0; t < ticks; t++) {
      if (h && h.u.death) {
        seat = null;
        h = null;
      }
      if (!h && t % 180 === 0) join();
      if (h) {
        h.seq = (h.seq + 1) & 255;
        room.setInput(sock.id, MP.encodeInput(h.seq, MP.angleToByte(steer()), false));
      }
      now += MP.STEP_MS;
      room.tickOnce();
      for (const u of g.units) {
        if (u.isHuman || u.death) continue;
        let st = per.get(u);
        if (!st) {
          st = { dirs: [], pos: [], spinning: 0, sq: u.base.square, lastTrack: 0, maxTrack: 0, spinNow: false };
          per.set(u, st);
        }
        botTicks++;
        st.dirs.push(u.direction);
        st.pos.push(u.position.x, u.position.y);
        if (st.dirs.length > winTicks) {
          st.dirs.shift();
          st.pos.splice(0, 2);
        }
        // spinning: a full turn of heading (either way) inside the window while staying inside a small disc
        let spin = false;
        if (st.dirs.length === winTicks) {
          const turned = Math.abs(st.dirs[st.dirs.length - 1] - st.dirs[0]);
          if (turned >= TAU) {
            let cx = 0;
            let cy = 0;
            const n = st.pos.length / 2;
            for (let i = 0; i < st.pos.length; i += 2) { cx += st.pos[i]; cy += st.pos[i + 1]; }
            cx /= n;
            cy /= n;
            let far = 0;
            for (let i = 0; i < st.pos.length; i += 2) far = Math.max(far, Math.hypot(st.pos[i] - cx, st.pos[i + 1] - cy));
            spin = far < SPIN_RADIUS;
          }
        }
        if (spin) spinTicks++;
        // a tight turn: the heading changing at more than half the full turn rate this tick
        if (st.dirs.length >= 2 && Math.abs(st.dirs[st.dirs.length - 1] - st.dirs[st.dirs.length - 2]) > (Math.PI * MP.STEP_MS) / 1000) tightTicks++;
        const sq = u.base.square;
        if (sq > st.sq + 1) {
          gained += sq - st.sq;
          captures++;
          loopAreas.push(sq - st.sq);
          loopLens.push(st.maxTrack);
          st.maxTrack = 0;
        }
        st.sq = sq;
        if (u.track && u.track.length > st.maxTrack) st.maxTrack = u.track.length;
        if (opts.trace && spin && !st.spinNow) {
          console.log('[spin] t=' + t + ' ' + u.name + ' state=' + (u.fsm && u.fsm.state) + ' in=' + (u.in === u.base ? 'home' : 'out') +
            ' pos=' + u.position.x.toFixed(0) + ',' + u.position.y.toFixed(0) + ' target=' +
            (u.target ? u.target.x.toFixed(0) + ',' + u.target.y.toFixed(0) : '-') +
            ' d2target=' + (u.target ? u.position.distance(u.target).toFixed(1) : '-') + ' track=' + (u.track ? u.track.length.toFixed(0) : 0) +
            ' wallGap=' + (g.border.radius - u.position.distance(C)).toFixed(0) + ' R=' + g.border.radius.toFixed(0) + ' aspect=' + u.aspect);
        }
        st.spinNow = spin;
      }
    }
    const botMin = (botTicks * MP.STEP_MS) / 60000;
    const sorted = (a) => a.slice().sort((x, y) => x - y);
    const med = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : 0);
    return {
      seed,
      minutes,
      botMinutes: botMin,
      spinShare: spinTicks / Math.max(1, botTicks),
      tightTurnShare: tightTicks / Math.max(1, botTicks),
      gainedPerBotMin: gained / Math.max(1e-9, botMin),
      capturesPerBotMin: captures / Math.max(1e-9, botMin),
      meanCapture: captures ? gained / captures : 0,
      medianCapture: med(loopAreas),
      medianLoopLen: med(loopLens),
      deaths,
      ownDeathsPerBotHour: Object.keys(deaths).filter((k) => !/_by/.test(k)).reduce((s, k) => s + deaths[k], 0) / Math.max(1e-9, botMin / 60),
      humanDeaths,
      radius: g.border.radius
    };
  } finally {
    Math.random = realRandom;
  }
}

if (require.main === module) {
  const minutes = Number(process.argv[2]) || 10;
  const seeds = process.env.PAPER_SIM_SEEDS ? process.env.PAPER_SIM_SEEDS.split(',').map(Number) : [Number(process.argv[3]) || 1];
  const trace = process.argv.includes('--trace');
  const rows = seeds.map((s) => runOne(minutes, s, { trace }));
  if (process.env.PAPER_SIM_JSON) console.log(JSON.stringify(rows));
  else for (const r of rows) console.log(JSON.stringify(r, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
}

module.exports = { runOne };
