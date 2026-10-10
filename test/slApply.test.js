'use strict';
// slither.io redo, apply card: public/js/sl/slApply.js (build brief 6, 8, 9, 11; spec core-apply.md 12.2).
// Vectors A0-A26 were COMPUTED by running the reference client in a vm (reference side). Their event
// lists are copied below as literals, already cut down to the consumed fields of brief 6.2, so every
// test also proves slApply reads nothing else. Plus DWH 9.2, 9.3, 9.10-9.12, 9.19-9.21 and DS T15.
// Collaborators (slSprites, slHud, slDrawWorld, slNet, slLoop) are small fakes on the namespace; their
// own behaviour is tested in their own cards. slCore is the real module.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../shared/slCore.js');
require('../public/js/sl/slApply.js');
const D = globalThis.DuelSlither;
const A = D.slApply;

// Colour tables (data, game.js:3325-3327; slSprites owns them in the product).
const RRS = [192, 144, 128, 128, 238, 255, 255, 255, 224, 255, 144, 80, 255, 40, 100, 120, 72, 160, 255, 56, 56, 78, 255, 101, 128, 60, 0, 217, 255, 144, 32, 240, 240, 240, 240, 32, 40, 104, 0, 104, 0, 128];
const GGS = [128, 153, 208, 255, 238, 160, 144, 64, 48, 255, 153, 80, 192, 136, 117, 134, 84, 80, 224, 68, 68, 35, 86, 200, 132, 192, 255, 69, 64, 144, 32, 32, 240, 144, 32, 240, 60, 128, 0, 40, 0, 128];
const BBS = [255, 255, 208, 128, 112, 96, 144, 64, 224, 255, 255, 80, 80, 96, 255, 255, 255, 255, 64, 255, 255, 192, 9, 232, 144, 72, 83, 69, 64, 144, 240, 32, 32, 32, 240, 32, 173, 255, 112, 170, 0, 255];
// Sprite sizes (DWH 9.1): core widths of the 17 food sprites, glow widths, 22 prey sprites.
const CORE_W = [4, 5, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 24, 25];
const GLOW_W = [29, 37, 45, 53, 61, 69, 77, 85, 93, 101, 109, 117, 125, 133, 141, 149, 157];
const PREY_W = Array.from({ length: 22 }, (_, k) => 44 + 2 * k);

// per_color_imgs shaped like theirs. sized=false: image names and sizes are index markers (the shape
// the A vectors were computed with); sized=true: the real widths above (DWH 9.2, 9.3).
function buildPci(sized) {
  const h = v => ('00' + v.toString(16)).slice(-2);
  return RRS.map((r, i) => {
    const o = { cs: '#' + h(RRS[i]) + h(GGS[i]) + h(BBS[i]) };
    if (i <= 9) {
      const mk = (tag, n) => Array.from({ length: n }, (_, k) => tag + k);
      const idx = n => Array.from({ length: n }, (_, k) => k);
      o.ic = 17;
      o.imgs = mk('img', 17); o.oimgs = mk('oimg', 17); o.gimgs = mk('gimg', 17); o.pr_imgs = mk('primg', 22);
      for (const f of ['fws', 'fhs', 'fw2s', 'fh2s']) o[f] = sized ? CORE_W.slice() : idx(17);
      for (const f of ['ofws', 'ofhs', 'ofw2s', 'ofh2s']) o[f] = idx(17);
      for (const f of ['gfws', 'gfhs', 'gfw2s', 'gfh2s']) o[f] = sized ? GLOW_W.slice() : idx(17);
      for (const f of ['pr_fws', 'pr_fhs', 'pr_fw2s', 'pr_fh2s']) o[f] = sized ? PREY_W.slice() : idx(22);
    }
    return o;
  });
}

// setSkin fake: only the non-custom colour map of the values these vectors use (game.js:2555-2627:
// 9 -> 7, 30 -> 10, 60 -> 36, 0..8 stay). The real one is slSprites' (DS T13).
const SKIN_FIRST = { 9: 7, 30: 10, 60: 36 };
function fakeSetSkin(o, cv, ca) {
  o.rcv = cv;
  o.cv = SKIN_FIRST[cv] !== undefined ? SKIN_FIRST[cv] : cv % 9;
}

const clock = { t: 1000 };

// One fresh client. Collaborators are installed on the shared namespace (looked up at call time).
function newWorld(frames, opts = {}) {
  const S = { is_mobile: !!opts.mobile };
  S.rrs = RRS.slice(); S.ggs = GGS.slice(); S.bbs = BBS.slice();
  S.per_color_imgs = buildPci(!!opts.sized);
  const randQ = [], randLog = [];
  D.rand = () => { const v = randQ.length ? randQ.shift() : 0.5; randLog.push(v); return v; };
  D.slLoop = { now: () => clock.t };
  D.slSprites = { setSkin: fakeSetSkin };
  const hud = { calls: [] };
  // onInit fake: the state part of their setMinimapSize(24, true) and mmsta (game.js:7370, 2029-2035),
  // with startShowGame left out, exactly as the A vectors were computed (their startShowGame was stubbed).
  hud.onInit = ev => { hud.calls.push(['onInit', ev]); S.mmsta = .475; S.mmrad = 12; S.mmsz = 24; S.mmdata = new Uint8Array(576); };
  hud.setLeaderboard = (s, n, p) => { hud.calls.push(['setLeaderboard']); hud.lbs = s; hud.lbn = n; hud.lbp = p; };
  hud.setVcm = h => { hud.calls.push(['setVcm']); hud.vcm = h; };
  hud.gameOver = (fs, v) => { hud.calls.push(['gameOver', fs, v]); };
  hud.resetHud = () => { hud.calls.push(['resetHud']); };
  hud.onMinimap = ev => { hud.calls.push(['onMinimap', ev]); };
  D.slHud = hud;
  const tile = [];
  D.slDrawWorld = {
    // DWH 2.3.1 (game.js:5211-5216), here so the own-move vectors can check bgx2/bgy2.
    updateTilePhase(lvx, lvy) {
      tile.push([lvx, lvy]);
      S.bgx2 -= (S.view_xx - lvx) * 1 / S.bgw2;
      S.bgy2 -= (S.view_yy - lvy) * 1 / S.bgh2;
      S.bgx2 %= 1; if (S.bgx2 < 0) S.bgx2 += 1;
      S.bgy2 %= 1; if (S.bgy2 < 0) S.bgy2 += 1;
    },
  };
  const net = { open: false, closes: 0, hasSocket() { return this.open; }, closeSocket() { this.closes++; this.open = false; } };
  D.slNet = net;
  A.initApplyState(S);
  let fi = 0;
  return {
    S, randQ, randLog, hud, tile, net,
    next() {
      const evs = frames[fi++];
      if (!evs) throw new Error('no frame left');
      try { A.applyFrame(evs, 0); return null; } catch (e) { return e.message; }
    },
    left() { return frames.length - fi; },
  };
}

// Fixture events (consumed fields only) and expected outputs, COMPUTED by the reference self-test generator.
const EV = [{"type":"init","grd":16384,"mscps":411,"sectorSize":480,"sectorCount":130,"spangdv":4.8,"nsp1":4.25,"nsp2":0.5,"nsp3":12,"mamu":0.033,"mamu2":0.028,"cst":0.43,"pv":15,"defaultMsl":42,"realSid":7,"fluxGrd":16000},{"type":"init","grd":21600,"mscps":300,"sectorSize":300,"sectorCount":144,"spangdv":4.8,"nsp1":4.25,"nsp2":0.5,"nsp3":12,"mamu":0.033,"mamu2":0.028,"cst":0.43},{"type":"snake_add","id":1,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":49800,"y":50000},{"bx":137,"by":127},{"bx":137,"by":129},{"bx":137,"by":125},{"bx":137,"by":127},{"bx":137,"by":131},{"bx":137,"by":127},{"iang":0}]}},{"type":"snake_add","id":7,"cv":30,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"x1234567","skin":[],"raw":{"pts":[{"x":60000,"y":60000},{"iang":16384}]}},{"type":"snake_move","cmd":"G","own":true},{"type":"snake_move","cmd":"G","own":true,"iang":10000},{"type":"snake_move","cmd":"N","own":true,"iang":0,"fam":0.2500000149011621},{"type":"init","grd":16384,"mscps":411,"sectorSize":480,"sectorCount":130,"spangdv":4.8,"nsp1":4.25,"nsp2":0.5,"nsp3":12,"mamu":0.033,"mamu2":0.028,"cst":0.43,"pv":14,"defaultMsl":42},{"type":"snake_add","id":1,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":50001,"y":50003},{"bx":128,"by":128}]}},{"type":"snake_add","id":9,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":81402,"y":50003},{"bx":127,"by":127}]}},{"type":"snake_move","cmd":"G","own":false,"id":9,"raw":{"bx":200,"by":3}},{"type":"snake_add","id":7,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":60000,"y":60000},{"iang":16384}]}},{"type":"snake_rot","own":false,"id":7,"dir":1,"ang":1.718058482431918,"wang":4.908738521234052,"sp":5},{"type":"snake_rot","own":true,"ang":0.2454369260617026},{"type":"snake_rot","own":true,"dir":2,"wang":3.141592653589793,"sp":2},{"type":"snake_rot","own":true,"dir":1,"ang":6.135923151542564,"wang":0.1227184630308513,"sp":14.166666666666666},{"type":"snake_fam","id":1,"fam":1},{"type":"snake_tail","id":1,"fam":0.000059604648328104514},{"type":"snake_tail","id":1},{"type":"own_rsc","rsc":3},{"type":"sector_add","sx":5,"sy":6},{"type":"food_sector","sx":20,"sy":21,"foods":[{"cv":3,"rx":0,"ry":255,"rad":5},{"cv":12,"rx":128,"ry":64,"rad":10},{"cv":9,"rx":1,"ry":2,"rad":1}]},{"type":"food_sector","sx":200,"sy":1,"foods":[{"cv":0,"rx":10,"ry":10,"rad":16}]},{"type":"food_add","rapid":true,"sectorFromLast":false,"sx":30,"sy":31,"rx":100,"ry":100,"cvFromLast":false,"cv":5,"rad":4},{"type":"food_add","rapid":false,"sectorFromLast":true,"rx":101,"ry":102,"cvFromLast":true,"rad":3},{"type":"food_sector","sx":1,"sy":1,"foods":[{"cv":0,"rx":1,"ry":1,"rad":1},{"cv":0,"rx":2,"ry":2,"rad":1},{"cv":0,"rx":3,"ry":3,"rad":1},{"cv":0,"rx":4,"ry":4,"rad":1},{"cv":0,"rx":5,"ry":5,"rad":1}]},{"type":"food_eat","cmd":"c","sectorFromLast":false,"sx":1,"sy":1,"rx":2,"ry":2},{"type":"food_eat","cmd":"C","sectorFromLast":true,"rx":3,"ry":3},{"type":"food_eat","cmd":"<","sectorFromLast":false,"sx":1,"sy":1,"rx":4,"ry":4,"eater":1},{"type":"food_eat","cmd":"<","sectorFromLast":false,"sx":1,"sy":1,"rx":1,"ry":1,"eater":55},{"type":"food_eat","cmd":"C","sectorFromLast":true,"rx":5,"ry":5},{"type":"sector_add","sx":1,"sy":1},{"type":"sector_add","sx":2,"sy":2},{"type":"food_sector","sx":1,"sy":1,"foods":[{"cv":0,"rx":1,"ry":1,"rad":1},{"cv":0,"rx":2,"ry":2,"rad":1},{"cv":0,"rx":3,"ry":3,"rad":1}]},{"type":"food_sector","sx":2,"sy":2,"foods":[{"cv":0,"rx":4,"ry":4,"rad":1}]},{"type":"food_sector","sx":1,"sy":1,"foods":[{"cv":0,"rx":5,"ry":5,"rad":1}]},{"type":"food_sector","sx":3,"sy":3,"foods":[{"cv":0,"rx":6,"ry":6,"rad":1}]},{"type":"sector_remove","sx":1,"sy":1},{"type":"prey_add","id":40,"cv":12,"xx":10020,"yy":10040,"rad":8,"wang":1.5707964204216591,"ang":3.1415928408433182,"sp":9.1,"dir":2},{"type":"prey_move","id":40,"xx":10201,"yy":10501,"dir":2,"ang":0.00003745070506147526,"wang":0.00007490141012295051,"sp":1.234},{"type":"prey_move","id":40,"xx":10204,"yy":10501,"sp":2},{"type":"prey_add","id":41,"cv":1,"xx":10000,"yy":10000,"rad":4,"wang":0,"ang":0,"sp":0,"dir":0},{"type":"prey_add","id":42,"cv":2,"xx":10000,"yy":10000,"rad":4,"wang":0,"ang":0,"sp":0,"dir":0},{"type":"prey_eaten","id":41,"eater":1},{"type":"prey_eaten","id":42,"eater":77},{"type":"prey_remove","id":40},{"type":"flux","fluxGrd":15000},{"type":"flux","fluxGrd":14000},{"type":"leaderboard","myPos":2,"rank":5,"count":321,"rows":[{"sct":100,"fam":0.49999997019767584,"nick":"Bob 1","raw":{"cv":12}},{"sct":20,"fam":0,"nick":"abc","raw":{"cv":3}},{"sct":10,"fam":1,"nick":"12345678","raw":{"cv":9}}]},{"type":"longest_msg","sct":200,"fam":0,"nick":"Ann","msg":"hi <3"},{"type":"longest_msg","sct":200,"fam":0,"nick":"","msg":"only msg"},{"type":"longest_msg","sct":200,"fam":0,"nick":"Ann","msg":""},{"type":"longest_msg","sct":200,"fam":0,"nick":"","msg":""},{"type":"longest_msg","sct":1,"fam":0,"nick":"Zed","msg":""},{"type":"pong"},{"type":"kill_count","id":1,"count":70000},{"type":"dead","code":0},{"type":"dead","code":1},{"type":"dead","code":2},{"type":"snake_add","id":8,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":61000,"y":60000},{"iang":16384}]}},{"type":"snake_remove","id":7,"kill":true},{"type":"snake_remove","id":8,"kill":false},{"type":"snake_remove","id":1,"kill":false},{"type":"minimap","cmd":"M","raw":{"size":24},"size":24,"pixels":[[23,23],[17,23],[1,23],[0,23]]},{"type":"minimap","cmd":"V","size":24,"toggles":[[23,23],[22,23]]},{"type":"snake_add","id":1,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":50000,"y":50000},{"bx":130,"by":127},{"iang":0}]}},{"type":"food_sector","sx":1,"sy":1,"foods":[{"cv":0,"rx":1,"ry":1,"rad":1}]},{"type":"snake_add","id":7,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":61000,"y":60000},{"iang":0}]}},{"type":"snake_add","id":1,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","raw":{"pts":[{"x":65280,"y":12748800},{"bx":195,"by":80},{"bx":137,"by":127},{"bx":137,"by":129},{"bx":137,"by":125},{"bx":137,"by":127},{"bx":137,"by":131},{"bx":137,"by":127},{"bx":0,"by":0}]}},{"type":"leaderboard","myPos":0,"rank":5,"count":9,"rows":[]},{"type":"sector_add","sx":3,"sy":4},{"type":"flux","fluxGrd":9000},{"type":"snake_add","id":1,"cv":3,"ang":1.5707964204216591,"wang":3.1415928408433182,"sp":5.78,"fam":0.49999997019767584,"snx":10043,"sny":10004,"nick":"abc","skin":[],"raw":{"pts":[{"x":50000,"y":50000},{"bx":131,"by":127},{"bx":131,"by":127}]}},{"type":"sector_add","sx":9,"sy":9}];
const FX = {"A0":{"w":[[]],"x":{"lfas":{"ctor":"Float32Array","len":53,"v":[1,0.9990877509117126,0.5,0.0009122228948399425,0]},"rfas_equals_lfas":true,"afas":{"ctor":"Float32Array","len":26,"v":[1,0.9960573315620422,0.5313952565193176,0.003942649345844984,0]},"flxas":{"ctor":"Array","len":56,"v":[0,0.0008154480369321759,0.48572197460315175,0.9991845519630678,1]},"vfas":{"ctor":"Array","len":62,"v":[1,0.9996679802484048,0.5165454040822839,0.00033201975159527497,0]},"p12_not_used_by_apply":[0,0.11999999731779099,0.225600004196167]}},"A1":{"w":[[[0]],[[1]]],"x":{"bytes full":"61004000019b01e000823001a9003204b00021001c01ae0f2a0007003e80","full":{"connecting":false,"connected":true,"playing":true,"grd":16384,"mscps":411,"sector_size":480,"ssd256":1.875,"sector_count_along_edge":130,"spangdv":4.8,"nsp1":4.25,"nsp2":0.5,"nsp3":12,"mamu":0.033,"mamu2":0.028,"cst":0.43,"protocol_version":15,"default_msl":42,"real_sid":7,"flux_grd":16000,"real_flux_grd":16000,"team_mode":false,"mmsz":24,"flx_tg":0,"flux_grd_pos":0,"lb_fr":0,"flux_grds":[56,16000,16000],"smus4":0.8924999833106995,"fmlts_len":2460,"mmdata_len":576},"bytes short":"61005460012c012c00903001a9003204b00021001c01ae","short":{"grd":21600,"protocol_version":2,"default_msl":42,"real_sid":0,"flux_grd":21168,"real_flux_grd":21168,"team_mode":false,"sector_size":300,"ssd256":1.171875,"mscps":300}}},"A2":{"w":[[[0],[2]]],"x":{"bytes":"7300014000003180000016947fffff0300c42700c3640361626300ff00c28800c350897f8981897d897f8983897f0000","err":null,"own":true,"o":{"id":1,"xx":10043,"yy":10004,"cv":3,"rr":129,"gg":255,"bb":147,"cs":"#81ff93","cs04":"#34663b","csw":"#c0ffc9","ang":0,"wang":3.1415928408433182,"eang":3.1415928408433182,"ehang":0,"wehang":0,"sp":5.78,"spang":1,"fam":0.49999997019767584,"sct":8,"sc":1.0566037735849056,"scang":0.9836623353506586,"ssp":4.778301886792453,"fsp":4.878301886792452,"msp":12,"wsep":6.339622641509434,"sep":6.339622641509434,"tl":8.499999970197676,"cfl":7.4,"fl":-0.4999999701976776,"fltg":53,"flpos":0,"msl":42,"na":1,"chl":0,"tsp":0,"sfr":0,"ehl":1,"rsc":0,"kill_count":0,"accessory":-1,"nk":"","ip":"","onk":"","md":false,"wmd":false,"dead_amt":0,"alive_amt":0,"fpos":0,"ftg":0,"fx":0,"fy":0,"fapos":0,"fatg":0,"fa":0},"fls[0..2], fls[52]":[-0.4999999701976776,-0.49954384565353394,-0.4981772005558014,0],"pts":[{"xx":9960,"yy":10000,"smu":0.5699999928474426,"ltn":1,"ebx":0,"eby":0},{"xx":9965,"yy":10000,"smu":0.6775000095367432,"ltn":1,"ebx":5,"eby":0},{"xx":9970,"yy":10001,"smu":0.7850000262260437,"ltn":1,"ebx":5,"eby":1},{"xx":9975,"yy":10000,"smu":0.8924999833106995,"ltn":1,"ebx":5,"eby":-1},{"xx":9980,"yy":10000,"smu":1,"ltn":1,"ebx":5,"eby":0},{"xx":9985,"yy":10002,"smu":1,"ltn":1,"ebx":5,"eby":2},{"xx":9990,"yy":10002,"smu":1,"ltn":1,"ebx":5,"eby":0},{"xx":10032,"yy":10002,"smu":1,"ltn":1,"ebx":42,"eby":0,"iang":0}],"view":[10032,10002],"lf":[-1,-1,0,-1,-1,-1],"wumsts":true,"randUsed":[0.05,0.5,0.97]}},"A3":{"w":[[[0],[2],[3]]],"x":{"order":[7,1],"nk":"","cv":10,"rr":154,"ang":1.5707963267948966,"eang":3.1415928408433182,"sct":2,"pts":[{"xx":12000,"yy":12000,"smu":1,"ebx":0,"eby":0},{"xx":12000,"yy":12042,"smu":1,"iang":16384,"ebx":0,"eby":42}],"slitherStillOwn":1,"gdnm":{"x1234567":false,"x123456":true,"12-34-567":false,"12a34567":true,"1 2 3 4 5 6 7":false}}},"A4":{"w":[[[0],[2],[4],[5]]],"x":{"before":[[9960,10000],[9965,10000],[9970,10001],[9975,10000],[9980,10000],[9985,10002],[9990,10002],[10032,10002]],"xxBefore":[10043,10004],"afterRepeat":{"pts":[{"xx":9963.630767259492,"yy":10000.116418633224,"smu":0.5699999928474426,"ltn":1,"ebx":0,"eby":0,"dying":true},{"xx":9968.443644789515,"yy":10000.2707410075,"smu":0.5699999928474426,"ltn":1,"ebx":5,"eby":0},{"xx":9973.008476254687,"yy":10000.62963025,"smu":0.6775000095367432,"ltn":1,"ebx":5,"eby":1},{"xx":9976.99645640625,"yy":10000.138675,"smu":0.7850000262260437,"ltn":1,"ebx":5,"eby":-1},{"xx":9981.1905625,"yy":10000.43,"smu":0.8924999833106995,"ltn":1,"ebx":5,"eby":0},{"xx":9985.5375,"yy":10002,"smu":1,"ltn":1,"ebx":5,"eby":2},{"xx":9990,"yy":10002,"smu":1,"ltn":1,"ebx":5,"eby":0},{"xx":10032,"yy":10002,"smu":1,"ltn":1,"ebx":42,"eby":0,"iang":0},{"xx":10074,"yy":10002,"smu":1,"ltn":1,"ebx":42,"eby":0,"iang":0}],"o":{"xx":10074,"yy":10002,"fx":-31,"fy":2,"fchl":-1,"chl":0,"ftg":53,"fpos":0,"ehl":0,"sct":8,"sc":1.0566037735849056,"tl":8.499999970197676,"fl":-0.4999999701976776},"fxs[0..2]":[-31,-30.97171974182129,-30.886987686157227],"fchls[0..1]":[-1,-0.9990877509117126],"view":[10043,10004],"bg":[0.9816360601001669,0.9961464354527938],"fvxs[0..1]":[0,0],"fvys[0]":0,"fvtg":62,"ovxx":[10043,10004]},"afterAngle":{"lastPt":{"xx":10098.131240912004,"yy":10036.375619442373,"iang":10000,"ltn":1.0000000000000067,"ebx":24.131240912003705,"eby":34.375619442373136},"dyingCount":2,"len":10,"o":{"xx":10098.131240912004,"yy":10036.375619442373,"fx":-55.13124084472656,"fy":-32.37561798095703,"ftg":53},"fxs[0..1]":[-55.13124084472656,-55.08094787597656],"view":[10043.000000067277,10004.000001461416],"bg":[0.9816360599878512,0.9961464326369631],"fvxs[0..1]":[-6.727714207954705e-8,-6.725480473954576e-8],"pts":[[9967.074011416613,10000.237371562216,0.5699999928474426],[9971.638311810937,10000.3977045146,0.5699999928474426],[9975.873102978869,10000.5660049775,0.5699999928474426],[9979.670398869062,10000.481664500001,0.6775000095367432],[9983.21492725,10000.936325,0.7850000262260437],[9987.4676625,10002,0.8924999833106995],[9994.515,10002,1],[10032,10002,1],[10074,10002,1],[10098.131240912004,10036.375619442373,1]]}}},"A5":{"w":[[[0],[2],[4]]],"x":{"newPoint":{"xx":10074,"yy":10002,"smu":1,"ltn":1,"ebx":42,"eby":0,"iang":0,"fx":-34.25,"fy":3.5,"fltn":-0.7975315451622009,"fsmu":0,"ftg":53,"fxs0":-34.25,"fys0":3.5,"fltns0":-0.7975315451622009,"fsmus0":0,"fxs1":-34.218753814697266},"pulled":[{"xx":9963.630767259492,"yy":10000.116418633224,"smu":0.5699999928474426,"ltn":1,"ebx":0,"eby":0,"dying":true,"fx":-3.630767345428467,"fy":-0.11641862988471985,"fltn":0,"fsmu":0,"ftg":53,"fxs0":-3.630767345428467,"fys0":-0.11641862988471985,"fltns0":0,"fsmus0":0,"fxs1":-3.627454996109009},{"xx":9968.443644789515,"yy":10000.2707410075,"smu":0.5699999928474426,"ltn":1,"ebx":5,"eby":0,"fx":-3.4436447620391846,"fy":-0.2707410156726837,"fltn":0,"fsmu":0.10750001668930054,"ftg":53,"fxs0":-3.4436447620391846,"fys0":-0.2707410156726837,"fltns0":0,"fsmus0":0.10750001668930054,"fxs1":-3.4405033588409424},{"xx":9973.008476254687,"yy":10000.62963025,"smu":0.6775000095367432,"ltn":1,"ebx":5,"eby":1,"fx":-3.0084762573242188,"fy":0.3703697621822357,"fltn":0,"fsmu":0.10750001668930054,"ftg":53,"fxs0":-3.0084762573242188,"fys0":0.3703697621822357,"fltns0":0,"fsmus0":0.10750001668930054,"fxs1":-3.0057318210601807},{"xx":9976.99645640625,"yy":10000.138675,"smu":0.7850000262260437,"ltn":1,"ebx":5,"eby":-1,"fx":-1.9964563846588135,"fy":-0.1386750042438507,"fltn":0,"fsmu":0.10749995708465576,"ftg":53,"fxs0":-1.9964563846588135,"fys0":-0.1386750042438507,"fltns0":0,"fsmus0":0.10749995708465576,"fxs1":-1.9946351051330566},{"xx":9981.1905625,"yy":10000.43,"smu":0.8924999833106995,"ltn":1,"ebx":5,"eby":0,"fx":-1.1905624866485596,"fy":-0.4300000071525574,"fltn":0,"fsmu":0.10750001668930054,"ftg":53,"fxs0":-1.1905624866485596,"fys0":-0.4300000071525574,"fltns0":0,"fsmus0":0.10750001668930054,"fxs1":-1.1894763708114624},{"xx":9985.5375,"yy":10002,"smu":1,"ltn":1,"ebx":5,"eby":2,"fx":-0.5375000238418579,"fy":0,"fltn":0,"fsmu":0,"ftg":53,"fxs0":-0.5375000238418579,"fys0":0,"fltns0":0,"fsmus0":0,"fxs1":-0.5370096564292908}],"o":{"xx":10074,"yy":10002,"fx":-31,"fy":2,"ftg":53}}},"A5b":{"w":[[[0],[2],[4]]],"x":{"newPoint":{"xx":10074,"yy":10002,"smu":1,"ltn":1,"ebx":42,"eby":0,"iang":0,"fx":-41.72049331665039,"fy":0.1397542506456375,"fltn":-0.9866900444030762,"fsmu":0,"ftg":53,"fxs0":-41.72049331665039,"fys0":0.1397542506456375,"fltns0":-0.9866900444030762,"fsmus0":0,"fxs1":-41.682430267333984}}},"A6":{"w":[[[0],[2],[6]]],"x":{"o":{"sct":9,"fam":0.2500000149011621,"tl":9.250000014901161,"fl":-1.25,"fltg":53,"sc":1.0660377358490567,"scang":0.9809544470155451,"wsep":6.39622641509434,"xx":10074,"yy":10002},"fls[0..2]":[-1.25,-1.2488596439361572,-1.2454431056976318],"len":9,"dying":0,"wumsts":true}},"A7":{"w":[[[7],[8],[9],[10]]],"x":{"lpo":[16280.4,10000.6],"newPoint":[16352.400000000001,9875.6],"leftToRight":[16352.400000000001,9875.6],"grouped":[16352.4,9875.6]}},"A8":{"w":[[[0],[2],[11],[12],[13],[14],[15]]],"x":{"other":{"dir":1,"ang":1.718058482431918,"wang":4.908738521234052,"eang":4.908738521234052,"sp":5,"spang":1,"fa":0,"fatg":26,"fapos":0},"angBefore":1.5707963267948966,"fas[0..2], fas[25]":[-0.14726215600967407,-0.146681547164917,-0.14494889974594116,0],"ownE":{"ang":0.2454369260617026,"wang":3.1415928408433182,"sp":5.78,"fa":0,"fatg":26},"ownEfas":[-0.2454369217157364,-0.24446925520896912],"own4":{"dir":2,"wang":3.141592653589793,"eang":3.1415928408433182,"sp":2,"spang":0.4166666666666667},"eangUnchanged":true,"ownD":{"dir":1,"ang":6.135923151542564,"wang":0.1227184630308513,"sp":14.166666666666666,"spang":1},"ownDfas0":0.14726215600967407}},"A9":{"w":[[[0],[2],[16],[17],[18]]],"x":{"afterH":{"fam":1,"tl":9,"fl":-1,"fltg":53},"afterH fls[0..1]":[-1,-0.9990877509117126],"afterR":{"fam":0.000059604648328104514,"sct":7,"sc":1.0471698113207548,"scang":0.986374525335232,"ssp":4.773584905660377,"fsp":4.873584905660377,"wsep":6.283018867924529,"tl":7.000059604648328,"fl":0.9999403953552246},"dying":[true,false,false,false,false,false,false,false],"afterR fls[0..1]":[0.9999403953552246,0.999028205871582],"afterR2":{"fam":0.000059604648328104514,"sct":6,"tl":6.000059604648328,"fl":1.9999403953552246},"dying2":[true,true,false,false,false,false,false,false]}},"A10":{"w":[[[0],[19,20],[2],[19,20]]],"x":{"err":"Cannot set properties of null (setting 'rsc')","sectorsAfterThrow":0,"rsc":3,"sectors":[[5,6]]}},"A11":{"w":[[[0],[2],[21],[22],[23],[24]]],"x":{"foods_c":4,"foods":[{"id":336920831,"xx":9600,"yy":10558.125,"sz":5,"cv":3,"rsp":3,"rad":0.00001,"fr":0,"gfr":16,"wsp":0.01125,"gr":1.15,"cv2":5,"gcv":9,"g2cv":16,"fi":"img5","gfi":"gimg9","g2fi":"gimg16","sx":20,"sy":21,"eaten_fr":0,"lrrad":0.00001},{"id":336953408,"xx":9840,"yy":10200,"sz":10,"cv":3,"rsp":3,"rad":0.00001,"fr":0,"gfr":6.4,"wsp":0.018,"gr":1.65,"cv2":11,"gcv":13,"g2cv":16,"fi":"img11","gfi":"gimg13","g2fi":"gimg16","sx":20,"sy":21,"eaten_fr":0,"lrrad":0.00001},{"id":336920834,"xx":9601.875,"yy":10083.75,"sz":1,"cv":9,"rsp":3,"rad":0.00001,"fr":0,"gfr":38.4,"wsp":-0.004499999999999999,"gr":0.75,"cv2":1,"gcv":5,"g2cv":11,"fi":"img1","gfi":"gimg5","g2fi":"gimg11","sx":20,"sy":21,"eaten_fr":0,"lrrad":0.00001},{"id":-939455990,"xx":96018.75,"yy":498.75,"sz":16,"cv":0,"rsp":3,"rad":0.00001,"fr":0,"gfr":32,"wsp":0,"gr":2.25,"cv2":16,"gcv":16,"g2cv":16,"fi":"img16","gfi":"gimg16","g2fi":"gimg16","sx":200,"sy":1,"eaten_fr":0,"lrrad":0.00001}],"lf":[30,31,5],"bf":[{"id":505373796,"xx":14587.5,"yy":15067.5,"cv":5,"rsp":3,"sz":4,"sx":30,"sy":31},{"id":505374054,"xx":14589.375,"yy":15071.25,"cv":5,"rsp":1,"sz":3,"sx":30,"sy":31}]}},"A12":{"w":[[[0],[2],[25],[26],[27],[28],[29],[30]]],"x":{"start":[257,514,771,1028,1285],"afterC22":[257,1285,771,1028],"nullTail":true,"foods_c":4,"afterCwithEsidMinus1":[257,1285,1028],"afterLt":{"ids":[257,1285,1028],"eaten":true,"eaten_by_is_own":true,"eaten_fr":0,"lfesid":1},"unknownEater":{"ids":[257,1285,1028],"eaten":true,"eaten_by":"undefined","lfesid":55},"CwithEsid55":{"ids":[257,1285,1028],"eaten":true,"lfvs":[1,1]}}},"A13":{"w":[[[0],[2],[31,32,31],[33],[34],[35],[36],[37]]],"x":{"start":["1,1:1","1,1:2","1,1:3","2,2:4","1,1:5","3,3:6"],"sectors":[[1,1],[2,2],[1,1]],"after":["3,3:6","2,2:4"],"sectorsAfter":[[2,2]],"foods_len_array":6,"tailNulls":[null,null,null,null]}},"A14":{"w":[[[0],[2],[38],[39],[40],[41],[42],[43],[44],[45]]],"x":{"add":{"id":40,"xx":10020,"yy":10040,"rad":0.00001,"sz":8,"cv":3,"dir":2,"wang":1.5707964204216591,"ang":3.1415928408433182,"sp":9.1,"fr":0,"gfr":19.2,"gr":1.3900000000000001,"rr":255,"gg":192,"bb":80,"cs":"#ffc050","cv2":21,"fi":"primg21","gcv":16,"gfi":"gimg16","fpos":0,"ftg":0,"fx":0,"fy":0,"eaten":false,"eaten_fr":0},"j15":{"xx":10201,"yy":10501,"dir":2,"ang":0.00003745070506147526,"wang":0.00007490141012295051,"sp":1.234,"fx":-181,"fy":-461,"ftg":53,"fpos":0},"j15fxs":[-181,-180.8348846435547,0],"j8":{"xx":10204,"yy":10501,"sp":2,"fx":-184,"fy":-461},"order":[40,41,42],"eatenByOwn":{"order":[40,41,42],"eaten":true,"own":true,"eaten_fr":0},"eatenByUnknown":[40,41],"afterRemove":[41]}},"A15":{"w":[[[0],[46],[47]]],"x":{"z1":{"real_flux_grd":15000,"flux_grd":16000,"flx_tg":56,"flux_grd_pos":0,"v":[16000,15999.184551963068,15514.278025396849,15000]},"z2":{"real_flux_grd":14000,"flux_grd":16000,"flx_tg":56,"v":[16000,15997.554320844705,14778.759912802929,14000]}}},"A16":{"w":[[[0],[2],[48]]],"x":{"rank":5,"best_rank":5,"slither_count":321,"biggest":321,"wumsts":true,"lb_fr":0,"lbs":"<span style=\"opacity:0.6509999999999999; color:#80ff80;\">2043</span><BR><span style=\"opacity:1; color:#80ff80;\">296</span><BR><span style=\"opacity:0.5529999999999999; color:#c080ff;\">149</span><BR>","lbn":"<span style=\"opacity:0.6509999999999999; color:#80ff80;\">Bob&nbsp;1</span><BR><span style=\"opacity:1; color:#80ff80;font-weight:bold;\">Me&amp;&lt;Q&gt;&nbsp;x</span><BR><span style=\"opacity:0.5529999999999999; color:#c080ff;\">\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000</span><BR>","lbp":"<span style=\"opacity:0.6509999999999999; color:#80ff80;\">#1</span><BR><span style=\"opacity:1; color:#80ff80;\">#2</span><BR><span style=\"opacity:0.5529999999999999; color:#c080ff;\">#3</span><BR>"}},"A17":{"w":[[[0],[49],[50],[51],[52],[53]]],"x":{"nickAndMsg":"<span style='font-size:17px;'><b><i><span style='opacity: .5;'>&quot;</span>hi &lt;3<span style='opacity: .5;'>&quot;</span></i></b></span><BR><div style='height: 5px;'></div><i><span style='opacity: .5;'>- </span><span style='opacity: .75;'><b>Ann</b></span><span style='opacity: .5;'>, today's longest</span></i><br><i><span style='opacity: .5;'>with a length of </span><span style='opacity: .65;'><b>6371</b></span></i>","msgOnly":"<span style='font-size:17px;'><b><i><span style='opacity: .5;'>&quot;</span>only msg<span style='opacity: .5;'>&quot;</span></i></b></span><BR><div style='height: 5px;'></div><i><span style='opacity: .5;'>- </span><span style='opacity: .5;'>today's longest</span></i><br><i><span style='opacity: .5;'>with a length of </span><span style='opacity: .65;'><b>6371</b></span></i>","nickOnly":"<i><span style='opacity: .5;'>Today's longest was </span><span style='opacity: .75;'><b>Ann</b></span></i><br><i><span style='opacity: .5;'>with a length of </span><span style='opacity: .65;'><b>6371</b></span></i>","neither":"<i><span style='opacity: .5;'>Today's longest: </span><span style='opacity: .75;'><b>6371</b></span></i>","scoreNotPositiveKeepsOld":"<i><span style='opacity: .5;'>Today's longest: </span><span style='opacity: .75;'><b>6371</b></span></i>"}},"A18":{"w":[[[0],[2],[54],[55],[56]],[[0],[2],[57]],[[0],[2],[58]]],"x":{"afterP":{"wfpr":false,"lagging":false,"lag_mult":0.4,"etm":0},"kill_count":70000,"v0":{"dead_mtm":5000,"want_close_socket":true,"lagging":false,"lag_mult":1,"want_victory_message":false,"playing":true,"lastscore":"<span style=\"opacity: .45;\">Your final length was </span><b>110</b>"},"v1":{"dead_mtm":5000,"want_close_socket":false,"want_victory_message":true,"want_victory_focus":true},"v2":{"dead_mtm":-1,"want_close_socket":true,"want_victory_message":false,"want_hide_victory":1,"hvfr":0}}},"A19":{"w":[[[0],[2],[11],[59],[60],[61],[62]]],"x":{"start":[8,7,1],"kill":{"order":[8,-1234,1],"o7":{"id":-1234,"dead":true,"dead_amt":0,"edir":0},"inOs":false},"nonKill":{"order":[-1234,1],"o8id":-1234,"inOs":false},"ownRemoved":{"order":[-1234],"slitherStillSet":true,"slitherId":-1234}}},"A20":{"w":[[[0],[63],[64]]],"x":{"M":{"calls":[["asmc2","clearRect",0,0,24,24],["asmc2","fillStyle=","#FFFFFF"],["asmc2","fillRect",23,23,1,1],["asmc2","fillRect",17,23,1,1],["asmc2","fillRect",1,23,1,1],["asmc2","fillRect",0,23,1,1],["asmc","clearRect",0,0,24,24],["asmc","drawImage","asmc2",0,0]],"set":[[0,23],[1,23],[17,23],[23,23]],"mmgad":true,"mmbfr":0,"op":[0.475,0]},"V":{"calls":[["asmc","clearRect",0,0,24,24],["asmc","drawImage","asmc2",0,0],["asmc2","fillStyle=","#FFFFFF"],["asmc2","clearRect",23,23,1,1],["asmc2","fillRect",22,23,1,1]],"set":[[0,23],[1,23],[17,23],[22,23]]}}},"A21":{"w":[[[0],[65]]],"x":{"recycledIsFirst":true,"iang":777,"smu":1,"fxs0":0,"fxs52":0,"dpEnd":0,"lastIang":0}},"A22":{"w":[[[0],[2],[66],[46]]],"x":{"dead_mtm":7000,"connected":false,"playing":false,"want_close_socket":false,"foods_c":0,"slither":null,"protocol_version":15,"flx_tg":56,"flux_grd_pos":0,"gsc":1.157142857142857,"bgx2":0.3,"lag_mult":1,"rank":0,"best_rank":999999999,"ws":null,"mmgad":false,"fvtg":0,"lfsx":-1}},"A23":{"w":[[[0],[2],[11],[67]]],"x":{"order":[7,7,1],"osIsNew":true,"firstStillListed":true,"len":3}},"A24":{"w":[[[68],[69],[70],[71]]],"x":{"slithers":0,"slither":null,"rank":0,"sectors":1,"real_flux_grd":9000,"pv":2}},"A25":{"w":[[[7],[72]]],"x":{"ang":1.5707964204216591,"ehang":1.5707964204216591,"wang":3.1415928408433182,"packetAng":1.5707964204216591,"pts":[[10000,10000,1,null],[10002,10000,1,null],[10004,10000,1,null]]}},"A26":{"w":[[[0],[56,73]]],"x":{"err":"Cannot read properties of null (reading 'sct')","dead_mtm":1000,"lagging":false,"lag_mult":1,"sectors":0,"want_close_socket":false}}};

// ---------------------------------------------------------------- fixture access and comparison

const clone = v => JSON.parse(JSON.stringify(v));
function fixture(id) {
  const f = FX[id];
  let wi = 0;
  return {
    x: f.x,
    world(opts) { const w = f.w[wi++]; return newWorld(w.map(fr => fr.map(i => clone(EV[i]))), opts); },
    worldsLeft() { return f.w.length - wi; },
  };
}
function fmt(v) { return typeof v === 'string' ? JSON.stringify(v) : String(v); }
// First difference between two JSON-shaped values, leaves compared with Object.is. Reports a path
// instead of printing two big objects.
function firstDiff(a, b, p) {
  if (typeof b !== 'object' || b === null) return Object.is(a, b) ? null : `${p}: got ${fmt(a)} want ${fmt(b)}`;
  if (typeof a !== 'object' || a === null) return `${p}: got ${fmt(a)} want an object`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array vs object`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return `${p}: keys [${ka}] want [${kb}]`;
  for (const k of kb) {
    if (!Object.prototype.hasOwnProperty.call(a, k)) return `${p}: missing ${k}`;
    const d = firstDiff(a[k], b[k], p + '.' + k);
    if (d) return d;
  }
  return null;
}
// The expected values went through JSON (undefined keys dropped, NaN as null), so ours does too.
function same(actual, expected, label) {
  assert.strictEqual(firstDiff(clone(actual), expected, label || '$'), null);
}
function without(o, keys) { const c = Object.assign({}, o); for (const k of keys) delete c[k]; return c; }
const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o[k]]));
const ptView = p => ({ xx: p.xx, yy: p.yy, smu: p.smu, ltn: p.ltn, ebx: p.ebx, eby: p.eby, iang: p.iang, dying: p.dying,
  fx: p.fx, fy: p.fy, fltn: p.fltn, fsmu: p.fsmu, ftg: p.ftg, fxs0: p.fxs[0], fys0: p.fys[0], fltns0: p.fltns[0], fsmus0: p.fsmus[0], fxs1: p.fxs[1] });

// SPAWN: the init frame, then the own `s` with rand .05 .5 .97 (core-apply.md 12).
function spawnOwn(W) {
  assert.strictEqual(W.next(), null);
  W.randQ.push(0.05, 0.5, 0.97);
  return W.next();
}
function allFramesUsed(W) { assert.strictEqual(W.left(), 0, 'every fixture frame applied'); }
function allWorldsUsed(F) { assert.strictEqual(F.worldsLeft(), 0, 'every fixture world used'); }

// ---------------------------------------------------------------- A0 to A26

test('A0 ease tables at load', () => {
  const F = fixture('A0'); const W = F.world(); const S = W.S; const x = F.x;
  same({ ctor: S.lfas.constructor.name, len: S.lfas.length, v: [S.lfas[0], S.lfas[1], S.lfas[26], S.lfas[51], S.lfas[52]] }, x.lfas);
  same(Array.from(S.rfas).every((v, i) => v === S.lfas[i]) && Array.from(S.hfas).every((v, i) => v === S.lfas[i]), x.rfas_equals_lfas);
  assert.notStrictEqual(S.rfas, S.lfas); assert.notStrictEqual(S.hfas, S.lfas);
  same({ ctor: S.afas.constructor.name, len: S.afas.length, v: [S.afas[0], S.afas[1], S.afas[12], S.afas[24], S.afas[25]] }, x.afas);
  same({ ctor: S.flxas.constructor.name, len: S.flxas.length, v: [S.flxas[0], S.flxas[1], S.flxas[27], S.flxas[54], S.flxas[55]] }, x.flxas);
  same({ ctor: S.vfas.constructor.name, len: S.vfas.length, v: [S.vfas[0], S.vfas[1], S.vfas[30], S.vfas[60], S.vfas[61]] }, x.vfas);
  assert.ok(Array.isArray(S.fvxs) && S.fvxs.length === 62 && S.fvxs.every(v => v === 0));
  assert.ok(Array.isArray(S.fvys) && S.fvys.length === 62);
  assert.ok(S.smus instanceof Float32Array && S.smus[4] === 0.8924999833106995);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A1 init full (pv 15) then init short on a fresh client', () => {
  const F = fixture('A1'); const x = F.x;
  const W = F.world(); const S = W.S;
  assert.strictEqual(W.next(), null);
  const full = pick(S, ['connecting', 'connected', 'playing', 'grd', 'mscps', 'sector_size', 'ssd256', 'sector_count_along_edge', 'spangdv', 'nsp1', 'nsp2', 'nsp3', 'mamu', 'mamu2', 'cst', 'protocol_version', 'default_msl', 'real_sid', 'flux_grd', 'real_flux_grd', 'team_mode', 'mmsz', 'flx_tg', 'flux_grd_pos', 'lb_fr']);
  full.flux_grds = [S.flux_grds.length, S.flux_grds[0], S.flux_grds[55]];
  full.smus4 = S.smus[4]; full.fmlts_len = S.fmlts.length; full.mmdata_len = S.mmdata.length;
  same(full, x.full, 'full');
  assert.strictEqual(W.hud.calls.length, 1); assert.strictEqual(W.hud.calls[0][0], 'onInit');
  allFramesUsed(W);
  const W2 = F.world(); const S2 = W2.S;
  assert.strictEqual(W2.next(), null);
  same(pick(S2, ['grd', 'protocol_version', 'default_msl', 'real_sid', 'flux_grd', 'real_flux_grd', 'team_mode', 'sector_size', 'ssd256', 'mscps']), x.short, 'short');
  allFramesUsed(W2); allWorldsUsed(F);
});

test('A2 own snake add (pv 15)', () => {
  const F = fixture('A2'); const W = F.world(); const S = W.S;
  const err = spawnOwn(W);
  const o = S.slither;
  same({
    err, own: o === S.os.s1,
    o: pick(o, ['id', 'xx', 'yy', 'cv', 'rr', 'gg', 'bb', 'cs', 'cs04', 'csw', 'ang', 'wang', 'eang', 'ehang', 'wehang', 'dir', 'sp', 'spang', 'fam', 'sct', 'sc', 'scang', 'ssp', 'fsp', 'msp', 'wsep', 'sep', 'tl', 'cfl', 'fl', 'fltg', 'flpos', 'msl', 'na', 'chl', 'tsp', 'sfr', 'ehl', 'rsc', 'kill_count', 'accessory', 'nk', 'ip', 'onk', 'md', 'wmd', 'dead_amt', 'alive_amt', 'fpos', 'ftg', 'fx', 'fy', 'fapos', 'fatg', 'fa', 'iiv', 'dead']),
    'fls[0..2], fls[52]': [o.fls[0], o.fls[1], o.fls[2], o.fls[52]],
    pts: o.pts.map(p => pick(p, ['xx', 'yy', 'smu', 'ltn', 'ebx', 'eby', 'iang'])),
    view: [S.view_xx, S.view_yy], lf: [S.lfsx, S.lfsy, S.lfcv, S.lfvsx, S.lfvsy, S.lfesid], wumsts: S.wumsts,
    randUsed: W.randLog.slice(),
  }, without(F.x, ['bytes']));
  // Lazy fields stay absent, not false (brief 10.2).
  for (const k of ['dir', 'iiv', 'dead', 'edir']) assert.ok(!(k in o), k);
  assert.ok(o.fls instanceof Float32Array && o.fxs instanceof Float32Array && o.fas instanceof Float32Array && o.fas.length === 26);
  assert.ok(o.pts.every(p => !('dying' in p)));
  allFramesUsed(W); allWorldsUsed(F);
});

test('A3 other snake goes to the front; nick through gdnm', () => {
  const F = fixture('A3'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(0.5, 0.5, 0.5);
  assert.strictEqual(W.next(), null);
  const o = S.os.s7;
  same({
    order: S.slithers.map(s => s.id), nk: o.nk, cv: o.cv, rr: o.rr, ang: o.ang, eang: o.eang, sct: o.sct,
    pts: o.pts.map(p => pick(p, ['xx', 'yy', 'smu', 'iang', 'ebx', 'eby'])), slitherStillOwn: S.slither.id,
    gdnm: { 'x1234567': A.gdnm('x1234567'), 'x123456': A.gdnm('x123456'), '12-34-567': A.gdnm('12-34-567'), '12a34567': A.gdnm('12a34567'), '1 2 3 4 5 6 7': A.gdnm('1 2 3 4 5 6 7') },
  }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A4 own repeat-angle move then angle move: chain pull, head ring, camera ring', () => {
  const F = fixture('A4'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  const o = S.slither;
  const r = { before: o.pts.map(p => [p.xx, p.yy]), xxBefore: [o.xx, o.yy] };
  W.next();
  r.afterRepeat = {
    pts: o.pts.map(p => pick(p, ['xx', 'yy', 'smu', 'ltn', 'ebx', 'eby', 'iang', 'dying'])),
    o: pick(o, ['xx', 'yy', 'fx', 'fy', 'fchl', 'chl', 'ftg', 'fpos', 'ehl', 'sct', 'sc', 'tl', 'fl']),
    'fxs[0..2]': [o.fxs[0], o.fxs[1], o.fxs[2]], 'fchls[0..1]': [o.fchls[0], o.fchls[1]],
    view: [S.view_xx, S.view_yy], bg: [S.bgx2, S.bgy2], 'fvxs[0..1]': [S.fvxs[0], S.fvxs[1]], 'fvys[0]': S.fvys[0], fvtg: S.fvtg, ovxx: [S.ovxx, S.ovyy],
  };
  W.next();
  r.afterAngle = {
    lastPt: pick(o.pts[o.pts.length - 1], ['xx', 'yy', 'iang', 'ltn', 'ebx', 'eby']),
    dyingCount: o.pts.filter(p => p.dying).length, len: o.pts.length,
    o: pick(o, ['xx', 'yy', 'fx', 'fy', 'ftg']), 'fxs[0..1]': [o.fxs[0], o.fxs[1]],
    view: [S.view_xx, S.view_yy], bg: [S.bgx2, S.bgy2], 'fvxs[0..1]': [S.fvxs[0], S.fvxs[1]],
    pts: o.pts.map(p => [p.xx, p.yy, p.smu]),
  };
  same(r, F.x);
  // the tile phase is slDrawWorld's: called once per own move with the view from before the move
  same(W.tile, [[10032, 10002], [10043, 10004]]);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A5 own repeat move in view: point rings', () => {
  const F = fixture('A5'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  const o = S.slither;
  o.iiv = true; o.fx = -3.25; o.fy = 1.5;
  W.next();
  same({ newPoint: ptView(o.pts[o.pts.length - 1]), pulled: o.pts.slice(0, o.pts.length - 3).map(ptView), o: pick(o, ['xx', 'yy', 'fx', 'fy', 'ftg']) }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A5b in view, head within 1 unit of the last point: no normalising', () => {
  const F = fixture('A5b'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  const o = S.slither;
  const lp = o.pts[o.pts.length - 1];
  o.iiv = true; o.xx = lp.xx + 0.5; o.yy = lp.yy + 0.25; o.fx = 0; o.fy = 0;
  W.next();
  same({ newPoint: ptView(o.pts[o.pts.length - 1]) }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A6 own grow with angle (N, pv 15)', () => {
  const F = fixture('A6'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  const o = S.slither;
  W.next();
  same({ o: pick(o, ['sct', 'fam', 'tl', 'fl', 'fltg', 'sc', 'scang', 'wsep', 'xx', 'yy']), 'fls[0..2]': [o.fls[0], o.fls[1], o.fls[2]], len: o.pts.length, dying: o.pts.filter(p => p.dying).length, wumsts: S.wumsts }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A7 pv 14 relative move: (lpo.xx + bx) - 128', () => {
  const F = fixture('A7'); const W = F.world(); const S = W.S;
  W.next();
  W.randQ.push(.5, .5, .5, .5, .5, .5);
  W.next(); W.next();
  const o = S.os.s9;
  const lp = o.pts[o.pts.length - 1];
  const lpx = lp.xx, lpy = lp.yy;
  W.next();
  const np = o.pts[o.pts.length - 1];
  same({ lpo: [lpx, lpy], newPoint: [np.xx, np.yy], leftToRight: [(lpx + 200) - 128, (lpy + 3) - 128], grouped: [lpx + (200 - 128), lpy + (3 - 128)], iang: np.iang }, F.x);
  assert.ok(!('iang' in np));
  allFramesUsed(W); allWorldsUsed(F);
});

test('A8 e-family: other plen 6, then own short forms', () => {
  const F = fixture('A8'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(.5, .5, .5);
  W.next();
  const o = S.os.s7;
  const angBefore = o.ang;
  W.next();
  const r = { other: pick(o, ['dir', 'ang', 'wang', 'eang', 'sp', 'spang', 'fa', 'fatg', 'fapos']), angBefore, 'fas[0..2], fas[25]': [o.fas[0], o.fas[1], o.fas[2], o.fas[25]] };
  const me = S.slither;
  const eangBefore = me.eang;
  W.next();
  r.ownE = pick(me, ['ang', 'dir', 'wang', 'sp', 'fa', 'fatg']); r.ownEfas = [me.fas[0], me.fas[1]];
  W.next();
  r.own4 = pick(me, ['dir', 'wang', 'eang', 'sp', 'spang']); r.eangUnchanged = me.eang === eangBefore;
  W.next();
  r.ownD = pick(me, ['dir', 'ang', 'wang', 'sp', 'spang']); r.ownDfas0 = me.fas[0];
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A9 h fam then r tail on the own snake', () => {
  const F = fixture('A9'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  const o = S.slither;
  W.next();
  const r = { afterH: pick(o, ['fam', 'tl', 'fl', 'fltg']), 'afterH fls[0..1]': [o.fls[0], o.fls[1]] };
  W.next();
  r.afterR = pick(o, ['fam', 'sct', 'sc', 'scang', 'ssp', 'fsp', 'wsep', 'tl', 'fl']);
  r.dying = o.pts.map(p => !!p.dying);
  r['afterR fls[0..1]'] = [o.fls[0], o.fls[1]];
  W.next();
  r.afterR2 = pick(o, ['fam', 'sct', 'tl', 'fl']); r.dying2 = o.pts.map(p => !!p.dying);
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A10 R before the own snake throws and drops the rest of the message', () => {
  const F = fixture('A10'); const W = F.world(); const S = W.S;
  W.next();
  const err = W.next();
  const r = { err, sectorsAfterThrow: S.sectors.length };
  W.randQ.push(.5, .5, .5);
  W.next();
  W.next();
  r.rsc = S.slither.rsc; r.sectors = S.sectors.map(s => [s.xx, s.yy]);
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A11 F (pv 15) incl. a negative id, then b and f short forms', () => {
  const F = fixture('A11'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(0.25, 0.75, 0.1, 0.9, 0.6, 0.4);
  W.next();
  W.randQ.push(0.5, 0.5);
  W.next();
  const r = { foods_c: S.foods_c, foods: S.foods.slice(0, S.foods_c).map(f => pick(f, ['id', 'xx', 'yy', 'sz', 'cv', 'rsp', 'rad', 'fr', 'gfr', 'wsp', 'gr', 'cv2', 'gcv', 'g2cv', 'fi', 'gfi', 'g2fi', 'sx', 'sy', 'eaten_fr', 'lrrad'])) };
  W.randQ.push(.5, .5, .5, .5);
  W.next(); W.next();
  r.lf = [S.lfsx, S.lfsy, S.lfcv];
  r.bf = S.foods.slice(4, S.foods_c).map(f => pick(f, ['id', 'xx', 'yy', 'cv', 'rsp', 'sz', 'sx', 'sy']));
  same(r, F.x);
  assert.ok(S.foods.slice(0, S.foods_c).every(f => !('eaten' in f) && !('eaten_by' in f)));
  allFramesUsed(W); allWorldsUsed(F);
});

test('A12 food removal order and eaten marks', () => {
  const F = fixture('A12'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(...Array(20).fill(.5));
  W.next();
  const ids = () => S.foods.slice(0, S.foods_c).map(f => f.id & 0xffff);
  const r = { start: ids() };
  W.next();
  r.afterC22 = ids(); r.nullTail = S.foods[S.foods_c] === null; r.foods_c = S.foods_c;
  W.next();
  r.afterCwithEsidMinus1 = ids();
  W.next();
  const f4 = S.foods.find(f => f && (f.id & 0xffff) === 0x0404);
  r.afterLt = { ids: ids(), eaten: f4.eaten, eaten_by_is_own: f4.eaten_by === S.slither, eaten_fr: f4.eaten_fr, lfesid: S.lfesid };
  W.next();
  const f1 = S.foods.find(f => f && (f.id & 0xffff) === 0x0101);
  r.unknownEater = { ids: ids(), eaten: f1.eaten, eaten_by: f1.eaten_by === undefined ? 'undefined' : 'set', lfesid: S.lfesid };
  W.next();
  const f5 = S.foods.find(f => f && (f.id & 0xffff) === 0x0505);
  r.CwithEsid55 = { ids: ids(), eaten: f5.eaten, lfvs: [S.lfvsx, S.lfvsy] };
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A13 w removes the sector foods (swap with last) and every duplicate sector', () => {
  const F = fixture('A13'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(...Array(40).fill(.5));
  W.next(); W.next(); W.next(); W.next(); W.next();
  const lab = f => `${f.sx},${f.sy}:${f.id & 0xff}`;
  const r = { start: S.foods.slice(0, S.foods_c).map(lab), sectors: S.sectors.map(s => [s.xx, s.yy]) };
  W.next();
  r.after = S.foods.slice(0, S.foods_c).map(lab); r.sectorsAfter = S.sectors.map(s => [s.xx, s.yy]);
  r.foods_len_array = S.foods.length; r.tailNulls = S.foods.slice(S.foods_c);
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A14 prey add, move, eaten, remove', () => {
  const F = fixture('A14'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(0.3, 0.6);
  W.next();
  const pr = S.preys[0];
  const r = { add: pick(pr, ['id', 'xx', 'yy', 'rad', 'sz', 'cv', 'dir', 'wang', 'ang', 'sp', 'fr', 'gfr', 'gr', 'rr', 'gg', 'bb', 'cs', 'cv2', 'fi', 'gcv', 'gfi', 'fpos', 'ftg', 'fx', 'fy', 'eaten', 'eaten_fr']) };
  W.next();
  r.j15 = pick(pr, ['xx', 'yy', 'dir', 'ang', 'wang', 'sp', 'fx', 'fy', 'ftg', 'fpos']); r.j15fxs = [pr.fxs[0], pr.fxs[1], pr.fxs[52]];
  W.next();
  r.j8 = pick(pr, ['xx', 'yy', 'sp', 'fx', 'fy']);
  W.randQ.push(.5, .5, .5, .5);
  W.next(); W.next();
  r.order = S.preys.map(p => p.id);
  W.next();
  r.eatenByOwn = { order: S.preys.map(p => p.id), eaten: S.preys[1].eaten, own: S.preys[1].eaten_by === S.slither, eaten_fr: S.preys[1].eaten_fr };
  W.next();
  r.eatenByUnknown = S.preys.map(p => p.id);
  W.next();
  r.afterRemove = S.preys.map(p => p.id);
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A15 z twice: border ring; a filled it', () => {
  const F = fixture('A15'); const W = F.world(); const S = W.S;
  W.next(); W.next();
  const r = { z1: { real_flux_grd: S.real_flux_grd, flux_grd: S.flux_grd, flx_tg: S.flx_tg, flux_grd_pos: S.flux_grd_pos, v: [S.flux_grds[0], S.flux_grds[1], S.flux_grds[27], S.flux_grds[55]] } };
  W.next();
  r.z2 = { real_flux_grd: S.real_flux_grd, flux_grd: S.flux_grd, flx_tg: S.flx_tg, v: [S.flux_grds[0], S.flux_grds[1], S.flux_grds[27], S.flux_grds[55]] };
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A16 leaderboard strings, own row, filtered name as NULs', () => {
  const F = fixture('A16'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  S.my_nick = 'Me&<Q> x';
  W.next();
  same({ rank: S.rank, best_rank: S.best_rank, slither_count: S.slither_count, biggest: S.biggest_slither_count, wumsts: S.wumsts, lb_fr: S.lb_fr, lbs: W.hud.lbs, lbn: W.hud.lbn, lbp: W.hud.lbp }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A17 m: the four text forms; a non-positive score keeps the old text', () => {
  const F = fixture('A17'); const W = F.world();
  W.next();
  const out = {};
  W.next(); out.nickAndMsg = W.hud.vcm;
  W.next(); out.msgOnly = W.hud.vcm;
  W.next(); out.nickOnly = W.hud.vcm;
  W.next(); out.neither = W.hud.vcm;
  const n = W.hud.calls.length;
  W.next(); out.scoreNotPositiveKeepsOld = W.hud.vcm;
  assert.strictEqual(W.hud.calls.length, n, 'no setVcm call for score -5');
  same(out, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A18 pong, kill count, v 0 / 1 / 2', () => {
  const F = fixture('A18'); const x = F.x;
  const W = F.world(); const S = W.S;
  spawnOwn(W);
  S.lagging = true; S.lag_mult = .4; S.wfpr = true;
  W.next();
  const r = { afterP: pick(S, ['wfpr', 'lagging', 'lag_mult', 'etm']) };
  W.next();
  r.kill_count = S.slither.kill_count;
  clock.t = 5000;
  S.lag_mult = .5; S.lagging = true;
  W.next();
  r.v0 = pick(S, ['dead_mtm', 'want_close_socket', 'lagging', 'lag_mult', 'want_victory_message', 'playing']);
  // slHud builds the lastscore text from (final_score, v); the expected text carries the same number.
  same(W.hud.calls.filter(c => c[0] === 'gameOver'), [['gameOver', 110, false]], 'v0 gameOver args');
  assert.ok(x.v0.lastscore.endsWith('<b>110</b>'));
  allFramesUsed(W);
  const W2 = F.world(); const S2 = W2.S;
  spawnOwn(W2);
  W2.next();
  r.v1 = pick(S2, ['dead_mtm', 'want_close_socket', 'want_victory_message', 'want_victory_focus']);
  same(W2.hud.calls.filter(c => c[0] === 'gameOver'), [['gameOver', 110, true]], 'v1 gameOver args');
  allFramesUsed(W2);
  const W3 = F.world(); const S3 = W3.S;
  spawnOwn(W3);
  W3.next();
  r.v2 = pick(S3, ['dead_mtm', 'want_close_socket', 'want_victory_message', 'want_hide_victory', 'hvfr']);
  assert.strictEqual(W3.hud.calls.filter(c => c[0] === 'gameOver').length, 0);
  clock.t = 1000;
  same(r, Object.assign({}, x, { v0: without(x.v0, ['lastscore']) }));
  allFramesUsed(W3); allWorldsUsed(F);
});

test('A19 s remove: kill keeps the snake listed, non-kill splices, own pointer kept', () => {
  const F = fixture('A19'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(...Array(6).fill(.5));
  W.next(); W.next();
  const o7 = S.os.s7, o8 = S.os.s8;
  const r = { start: S.slithers.map(s => s.id) };
  W.next();
  r.kill = { order: S.slithers.map(s => s.id), o7: pick(o7, ['id', 'dead', 'dead_amt', 'edir']), inOs: 's7' in S.os };
  W.next();
  r.nonKill = { order: S.slithers.map(s => s.id), o8id: o8.id, inOs: 's8' in S.os };
  W.next();
  r.ownRemoved = { order: S.slithers.map(s => s.id), slitherStillSet: S.slither != null, slitherId: S.slither.id };
  same(r, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A20 minimap events go to slHud unchanged, in order (the handler is slHud\'s)', () => {
  const F = fixture('A20'); const W = F.world(); const S = W.S;
  W.next();
  W.next(); W.next();
  const mm = W.hud.calls.filter(c => c[0] === 'onMinimap').map(c => c[1]);
  assert.strictEqual(mm.length, 2);
  assert.strictEqual(mm[0].cmd, 'M'); assert.strictEqual(mm[0].size, 24); assert.strictEqual(mm[0].raw.size, 24);
  same(mm[0].pixels, [[23, 23], [17, 23], [1, 23], [0, 23]]);
  assert.strictEqual(mm[1].cmd, 'V'); same(mm[1].toggles, [[23, 23], [22, 23]]);
  assert.strictEqual(S.mmgad, false, 'slApply writes no minimap state');
  allFramesUsed(W); allWorldsUsed(F);
});

test('A21 deadpool reuse in s: stale iang kept, rings zeroed', () => {
  const F = fixture('A21'); const W = F.world(); const S = W.S;
  W.next();
  const old = { fxs: new Float32Array(53).fill(7), fys: new Float32Array(53).fill(7), fltns: new Float32Array(53).fill(7), fsmus: new Float32Array(53).fill(7), iang: 777, dying: false, smu: 0.1 };
  S.points_dp.add(old);
  W.randQ.push(.5, .5, .5);
  W.next();
  const p0 = S.slither.pts[0];
  same({ recycledIsFirst: p0 === old, iang: p0.iang, smu: p0.smu, fxs0: p0.fxs[0], fxs52: p0.fxs[52], dpEnd: S.points_dp.end_pos, lastIang: S.slither.pts[2].iang }, F.x);
  assert.ok([p0.fxs, p0.fys, p0.fltns, p0.fsmus].every(ring => ring.every(v => v === 0)));
  assert.strictEqual(p0.dying, false);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A22 socket close while playing: gameOver, resetGame, then not connected', () => {
  const F = fixture('A22'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(.5, .5);
  W.next(); W.next();
  S.bgx2 = .3;
  clock.t = 7000;
  W.net.open = true;
  const fvxs = S.fvxs;
  A.applyClose();
  clock.t = 1000;
  same(pick(S, ['dead_mtm', 'connected', 'playing', 'want_close_socket', 'foods_c', 'slither', 'protocol_version', 'flx_tg', 'flux_grd_pos', 'gsc', 'bgx2', 'lag_mult', 'rank', 'best_rank', 'mmgad', 'fvtg', 'lfsx']), without(F.x, ['ws']));
  assert.strictEqual(W.net.closes, 1, 'resetGame closed the socket');
  same(W.hud.calls.map(c => c[0]), ['onInit', 'gameOver', 'resetHud']);
  assert.strictEqual(S.fvxs, fvxs, 'camera ring zeroed in place');
  assert.strictEqual(S.slithers.length, 0); assert.strictEqual(S.foods.length, 0); assert.strictEqual(Object.keys(S.os).length, 0);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A23 duplicate s id: both listed, os points at the new one', () => {
  const F = fixture('A23'); const W = F.world(); const S = W.S;
  spawnOwn(W);
  W.randQ.push(...Array(6).fill(.5));
  W.next();
  const first = S.os.s7;
  W.next();
  same({ order: S.slithers.map(s => s.id), osIsNew: S.os.s7 !== first, firstStillListed: S.slithers.includes(first), len: S.slithers.length }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A24 before a: s and l ignored, W and z applied', () => {
  const F = fixture('A24'); const W = F.world(); const S = W.S;
  W.randQ.push(...Array(10).fill(.5));
  W.next();
  const r = { slithers: S.slithers.length, slither: S.slither };
  W.next(); r.rank = S.rank;
  W.next(); r.sectors = S.sectors.length;
  W.next(); r.real_flux_grd = S.real_flux_grd; r.pv = S.protocol_version;
  same(r, F.x);
  assert.strictEqual(W.randLog.length, 0, 'no random draw for an ignored s');
  assert.strictEqual(W.hud.calls.length, 0);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A25 s at pv 14: o.ang is the packet angle', () => {
  const F = fixture('A25'); const W = F.world(); const S = W.S;
  W.next();
  W.randQ.push(.5, .5, .5);
  W.next();
  const o = S.slither;
  same({ ang: o.ang, ehang: o.ehang, wang: o.wang, packetAng: 4194304 * 2 * Math.PI / 16777215, pts: o.pts.map(p => [p.xx, p.yy, p.smu, p.iang]) }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

test('A26 v 0 with no own snake while playing throws after clearing lag', () => {
  const F = fixture('A26'); const W = F.world(); const S = W.S;
  W.next();
  S.lagging = true; S.lag_mult = .3;
  const err = W.next();
  same({ err, dead_mtm: S.dead_mtm, lagging: S.lagging, lag_mult: S.lag_mult, sectors: S.sectors.length, want_close_socket: S.want_close_socket }, F.x);
  allFramesUsed(W); allWorldsUsed(F);
});

// ---------------------------------------------------------------- DWH and DS vectors (hand-built events)

const INIT300 = { type: 'init', grd: 21600, mscps: 300, sectorSize: 300, sectorCount: 144, spangdv: 4.8, nsp1: 4.25, nsp2: 0.5, nsp3: 12, mamu: 0.033, mamu2: 0.028, cst: 0.43 };
const fam24 = v => v / 16777215;   // the client's fam expression (game.js:7929)

test('DWH 9.2 newFood picks and fields', () => {
  const table = [
    [1.157142857142857, [[1, 1, 5, 11, 5], [2.4, 2, 7, 14, 7], [5, 5, 9, 16, 11], [8.6, 10, 12, 16, 17], [10, 11, 13, 16, 18], [15, 16, 16, 16, 25], [16.5, 16, 16, 16], [30, 16, 16, 16]]],
    [1, [[1, 1, 5, 10], [2.4, 2, 6, 12], [5, 5, 8, 16], [8.6, 8, 10, 16], [10, 10, 11, 16], [15, 15, 15, 16, 24], [16.5, 16, 16, 16], [30, 16, 16, 16]]],
    [0.75, [[1, 0, 3, 7, 4], [2.4, 1, 4, 9], [5, 3, 6, 12], [8.6, 6, 8, 16], [10, 7, 8, 16], [15, 11, 11, 16], [16.5, 12, 12, 16], [30, 16, 16, 16]]],
  ];
  for (const [gsc, rows] of table) {
    for (const [sz, cv2, gcv, g2cv, fw] of rows) {
      const W = newWorld([], { sized: true }); const S = W.S;
      S.gsc = gsc;
      W.randQ.push(.5, .25);
      const fo = A.newFood(7, 1000, 2000, sz, true, 12);
      const tag = `gsc ${gsc} sz ${sz}`;
      assert.strictEqual(fo.cv2, cv2, tag); assert.strictEqual(fo.gcv, gcv, tag); assert.strictEqual(fo.g2cv, g2cv, tag);
      if (fw !== undefined) assert.strictEqual(fo.fw, fw, tag);
      assert.strictEqual(fo.cv, 3); assert.strictEqual(fo.rsp, 3); assert.strictEqual(fo.rad, 0.00001);
      assert.strictEqual(fo.gfr, 32); assert.strictEqual(fo.wsp, -0.01125); assert.strictEqual(S.foods_c, 1);
      assert.strictEqual(fo.gr, .65 + .1 * sz);
      if (sz === 16.5) assert.strictEqual(fo.gr, 2.3000000000000003);
      assert.strictEqual(S.foods[0], fo);
    }
  }
  // field order (DWH 2.5); eaten and eaten_by are not created
  const W = newWorld([], { sized: true });
  const fo = A.newFood(1, 2, 3, 4, false, 2);
  assert.strictEqual(Object.keys(fo).join(','), 'id,xx,yy,rx,ry,rsp,cv,rad,sz,lrrad,cv2,fi,fw,fh,fw2,fh2,ofi,ofw,ofh,ofw2,ofh2,gcv,gfi,gfw,gfh,gfw2,gfh2,g2cv,g2fi,g2fw,g2fh,g2fw2,g2fh2,fr,gfr,gr,wsp,eaten_fr');
  assert.strictEqual(fo.rsp, 1);
  assert.strictEqual(W.randLog.length, 2);
});

test('DWH 9.3 newPrey picks and fields', () => {
  for (const [gsc, list] of [[1.157142857142857, [[1, 2, 48], [3.2, 9, 62], [6, 16, 76], [9, 21, 86], [12, 21, 86]]], [1, [[1, 2], [3.2, 7], [6, 14], [9, 21], [12, 21]]]]) {
    for (const [sz, cv2, fw] of list) {
      const W = newWorld([], { sized: true }); const S = W.S;
      S.gsc = gsc;
      W.randQ.push(.5, .25);
      const pr = A.newPrey(3, 1000, 2000, sz, 13, 1, 1.5, 1.25, 2.5);
      assert.strictEqual(pr.cv2, cv2, `gsc ${gsc} sz ${sz}`);
      if (fw !== undefined) assert.strictEqual(pr.fw, fw);
      assert.strictEqual(pr.cv, 4); assert.strictEqual(pr.cs, '#288860'); assert.strictEqual(pr.gcv, 16); assert.strictEqual(pr.gfw, 157);
      assert.strictEqual(pr.gfr, 32); assert.strictEqual(pr.gr, .5 + .25 * .15 + .1 * sz);
      if (sz === 1) assert.strictEqual(pr.gr, 0.6375);
      assert.strictEqual(S.preys[0], pr);
      assert.ok(pr.fxs instanceof Float32Array && pr.fxs.length === 53);
    }
  }
});

test('DWH 9.21 colour wraps of newFood and newPrey', () => {
  const W = newWorld([]); const S = W.S;
  S.gsc = 1;
  for (const [cv, want] of [[9, 9], [10, 1], [17, 8], [18, 0], [26, 8]]) assert.strictEqual(A.newFood(1, 0, 0, 5, true, cv).cv, want, 'food cv ' + cv);
  for (const [cv, pcv, cs, rr] of [[8, 8, '#e030e0', 224], [9, 0, '#ffffff', 255], [13, 4, '#288860', 40], [41, 5, '#8080ff', 128], [42, 6, '#aNaNaN', NaN], [45, 0, '#aNaNaN', NaN]]) {
    const pr = A.newPrey(1, 0, 0, 5, cv, 0, 0, 0, 0);
    assert.strictEqual(pr.cv, pcv); assert.strictEqual(pr.cs, cs); assert.ok(Object.is(pr.rr, rr), 'prey cv ' + cv);
  }
});

test('DWH 9.10 leaderboard of 10 rows', () => {
  const W = newWorld([[INIT300]]); const S = W.S;
  W.next();
  S.my_nick = 'Owen'; S.lb_fr = -1; S.dead_mtm = -1;
  const rows = [[250, 8388607, 3, 'Big Snake'], [120, 0, 0, 'x'], [80, 16777215, 11, 'a<b>&c'], [40, 1000, 4, '1234567'], [20, 0, 8, ''],
    [12, 0, 2, 'r6'], [11, 0, 5, 'r7'], [10, 0, 6, 'r8'], [9, 0, 7, 'r9'], [8, 0, 1, 'r10']]
    .map(([sct, f, cv, nick]) => ({ sct, fam: fam24(f), nick, raw: { cv } }));
  A.applyFrame([{ type: 'leaderboard', myPos: 2, rank: 7, count: 300, rows }], 0);
  same(pick(S, ['rank', 'slither_count', 'best_rank', 'lb_fr', 'wumsts']), { rank: 7, slither_count: 300, best_rank: 7, lb_fr: 0, wumsts: true });
  const cells = s => s.split('<BR>').slice(0, -1);
  same(cells(W.hud.lbs).map(c => Number(/>(-?\d+)</.exec(c)[1])), [30196, 3181, 1707, 682, 302, 167, 151, 135, 119, 103]);
  same(cells(W.hud.lbs).map(c => /opacity:([^;]+);/.exec(c)[1]), ['0.6509999999999999', '1', '0.5529999999999999', '0.504', '0.4549999999999999', '0.40599999999999997', '0.357', '0.30799999999999994', '0.259', '0.21']);
  const names = cells(W.hud.lbn);
  assert.strictEqual(names[0], '<span style="opacity:0.6509999999999999; color:#80ff80;">Big&nbsp;Snake</span>');
  assert.strictEqual(names[1], '<span style="opacity:1; color:#c080ff;font-weight:bold;">Owen</span>');
  assert.ok(names[2].endsWith('>a&lt;b&gt;&amp;c</span>'));
  assert.ok(names[3].endsWith('>' + '\u0000'.repeat(7) + '</span>'));
  assert.ok(names[4].endsWith('"></span>'));
  assert.strictEqual(cells(W.hud.lbs)[0], '<span style="opacity:0.6509999999999999; color:#80ff80;">30196</span>');
  assert.strictEqual(cells(W.hud.lbp)[0], '<span style="opacity:0.6509999999999999; color:#80ff80;">#1</span>');
});

test('DWH 9.11 gdnm', () => {
  newWorld([]);
  const want = { 'Owen': true, '': true, '123456': true, '1234567': false, '123 456 7': false, '12345a67890': true, 'a1b2c3d4e5f6g7': true,
    '555-123-4567': false, 'phone 5551234': false, '+1 (555) 123-4567': false };
  for (const [s, v] of Object.entries(want)) assert.strictEqual(A.gdnm(s), v, s);
});

test('DWH 9.12 and 9.19 m with mscps 300', () => {
  const W = newWorld([[INIT300]]); W.next();
  const m = (sct, nick, msg) => { A.applyFrame([{ type: 'longest_msg', sct, fam: 0, nick, msg }], 0); return W.hud.vcm; };
  assert.strictEqual(m(500, 'Champ', ''), "<i><span style='opacity: .5;'>Today's longest was </span><span style='opacity: .75;'><b>Champ</b></span></i><br><i><span style='opacity: .5;'>with a length of </span><span style='opacity: .65;'><b>8200468</b></span></i>");
  assert.ok(m(500, 'Champ', 'gg <3 & bye').startsWith("<span style='font-size:17px;'><b><i><span style='opacity: .5;'>&quot;</span>gg &lt;3 &amp; bye<span style='opacity: .5;'>&quot;</span></i></b></span><BR><div style='height: 5px;'></div><i><span style='opacity: .5;'>- </span>"));
  assert.strictEqual(m(500, '', ''), "<i><span style='opacity: .5;'>Today's longest: </span><span style='opacity: .75;'><b>8200468</b></span></i>");
  assert.strictEqual(m(500, '1234567', 'hi'), m(500, '', 'hi'));
  W.hud.vcm = 'OLD';
  assert.strictEqual(m(1, 'Zed', ''), 'OLD');
  assert.strictEqual(m(16777215, 'A', ''), 'OLD');
  assert.strictEqual(W.S.fpsls.length, 2349);
});

test('DWH 9.20 l with playing false, then while dead', () => {
  const W = newWorld([]); const S = W.S;
  S.lb_fr = -1;
  const ev = () => ({ type: 'leaderboard', myPos: 1, rank: 1, count: 1, rows: [{ sct: 10, fam: 0, nick: 'a', raw: { cv: 0 } }] });
  W.hud.lbs = 'OLD';
  A.applyFrame([ev()], 0);
  same(pick(S, ['wumsts', 'lb_fr', 'rank']), { wumsts: false, lb_fr: -1, rank: 0 });
  assert.strictEqual(W.hud.lbs, 'OLD');
  S.playing = true; S.dead_mtm = 5000;
  A.applyFrame([ev()], 0);
  same(pick(S, ['wumsts', 'lb_fr', 'rank']), { wumsts: true, lb_fr: -1, rank: 1 });
  assert.notStrictEqual(W.hud.lbs, 'OLD');
});

test('DS T15 snake colours with rand .5', () => {
  const W = newWorld([]); const S = W.S;
  S.playing = true;
  const add = (id, cv) => ({ type: 'snake_add', id, cv, ang: 0, wang: 0, sp: 1, fam: 0, snx: 100, sny: 100, nick: 'n', raw: { pts: [{ x: 500, y: 500 }, { bx: 127, by: 127 }] } });
  const want = { 0: [0, 202, 138, 255, '#ca8aff', '#513766', '#e5c5ff'], 7: [7, 255, 74, 74, '#ff4a4a', '#661e1e', '#ffa5a5'],
    9: [7, 255, 74, 74, '#ff4a4a', '#661e1e', '#ffa5a5'], 60: [36, 50, 70, 183, '#3246b7', '#141c49', '#99a3db'] };
  let id = 1;
  for (const cv of Object.keys(want)) {
    A.applyFrame([add(id, Number(cv))], 0);
    const o = S.os['s' + id++];
    same([o.cv, o.rr, o.gg, o.bb, o.cs, o.cs04, o.csw], want[cv], 'cv ' + cv);
  }
});

// ---------------------------------------------------------------- order rules, gates and hygiene

test('foodRemoveAt keeps the shared cm1 in step (swap with last, stale nulls)', () => {
  const W = newWorld([]); const S = W.S;
  for (let i = 0; i < 4; i++) A.newFood(i, 0, 0, 1, true, 0);
  S.cm1 = S.foods_c - 1;
  A.foodRemoveAt(1);
  same(S.foods.map(f => f && f.id), [0, 3, 2, null]);
  assert.strictEqual(S.foods_c, 3); assert.strictEqual(S.cm1, 2);
  A.foodRemoveAt(2);
  same(S.foods.map(f => f && f.id), [0, 3, null, null]);
  assert.strictEqual(S.foods_c, 2); assert.strictEqual(S.cm1, 1);
});

test('resetGame keeps the quirks of core-apply 4.7 and closes only an open socket', () => {
  const W = newWorld([]); const S = W.S;
  S.fvpos = 9; S.lfsx = 4; S.view_xx = 77; S.bgx2 = .4; S.lb_fr = .5; S.dead_mtm = 123; S.protocol_version = 15;
  S.bgees = [{ sp: .7, sc: 0 }, { sp: .8, sc: 0 }];
  S.gsc = .5; S.fvxs[3] = 2; S.mmal = 1; S.mmgad = true; S.rank = 4;
  A.resetGame();
  assert.strictEqual(W.net.closes, 0);
  same(pick(S, ['fvpos', 'lfsx', 'view_xx', 'bgx2', 'lb_fr', 'dead_mtm', 'protocol_version', 'gsc', 'mmal', 'mmgad', 'rank', 'best_rank', 'lag_mult', 'cptm']),
    { fvpos: 9, lfsx: 4, view_xx: 77, bgx2: .4, lb_fr: .5, dead_mtm: 123, protocol_version: 15, gsc: S.sgsc, mmal: 0, mmgad: false, rank: 0, best_rank: 999999999, lag_mult: 1, cptm: 0 });
  assert.strictEqual(S.fvxs[3], 0);
  assert.strictEqual(S.bgees[0].sc, S.sgsc * .7); assert.strictEqual(S.bgees[1].sc, S.sgsc * .8);
  W.net.open = true;
  A.resetGame();
  assert.strictEqual(W.net.closes, 1);
});

test('ignored and unknown events only count; wire_error is skipped', () => {
  const W = newWorld([]); const S = W.S;
  const before = JSON.stringify(pick(S, ['playing', 'rank', 'sectors', 'foods_c']));
  A.applyFrame(['server_version', 'admin_info', 'team_scores', 'session_id', 'debug_point', 'unknown', 'malformed', 'empty'].map(type => ({ type })), 40);
  A.applyFrame([{ type: 'wire_error', reason: 'x', offset: 3 }], 4);
  assert.strictEqual(S.pkps, 8); assert.strictEqual(S.apkps, 2); assert.strictEqual(S.rdps, 44);
  assert.strictEqual(JSON.stringify(pick(S, ['playing', 'rank', 'sectors', 'foods_c'])), before);
});

test('render_mode follows is_mobile; cfl of a new snake follows render_mode', () => {
  const W = newWorld([], { mobile: true }); const S = W.S;
  assert.strictEqual(S.render_mode, 1);
  S.playing = true;
  A.applyFrame([{ type: 'snake_add', id: 3, cv: 1, ang: 0, wang: 0, sp: 1, fam: 0, snx: 1, sny: 1, nick: '', raw: { pts: [{ x: 50, y: 50 }, { bx: 128, by: 127 }] } }], 0);
  assert.strictEqual(S.slither.cfl, 2);
  assert.strictEqual(newWorld([]).S.render_mode, 2);
});

test('initApplyState defines every core-apply 1.4 key and never the non-globals', () => {
  const S = newWorld([]).S;
  for (const k of ['grd', 'mscps', 'fmlts', 'fpsls', 'sector_size', 'ssd256', 'sector_count_along_edge', 'spangdv', 'nsp1', 'nsp2', 'nsp3', 'mamu', 'mamu2', 'cst',
    'default_msl', 'protocol_version', 'real_sid', 'flux_grd', 'real_flux_grd', 'flux_grds', 'flux_grd_pos', 'flx_tg', 'team_mode', 'team_val', 'mmsta', 'mmrad', 'mmsz',
    'mmdata', 'mmgad', 'mmbfr', 'sgsc', 'gsc', 'render_mode', 'nsep', 'slithers', 'slither', 'os', 'foods', 'foods_c', 'cm1', 'preys', 'sectors', 'points_dp', 'rank',
    'best_rank', 'slither_count', 'biggest_slither_count', 'wumsts', 'lb_fr', 'dead_mtm', 'view_xx', 'view_yy', 'fvx', 'fvy', 'fvxs', 'fvys', 'fvpos', 'fvtg', 'ovxx', 'ovyy',
    'bgx2', 'bgy2', 'bgw2', 'bgh2', 'follow_view', 'lfsx', 'lfsy', 'lfcv', 'lfvsx', 'lfvsy', 'lfesid', 'etm', 'lag_mult', 'lagging', 'wfpr', 'playing', 'connected',
    'connecting', 'want_close_socket', 'want_victory_message', 'want_victory_focus', 'want_hide_victory', 'hvfr', 'adm', 'my_nick', 'rdps', 'apkps', 'pkps']) {
    assert.ok(Object.prototype.hasOwnProperty.call(S, k), k);
  }
  for (const k of ['msl', 'snake_id', 'snake_count']) assert.ok(!(k in S), k);
  same(pick(S, ['grd', 'sector_count_along_edge', 'gsc', 'lb_fr', 'dead_mtm', 'best_rank', 'mmsta', 'bgw2', 'bgh2']),
    { grd: 16384, sector_count_along_edge: 130.00001, gsc: 1.157142857142857, lb_fr: 0, dead_mtm: -1, best_rank: 999999999, mmsta: .475, bgw2: 599, bgh2: 519 });
});

test('source hygiene: no Math.random, no DOM, no reference paths, no em dash', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/sl/slApply.js'), 'utf8');
  assert.ok(!/Math\.random/.test(src));
  assert.ok(!/document\.|getContext|innerHTML\s*=|slither-reference|require\(/.test(src));
  assert.ok(!/—/.test(src));
});
