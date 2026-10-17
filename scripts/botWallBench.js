'use strict';
// Headless bots-only bench (Owen 2026-10-17: "the bots keep killing themselves on the walls"): wall and own-trail
// deaths per bot-minute in a paid slither room and a paid Paper.io arena, nobody seated. Test rigs only, no server.
//   node scripts/botWallBench.js [minutes]
const path = require('path');
const fs = require('fs');
const os = require('os');
const MIN = Number(process.argv[2]) || 3;
const quiet = { log() {}, warn() {}, error() {} };

function bank() {
  const { createBotBank } = require('../server/botBank');
  const b = createBotBank({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bench-')), 'b.json'), log: quiet });
  b.credit(1000e6, 'BENCH' + Math.random());
  b.setCap(1000e6);
  return b;
}

function slither() {
  const { paidRig } = require('../test/slPaidFakes');
  const { createBotDriver } = require('../server/sl/slBots');
  let r = null;
  r = paidRig({ rig: { laws: require('../server/sl/slLaws').LAWS }, arenas: { botDriver: () => createBotDriver(r.laws, {}), botStore: { load: () => null, save: () => true },
    botBank: bank() } });
  r.paid.setBotTarget(1, 12);
  const room = r.paid.rooms()[0];
  const steps = Math.round(MIN * 60000 / r.P);
  let botMs = 0;
  const causes = {};
  for (let i = 0; i < steps; i++) {
    r.step(1);
    botMs += (Number(room.botCount) || 0) * r.P;
    const log = room.sim.lastLog();
    for (const d of (log && log.deaths) || []) causes[d.cause] = (causes[d.cause] || 0) + 1;
    if (room.botCount < 6) r.paid.setBotTarget(1, 12); // keep a crowd (Control would)
  }
  return { game: 'slither $1', botMinutes: +(botMs / 60000).toFixed(1), causes };
}

function paper() {
  const { PaperArenas } = require('../server/paper/PaperArenas');
  if (process.env.BEFORE === '1') require('../server/paper/ArenaGame').ArenaGame.prototype._steerFromWall = () => {};
  const { REASON } = require('../server/paper/ArenaGame');
  const names = Object.fromEntries(Object.entries(REASON).map(([k, v]) => [v, k]));
  const a = new PaperArenas({ io: { to: () => ({ emit() {}, volatile: { emit() {} } }) },
    hooks: { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {}, onOwed: () => null },
    paidEnabled: true, autoTick: false, warm: false, botStore: { load: () => null, save: () => true }, botBank: bank() });
  a.setBotTarget(1, 6);
  const room = a.arenas[Object.keys(a.arenas).find((k) => a.arenas[k].some((x) => x.stake === 1))][0];
  const causes = {};
  const orig = room.onDeath.bind(room);
  room.onDeath = (v, k, reason, at) => {
    if (!v.isHuman) causes[names[reason] || reason] = (causes[names[reason] || reason] || 0) + 1;
    return orig(v, k, reason, at);
  };
  const STEP = 1000 / 60;
  const steps = Math.round(MIN * 60000 / STEP);
  let botMs = 0;
  for (let i = 0; i < steps; i++) {
    room.game.update(STEP);
    botMs += room.botCount * STEP;
    if (room.botCount < 3 && i % 60 === 0) a.setBotTarget(1, 6);
  }
  return { game: 'paper $1', botMinutes: +(botMs / 60000).toFixed(1), causes };
}

for (const f of (process.env.ONLY === 'paper' ? [paper] : process.env.ONLY === 'sl' ? [slither] : [slither, paper])) {
  const r = f();
  const per = {};
  for (const [k, v] of Object.entries(r.causes)) per[k] = +(v / Math.max(r.botMinutes, 0.001)).toFixed(3);
  console.log(JSON.stringify({ game: r.game, botMinutes: r.botMinutes, deaths: r.causes, perBotMinute: per }));
}
