// slither.io redo: packet semantics (build brief sections 6, 8, 9 and 10; spec core-apply.md).
// One call per received message: applyFrame(events, byteLength) runs every event of that message in
// order against the mirrored state object S, the way their socket handler and packet switch do.
// It never runs per frame: rings, turning, fades and food motion are slLoop's and the draw modules'.
//
// Rules this module keeps:
// - Every value comes from the event fields of brief 6.2 plus our own state. Tracker fields of the
//   decoder (head, target, isOwn, pts, ...) are never read.
// - Same arithmetic in the same order as the reference client, with float32 storage exactly where
//   theirs uses Float32Array (brief section 8), so every stored number matches to the last bit.
// - Containers keep their order rules (brief section 9): foods swap-with-last, snakes inserted at the
//   front, preys and sectors spliced. A different container gives a different draw order.
// - Their crash cases are kept as crashes: an own-snake packet with no own snake throws a TypeError and
//   the rest of that message is dropped (core-apply.md 5.3). slNet catches and counts it.
// - Collaborators are looked up on DuelSlither at call time, never captured at load.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;          // game.js:125
  var K64A = PI2 / 65536;         // game.js:127
  var EEZ = 53;                   // game.js:1855: head, point, length and prey ring length
  var AFC = 26;                   // game.js:1888: angle ring length
  var FLXC = 56;                  // game.js:1801: border ring length
  var VFC = 62;                   // game.js:1896: camera ring length

  var S = null;                   // the mirrored state object, bound by initApplyState

  function core() { return D.slCore; }
  function rand() { return D.rand(); }
  function now() { return D.slLoop.now(); }

  // ---------------------------------------------------------------- tables (game.js:1855-1907)

  // Half cosine ease of x in 0..1 (0 to 1).
  function cosEase(x) {
    return .5 * (1 - Math.cos(Math.PI * x));
  }

  // Slot i of a falling half cosine from 1 to 0 over n slots (their operator order: PI * (n - 1 - i) first).
  function fallingAt(i, n) {
    return .5 * (1 - Math.cos(Math.PI * (n - 1 - i) / (n - 1)));
  }

  // Slot i of a rising half cosine from 0 to 1 over n slots.
  function risingAt(i, n) {
    return .5 * (1 - Math.cos(Math.PI * i / (n - 1)));
  }

  // The falling ease over n slots, stored float32.
  function fallingEase(n) {
    var table = new Float32Array(n);
    for (var i = 0; i < n; i++) table[i] = fallingAt(i, n);
    return table;
  }

  // Queues `delta` into a ring from slot `pos`: slot pos + j (wrapping at n) loses delta * ease[j]. slLoop plays
  // the ring back one slot per 8 ms tick.
  function feedRing(ring, pos, delta, ease, n) {
    var at = pos;
    for (var j = 0; j < n; j++) {
      ring[at] -= delta * ease[j];
      at++;
      if (at >= n) at = 0;
    }
  }

  // The signed turn from angle `from` to angle `to`, folded into (-pi, pi].
  function turnBetween(to, from) {
    var v = (to - from) % PI2;
    if (v < 0) v += PI2;
    if (v > Math.PI) v -= PI2;
    return v;
  }

  // Point deadpool: a LIFO stack of retired body points (game.js:1723-1742). slLoop adds, slApply gets.
  // The field names os and end_pos are theirs (the state differential reads them).
  function Deadpool() {
    this.os = [];
    this.end_pos = 0;
  }
  Deadpool.prototype.add = function (p) {
    var top = this.end_pos;
    if (top == this.os.length) this.os.push(p);
    else this.os[top] = p;
    this.end_pos = top + 1;
  };
  Deadpool.prototype.get = function () {
    if (!(this.end_pos >= 1)) return null;
    var top = this.end_pos - 1;
    this.end_pos = top;
    var p = this.os[top];
    this.os[top] = null;
    return p;
  };

  // ---------------------------------------------------------------- state (core-apply.md 1.4)

  function initApplyState(s) {
    S = s;
    var i;
    S.grd = 16384;                                  // game.js:1798
    S.mscps = 0;                                    // game.js:7031
    S.fmlts = [];
    S.fpsls = [];
    S.sector_size = 480;                            // game.js:1844
    S.ssd256 = S.sector_size / 256;
    S.sector_count_along_edge = 130.00001;
    S.spangdv = 4.8;                                // game.js:1847-1853 (client fallbacks until `a`)
    S.nsp1 = 4.25;
    S.nsp2 = .5;
    S.nsp3 = 12;
    S.mamu = .033;
    S.mamu2 = .028;
    S.cst = .43;
    S.default_msl = 42;                             // game.js:1854
    S.protocol_version = 2;                         // game.js:7167
    S.real_sid = undefined;
    S.flux_grd = undefined;
    S.real_flux_grd = undefined;
    S.flux_grds = [];
    S.flux_grd_pos = 0;
    S.flx_tg = 0;
    S.team_mode = false;
    S.team_val = 0;
    S.mmsta = .475;                                 // game.js:2012-2018
    S.mmrad = -1;
    S.mmsz = -1;
    S.mmdata = null;
    S.mmgad = false;
    S.mmbfr = 0;
    S.sgsc = .9 * 18 / 14;                          // game.js:1788
    S.gsc = S.sgsc;
    S.render_mode = S.is_mobile ? 1 : 2;            // game.js:1812-1813
    S.nsep = 4.5;
    S.slithers = [];
    S.slither = null;
    S.os = {};
    S.foods = [];
    S.foods_c = 0;
    S.cm1 = undefined;
    S.preys = [];
    S.sectors = [];
    S.points_dp = new Deadpool();
    S.rank = 0;
    S.best_rank = 999999999;
    S.slither_count = 0;
    S.biggest_slither_count = 0;
    S.wumsts = false;
    S.lb_fr = 0;                                    // game.js:1114 (0, not -1)
    S.dead_mtm = -1;
    S.view_xx = 0;
    S.view_yy = 0;
    S.fvx = 0;
    S.fvy = 0;
    S.fvpos = 0;
    S.fvtg = 0;
    S.ovxx = undefined;
    S.ovyy = undefined;
    S.bgx2 = 0;
    S.bgy2 = 0;
    S.bgw2 = 599;                                   // game.js:1677-1678
    S.bgh2 = 519;
    S.follow_view = true;
    S.lfsx = undefined;                             // game.js:92-97
    S.lfsy = undefined;
    S.lfcv = undefined;
    S.lfvsx = undefined;
    S.lfvsy = undefined;
    S.lfesid = undefined;
    S.etm = 0;
    S.lag_mult = 1;
    S.lagging = false;
    S.wfpr = false;
    S.playing = false;
    S.connected = false;
    S.connecting = false;
    S.want_close_socket = false;
    S.want_victory_message = false;
    S.want_victory_focus = false;
    S.want_hide_victory = 0;
    S.hvfr = 0;
    S.adm = false;
    S.my_nick = '';
    S.rdps = 0;
    S.apkps = 0;
    S.pkps = 0;

    // Ease tables (game.js:1856-1907). lfas, rfas and hfas hold the same numbers in separate arrays.
    S.lfas = fallingEase(EEZ);
    S.rfas = fallingEase(EEZ);
    S.hfas = fallingEase(EEZ);
    S.afas = fallingEase(AFC);
    // Border ease: rising, plain doubles.
    var borderEase = [];
    for (i = 0; i < FLXC; i++) borderEase[i] = risingAt(i, FLXC);
    S.flxas = borderEase;
    // Camera ease: falling, then pulled half way toward a second ease of itself (game.js:1904); plain doubles,
    // with the two empty camera rings beside it.
    var camEase = [], camX = [], camY = [];
    for (i = 0; i < VFC; i++) {
      var e = fallingAt(i, VFC);
      e += (cosEase(e) - e) * .5;
      camEase.push(e);
      camX.push(0);
      camY.push(0);
    }
    S.vfas = camEase;
    S.fvxs = camX;
    S.fvys = camY;
    S.smus = core().buildSmus(S.cst);               // game.js:1912, with the load value of cst
    return S;
  }

  // ---------------------------------------------------------------- helpers

  // Rebuild the score tables only when the value changed (game.js:1990-2008).
  function setMscps(n) {
    if (n != S.mscps) {
      S.mscps = n;
      var t = core().buildScoreTables(n);
      S.fmlts = t.fmlts;
      S.fpsls = t.fpsls;
    }
  }

  function scoreOf(sct, fam) {
    return core().scoreOf(S.fmlts, S.fpsls, sct, fam);
  }

  // Size factors from sct (game.js:7844-7850; same text at 7625-7632 and 8564-8570).
  function setSizes(o) {
    var C = core();
    o.sc = C.scOf(o.sct);
    o.scang = C.scangOf(o.sc);
    o.ssp = C.sspOf(o.sc, S.nsp1, S.nsp2);
    o.fsp = o.ssp + .1;
    o.wsep = C.wsepOf(o.sc, S.gsc);
  }

  // Two lowercase hex digits of a clamped, rounded channel. NaN gives "aN", as theirs (game.js:2675).
  function hex2(c) {
    var s = '00' + Math.min(255, Math.max(0, Math.round(c))).toString(16);
    return s.substr(s.length - 2);
  }

  // '#rrggbb' of three channels.
  function colourHex(r, g, b) {
    return '#' + hex2(r) + hex2(g) + hex2(b);
  }

  // A table channel plus a random 0..19, capped at 255 (one random draw).
  function jitter(base) {
    return Math.min(255, base + Math.floor(rand() * 20));
  }

  // The rings a snake carries, empty, in their field order (game.js:2703-2714, 2735-2738). slApply feeds
  // them, slLoop plays them.
  function addHeadRing(o) {
    o.fxs = new Float32Array(EEZ);
    o.fys = new Float32Array(EEZ);
    o.fchls = new Float32Array(EEZ);
    o.fpos = 0;
    o.ftg = 0;
    o.fx = 0;
    o.fy = 0;
    o.fchl = 0;
  }
  function addAngleRing(o) {
    o.fas = new Float32Array(AFC);
    o.fapos = 0;
    o.fatg = 0;
    o.fa = 0;
  }
  function addPreyRing(pr) {
    pr.fxs = new Float32Array(EEZ);
    pr.fys = new Float32Array(EEZ);
    pr.fpos = 0;
    pr.ftg = 0;
    pr.fx = 0;
    pr.fy = 0;
  }
  function addLengthRing(o) {
    o.flpos = 0;
    o.fls = new Float32Array(EEZ);
    o.fl = 0;
    o.fltg = 0;
  }

  // Shows the slot a point ring will play next and starts the playback (ftg = ring length).
  function showPointRing(p) {
    p.fx = p.fxs[p.fpos];
    p.fy = p.fys[p.fpos];
    p.fltn = p.fltns[p.fpos];
    p.fsmu = p.fsmus[p.fpos];
    p.ftg = EEZ;
  }

  // Clamped size index for a sprite list of `count` entries from a raw size (floor, then 0..count-1).
  function sizeIndex(raw, count) {
    var i = Math.floor(raw);
    if (i < 0) i = 0;
    if (i >= count) i = count - 1;
    return i;
  }

  // Field names of one sprite tier: the object's image and size fields (`to`) and the colour set's lists they
  // are copied from (`from`), in their write order (image, w, h, w/2, h/2).
  function tier(to, from) {
    return {
      to: [to + 'fi', to + 'fw', to + 'fh', to + 'fw2', to + 'fh2'],
      from: [from + 'imgs', from + 'fws', from + 'fhs', from + 'fw2s', from + 'fh2s']
    };
  }
  var FOOD_TIER = tier('', '');
  var FOOD_OUTLINE_TIER = tier('o', 'o');
  var FOOD_GLOW_TIER = tier('g', 'g');
  var FOOD_GLOW2_TIER = tier('g2', 'g');
  var PREY_TIER = tier('', 'pr_');
  var PREY_GLOW_TIER = tier('g', 'g');

  function copyTier(obj, set, index, t) {
    for (var k = 0; k < 5; k++) obj[t.to[k]] = set[t.from[k]][index];
  }

  // A body point: recycled from the deadpool with its four rings zeroed, or a new one.
  // A recycled point keeps every other field it had, a stale iang included (core-apply.md 4.3).
  function getPoint() {
    var p = S.points_dp.get();
    if (p) {
      p.fxs.fill(0);
      p.fys.fill(0);
      p.fltns.fill(0);
      p.fsmus.fill(0);
      return p;
    }
    p = {};
    p.fxs = new Float32Array(EEZ);
    p.fys = new Float32Array(EEZ);
    p.fltns = new Float32Array(EEZ);
    p.fsmus = new Float32Array(EEZ);
    return p;
  }

  // Length ease after sct or fam changed (game.js:2794-2807). cfl is slLoop's.
  function snl(o) {
    var before = o.tl;
    o.tl = core().tlOf(o.sct, o.fam);
    feedRing(o.fls, o.flpos, o.tl - before, S.lfas, EEZ);
    o.fl = o.fls[o.flpos];
    o.fltg = EEZ;
    if (o == S.slither) S.wumsts = true;
  }

  // Name filter (game.js:1744-1783): false when 7 digits come with no letter between them.
  // Spaces and punctuation neither count nor reset. Admins skip it.
  function gdnm(s) {
    if (S.adm) return true;
    var run = 0;
    for (var i = 0; i < s.length; i++) {
      var v = s.charCodeAt(i);
      if (v >= 48 && v <= 57) {
        run++;
        if (run >= 7) return false;
      } else if (v >= 65 && v <= 90 || v >= 97 && v <= 122) {
        run = 0;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- object constructors

  // A new snake (game.js:2657-2748). The colour jitter takes 3 random draws.
  function newSlither(id, xx, yy, cv, ang, pts, msl, customSkin) {
    var o = { id: id, xx: xx, yy: yy };
    D.slSprites.setSkin(o, cv, customSkin);
    cv = o.cv;                                      // the skin-mapped colour (game.js:2663)
    // name fade, head part, boost easing, the circle pool, accessory (none) and kills, in their order
    o.fnfr = 0;
    o.na = 1;
    o.chl = 0;
    o.tsp = 0;
    o.sfr = 0;
    o.gptz = [];
    o.accessory = -1;
    o.kill_count = 0;
    // Colour: the table colour plus 0..19 per channel, capped at 255 (3 draws, r g b).
    o.rr = jitter(S.rrs[cv]);
    o.gg = jitter(S.ggs[cv]);
    o.bb = jitter(S.bbs[cv]);
    o.cs = colourHex(o.rr, o.gg, o.bb);
    o.cs04 = colourHex(o.rr * .4, o.gg * .4, o.bb * .4);
    o.csw = colourHex((255 + o.rr) * .5, (255 + o.gg) * .5, (255 + o.bb) * .5);
    o.sc = 1;
    o.ssp = core().sspOf(o.sc, S.nsp1, S.nsp2);
    o.fsp = o.ssp + .1;
    o.msp = S.nsp3;
    addHeadRing(o);
    addAngleRing(o);
    startHeading(o, ang, msl);
    o.pts = pts || [];
    o.sct = o.pts.length;
    if (pts && pts[0].dying) o.sct--;               // an empty body throws here, as theirs (2730)
    addLengthRing(o);
    o.tl = o.sct + o.fam;                           // no cap here (game.js:2739)
    o.cfl = S.render_mode == 1 ? o.tl : o.tl - .6;
    o.scang = 1;
    o.dead_amt = 0;                                 // fades in from alive_amt 0
    o.alive_amt = 0;
    // game.js:2745-2746: a team mate of the own snake goes to the back, everyone else to the front.
    if (S.team_mode && S.slither && cv == S.slither.cv) S.slithers.push(o);
    else S.slithers.splice(0, 0, o);
    S.os['s' + o.id] = o;
    return o;
  }

  // Eyes and heading of a new snake, all at the spawn angle; pupils centred; speed 2 until the add sets it.
  function startHeading(o, ang, msl) {
    o.ehang = ang;
    o.wehang = ang;
    o.ehl = 1;
    o.msl = msl;
    o.fam = 0;
    o.rsc = 0;
    o.ang = ang;
    o.eang = ang;
    o.wang = ang;
    o.rex = 0;
    o.rey = 0;
    o.sp = 2;
  }

  // A new food (game.js:2809-2860). Sprite picks use the zoom of this moment and never change.
  // Two random draws, gfr then wsp.
  function newFood(id, xx, yy, rad, rapid, cv) {
    var f = {};
    f.id = id;
    f.xx = xx;
    f.yy = yy;
    f.rx = xx;
    f.ry = yy;
    f.rsp = rapid ? 3 : 1;
    if (cv > 9) cv %= 9;                            // 9 stays 9 (game.js:2818)
    f.cv = cv;
    f.rad = 1E-5;
    f.sz = rad;
    f.lrrad = f.rad;
    // Three sprite tiers, each indexed by the zoom of this moment (game.js:2824-2854): the dot and its outline,
    // the glow, and the double-size glow. Each index is floor(ic * gsc * ...) clamped to the list.
    var set = S.per_color_imgs[f.cv];
    var zoom = S.gsc;
    var count = set.ic;
    f.cv2 = sizeIndex(count * zoom * f.sz / 16.5, count);
    copyTier(f, set, f.cv2, FOOD_TIER);
    copyTier(f, set, f.cv2, FOOD_OUTLINE_TIER);
    f.gcv = sizeIndex(count * zoom * (.25 + .75 * f.sz / 16.5), count);
    copyTier(f, set, f.gcv, FOOD_GLOW_TIER);
    f.g2cv = sizeIndex(count * zoom * 2 * (.25 + .75 * f.sz / 16.5), count);
    copyTier(f, set, f.g2cv, FOOD_GLOW2_TIER);
    f.fr = 0;
    f.gfr = rand() * 64;
    f.gr = .65 + .1 * f.sz;
    f.wsp = (2 * rand() - 1) * .0225;
    f.eaten_fr = 0;
    S.foods[S.foods_c++] = f;                       // no duplicate check
    return f;
  }

  // A new prey (game.js:2862-2912). Colour from the RAW cv, sprites from cv % 9 (quirk kept).
  // Two random draws, gfr then gr.
  function newPrey(id, xx, yy, rad, cv, dir, wang, ang, speed) {
    var pr = { id: id, xx: xx, yy: yy, rad: 1E-5, sz: rad, cv: cv % 9, dir: dir, wang: wang, ang: ang, sp: speed, fr: 0 };
    pr.gfr = rand() * 64;
    pr.gr = .5 + rand() * .15 + .1 * pr.sz;
    pr.rr = Math.min(255, S.rrs[cv]);
    pr.gg = Math.min(255, S.ggs[cv]);
    pr.bb = Math.min(255, S.bbs[cv]);
    pr.cs = colourHex(pr.rr, pr.gg, pr.bb);
    var set = S.per_color_imgs[pr.cv];
    var count = set.pr_imgs.length;
    pr.cv2 = sizeIndex(count * S.gsc * pr.sz / 9, count);
    copyTier(pr, set, pr.cv2, PREY_TIER);
    pr.gcv = set.gimgs.length - 1;                  // always the largest glow
    copyTier(pr, set, pr.gcv, PREY_GLOW_TIER);
    addPreyRing(pr);
    pr.eaten = false;
    pr.eaten_fr = 0;
    S.preys.push(pr);
    return pr;
  }

  // The Play lock lives in slMain (absent in node tools that load slApply alone).
  function unlockPlay() {
    var m = D.slMain;
    if (m && typeof m.unlockPlay === 'function') m.unlockPlay();
  }

  // Remove the food at i by swapping in the last live one (brief section 9). The caller set
  // S.cm1 = foods_c - 1 before its downward loop; this keeps it in step. Stale nulls stay past foods_c.
  function foodRemoveAt(i) {
    var last = S.cm1;
    if (i == last) {
      S.foods[i] = null;
    } else {
      S.foods[i] = S.foods[last];
      S.foods[last] = null;
    }
    S.foods_c--;
    S.cm1--;
  }

  // ---------------------------------------------------------------- packet handlers

  // `a` (game.js:7274-7383). State first, then the HUD part (brief 10.4 row 22).
  function onInit(ev) {
    S.connecting = false;
    S.connected = true;
    S.playing = true;
    S.grd = ev.grd;
    var scps = ev.mscps;
    S.sector_size = ev.sectorSize;
    S.ssd256 = S.sector_size / 256;
    S.sector_count_along_edge = ev.sectorCount;
    S.spangdv = ev.spangdv;
    S.nsp1 = ev.nsp1;
    S.nsp2 = ev.nsp2;
    S.nsp3 = ev.nsp3;
    S.mamu = ev.mamu;
    S.mamu2 = ev.mamu2;
    S.cst = ev.cst;
    // The optional tail is a prefix: each field exists only if the packet had bytes for it.
    if (ev.pv !== undefined) S.protocol_version = ev.pv;      // never reset (game.js:7307-7310)
    if (ev.defaultMsl !== undefined) S.default_msl = ev.defaultMsl;
    if (ev.realSid !== undefined) S.real_sid = ev.realSid;
    else S.real_sid = 0;
    if (ev.fluxGrd !== undefined) S.flux_grd = ev.fluxGrd;
    else S.flux_grd = S.grd * .98;
    S.real_flux_grd = S.flux_grd;
    for (var i = 0; i < FLXC; i++) S.flux_grds[i] = S.flux_grd;   // position and countdown kept (7324)
    S.team_mode = false;
    if (ev.gameMode !== undefined) S.team_mode = ev.gameMode == 2;
    if (ev.extraB !== undefined) {
      if (S.team_mode) S.team_val = ev.extraB;
    }
    S.smus = core().buildSmus(S.cst);               // a NEW table (game.js:7373)
    setMscps(scps);
    D.slHud.onInit(ev);
  }

  // e-family: angle, turn direction, wanted angle, speed (game.js:7384-7594). No playing gate,
  // no dead gate. An absent field is their -1 sentinel; a dir of -1 (pv < 3 byte 47) is skipped too.
  function onSnakeRot(ev) {
    var o = ev.own ? S.slither : S.os['s' + ev.id];
    if (!o) return;
    var newDir = ev.dir === undefined ? -1 : ev.dir;
    var newAng = ev.ang === undefined ? -1 : ev.ang;
    var newWang = ev.wang === undefined ? -1 : ev.wang;
    var newSp = ev.sp === undefined ? -1 : ev.sp;
    if (newDir != -1) o.dir = newDir;
    if (newAng != -1) {
      // Angle ring: fed here, read back by slLoop only (o.fa is not touched, game.js:7576-7582).
      feedRing(o.fas, o.fapos, turnBetween(newAng, o.ang), S.afas, AFC);
      o.fatg = AFC;
      o.ang = newAng;
    }
    if (newWang != -1) {
      o.wang = newWang;
      if (o != S.slither) o.eang = newWang;
    }
    if (newSp != -1) {
      o.sp = newSp;
      o.spang = core().spangOf(o.sp, S.spangdv);
    }
  }

  // `h` (game.js:7602-7611).
  function onSnakeFam(ev) {
    var o = S.os['s' + ev.id];
    if (o) {
      o.fam = ev.fam;
      snl(o);
    }
  }

  // Marks the tail-most point that is not dying yet as dying. Returns false when every point already is.
  function markTailDying(pts) {
    for (var i = 0; i < pts.length; i++) {
      if (!pts[i].dying) {
        pts[i].dying = true;
        return true;
      }
    }
    return false;
  }

  // `r`: the tail point starts dying (game.js:7612-7635).
  function onSnakeTail(ev) {
    var o = S.os['s' + ev.id];
    if (!o) return;
    if (ev.fam !== undefined) o.fam = ev.fam;
    if (markTailDying(o.pts)) {
      o.sct--;
      setSizes(o);
    }
    snl(o);
  }

  // Where a move packet puts the new head point (game.js:7712-7750). At pv 15 the short forms step msl along
  // an angle: their own, or the last point's (possibly stale or undefined) iang (game.js:7722-7727). pv 3-14
  // short forms are byte offsets from the last point, added left to right ((last.xx + bx) - 128, game.js:7740).
  function headPoint(ev, last, pt, msl) {
    var cmd = ev.cmd;
    var pv = S.protocol_version;
    if (pv >= 15) {
      if (cmd == '+' || cmd == '=') {
        pt.iang = ev.iang;
        return [ev.xx, ev.yy];
      }
      var a = ev.iang !== undefined ? ev.iang : last.iang;
      pt.iang = a;
      return core().headStep(last.xx, last.yy, a, msl);
    }
    if (pv >= 3 && !(cmd == 'g' || cmd == 'n')) return [last.xx + ev.raw.bx - 128, last.yy + ev.raw.by - 128];
    return [ev.xx, ev.yy];
  }

  // In view, the new point is first drawn where the drawn head was, so the body does not jump: its rings
  // start at that spot and ease to the real one (game.js:7769-7800).
  function easeFromHead(o, pt, last, msl, ease) {
    var dx = o.xx + o.fx - (last.xx + last.fx);
    var dy = o.yy + o.fy - (last.yy + last.fy);
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) {                                 // no normalising at dist <= 1 (quirk kept)
      dx /= dist;
      dy /= dist;
    }
    var full = pt.ltn * msl;
    var used = dist < msl ? dist : full;
    var fromX = last.xx + last.fx + dx * used;
    var fromY = last.yy + last.fy + dy * used;
    feedRing(pt.fxs, pt.fpos, pt.xx - fromX, ease, EEZ);
    feedRing(pt.fys, pt.fpos, pt.yy - fromY, ease, EEZ);
    feedRing(pt.fltns, pt.fpos, 1 - used / full, ease, EEZ);
    showPointRing(pt);
  }

  // Move packets g G n N + = (game.js:7662-7903).
  function onSnakeMove(ev) {
    if (!S.playing) return;
    var cmd = ev.cmd;
    var growing = cmd == 'n' || cmd == 'N' || cmd == '+';
    var o = ev.own ? S.slither : S.os['s' + ev.id];
    if (!o) return;
    var pts = o.pts;
    if (growing) o.sct++;
    else markTailDying(pts);
    var last = pts[pts.length - 1];                 // taken after the dying mark (quirk kept)
    var pt = getPoint();
    var msl = o.msl;
    var at = headPoint(ev, last, pt, msl);
    var nx = at[0];
    var ny = at[1];
    if (growing) o.fam = ev.fam;
    pt.fpos = 0;
    pt.ftg = 0;
    pt.smu = 1;
    pt.fsmu = 0;
    pt.xx = nx;
    pt.yy = ny;
    pt.fx = 0;
    pt.fy = 0;
    pt.fltn = 0;
    pt.da = 0;
    pt.ltn = Math.sqrt(Math.pow(pt.xx - last.xx, 2) + Math.pow(pt.yy - last.yy, 2)) / msl;
    pt.ebx = pt.xx - last.xx;
    pt.eby = pt.yy - last.yy;
    pts.push(pt);

    var ease = S.hfas;
    if (o.iiv) easeFromHead(o, pt, last, msl, ease);

    // Chain pull; in view, each pulled point's move goes into its rings (game.js:7801-7843).
    core().chainPull(pts, S.cst, S.smus, o.iiv ? function (p, mx, my, smuShift) {
      feedRing(p.fxs, p.fpos, mx, ease, EEZ);
      feedRing(p.fys, p.fpos, my, ease, EEZ);
      feedRing(p.fsmus, p.fpos, smuShift, ease, EEZ);
      p.fx = p.fxs[p.fpos];
      p.fy = p.fys[p.fpos];
      p.fsmu = p.fsmus[p.fpos];
      p.ftg = EEZ;
    } : null);

    setSizes(o);
    if (growing) snl(o);
    var own = o == S.slither;
    if (own) {
      S.ovxx = o.xx + o.fx;                         // drawn head before this move
      S.ovyy = o.yy + o.fy;
    }
    moveHead(o, nx, ny);
    if (own) followOwnHead(o);
  }

  // The head jumps to the new point; its ring eases the drawn head from the old spot (game.js:7856-7877).
  // etm is always 0, so chl resets to 0 every move; kept literal.
  function moveHead(o, nx, ny) {
    var move = o.sp * (S.etm / 8) / 4;
    move *= S.lag_mult;
    var oldChl = o.chl - 1;
    o.chl = move / o.msl;
    var dx = nx - o.xx;
    var dy = ny - o.yy;
    var chlShift = o.chl - oldChl;
    o.xx = nx;
    o.yy = ny;
    var ease = S.rfas;
    feedRing(o.fxs, o.fpos, dx, ease, EEZ);
    feedRing(o.fys, o.fpos, dy, ease, EEZ);
    feedRing(o.fchls, o.fpos, chlShift, ease, EEZ);
    o.fx = o.fxs[o.fpos];
    o.fy = o.fys[o.fpos];
    o.fchl = o.fchls[o.fpos];
    o.ftg = EEZ;
    o.ehl = 0;
  }

  // Own snake: view, tile phase and camera ring (game.js:7878-7902). fvx/fvy are the redraw's.
  function followOwnHead(o) {
    var oldX = S.view_xx;
    var oldY = S.view_yy;
    if (S.follow_view) {
      S.view_xx = o.xx + o.fx;
      S.view_yy = o.yy + o.fy;
    }
    D.slDrawWorld.updateTilePhase(oldX, oldY);
    feedRing(S.fvxs, S.fvpos, S.view_xx - S.ovxx, S.vfas, VFC);
    feedRing(S.fvys, S.fvpos, S.view_yy - S.ovyy, S.vfas, VFC);
    S.fvtg = VFC;
  }

  // Name escaping for the leaderboard: exactly nl chars. A filtered name ("" with the wire length)
  // prints that many U+0000 (charCodeAt past the end is NaN, game.js:7948-7955).
  function escapeName(name, len) {
    var out = '';
    for (var i = 0; i < len; i++) {
      var v = name.charCodeAt(i);
      if (v == 38) out += '&amp;';
      else if (v == 60) out += '&lt;';
      else if (v == 62) out += '&gt;';
      else if (v == 32) out += '&nbsp;';
      else out += String.fromCharCode(v);
    }
    return out;
  }

  // `l` leaderboard (game.js:7904-7967). slHud writes the three strings.
  function onLeaderboard(ev) {
    if (!S.playing) return;
    S.wumsts = true;
    var scoreHtml = '', nameHtml = '', placeHtml = '';
    var shown = 0, place = 0;
    if (S.lb_fr == -1) {
      if (S.dead_mtm == -1) S.lb_fr = 0;
    }
    var mine = ev.myPos;
    S.rank = ev.rank;
    if (S.rank < S.best_rank) S.best_rank = S.rank;
    S.slither_count = ev.count;
    if (S.slither_count > S.biggest_slither_count) S.biggest_slither_count = S.slither_count;
    var rows = ev.rows;
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      var score = scoreOf(row.sct, row.fam);
      var colourIdx = row.raw.cv % 9;
      place++;
      var name, nameLen;
      if (place == mine) {
        name = S.my_nick;
        nameLen = name.length;
      } else {
        name = row.nick;
        nameLen = name.length;                             // the wire length, kept even when filtered
        if (!gdnm(name)) name = '';
      }
      name = escapeName(name, nameLen);
      shown++;
      var alpha = place == mine ? 1 : .7 * (.3 + .7 * (1 - shown / 10));
      var colour = S.per_color_imgs[colourIdx].cs;
      scoreHtml += '<span style="opacity:' + alpha + '; color:' + colour + ';">' + score + '</span><BR>';
      nameHtml += '<span style="opacity:' + alpha + '; color:' + colour + ';' + (place == mine ? 'font-weight:bold;' : '') +
        '">' + name + '</span><BR>';
      placeHtml += '<span style="opacity:' + alpha + '; color:' + colour + ';">#' + shown + '</span><BR>';
    }
    D.slHud.setLeaderboard(scoreHtml, nameHtml, placeHtml);
  }

  // `v` (game.js:7968-7977). Not gated by playing.
  function onDead(ev) {
    if (ev.code == 2) {
      S.want_close_socket = true;
      S.want_victory_message = false;
      S.want_hide_victory = 1;
      S.hvfr = 0;
    } else {
      S.dead_mtm = now();
      gameOver(ev.code == 1);
    }
  }

  // Remove every food of a sector and every matching sector entry (game.js:8009-8030).
  function removeSector(sx, sy) {
    S.cm1 = S.foods_c - 1;
    for (var i = S.cm1; i >= 0; i--) {
      var f = S.foods[i];
      if (f.sx == sx && f.sy == sy) foodRemoveAt(i);
    }
    var list = S.sectors;
    for (var j = list.length - 1; j >= 0; j--) {
      var sec = list[j];
      if (sec.xx == sx && sec.yy == sy) list.splice(j, 1);   // no break: duplicates all go
    }
  }

  function addSector(sx, sy) {
    var sec = {};
    sec.xx = sx;
    sec.yy = sy;
    S.sectors.push(sec);
  }

  // Split/join escaping of `m` strings: &, <, > only, in that order (game.js:8052-8054).
  function escapeLongest(s) {
    return s.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;');
  }

  // `m` today's longest (game.js:8032-8069). The box keeps its old text unless the score is positive.
  function onLongest(ev) {
    var score = scoreOf(ev.sct, ev.fam);
    var nick = ev.nick;
    if (!gdnm(nick)) nick = '';
    var text = ev.msg;
    if (!gdnm(text)) text = '';
    nick = escapeLongest(nick);
    text = escapeLongest(text);
    if (!(score > 0)) return;
    var tail = "<br><i><span style='opacity: .5;'>with a length of </span><span style='opacity: .65;'><b>" +
      score + '</b></span></i>';
    var html = '';
    if (text.length > 0) {
      html += "<span style='font-size:17px;'><b><i><span style='opacity: .5;'>&quot;</span>" + text +
        "<span style='opacity: .5;'>&quot;</span></i></b></span><BR><div style='height: 5px;'></div>";
    }
    if (nick.length > 0) {
      if (text.length > 0) {
        html += "<i><span style='opacity: .5;'>- </span><span style='opacity: .75;'><b>" + nick +
          "</b></span><span style='opacity: .5;'>, today's longest</span></i>";
      } else {
        html = "<i><span style='opacity: .5;'>Today's longest was </span><span style='opacity: .75;'><b>" + nick +
          '</b></span></i>';
      }
      html += tail;
    } else if (text.length > 0) {
      html += "<i><span style='opacity: .5;'>- </span><span style='opacity: .5;'>today's longest</span></i>";
      html += tail;
    } else {
      html += "<i><span style='opacity: .5;'>Today's longest: </span><span style='opacity: .75;'><b>" + score +
        '</b></span></i>';
    }
    D.slHud.setVcm(html);
  }

  // `p` (game.js:8070-8076). lag_mult is left for slLoop to ramp back.
  function onPong() {
    S.wfpr = false;
    if (S.lagging) {
      S.etm *= S.lag_mult;
      S.lagging = false;
    }
  }

  // The body of an `s` add (game.js:8470-8534). The first point is absolute (x / 5); each later one is either
  // one default_msl step along its own angle (the last 2 bytes at pv >= 15, game.js:8499-8506; that angle also
  // becomes the snake's) or a half-unit byte offset from the one before. Spacing multipliers are then given
  // from the head back. Returns the points; `out` gets the last position and the angle.
  function buildBody(raw, out) {
    var x = 0, y = 0;
    var pts = [];
    for (var i = 0; i < raw.length; i++) {
      var e = raw[i];
      var p = getPoint();
      var prevX = x, prevY = y;
      if (i == 0) {
        x = e.x / 5;
        y = e.y / 5;
        prevX = x;
        prevY = y;
      } else if (e.iang !== undefined) {
        p.iang = e.iang;
        out.ang = e.iang * K64A;
        x += Math.cos(out.ang) * S.default_msl;
        y += Math.sin(out.ang) * S.default_msl;
      } else {
        x += (e.bx - 127) / 2;
        y += (e.by - 127) / 2;
      }
      p.fpos = 0;
      p.ftg = 0;
      p.fsmu = 0;
      p.xx = x;
      p.yy = y;
      p.fx = 0;
      p.fy = 0;
      p.fltn = 0;
      p.da = 0;
      p.ltn = 1;
      p.ebx = x - prevX;
      p.eby = y - prevY;
      pts.push(p);
    }
    var table = S.smus, limit = core().SMUC_M3;
    var mul = 1;
    for (var back = 0; back < pts.length; back++) {
      if (back < limit) mul = table[back];
      pts[pts.length - 1 - back].smu = mul;
    }
    out.x = x;
    out.y = y;
    return pts;
  }

  // `s` with a body (game.js:8418-8572). The first one after connect is the own snake.
  function onSnakeAdd(ev) {
    if (!S.playing) return;
    var customSkin = null;
    var skin = ev.skin;
    if (skin && skin.length > 0) customSkin = Uint8Array.from(skin);
    var end = { x: 0, y: 0, ang: ev.ang };          // ang is replaced by an iang point's angle when present
    var pts = buildBody(ev.raw.pts, end);
    var o = newSlither(ev.id, ev.snx, ev.sny, ev.cv, end.ang, pts, S.default_msl, customSkin);
    if (S.slither == null) {
      S.view_xx = end.x;                            // the last body point, no tile phase update
      S.view_yy = end.y;
      S.slither = o;
      // The stored accessory (game.js:8540-8543) is not built: accessory stays -1.
      o.md = false;
      o.wmd = false;
      o.nk = S.my_nick;
      S.lfsx = -1;
      S.lfsy = -1;
      S.lfcv = 0;
      S.lfvsx = -1;
      S.lfvsy = -1;
      S.lfesid = -1;
    } else {
      o.nk = ev.nick;
      if (!gdnm(ev.nick)) o.nk = '';
    }
    o.ip = '';
    o.onk = '';
    o.eang = o.wang = ev.wang;
    o.sp = ev.sp;
    o.spang = core().spangOf(o.sp, S.spangdv);
    o.fam = ev.fam;
    setSizes(o);
    o.sep = o.wsep;
    snl(o);
  }

  // `s` without a body: remove or kill (game.js:8573-8589). The own pointer is never cleared.
  function onSnakeRemove(ev) {
    if (!S.playing) return;
    var id = ev.id;
    var snakes = S.slithers;
    for (var i = snakes.length - 1; i >= 0; i--) {
      if (snakes[i].id == id) {
        var o = snakes[i];
        o.id = -1234;
        if (ev.kill) {
          o.dead = true;                            // stays listed until slLoop sees dead_amt >= 1
          o.dead_amt = 0;
          o.edir = 0;
        } else {
          snakes.splice(i, 1);
        }
        delete S.os['s' + id];
        break;
      }
    }
  }

  // `F` (game.js:8590-8660). Does not touch the "from last" memory.
  function onFoodSector(ev) {
    var entries = ev.foods;
    var pv = S.protocol_version;
    var i, f, food, x, y, id;
    if (pv >= 14) {
      var sx = ev.sx, sy = ev.sy;
      var baseX = sx * S.sector_size;
      var baseY = sy * S.sector_size;
      for (i = 0; i < entries.length; i++) {
        f = entries[i];
        x = baseX + f.rx * S.ssd256;
        y = baseY + f.ry * S.ssd256;
        id = sx << 24 | sy << 16 | f.rx << 8 | f.ry;    // signed int32: sx >= 128 is negative
        food = newFood(id, x, y, f.rad, true, f.cv);
        food.sx = sx;
        food.sy = sy;
      }
    } else if (pv >= 4) {
      var named = false, firstSx, firstSy;
      for (i = 0; i < entries.length; i++) {
        f = entries[i];
        id = f.yy * S.grd * 3 + f.xx;
        food = newFood(id, f.xx, f.yy, f.rad, true, f.cv);
        if (!named) {                           // the first entry names the sector of all
          named = true;
          firstSx = Math.floor(f.xx / S.sector_size);
          firstSy = Math.floor(f.yy / S.sector_size);
        }
        food.sx = firstSx;
        food.sy = firstSy;
      }
    } else {
      for (i = 0; i < entries.length; i++) {
        f = entries[i];
        x = S.sector_size * (ev.sx + f.rx / 255);
        y = S.sector_size * (ev.sy + f.ry / 255);
        food = newFood(f.id, x, y, f.rad, true, f.cv);
        food.sx = ev.sx;
        food.sy = ev.sy;
      }
    }
  }

  // `b` rapid / `f` normal (game.js:8661-8730).
  function onFoodAdd(ev) {
    var pv = S.protocol_version;
    var food, x, y, id;
    if (pv >= 14) {
      var sx, sy, cv;
      if (!ev.sectorFromLast) {
        sx = ev.sx;
        sy = ev.sy;
        S.lfsx = sx;
        S.lfsy = sy;
      } else {
        sx = S.lfsx;
        sy = S.lfsy;
      }
      x = sx * S.sector_size + ev.rx * S.ssd256;
      y = sy * S.sector_size + ev.ry * S.ssd256;
      id = sx << 24 | sy << 16 | ev.rx << 8 | ev.ry;
      if (!ev.cvFromLast) {
        cv = ev.cv;
        S.lfcv = cv;
      } else {
        cv = S.lfcv;
      }
      food = newFood(id, x, y, ev.rad, ev.rapid, cv);
      food.sx = sx;
      food.sy = sy;
    } else if (pv >= 4) {
      if (!ev.noop) {
        id = ev.yy * S.grd * 3 + ev.xx;
        food = newFood(id, ev.xx, ev.yy, ev.rad, ev.rapid, ev.cv);
        food.sx = Math.floor(ev.xx / S.sector_size);
        food.sy = Math.floor(ev.yy / S.sector_size);
      }
    } else if (!ev.noop) {
      x = S.sector_size * (ev.sx + ev.rx / 255);
      y = S.sector_size * (ev.sy + ev.ry / 255);
      food = newFood(ev.id, x, y, ev.rad, ev.rapid, ev.cv);
      food.sx = ev.sx;
      food.sy = ev.sy;
    }
  }

  // `c` gone, `C` eaten by the last eater, `<` eaten by a named snake (game.js:8731-8794).
  function onFoodEat(ev) {
    var pv = S.protocol_version;
    var cmd = ev.cmd;
    var id, eaterId = -1;
    if (pv >= 14) {
      var sx, sy;
      if (ev.sectorFromLast) {
        sx = S.lfvsx;
        sy = S.lfvsy;
      } else {
        sx = ev.sx;
        sy = ev.sy;
        S.lfvsx = sx;
        S.lfvsy = sy;
      }
      id = sx << 24 | sy << 16 | ev.rx << 8 | ev.ry;
      if (cmd == '<') {
        eaterId = ev.eater;
        S.lfesid = eaterId;
      } else if (cmd == 'C') {
        eaterId = S.lfesid;                            // -1 after the own spawn, undefined before it
      }
    } else if (pv >= 4) {
      id = ev.yy * S.grd * 3 + ev.xx;
      eaterId = ev.eater;
    } else {
      id = ev.id;
      eaterId = ev.eater;
    }
    S.cm1 = S.foods_c - 1;
    for (var i = S.cm1; i >= 0; i--) {
      var f = S.foods[i];
      if (f.id == id) {
        f.eaten = true;
        if (eaterId >= 0) {
          f.eaten_by = S.os['s' + eaterId];           // may be undefined: slLoop drops it next frame
          f.eaten_fr = 0;
        } else {
          foodRemoveAt(i);
        }
        break;
      }
    }
  }

  function findPrey(id) {
    var list = S.preys;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].id == id) return list[i];
    }
    return null;
  }

  // `j` (game.js:8795-8869). etm is 0, so the position lands as sent; the ring eases the drawn prey from
  // where it was.
  function onPreyMove(ev) {
    var pr = findPrey(ev.id);
    if (!pr) return;
    var move = pr.sp * (S.etm / 8) / 4;
    move *= S.lag_mult;
    var wasX = pr.xx;
    var wasY = pr.yy;
    if (ev.dir !== undefined) pr.dir = ev.dir;
    if (ev.ang !== undefined) pr.ang = ev.ang;
    if (ev.wang !== undefined) pr.wang = ev.wang;
    if (ev.sp !== undefined) pr.sp = ev.sp;
    pr.xx = ev.xx + Math.cos(pr.ang) * move;
    pr.yy = ev.yy + Math.sin(pr.ang) * move;
    feedRing(pr.fxs, pr.fpos, pr.xx - wasX, S.rfas, EEZ);
    feedRing(pr.fys, pr.fpos, pr.yy - wasY, S.rfas, EEZ);
    pr.fx = pr.fxs[pr.fpos];
    pr.fy = pr.fys[pr.fpos];
    pr.ftg = EEZ;
  }

  // `y` removal (game.js:8873-8879).
  function onPreyRemove(ev) {
    var list = S.preys;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].id == ev.id) {
        list.splice(i, 1);
        break;
      }
    }
  }

  // `y` eaten (game.js:8880-8892). An unknown eater removes it at once.
  function onPreyEaten(ev) {
    var list = S.preys;
    for (var i = list.length - 1; i >= 0; i--) {
      var pr = list[i];
      if (pr.id == ev.id) {
        pr.eaten = true;
        pr.eaten_by = S.os['s' + ev.eater];
        if (pr.eaten_by) pr.eaten_fr = 0;
        else list.splice(i, 1);
        break;
      }
    }
  }

  // `z` new border target (game.js:8918-8928). flux_grd itself is slLoop's to move.
  // Every slot of the border ring moves toward the new target by the border ease, from the current position.
  function onFlux(ev) {
    S.real_flux_grd = ev.fluxGrd;
    var ring = S.flux_grds, ease = S.flxas;
    var at = S.flux_grd_pos;
    for (var j = 0; j < FLXC; j++) {
      ring[at] = ring[at] + (S.real_flux_grd - ring[at]) * ease[j];
      at = at + 1 < FLXC ? at + 1 : 0;
    }
    S.flx_tg = FLXC;
  }

  function dispatch(ev) {
    switch (ev.type) {
      case 'init': onInit(ev); break;
      case 'snake_rot': onSnakeRot(ev); break;
      case 'snake_fam': onSnakeFam(ev); break;
      case 'snake_tail': onSnakeTail(ev); break;
      case 'own_rsc': S.slither.rsc = ev.rsc; break;       // throws with no own snake (game.js:7637)
      case 'snake_move': onSnakeMove(ev); break;
      case 'leaderboard': onLeaderboard(ev); break;
      case 'dead': onDead(ev); break;
      case 'sector_add': addSector(ev.sx, ev.sy); break;
      case 'sector_remove': removeSector(ev.sx, ev.sy); break;
      case 'sector_w':                                      // pv < 8 form (game.js:7996-8031)
        if (ev.mode == 1) addSector(ev.sx, ev.sy);
        else removeSector(ev.sx, ev.sy);
        break;
      case 'longest_msg': onLongest(ev); break;
      case 'pong': onPong(); break;
      case 'minimap': D.slHud.onMinimap(ev); break;         // U M V u L, all slHud's (brief 10.4 row 2)
      case 'snake_add': onSnakeAdd(ev); break;
      case 'snake_remove': onSnakeRemove(ev); break;
      case 'food_sector': onFoodSector(ev); break;
      case 'food_add': onFoodAdd(ev); break;
      case 'food_eat': onFoodEat(ev); break;
      case 'prey_move': onPreyMove(ev); break;
      case 'prey_remove': onPreyRemove(ev); break;
      case 'prey_eaten': onPreyEaten(ev); break;
      case 'prey_add':
        newPrey(ev.id, ev.xx, ev.yy, ev.rad, ev.cv, ev.dir, ev.wang, ev.ang, ev.sp);
        break;
      case 'kill_count': {
        var o = S.os['s' + ev.id];
        if (o) o.kill_count = ev.count;
        break;
      }
      case 'flux': onFlux(ev); break;
      default:
        // server_version, admin_info, team_scores, session_id, debug_point, unknown, malformed,
        // empty: counted, nothing else (core-apply.md 6.22).
        break;
    }
  }

  // ---------------------------------------------------------------- frame, close, reset, game over

  // One received message (game.js:7219-7257). A throw stops the rest of the message, as theirs.
  function applyFrame(events, byteLength) {
    S.rdps += byteLength;
    S.apkps++;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type === 'wire_error') continue;       // a bad bundle tail: slNet counts it
      S.pkps++;
      dispatch(ev);
    }
  }

  // The current game socket closed (game.js:8937-8947).
  function applyClose() {
    if (S.playing) {
      S.dead_mtm = now();
      gameOver();
      resetGame();
    } else {
      unlockPlay();                                 // ours: no reconnect loop (slMain.unlockPlay)
    }
    S.connected = false;
    S.playing = false;
  }

  // Clear the world for the next connect (game.js:7117-7166). Kept across lives: fvpos, the deadpool,
  // pv and every `a` constant, the "from last" memory, the border ring, bgx2/bgy2, the view, the
  // minimap size and data, lb_fr and dead_mtm (core-apply.md 4.7).
  function resetGame() {
    var net = D.slNet;
    if (net.hasSocket()) net.closeSocket();
    S.want_close_socket = false;
    S.slithers.length = 0;                          // the old list is emptied too, then replaced
    S.slithers = [];
    S.slither = null;
    S.foods = [];
    S.foods_c = 0;
    S.preys = [];
    S.sectors = [];
    S.os = {};
    S.rank = 0;
    S.best_rank = 999999999;
    S.slither_count = 0;
    S.biggest_slither_count = 0;
    S.connected = false;
    S.playing = false;
    S.wfpr = false;
    S.lagging = false;
    S.fvxs.fill(0);
    S.fvys.fill(0);
    S.fvtg = 0;
    S.fvx = 0;
    S.fvy = 0;
    S.lag_mult = 1;
    S.cptm = 0;
    S.mmal = 0;
    S.mmgad = false;
    // Team scoreboard resets (game.js:7150-7159) are not built: team mode UI is out.
    D.slHud.resetHud();
    S.gsc = S.sgsc;
    var floaters = S.bgees;
    if (floaters) {
      for (var b = floaters.length - 1; b >= 0; b--) floaters[b].sc = S.gsc * floaters[b].sp;
    }
  }

  // Death or close (game.js:9042-9075). With no own snake while playing this throws after the lag
  // reset, as theirs (core-apply.md 5.3).
  function gameOver(v) {
    S.lagging = false;
    S.lag_mult = 1;
    if (S.playing && !S.want_close_socket) {
      unlockPlay();                                 // their play_btn.setEnabled(true), game.js:9046
      var me = S.slither;
      var sct = me.sct + me.rsc;
      var finalScore = scoreOf(sct, me.fam);
      D.slHud.gameOver(finalScore, v);
      if (v) {
        S.want_victory_message = true;
        S.want_victory_focus = true;
      } else {
        S.want_close_socket = true;
      }
    }
  }

  D.slApply = {
    initApplyState: initApplyState,
    applyFrame: applyFrame,
    applyClose: applyClose,
    resetGame: resetGame,
    gameOver: gameOver,
    newFood: newFood,
    newPrey: newPrey,
    foodRemoveAt: foodRemoveAt,
    gdnm: gdnm,
    snl: snl
  };
})(typeof window !== 'undefined' ? window : globalThis);
