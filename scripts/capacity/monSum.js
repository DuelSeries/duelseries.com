'use strict';
// Compact view of serverMon.js output: one row per bucket of seconds.
//   node monSum.js /tmp/lt/mon.jsonl --from <epoch ms> [--to <epoch ms>] [--every 10] [--json]
// Row: node CPU % of a core, nginx CPU %, steal, event-loop utilisation, loop delay p99/max, healthz p95/max, memory
// available, game RSS, tx MB/s, and per room with seats or ticks: ticks/s, mean step ms, steps over 20 ms, wakes over
// 20 ms late, dropped steps.

const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const file = process.argv[2];
const FROM = Number(arg('from', 0));
const TO = Number(arg('to', Infinity));
const EVERY = Number(arg('every', 10)) * 1000;
const JSON_OUT = arg('json', false) === true;

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter((r) => r && r.type === 'sample' && r.at >= FROM && r.at <= TO && r.os);

const buckets = new Map();
for (const r of rows) {
  const k = Math.floor((r.at - FROM) / EVERY);
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(r);
}
const avg = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : null);
const mx = (a) => (a.length ? Math.max(...a) : null);
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

const out = [];
for (const [k, rs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  const ip = rs.map((r) => r.inproc).filter(Boolean);
  const row = {
    t: Math.round((k * EVERY) / 1000), at: rs[0].at,
    nodePct: r1(avg(rs.map((r) => r.os.nodePct))), nodePctMax: r1(mx(rs.map((r) => r.os.nodePct))),
    nginxPct: r1(avg(rs.map((r) => r.os.nginxPct))), steal: r1(avg(rs.map((r) => r.os.stealPct))),
    boxIdle: r1(avg(rs.map((r) => r.os.idlePct))),
    elu: r1(avg(ip.map((x) => x.elu))), loopP99: r1(mx(ip.map((x) => x.loopP99))), loopMax: r1(mx(ip.map((x) => x.loopMax))),
    gcMs: Math.round(ip.reduce((p, x) => p + x.gcMs, 0)), gcMax: mx(ip.map((x) => x.gcMax)),
    hzP95: r1(mx(rs.map((r) => r.probe.p95 || 0))), hzMax: r1(mx(rs.map((r) => r.probe.max || 0))),
    memAvail: Math.min(...rs.map((r) => r.os.memAvailMB)), rss: mx(rs.map((r) => r.os.nodeRssMB)), heap: mx(ip.map((x) => x.heapMB)),
    txMBs: r1(avg(rs.map((r) => r.os.txMBs))), rxMBs: r1(avg(rs.map((r) => r.os.rxMBs))),
    rooms: {},
  };
  const byRoom = new Map();
  for (const x of ip) for (const rm of x.rooms) {
    const key = rm.kind + ':' + rm.id;
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(rm);
  }
  for (const [key, list] of byRoom) {
    const seats = mx(list.map((x) => x.seats || (x.maps && (x.maps.seats || x.maps.players || x.maps.bySocket)) || 0));
    const tps = avg(list.filter((x) => x.tps !== undefined).map((x) => x.tps));
    if (!seats && !tps) continue;
    row.rooms[key] = { seats, tps: r1(tps), stepMs: r1(avg(list.filter((x) => x.stepMs !== null && x.stepMs !== undefined).map((x) => x.stepMs))),
      over20: list.reduce((p, x) => p + (x.stepOver20 || 0), 0), late20: list.reduce((p, x) => p + (x.lateOver20 || 0), 0),
      late50: list.reduce((p, x) => p + (x.lateOver50 || 0), 0), dropped: list.reduce((p, x) => p + (x.dropped || 0), 0),
      maps: list[list.length - 1].maps };
  }
  out.push(row);
}
if (JSON_OUT) console.log(JSON.stringify(out));
else for (const r of out) {
  const rooms = Object.entries(r.rooms).map(([k, x]) => k.replace(/^(\w+):/, '$1 ') + ' s' + x.seats + (x.tps !== null ? ' ' + x.tps + 'tps ' + x.stepMs + 'ms o20:' + x.over20 + ' l20:' + x.late20 + ' d' + x.dropped : '')).join(' | ');
  console.log('+' + r.t + 's node ' + r.nodePct + '% (max ' + r.nodePctMax + ') ngx ' + r.nginxPct + '% steal ' + r.steal + ' idle ' + r.boxIdle +
    ' | elu ' + r.elu + '% loop p99 ' + r.loopP99 + ' max ' + r.loopMax + ' gc ' + r.gcMs + 'ms | hz p95 ' + r.hzP95 + ' max ' + r.hzMax +
    ' | mem ' + r.memAvail + 'MB rss ' + r.rss + ' heap ' + r.heap + ' | tx ' + r.txMBs + 'MB/s || ' + rooms);
}
