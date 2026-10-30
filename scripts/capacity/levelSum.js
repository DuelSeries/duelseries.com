'use strict';
// One row per ramp level of a capacity run: the client windows (run.js --out) and the server samples (serverMon.js)
// over the last `--settle` seconds of each level (default 60), so a level's join burst is left out.
//   node levelSum.js <client.jsonl> <mon.jsonl> [--settle 60] [--room sl:sl_na_s0]

const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const cl = read(process.argv[2]);
const mon = read(process.argv[3]).filter((r) => r.type === 'sample' && r.os);
const SETTLE = Number(arg('settle', 60)) * 1000;
const ROOM = arg('room', null);

const avg = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : null);
const mx = (a) => (a.length ? Math.max(...a) : null);
const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const levels = cl.filter((r) => r.type === 'level');
const stop = cl.find((r) => r.type === 'stop');
const end = stop ? stop.at : cl[cl.length - 1].at;
const out = [];
levels.forEach((lv, i) => {
  const lvEnd = i + 1 < levels.length ? levels[i + 1].at : end;
  const from = Math.max(lv.at, lvEnd - SETTLE);
  const ws = cl.filter((r) => r.type === 'window' && r.at > from && r.at <= lvEnd);
  const ms = mon.filter((r) => r.at > from && r.at <= lvEnd);
  const row = { level: lv.level, secs: Math.round((lvEnd - from) / 1000), games: {} };
  const gameIds = new Set();
  ws.forEach((w) => Object.keys(w.games).forEach((g) => gameIds.add(g)));
  for (const g of gameIds) {
    const gw = ws.map((w) => w.games[g]).filter(Boolean);
    const dtSum = ws.reduce((p, w) => p + (w.dt || 5), 0);
    const seatedAvg = avg(gw.map((x) => x.seated));
    const first = gw[0];
    const last = gw[gw.length - 1];
    row.games[g] = {
      n: last.n, seated: r1(seatedAvg), ups: r1(avg(gw.map((x) => x.ups).filter((x) => x !== null))),
      upsP5: r1(pct(gw.map((x) => x.upsP5).filter((x) => x !== null), 0.5)), upsMin: r1(Math.min(...gw.map((x) => x.upsMin).filter((x) => x !== null))),
      gaps250PerMin: seatedAvg ? r1(gw.reduce((p, x) => p + x.gaps250, 0) / seatedAvg / (dtSum / 60)) : null,
      gaps1000: gw.reduce((p, x) => p + x.gaps1000, 0), maxGap: mx(gw.map((x) => x.maxGap)),
      pingP50: pct(gw.map((x) => x.pingP50).filter((x) => x !== null), 0.5), pingP95: mx(gw.map((x) => x.pingP95).filter((x) => x !== null)),
      pingMax: mx(gw.map((x) => x.pingMax).filter((x) => x !== null)),
      gpingP50: pct(gw.map((x) => x.gpingP50).filter((x) => x !== null), 0.5), gpingP95: mx(gw.map((x) => x.gpingP95).filter((x) => x !== null)),
      gpingMax: mx(gw.map((x) => x.gpingMax).filter((x) => x !== null)),
      pingTimeouts: gw.reduce((p, x) => p + x.pingTimeouts, 0),
      drops: last.drops - first.drops, connectErrors: last.connectErrors - first.connectErrors,
      joins: last.joins - first.joins, deaths: last.deaths - first.deaths,
      mbps: r1(avg(gw.map((x) => x.mbps))), kbpsPerSeated: r1(avg(gw.map((x) => x.kbpsPerSeated).filter((x) => x !== null))),
      refusals: last.refusals, errors: last.errors, notes: last.notes,
    };
  }
  const ip = ms.map((r) => r.inproc).filter(Boolean);
  row.server = {
    nodePct: r1(avg(ms.map((r) => r.os.nodePct))), nodePctMax: r1(mx(ms.map((r) => r.os.nodePct))), nginxPct: r1(avg(ms.map((r) => r.os.nginxPct))),
    steal: r1(avg(ms.map((r) => r.os.stealPct))), boxBusy: r1(100 - avg(ms.map((r) => r.os.idlePct))),
    elu: r1(avg(ip.map((x) => x.elu))), eluMax: r1(mx(ip.map((x) => x.elu))), loopP99: r1(pct(ip.map((x) => x.loopP99), 0.5)),
    loopP99Max: r1(mx(ip.map((x) => x.loopP99))), loopMax: r1(mx(ip.map((x) => x.loopMax))),
    gcMsPerSec: r1(ip.reduce((p, x) => p + x.gcMs, 0) / (row.secs || 1)), gcMax: mx(ip.map((x) => x.gcMax)),
    hzP95: r1(pct(ms.map((r) => r.probe.p95 || 0), 0.5)), hzMax: r1(mx(ms.map((r) => r.probe.max || 0))),
    memAvailMin: Math.min(...ms.map((r) => r.os.memAvailMB)), rssMax: mx(ms.map((r) => r.os.nodeRssMB)),
    txMBs: r1(avg(ms.map((r) => r.os.txMBs))), rxMBs: r1(avg(ms.map((r) => r.os.rxMBs))),
    rooms: {},
  };
  const byRoom = new Map();
  for (const x of ip) for (const rm of x.rooms) {
    const key = rm.kind + ':' + rm.id;
    if (ROOM && key !== ROOM && !String(key).startsWith(ROOM)) continue;
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(rm);
  }
  for (const [key, list] of byRoom) {
    const tl = list.filter((x) => x.tps !== undefined);
    const seats = mx(list.map((x) => x.seats || (x.maps && (x.maps.seats || x.maps.players || x.maps.rooms)) || 0));
    if (!seats && !avg(tl.map((x) => x.tps))) continue;
    row.server.rooms[key] = { seats, tps: r1(avg(tl.map((x) => x.tps))), tpsMin: r1(tl.length ? Math.min(...tl.map((x) => x.tps)) : null),
      stepMs: r1(avg(tl.map((x) => x.stepMs).filter((x) => x !== null && x !== undefined))), periodMs: tl[0] ? tl[0].periodMs : null,
      over20: tl.reduce((p, x) => p + (x.stepOver20 || 0), 0), over50: tl.reduce((p, x) => p + (x.stepOver50 || 0), 0),
      late20: tl.reduce((p, x) => p + (x.lateOver20 || 0), 0), late50: tl.reduce((p, x) => p + (x.lateOver50 || 0), 0),
      dropped: tl.reduce((p, x) => p + (x.dropped || 0), 0), maps: list[list.length - 1].maps };
  }
  out.push(row);
});
console.log(JSON.stringify(out, null, 1));
