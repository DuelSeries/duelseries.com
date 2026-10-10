'use strict';
// slither.io free room, server side: every number we send on THEIR wire grid (SERVER-DESIGN section 7, task T2).
//
// shared/slWire.js can carry any finite double (it falls back to 8 raw bytes, kind 15). Parity needs the opposite:
// every value we send must be one their server could have sent. Each quantizer here returns
//   { raw, v }
// where `raw` is the integer their wire would carry and `v` is the client's OWN expression of that integer, written
// in the client's operator order (the game.js line is cited at each one) so the double matches bit for bit. The view
// only ever puts `v` (or `raw`, for the fields our wire carries as integers) into events, so slWire always finds a
// scale kind and never writes kind 15.
//
// Where the rounding is a server law, the law id is cited. Two roundings are not settled yet (T0 checks them):
// the 8-bit rotation angle byte (`L48.angRound`) and the 24-bit fam (`L17.famRound`). This module does not pick
// either one: the caller passes the rule it read from the law table ('floor' or 'round'), and a missing or unknown
// rule throws. Choices with no visible effect are marked CHOSEN and listed in BUILD-DECISIONS.md.
//
// Every quantizer throws on a non-finite input or a raw outside its wire field, so a sim bug can never reach a
// client as NaN or as a clipped number.

const slCore = require('../../shared/slCore.js');

const PI2 = 2 * Math.PI;
const U8 = 255;
const U16 = 65535;
const U24 = 16777215;

// Rounding rules a law row may name. `floor` and `round` only: the candidates T0 tests for L48.angRound and
// L17.famRound (SERVER-DESIGN 7, 19 T0).
const RULES = Object.freeze({ floor: Math.floor, round: Math.round });

function need(x, what) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new TypeError('slQuant: ' + what + ' must be a finite number, got ' + String(x));
  }
  return x;
}

function needRule(rule, lawId) {
  if (typeof rule !== 'string' || !Object.prototype.hasOwnProperty.call(RULES, rule)) {
    throw new RangeError('slQuant: ' + lawId + ' rule must be one of ' + Object.keys(RULES).join(', ') +
      ', got ' + String(rule));
  }
  return RULES[rule];
}

// Checks a raw against its field and turns -0 into 0 (a -0 raw would give a -0 value, which only kind 15 carries).
function field(raw, max, what) {
  if (!(raw >= 0 && raw <= max)) {
    throw new RangeError('slQuant: ' + what + ' raw ' + raw + ' is outside 0..' + max);
  }
  return raw === 0 ? 0 : raw;
}

// An angle moved into [0, 2 pi). A tiny negative angle can round up to exactly 2 pi; that is the same direction as 0.
function wrapAngle(a) {
  let w = a % PI2;
  if (w < 0) w += PI2;
  if (w >= PI2) w -= PI2;
  return w === 0 ? 0 : w;
}

// ------------------------------------------------------------------ snake_rot fields (8-bit angles, speed / 18)

// Rotation `ang` (and a wanted angle that is not on the L15 grid, such as during an arrow-key turn): 8-bit byte.
// Rounding = the L48.angRound row. Client: `ang = a[m] * 2 * Math.PI / 256` (game.js:7401).
function rotAng(a, rule) {
  const f = needRule(rule, 'L48.angRound');
  const w = wrapAngle(need(a, 'rotation angle'));
  const raw = f(w * 256 / PI2) & U8;          // a round up to 256 is the same direction as 0
  return { raw: raw, v: raw * 2 * Math.PI / 256 };
}

// Wanted angle from the player's direction byte b (0..250): L15 WANG_MAP, byte = floor(256 b / 251). The sim stores
// `v` as the snake's wang, so the server's wanted angle is on the wire grid by construction.
// Client: `wang = a[m] * 2 * Math.PI / 256` (game.js:7401 form, rotation wang).
function wangFromInput(b) {
  if (!Number.isInteger(b) || b < 0 || b > 250) {
    throw new RangeError('slQuant: direction byte must be an integer 0..250, got ' + String(b));
  }
  const raw = Math.floor(256 * b / 251);
  return { raw: raw, v: raw * 2 * Math.PI / 256 };
}

// Rotation `sp`: L12 SPEED_WIRE, trunc(18 sp). Client: `speed = a[m] / 18` (game.js:7405).
function rotSp(sp) {
  const raw = field(Math.trunc(18 * need(sp, 'speed')), U8, 'rotation sp');
  return { raw: raw, v: raw / 18 };
}

// ------------------------------------------------------------------ 24-bit angles, speed / 1000 (snake_add, prey)

// u24 angle for `snake_add` ang and wang and every prey angle. Rounding CHOSEN: nearest (one u24 step is
// 3.7e-7 rad, invisible). 2 pi - tiny may give 16777215, which is 2 pi, the same direction as 0 and a legal raw.
// Client: `(u24) * 2 * Math.PI / 16777215` (game.js:7558, 8423, 8893-8911).
function ang24(a) {
  const w = wrapAngle(need(a, 'angle'));
  const raw = field(Math.round(w * U24 / PI2), U24, 'u24 angle');
  return { raw: raw, v: raw * 2 * Math.PI / 16777215 };
}

// Speed for `snake_add` and prey: L12 SPEED_WIRE, trunc(1000 sp) (prey: P:458-467, SERVER-DESIGN 7).
// Client: `(u16) / 1E3` (game.js:7566, 8430).
function sp1000(sp) {
  const raw = field(Math.trunc(1000 * need(sp, 'speed')), U16, 'u16 speed');
  return { raw: raw, v: raw / 1E3 };
}

// ------------------------------------------------------------------ fam

// fam on `h`, `r`, grow moves, `snake_add` and leaderboard rows: u24 of min(1, fam), rounding = the L17.famRound
// row. fam above 1 (even 2) is sent as the clamped raw 16777215 (L18, FG:179-182). A negative fam is a sim bug and
// throws. Client: `fam = (u24) / 16777215` (game.js:7605).
function fam24(fam, rule) {
  const f = needRule(rule, 'L17.famRound');
  need(fam, 'fam');
  if (fam < 0) throw new RangeError('slQuant: fam must not be negative, got ' + fam);
  const raw = field(Math.min(U24, f(Math.min(1, fam) * U24)), U24, 'fam');
  return { raw: raw, v: raw / 16777215 };
}

// ------------------------------------------------------------------ positions

// `snake_add` snx and sny (the server's continuous head), a `snake_add` first body point, `prey_add` position:
// round(5 x) as u24. Client: `(u24) / 5` (game.js:8437, 8470-8478, 8889-8892).
function pos5(x) {
  const raw = field(Math.round(5 * need(x, 'position')), U24, 'u24 position');
  return { raw: raw, v: raw / 5 };
}

// Absolute move `xx`, `yy` (forms `+`, `=`): u16 integers, which the sim stores back into its point
// (SERVER-DESIGN 7; client takes the integer as is, game.js:7713-7720).
function absXY(x) {
  const raw = field(Math.round(need(x, 'absolute position')), U16, 'u16 position');
  return { raw: raw, v: raw };
}

// `prey_move` position: round((x - 1) / 3) as u16. Client: `xx = 1 + (u16) * 3` (game.js:8798).
function preyPos(x) {
  const raw = field(Math.round((need(x, 'prey position') - 1) / 3), U16, 'prey position');
  return { raw: raw, v: 1 + raw * 3 };
}

// ------------------------------------------------------------------ radius bytes

// Food radius from its byte (L24 DROP_BYTE and L27 NATURAL_RAD_BYTE give bytes). Client: `rad = a[m] / 5`
// (game.js:8610).
function radByte(b) {
  if (!Number.isInteger(b) || b < 0 || b > U8) {
    throw new RangeError('slQuant: radius byte must be an integer 0..255, got ' + String(b));
  }
  const raw = b === 0 ? 0 : b;
  return { raw: raw, v: raw / 5 };
}

// `prey_add` radius from a continuous radius: round(5 rad) as u8 (P:464-467). Client: `rad = a[m] / 5`
// (game.js:8893).
function rad5(r) {
  const raw = field(Math.round(5 * need(r, 'radius')), U8, 'radius');
  return { raw: raw, v: raw / 5 };
}

// ------------------------------------------------------------------ move angle (16 bits)

// Move `iang` (also the last point of a `snake_add`): round(ang * 65536 / 2 pi) & 65535 (SERVER-DESIGN 7, rounding
// CHOSEN nearest). `v` is the angle the client steps along: `ang = iang * k64a` (game.js:127, 7728-7731).
function moveIang(a) {
  const w = wrapAngle(need(a, 'move angle'));
  const raw = Math.round(w * 65536 / PI2) & U16;
  return { raw: raw, v: raw * slCore.K64A };
}

// The point a move adds on the client: one msl step from the client's last point along the 16-bit angle. The same
// function the client calls (shared/slCore.js headStep, game.js:7728-7731), so for a snake held since its spawn the
// server's inserted point and the client's are the same doubles (SERVER-DESIGN 7 results).
function movePoint(lastX, lastY, iangRaw, msl) {
  if (!Number.isInteger(iangRaw) || iangRaw < 0 || iangRaw > U16) {
    throw new RangeError('slQuant: iang must be an integer 0..65535, got ' + String(iangRaw));
  }
  const p = slCore.headStep(need(lastX, 'x'), need(lastY, 'y'), iangRaw, need(msl, 'msl'));
  return { x: p[0], y: p[1] };
}

// ------------------------------------------------------------------ snake_add body

// The wire body of a `snake_add` from the server's pulled body (tail first, head last, at least 2 points: one point
// crashes their redraw, BB 2 item 18). The first point is absolute (round(5 x)); each middle point is a half-unit
// byte offset round(2 (x_true - x_rebuilt)) + 127 from the REBUILT previous point, so the error never adds up (each
// within 0.25); the last point is the 16-bit angle of the head segment, so every add ends angle-coded
// (SERVER-DESIGN 8.1). `headIang` is the head point's stored iang raw when the sim has it; otherwise the angle of
// the last segment is quantized here.
// Returns { raw: pts as slWire takes them, v: the points the client rebuilds, ang: the client's snake angle }.
// Client: game.js:8470-8534 (x / 5, then x += (b - 127) / 2, then x += Math.cos(iang * k64a) * default_msl).
function addBody(points, msl, headIang) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new RangeError('slQuant: a snake_add body needs at least 2 points');
  }
  need(msl, 'msl');
  const n = points.length;
  const raw = [];
  const v = [];
  const first = points[0];
  const fx = pos5(first.x);
  const fy = pos5(first.y);
  raw.push({ x: fx.raw, y: fy.raw });
  let x = fx.v;
  let y = fy.v;
  v.push({ x: x, y: y });
  for (let i = 1; i < n - 1; i++) {
    const p = points[i];
    const bx = Math.round(2 * (need(p.x, 'body x') - x)) + 127;
    const by = Math.round(2 * (need(p.y, 'body y') - y)) + 127;
    field(bx, U8, 'body delta x');
    field(by, U8, 'body delta y');
    raw.push({ bx: bx === 0 ? 0 : bx, by: by === 0 ? 0 : by });
    x += (bx - 127) / 2;
    y += (by - 127) / 2;
    v.push({ x: x, y: y });
  }
  let iang;
  if (headIang === undefined) {
    const prev = points[n - 2];
    const head = points[n - 1];
    iang = moveIang(Math.atan2(need(head.y, 'head y') - need(prev.y, 'y'), need(head.x, 'head x') - need(prev.x, 'x'))).raw;
  } else {
    iang = headIang;
  }
  const last = movePoint(x, y, iang, msl);
  raw.push({ iang: iang });
  v.push(last);
  return { raw: raw, v: v, ang: iang * slCore.K64A };
}

// ------------------------------------------------------------------ food cells

// Food lives on cells: sector (u8) and cell (u8) of sector_size / 256 inside it (L2, game.js:8596-8612). This is the
// position the client computes from the integers: `sx * sector_size + rx * ssd256`, ssd256 = sector_size / 256
// (game.js:1845, 7288, 8608, 8680).
function foodPos(s, r, sectorSize) {
  if (!Number.isInteger(s) || s < 0 || s > U8 || !Number.isInteger(r) || r < 0 || r > U8) {
    throw new RangeError('slQuant: food sector and cell must be integers 0..255, got ' + s + ', ' + r);
  }
  return s * sectorSize + r * (sectorSize / 256);
}

// The cell holding a continuous position (a drop placed along a body). CHOSEN: the cell that contains x (floor);
// a cell is 1.17 units wide.
function foodCell(x, sectorSize) {
  need(x, 'food position');
  need(sectorSize, 'sector size');
  const s = Math.floor(x / sectorSize);
  let r = Math.floor((x - s * sectorSize) / (sectorSize / 256));
  if (r > U8) r = U8;
  if (r < 0) r = 0;
  if (!(s >= 0 && s <= U8)) throw new RangeError('slQuant: food sector ' + s + ' is outside 0..255');
  const sx = s === 0 ? 0 : s;
  const rx = r === 0 ? 0 : r;
  return { s: sx, r: rx, v: foodPos(sx, rx, sectorSize) };
}

// ------------------------------------------------------------------ init

// The `init` numbers and the client's divisor for each (game.js:7292-7305): spangdv u8 / 10; nsp1, nsp2, nsp3
// u16 / 100; mamu, mamu2, cst u16 / 1E3. A law value that is not on its grid throws: their `a` could not carry it.
const INIT_SCALES = Object.freeze({
  spangdv: { div: 10, max: U8 },
  nsp1: { div: 100, max: U16 },
  nsp2: { div: 100, max: U16 },
  nsp3: { div: 100, max: U16 },
  mamu: { div: 1E3, max: U16 },
  mamu2: { div: 1E3, max: U16 },
  cst: { div: 1E3, max: U16 }
});

function initNum(name, value) {
  const s = INIT_SCALES[name];
  if (!s) throw new RangeError('slQuant: unknown init number ' + String(name));
  const raw = field(Math.round(need(value, 'init.' + name) * s.div), s.max, 'init.' + name);
  const v = raw / s.div;
  if (!Object.is(v, value)) {
    throw new RangeError('slQuant: init.' + name + ' = ' + value + ' is not on its wire grid (nearest ' + v + ')');
  }
  return { raw: raw, v: v };
}

// ------------------------------------------------------------------ grid check

// Each wire grid: the client expression of a raw (the same lines as the quantizers above), its inverse for the first
// guess, and the largest raw. onGrid(name, v) is true iff some raw in range gives exactly v (Object.is), so -0, NaN
// and every number their wire could not carry for that field are off the grid.
const GRIDS = Object.freeze({
  ang8: { expr: (r) => r * 2 * Math.PI / 256, inv: (v) => v * 256 / PI2, max: U8 },            // game.js:7401
  sp18: { expr: (r) => r / 18, inv: (v) => v * 18, max: U8 },                                 // game.js:7405
  ang24: { expr: (r) => r * 2 * Math.PI / 16777215, inv: (v) => v * U24 / PI2, max: U24 },    // game.js:7558, 8423
  sp1000: { expr: (r) => r / 1E3, inv: (v) => v * 1000, max: U16 },                         // game.js:7566, 8430
  fam24: { expr: (r) => r / 16777215, inv: (v) => v * U24, max: U24 },                        // game.js:7605
  pos5: { expr: (r) => r / 5, inv: (v) => v * 5, max: U24 },                                  // game.js:8437
  rad5: { expr: (r) => r / 5, inv: (v) => v * 5, max: U8 },                                   // game.js:8610
  u16: { expr: (r) => r, inv: (v) => v, max: U16 },                                           // game.js:7716-7719
  prey3: { expr: (r) => 1 + r * 3, inv: (v) => (v - 1) / 3, max: U16 },                       // game.js:8798
  init10: { expr: (r) => r / 10, inv: (v) => v * 10, max: U8 },                               // game.js:7292
  init100: { expr: (r) => r / 100, inv: (v) => v * 100, max: U16 },                           // game.js:7294-7299
  init1000: { expr: (r) => r / 1E3, inv: (v) => v * 1000, max: U16 }                         // game.js:7300-7305
});

function onGrid(name, v) {
  const g = GRIDS[name];
  if (!g) throw new RangeError('slQuant: unknown grid ' + String(name));
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  const r0 = Math.round(g.inv(v));
  for (let d = -1; d <= 1; d++) {
    const r = r0 + d;
    if (r >= 0 && r <= g.max && Object.is(g.expr(r), v)) return true;
  }
  return false;
}

// Integer fields (flux_grd, init integers, ids): a check only; their wire carries the integer as is.
function intField(n, max, what) {
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new RangeError('slQuant: ' + what + ' must be an integer 0..' + max + ', got ' + String(n));
  }
  return n === 0 ? 0 : n;
}

module.exports = {
  U8: U8,
  U16: U16,
  U24: U24,
  RULES: Object.keys(RULES),
  INIT_SCALES: INIT_SCALES,
  wrapAngle: wrapAngle,
  rotAng: rotAng,
  wangFromInput: wangFromInput,
  rotSp: rotSp,
  ang24: ang24,
  sp1000: sp1000,
  fam24: fam24,
  pos5: pos5,
  absXY: absXY,
  preyPos: preyPos,
  radByte: radByte,
  rad5: rad5,
  moveIang: moveIang,
  movePoint: movePoint,
  addBody: addBody,
  foodPos: foodPos,
  foodCell: foodCell,
  initNum: initNum,
  GRIDS: GRIDS,
  onGrid: onGrid,
  intField: intField
};
