'use strict';
/* The page driver for headless checks of the Swim Race page (scripts/swimEventPerf.js, the look picker's shots):
   the duel's bot driver as a page script, steering the page's own car through its test hook (__swimraceDriver),
   and a frame-time recorder (window.__ft). */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
/* The duel's bot driver, loaded into the page as a script (it is CommonJS), driving the page's own car through
   __swimraceDriver on its carriageway's four lanes (as server/swim/SwimEvent.js BotSeat). */
function driverScript() {
  const bot = fs.readFileSync(path.join(ROOT, 'server/swim/swimBot.js'), 'utf8');
  return '(function(){var module={exports:{}};var require=function(){return window.SwimSim};' + bot + ';window.__SwimBotX=module.exports;})();' +
  `(function(){
    var S = window.SwimSim, bot = null, win = null, base = 0, seat = null, seen = new Set(), view = null;
    window.__swimraceDriver = function () {
      var r = window.__swimraceRace && window.__swimraceRace();
      if (!r || r.me === null || !r.car || r.out) return null;
      if (seat !== r.me || !win) { seat = r.me; base = r.me & ~3; win = new S.Traffic(4); bot = new window.__SwimBotX.SwimBot(S.rng(seat + 77)); seen = new Set(); view = S.newCar(0); }
      for (var l = base; l < base + 4 && l < r.traffic.lanes.length; l++) {
        var list = r.traffic.lanes[l];
        for (var i = 0; i < list.length; i++) {
          var rec = list[i]; if (seen.has(rec[0])) continue; seen.add(rec[0]);
          var x = rec.slice(); x[1] -= base; if (x.length === 8) x[7] -= base; win.add(x);
        }
      }
      win.prune(r.car.z - 150, r.car.tick);
      S.copyCar(r.car, view); view.x = r.car.x - base * S.LANE_W;
      var code = bot.input(view, win, r.car.tick, null);
      return { steer: S.steerOf(code), pedal: S.pedalOf(code) };
    };
    /* The driver's own time per call (window.__drv), so a frame's cost can be told apart from the bot's planning. */
    var drv = []; window.__drv = drv; var inner = window.__swimraceDriver;
    window.__swimraceDriver = function () { var a = performance.now(); var o = inner(); drv.push(performance.now() - a); if (drv.length > 4000) drv.splice(0, 2000); return o; };
    var ft = []; window.__ft = ft; var last = performance.now();
    (function rec(t) { ft.push(t - last); last = t; if (ft.length > 4000) ft.splice(0, 2000); requestAnimationFrame(rec); })(last);
    /* The page's own work in each animation frame callback (its whole frame: the race, the HUD, the scene). */
    var js = []; window.__js = js; var raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) { return raf(function (t) { var a = performance.now(); cb(t); js.push(performance.now() - a); if (js.length > 4000) js.splice(0, 2000); }); };
  })();`;
}

/* A cheap driver instead of the bot (--driver light): gas held, steering for whichever of the lanes beside it has
   the most room ahead, so the frame times measure the page and not the bot's planning. */
function lightDriverScript() {
  return driverScript().replace(/window\.__swimraceDriver = function \(\) \{[\s\S]*?\n {4}\};/, `window.__swimraceDriver = function () {
      var r = window.__swimraceRace && window.__swimraceRace();
      if (!r || r.me === null || !r.car || r.out) return null;
      var c = r.car, lc = S.laneOfX(c.x), best = lc, room = -1;
      for (var l = lc - 1; l <= lc + 1; l++) {
        if (l < 0 || l >= r.traffic.lanes.length) continue;
        var a = r.traffic.aheadIn(l, c.z, c.tick), d = a ? S.zAt(a, c.tick) - c.z : 1e9;
        if (d > room + (l === lc ? 0 : 15)) { room = d; best = l; }
      }
      var dx = S.laneX(best) - c.x;
      return { steer: Math.max(-1, Math.min(1, dx * 0.9 - c.vx * 0.2)), pedal: room < 25 ? -1 : 1 };
    };`);
}

module.exports = { driverScript, lightDriverScript };
