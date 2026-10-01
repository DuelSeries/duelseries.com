'use strict';
// agCamera (build brief 9.2 "agCamera.js", client-camera-input spec sections 1, 5, 6, 8.2, 8.3):
// zoom, draw scale, easing, the integer world target and its send gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'ag', 'agCamera.js');
const C = require(FILE);

const cells = (sizes) => sizes.map((s, i) => ({ x: i * 10, y: -i * 10, size: s }));

// A camera that has had its first drawn frame on a W x H canvas, with no border and no cells.
function freshCam(W, H) {
  const cam = C.createCamera();
  cam.setCanvasSize(W, H);
  return cam;
}

test('loads under node and registers on DuelAgarLib with the card exports', () => {
  assert.strictEqual(globalThis.DuelAgarLib.agCamera, C);
  assert.strictEqual(typeof C.createCamera, 'function');
  const cam = C.createCamera();
  for (const k of ['stepZoom', 'stepCamera', 'targetScale', 'worldTarget', 'wheel', 'clampWheel', 'sendTarget',
    'frameGate', 'setBorder', 'onSpawn', 'onSpectateCam', 'setMouse', 'reset', 'setCanvasSize', 'stickPoint']) {
    assert.strictEqual(typeof cam[k], 'function', k);
  }
  assert.strictEqual(cam.scale, 1, 'draw scale starts at 1');
  assert.strictEqual(cam.zoom, 1);
  assert.strictEqual(cam.wheelFactor, 1);
});

test('zoom target: own sizes summing 128, 64 or less, 1000 (card)', () => {
  const zt = (sizes) => { const cam = freshCam(1920, 1080); cam.stepZoom(cells(sizes)); return cam.zoomTarget; };
  assert.strictEqual(zt([128]), 0.757858283255199);
  assert.strictEqual(zt([64, 64]), 0.757858283255199);
  assert.strictEqual(zt([64]), 1);
  assert.strictEqual(zt([32, 32]), 1);
  assert.strictEqual(zt([10]), 1);
  assert.strictEqual(zt([1000]), 0.33302128296074923);
  assert.strictEqual(C.sizeZoom(0), 1, 'a zero sum counts as 1 (64 / 0 is above 1)');
});

test('draw scale on a 1280 x 630 canvas at zoom 1 is 2/3 (card)', () => {
  const cam = freshCam(1280, 630);
  cam.stepZoom([]);
  assert.strictEqual(cam.zoom, 1);
  assert.strictEqual(cam.scale, 0.6666666666666666);
  assert.strictEqual(cam.targetScale(), 0.6666666666666666);
  assert.strictEqual(C.screenFactor(1366, 678), 1366 / 1920);
  assert.strictEqual(C.screenFactor(1000, 1080), 1);
});

test('visible width on 1920 x 990 at wheel 1 matches spec 6.4 for every size sum (card)', () => {
  const sums = [32, 64, 100, 200, 400, 800, 1600, 3200];
  const want = [1920, 1920, 2295, 3029, 3996, 5273, 6958, 9181];
  sums.forEach((S, i) => {
    const z = C.sizeZoom(S);
    assert.strictEqual(Math.round(C.visibleWorld(1920, 990, z).w), want[i], 'sum ' + S);
    // The steady state of the eased zoom is the target itself.
    const cam = freshCam(1920, 990);
    for (let f = 0; f < 600; f++) cam.stepZoom([{ x: 0, y: 0, size: S }]);
    assert.strictEqual(Math.round(1920 / cam.scale), want[i], 'eased, sum ' + S);
  });
});

test('half-lives in frames: camera with cells, without, zoom (card)', () => {
  assert.strictEqual(C.HALF_LIFE_FRAMES.cameraAlive, 1.7095112913514545);
  assert.strictEqual(C.HALF_LIFE_FRAMES.cameraNoCells, 20.445883633614383);
  assert.strictEqual(C.HALF_LIFE_FRAMES.zoom, 6.578813478960585);
  // The steps really ease by those ratios.
  const cam = freshCam(1920, 1080);
  cam.stepCamera([{ x: 300, y: -300, size: 10 }]);
  assert.ok(Math.abs(cam.x - 100) < 1e-12 && Math.abs(cam.y + 100) < 1e-12, 'alive: 1/3 of the way');
  const dead = freshCam(1920, 1080);
  dead.onSpectateCam(300, 0, 1);
  dead.stepCamera([]);
  assert.strictEqual(dead.x, 10, 'no cells: 1/30 of the way');
  const z = freshCam(1920, 1080);
  z.stepZoom([]); // first frame snaps
  z.onSpectateCam(0, 0, 1);
  z.noCellsZoomBase = 0;
  z.stepZoom([]);
  assert.ok(Math.abs(z.zoom - 0.9) < 1e-15, 'zoom: 1/10 of the way');
});

test('first frame snaps the zoom and sets the no-cells base; later frames ease 9:1', () => {
  const cam = freshCam(1920, 1080);
  cam.stepZoom([{ x: 0, y: 0, size: 128 }]);
  assert.strictEqual(cam.zoom, 0.757858283255199);
  assert.strictEqual(cam.noCellsZoomBase, 0.757858283255199);
  assert.strictEqual(cam.firstFrame, false);
  cam.stepZoom([{ x: 0, y: 0, size: 1000 }]);
  assert.strictEqual(cam.zoom, (0.757858283255199 * 9 + 0.33302128296074923) / 10);
});

test('alive camera: plain average (not size weighted), base follows zoom * 1.1', () => {
  const cam = freshCam(1920, 1080);
  cam.stepZoom([]);
  cam.stepCamera([{ x: 0, y: 0, size: 200 }, { x: 90, y: 30, size: 10 }]);
  assert.strictEqual(cam.targetX, 45);
  assert.strictEqual(cam.targetY, 15);
  assert.strictEqual(cam.x, 15);
  assert.strictEqual(cam.y, 5);
  assert.strictEqual(cam.noCellsZoomBase, 1 * 1.1);
});

test('after death the view eases toward 1.1 x last zoom x wheel (spec 6.2)', () => {
  const cam = freshCam(1920, 1080);
  cam.stepZoom([{ x: 0, y: 0, size: 128 }]);
  cam.stepCamera([{ x: 0, y: 0, size: 128 }]);
  const base = cam.noCellsZoomBase;
  assert.strictEqual(base, 0.757858283255199 * 1.1);
  for (let f = 0; f < 2000; f++) { cam.clampWheel(); cam.stepZoom([]); cam.stepCamera([]); }
  assert.ok(Math.abs(cam.zoom - base) < 1e-12);
});

test('first border: centre target and hard cut with no own cells, no cut with cells', () => {
  const cam = freshCam(1280, 630);
  cam.scale = 0.5;
  cam.setBorder(3000, -2000, -1000, 4000, 0); // given out of order: normalised per axis
  assert.deepStrictEqual([cam.minX, cam.minY, cam.maxX, cam.maxY], [-1000, -2000, 3000, 4000]);
  assert.deepStrictEqual([cam.targetX, cam.targetY, cam.x, cam.y, cam.scale], [1000, 1000, 1000, 1000, 1]);
  assert.strictEqual(cam.noCellsZoomBase, 1);
  // A second border on the same connection only stores the rectangle.
  cam.x = 5;
  cam.setBorder(-10, -10, 10, 10, 0);
  assert.deepStrictEqual([cam.targetX, cam.x, cam.maxX], [1000, 5, 10]);
  const alive = freshCam(1280, 630);
  alive.x = 7;
  alive.scale = 0.5;
  alive.setBorder(-100, -100, 300, 100, 1);
  assert.deepStrictEqual([alive.targetX, alive.targetY, alive.x, alive.scale], [100, 0, 7, 0.5]);
  alive.reset();
  alive.setBorder(-100, -100, 300, 100, 0);
  assert.strictEqual(alive.x, 100, 'a reconnect starts a new first border');
});

test('spawn: camera x 0 (not the cell x), y the cell y, draw scale 1; zoom and target untouched', () => {
  const cam = freshCam(1280, 630);
  cam.stepZoom([]);
  cam.zoom = 0.8;
  cam.targetX = 55;
  cam.x = 400;
  cam.onSpawn(Math.fround(123.4));
  assert.deepStrictEqual([cam.x, cam.y, cam.scale, cam.zoom, cam.targetX], [0, Math.fround(123.4), 1, 0.8, 55]);
});

test('spectate camera message is eased toward, and has no effect while alive', () => {
  const cam = freshCam(1280, 630);
  cam.onSpectateCam(900, 790, 0.5);
  assert.deepStrictEqual([cam.targetX, cam.targetY, cam.noCellsZoomBase], [900, 790, 0.5]);
  cam.stepZoom([]);
  cam.stepCamera([]);
  assert.strictEqual(cam.x, 30);
  const alive = freshCam(1280, 630);
  alive.stepZoom([]);
  alive.onSpectateCam(900, 790, 0.5);
  alive.stepCamera([{ x: 0, y: 0, size: 50 }]);
  assert.deepStrictEqual([alive.targetX, alive.targetY], [0, 0]);
  assert.strictEqual(alive.noCellsZoomBase, alive.zoom * 1.1);
});

test('wheel: 0.9^n per event, clamped every frame to [1, 4 / previous draw scale]', () => {
  const cam = freshCam(1920, 1080);
  cam.stepZoom([]);
  cam.wheel(1); // down: below 1, clamped back
  assert.strictEqual(cam.wheelFactor, 0.9);
  cam.clampWheel();
  assert.strictEqual(cam.wheelFactor, 1);
  for (let i = 0; i < 20; i++) cam.wheel(-1); // up 20 notches
  assert.strictEqual(cam.wheelFactor > 4, true);
  cam.clampWheel();
  assert.strictEqual(cam.wheelFactor, 4 / cam.scale);
  // Steady state for a small cell on a 1920-wide canvas: wheel 2, draw scale 2 (spec 6.1).
  for (let f = 0; f < 3000; f++) { cam.clampWheel(); cam.stepZoom([{ x: 0, y: 0, size: 10 }]); }
  assert.ok(Math.abs(cam.wheelFactor - 2) < 1e-9 && Math.abs(cam.scale - 2) < 1e-9);
  // The upper clamp wins when the two conflict.
  const big = freshCam(1920, 1080);
  big.scale = 8;
  big.wheelFactor = 0.2;
  big.clampWheel();
  assert.strictEqual(big.wheelFactor, 0.5);
});

test('target with border 0,0,0,0 is (0, 0) and is not sent again (card)', () => {
  const cam = freshCam(1280, 630);
  cam.setMouse(900, 100);
  assert.deepStrictEqual(cam.worldTarget(900, 100), { x: 0, y: 0 });
  const sent = [];
  assert.strictEqual(cam.sendTarget((x, y) => sent.push([x, y])), false, 'equals the initial last-sent (0, 0)');
  assert.deepStrictEqual(sent, []);
});

test('a target unchanged since the last send is not sent (card); last-sent survives reset', () => {
  const cam = freshCam(1280, 630);
  cam.setBorder(-2000, -2000, 2000, 2000, 0);
  const sent = [];
  const send = (x, y) => sent.push([x, y]);
  cam.setMouse(740, 315);
  assert.strictEqual(cam.sendTarget(send), true);
  assert.strictEqual(cam.sendTarget(send), false);
  cam.setMouse(740.9, 315.2); // same int32 mouse
  assert.strictEqual(cam.sendTarget(send), false);
  assert.deepStrictEqual(sent, [[100, 0]]);
  cam.reset();
  cam.setBorder(-2000, -2000, 2000, 2000, 0);
  cam.setMouse(740, 315);
  assert.strictEqual(cam.sendTarget(send), false, 'reset does not clear the last sent target');
  // The last sent pair moves even when the packet is dropped (no send function).
  cam.setMouse(840, 315);
  assert.strictEqual(cam.sendTarget(null), true);
  assert.strictEqual(cam.sendTarget(send), false);
});

test('frame gate passes at 16.67 ms and fails at 13.9 ms (card)', () => {
  const cam = freshCam(1280, 630);
  cam.setBorder(-2000, -2000, 2000, 2000, 0);
  let n = 0;
  const send = () => { n++; };
  cam.setMouse(0, 0);
  cam.frameGate(1000, send);
  assert.strictEqual(cam.lastTargetCheck, 1000);
  cam.setMouse(10, 0);
  assert.strictEqual(cam.frameGate(1013.9, send), false, '13.9 ms: no check');
  assert.strictEqual(cam.lastTargetCheck, 1000);
  assert.strictEqual(cam.frameGate(1016.67, send), true, '16.67 ms: checked and sent');
  assert.strictEqual(cam.lastTargetCheck, 1016.67);
  assert.strictEqual(cam.frameGate(1031.67, send), false, 'exactly 15 ms is not more than 15');
  assert.strictEqual(n, 2);
});

test('target maths: integer centre, divide by draw scale, truncate toward 0, truncated border clamp', () => {
  const cam = freshCam(1281, 631); // odd sizes: centre is floor(W / 2)
  cam.setBorder(-100.7, -50.9, 100.7, 50.9, 0);
  cam.x = 0.5;
  cam.y = -0.5;
  cam.scale = 2;
  assert.strictEqual(cam.centreX(), 640);
  assert.strictEqual(cam.centreY(), 315);
  // (643 - 640) / 2 + 0.5 = 2 ; (310 - 315) / 2 - 0.5 = -3
  assert.deepStrictEqual(cam.worldTarget(643, 310), { x: 2, y: -3 });
  // (641 - 640) / 2 - 0.4 ... truncation toward zero, not floor
  cam.x = -0.9;
  assert.deepStrictEqual(cam.worldTarget(641, 315), { x: 0, y: 0 });
  // Clamped to trunc(border): -100 and 100, -50 and 50.
  assert.deepStrictEqual(cam.worldTarget(5000, -5000), { x: 100, y: -50 });
  assert.deepStrictEqual(cam.worldTarget(-5000, 5000), { x: -100, y: 50 });
  // Out-of-range doubles become the int32 minimum before the clamp.
  assert.strictEqual(C.truncGuard(3e9), -2147483648);
  assert.strictEqual(C.truncGuard(NaN), -2147483648);
  assert.strictEqual(C.truncGuard(-2147483647.5), -2147483647);
});

test('reference outbound, simple stream frames 127 to 139: border cut, scale 2/3, first mouse copy', () => {
  // Their client on our synthetic simple stream sent (-640, -315) at frame 127, (-960, -472) at 130
  // and (348, 207) at 139 (harness simple-a). Rebuilt here from first principles.
  const cam = freshCam(1280, 630);
  const sent = [];
  const send = (x, y) => sent.push([x, y]);
  const frame = (now) => { cam.frameGate(now, send); cam.clampWheel(); cam.stepZoom([]); cam.stepCamera([]); };
  const step = 16.6667;
  let now = 1000;
  for (let f = 1; f <= 127; f++) now += step;
  cam.setBorder(-2000, -2000, 2000, 2000, 0); // arrives before the frame draws
  frame(now); // frame 127: the first drawn frame still has draw scale 1
  for (let f = 128; f <= 130; f++) now += step;
  frame(now); // frame 130 (25 fps cap: frames 128, 129 not drawn)
  for (let f = 131; f <= 139; f++) {
    now += step;
    if (f === 139) cam.setMouse(Math.round(640 + 250 * Math.cos(19 * 0.02)), Math.round(360 + 250 * Math.sin(19 * 0.02)));
    if (f % 3 === 1) frame(now);
  }
  assert.deepStrictEqual(sent, [[-640, -315], [-960, -472], [348, 207]]);
});

test('spawn swoop: the first target after spawn uses camera x 0 and scale 1', () => {
  const cam = freshCam(1280, 630);
  cam.setBorder(-2000, -2000, 2000, 2000, 0);
  cam.stepZoom([]);
  cam.stepCamera([]);
  const own = [{ x: Math.fround(300), y: Math.fround(-40), size: 40 }];
  cam.onSpawn(own[0].y);
  cam.setMouse(740, 415);
  const sent = [];
  cam.frameGate(5000, (x, y) => sent.push([x, y]));
  assert.deepStrictEqual(sent, [[100, 60]]);
  cam.clampWheel();
  cam.stepZoom(own);
  cam.stepCamera(own);
  assert.strictEqual(cam.x, 100, 'camera x eases from 0 toward the cell (1/3 per frame)');
  assert.strictEqual(cam.y, -40);
});

test('phone stick point: from the own cells on screen along the direction to the canvas edge', () => {
  const cam = freshCam(1280, 630);
  cam.stepZoom([]);
  cam.x = 100;
  cam.y = 50;
  const own = [{ x: 100, y: 50, size: 40 }, { x: 160, y: 50, size: 40 }]; // average (130, 50)
  // On screen the average sits at (640 + 30 * s, 315).
  const s = cam.scale;
  let p = cam.stickPoint(own, 1, 0);
  assert.strictEqual(p.x, 1280);
  assert.strictEqual(p.y, 315);
  p = cam.stickPoint(own, 0, -1);
  assert.strictEqual(p.x, 640 + 30 * s);
  assert.strictEqual(p.y, 0);
  const d = Math.SQRT1_2;
  p = cam.stickPoint(own, -d, d);
  assert.ok(Math.abs(p.y - 630) < 1e-9 && Math.abs(p.x - (640 + 30 * s - 315)) < 1e-9, 'diagonal hits the bottom edge first');
  p = cam.stickPoint(own, 0, 0);
  assert.deepStrictEqual(p, { x: 640 + 30 * s, y: 315 }, 'no direction: the cells themselves');
  p = cam.stickPoint([], 1, 0);
  assert.deepStrictEqual(p, { x: 1280, y: 315 }, 'no cells: from the screen centre');
  // The world target at that point is on the visible edge, in the stick direction.
  cam.setBorder(-1e5, -1e5, 1e5, 1e5, 2);
  const t = cam.worldTarget(cam.stickPoint(own, 1, 0).x, 315);
  assert.strictEqual(t.x, Math.trunc(100 + 640 / s));
});

test('canvas readiness: the HTML default 300 x 150 is not ready; ready sticks once set', () => {
  const cam = C.createCamera();
  assert.strictEqual(cam.ready, false);
  assert.strictEqual(cam.setCanvasSize(300, 150), true);
  assert.strictEqual(cam.ready, false);
  assert.strictEqual(cam.setCanvasSize(300, 600), true);
  assert.strictEqual(cam.ready, false, 'width still 300');
  cam.setCanvasSize(1280, 630);
  assert.strictEqual(cam.ready, true);
  assert.strictEqual(cam.setCanvasSize(1280, 630), false, 'unchanged');
  cam.setCanvasSize(300, 150);
  assert.strictEqual(cam.ready, true);
});

test('clean room: no Math.random, no Date, no D/W line citations in the shipped file', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/Math\.random/.test(src));
  assert.ok(!/\bDate\b/.test(src));
  assert.ok(!/\b[DW]\s+\d{3,}/.test(src) && !/dcmp|\.wat\b|f_[a-z]{2}\b/.test(src));
});
