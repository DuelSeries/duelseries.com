'use strict';
/* Swim Race, a race full of test clients over the real sockets.
   Each test client is a socket.io connection that joins the event like a page does (se:join), then drives its
   car with the duel's bot driver ON THIS SIDE (server/swim/SwimEvent.js BotSeat, the same four-lane window) and
   sends its wheel and pedal (se:in) every other tick, predicting its car with the shared step and taking the
   server's copy (se:me) when they differ. So the server sees N people, not N bots: input handling, N timelines,
   N se:me streams, the se:s fan-out to N sockets.
     node scripts/swimEventLoad.js --url http://localhost:4473 --n 49 [--secs 120]
   Needs a local server whose race starts on its own (SWIM_EVENT_EVERY_SEC) and lets many seats in from one address
   (SWIM_EVENT_PER_IP). Prints a line every 5 s: cars left, kB/s and messages/s per client, corrections. */
const { io } = require('socket.io-client');
const S = require('../shared/swimSim');
const { BotSeat } = require('../server/swim/SwimEvent');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL = arg('url', 'http://localhost:4473'), N = Number(arg('n', 7)), SECS = Number(arg('secs', 600)), FIRST = Number(arg('first', 0));
const R = 1024;

const stats = { bytes: 0, msgs: 0, corr: 0, ko: 0, over: null };
const clients = [];
let race = null;   // shared view: { id, goAt, lanes, traffic }

function client(i) {
  const sock = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { i, sock, seat: null, car: null, seat4: null, inputs: new Int16Array(R), hist: new Array(R), sentTo: -1, out: false };
  sock.onAny((ev, p) => { stats.msgs++; try { stats.bytes += JSON.stringify(p).length; } catch (_) {} });
  sock.on('connect', () => sock.emit('se:join', { name: 'load' + (FIRST + i), car: ['supercar', 'muscle', 'hatch'][i % 3], v: S.VERSION }));
  sock.on('se:refused', (m) => {
    /* The door opens a moment after boot (and a race in progress refuses until it is over): ask again. */
    if (m && (m.closed || m.started)) { setTimeout(() => sock.emit('se:join', { name: 'load' + (FIRST + i), car: 'supercar', v: S.VERSION }), 2000); return; }
    console.log('client ' + i + ' refused: ' + (m && m.why));
  });
  sock.on('se:start', (m) => {
    if (i === 0 || !race || race.id !== m.id) {
      const traffic = new S.Traffic(m.lanes);
      for (const rec of m.cars || []) traffic.add(rec);
      race = { id: m.id, goAt: m.goAt, lanes: m.lanes, traffic, cars: m.cars.length };
      console.log('race ' + m.id + ': ' + m.lanes + ' lanes, ' + (m.seats || []).length + ' cars, ' + m.cars.length + ' traffic records at the start');
    }
  });
  sock.on('se:you', (m) => {
    c.seat = m.seat;
    c.car = S.newCar(0); c.car.x = S.laneX(m.seat); S.quantize(c.car);
    c.seat4 = new BotSeat(m.seat, 1000 + i);
    for (const rec of race.traffic.all()) c.seat4.see(rec);
  });
  sock.on('se:cars', (m) => {
    if (i === 0 && race) for (const rec of m.add) race.traffic.add(rec);
    if (c.seat4) for (const rec of m.add) c.seat4.see(rec);
  });
  /* Our own row in se:s, as the page takes it (public/js/swim/swimEventMain.js reconcile). */
  sock.on('se:s', (m) => {
    if (!c.car || c.out || !m || !Array.isArray(m.p)) return;
    const a = m.p.find(q => q[0] === c.seat);
    if (!a) return;
    const t = a[1], h = c.hist[t % R];
    if (!h || h.tick !== t) return;
    if (h.alive === !!a[6] && h.cool === a[8] && h.z === a[2] && h.x === a[3] && h.v === a[4] && h.vx === a[5]) return;
    stats.corr++;
    const car = { tick: t, z: a[2], x: a[3], v: a[4], vx: a[5], alive: !!a[6], crashTick: -1, hit: -1, wall: a[7], cool: a[8], close: -1 };
    for (let k = t; k < c.car.tick; k++) S.quantize(S.step(car, c.inputs[k % R], race.traffic));
    c.car = car;
  });
  sock.on('se:ko', (k) => { if (k.seat === c.seat) { c.out = true; } if (i === 0) stats.ko++; });
  sock.on('se:over', (m) => { if (i === 0) { stats.over = m; console.log('over: ' + m.why + ', winner ' + (m.winner ? m.winner.name : '-') + ' at tick ' + m.tick); } });
  return c;
}

for (let i = 0; i < N; i++) clients.push(client(i));

/* One loop for every client: step to the server's tick, send every other tick. */
setInterval(() => {
  if (!race) return;
  const target = Math.floor((Date.now() - race.goAt) / S.TICK_MS) + 1;
  if (target < 1) return;
  for (const c of clients) {
    if (!c.car || c.out || !c.car.alive) continue;
    while (c.car.tick < target) {
      const code = c.seat4.input(c.car, c.car.tick, null);
      c.inputs[c.car.tick % R] = code;
      S.quantize(S.step(c.car, code, race.traffic));
      c.hist[c.car.tick % R] = S.copyCar(c.car);
    }
    const last = c.car.tick - 1;
    if (last - c.sentTo >= 2) {
      const from = Math.max(0, last - 11, Math.min(c.sentTo + 1, last - 5));
      const k = [];
      for (let t = from; t <= last; t++) k.push(c.inputs[t % R]);
      c.sock.volatile.emit('se:in', { t: last, k });
      c.sentTo = last;
    }
  }
}, 8);

const t0 = Date.now();
let lastB = 0, lastM = 0;
setInterval(() => {
  const left = clients.filter(c => c.car && !c.out && c.car.alive).length;
  const db = stats.bytes - lastB, dm = stats.msgs - lastM; lastB = stats.bytes; lastM = stats.msgs;
  console.log(`[load] ${Math.round((Date.now() - t0) / 1000)} s: ${left}/${N} test cars going, per client ${(db / 5 / N / 1024).toFixed(1)} kB/s ` +
    `${(dm / 5 / N).toFixed(0)} msgs/s, corrections ${stats.corr}, knockouts ${stats.ko}`);
  if ((Date.now() - t0) / 1000 > SECS || stats.over) { if (stats.over) setTimeout(() => process.exit(0), 1500); }
  if ((Date.now() - t0) / 1000 > SECS + 5) process.exit(0);
}, 5000);
