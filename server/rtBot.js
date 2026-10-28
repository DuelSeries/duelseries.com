'use strict';
/* ─── The free table's Rooftop Snipers opponent ───────────────────────────────
   It presses the same buttons a person does, through the same input the room
   reads from a socket, so it can do nothing a player cannot: jump, raise the
   gun, let go.

   HOW IT PLAYS is the reference's CPU at its default difficulty ("Medium"), as
   docs/rooftop-reference.md describes it (S: ComputerInput.gd). CLEAN ROOM
   (2026-10-28): written from that description in our own terms, not from the
   reference's script:
     · between shots it waits a random 0.5 to 3.5 s, and for each shot picks an
       aim error of up to 16 degrees either way
     · to shoot it raises the gun, then lets go the first frame the gun has
       swung past its aim point (the line from 55 above its own origin to 20
       above the target's, turned by the aim error) by less than 60 degrees, or
       after 0.6 s raised, whatever it points at
     · every random 0.5 to 6.5 s it decides whether to jump: yes, unless it
       leans toward the nearer roof edge by more than its room to that edge
       allows (the first 100 px of room allow no lean, each 400 px more allow a
       radian, and 0.01 rad is always allowed)
   It reads the match after each step, and its presses are applied on the next
   step, as a person's are. */

const Sim = require('../shared/rtSim');

// S: ComputerInput.gd at "Medium" (GameInfo.difficulty 1); doc: CPU.
const SHOT_WAIT = [0.5, 3.5];          // seconds between shots
const AIM_ERROR = 16;                  // degrees either way, picked anew for each shot
const AIM_WINDOW = 60;                 // lets go while the gun is less than this past its aim point...
const AIM_GIVE_UP = 0.6;               // ...or once it has been raised this long
const JUMP_WAIT = [0.5, 6.5];          // seconds between jump checks
const EYE_Y = -55, CHEST_Y = -20;      // it looks from 55 above its own origin at 20 above the target's
const EDGE_NO_LEAN = 100, EDGE_PX_PER_RAD = 400, LEAN_ALWAYS = 0.01;   // the jump check's lean allowance
const DEG = 180 / Math.PI;

// Its own state, kept on the bot; its random numbers are its own stream (never the match's).
function brainOf(bot) {
  if (!bot.brain) {
    bot.brain = { rng: (Math.random() * 4294967296) >>> 0, on: false,
                  shot: 'wait', shotIn: 0, aimErr: 0, aimFor: 0, jumpIn: 0 };
  }
  return bot.brain;
}
function between(ai, range) { return range[0] + Sim.rand(ai) * (range[1] - range[0]); }
function nextShot(ai) {
  ai.shot = 'wait';
  ai.shotIn = between(ai, SHOT_WAIT);
  ai.aimErr = (Sim.rand(ai) * 2 - 1) * AIM_ERROR;
}
function nextJump(ai) { ai.jumpIn = between(ai, JUMP_WAIT); }

// The signed difference a - b of two angles in degrees, folded into (-180, 180].
function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/* Whether the raised gun has swung past its aim point by less than AIM_WINDOW. The gun points along the arm, a
   quarter turn on from the arm's angle; it swings clockwise on screen when the arm is not mirrored (me.sx 1) and
   anticlockwise when it is, so "past" is that way round. */
function onTarget(me, him, aimErr) {
  const eye = Sim.toWorld(me.body, 0, EYE_Y), chest = Sim.toWorld(him.body, 0, CHEST_Y);
  const aim = Math.atan2(chest[1] - eye[1], chest[0] - eye[0]) * DEG + aimErr;
  const gun = Sim.armAngle(me) * DEG + 90;
  const past = angleDiff(gun, aim) * me.sx;
  return past >= 0 && past < AIM_WINDOW;
}

// Whether a jump now is safe enough (doc: CPU). m: the match, for its map's edge (each map has its own).
function wantsJump(me, m) {
  const eye = Sim.toWorld(me.body, 0, EYE_Y);
  const edge = m ? Sim.mapOf(m).edge : Sim.RT.EDGE_X;
  const towardEdge = eye[0] < 0 ? -me.body.a : me.body.a;      // its lean toward the nearer edge, radians
  const room = edge - Math.abs(me.body.x);
  return towardEdge <= Math.max((room - EDGE_NO_LEAN) / EDGE_PX_PER_RAD, LEAN_ALWAYS);
}

// The shot, one frame at a time: waiting, then pressed (until the room raises the gun), then aiming.
function shotStep(ai, me, him, inp, dt) {
  if (ai.shot === 'wait') {
    if (ai.shotIn > 0) { ai.shotIn -= dt; return; }
    if (!me.reloaded) { nextShot(ai); return; }
    inp.d++;
    ai.shot = 'pressed';
  } else if (ai.shot === 'pressed') {
    if (me.raising) { ai.shot = 'aim'; ai.aimFor = 0; }
    else nextShot(ai);                           // the room refused the raise: start over
  } else if (!me.raising) {
    nextShot(ai);
  } else if (ai.aimFor >= AIM_GIVE_UP || onTarget(me, him, ai.aimErr)) {
    inp.n = me.held;
    inp.r++;
    nextShot(ai);
  } else {
    ai.aimFor += dt;
  }
}
function jumpStep(ai, me, m, inp, dt) {
  if (ai.jumpIn > 0) { ai.jumpIn -= dt; return; }
  if (wantsJump(me, m)) inp.j++;
  nextJump(ai);
}

function drive(room, now, who) {
  const bot = who || room.bot;
  if (!bot || !room.match) return;
  if (room.state === 'waiting' || room.state === 'over') return;
  const side = room.sideOfSocket(bot.id);
  if (side === null) return;
  const m = room.match, me = m.p[side], him = m.p[1 - side];
  const inp = room.inputs[side];
  const ai = brainOf(bot);
  // The first round waits for a jump press to ready up: the bot readies after its first look.
  if (m.phase === 'ready') { if (!m.ready[side] && inp.j <= me.nj) inp.j++; ai.on = false; return; }
  if (!me.enabled) { ai.on = false; return; }
  if (!ai.on) { ai.on = true; nextJump(ai); nextShot(ai); }     // fresh waits each time play starts for it
  // Only once the room has applied what it pressed last.
  if (inp.d > me.nd || inp.r > me.nr || inp.j > me.nj) return;
  const dt = Sim.RT.STEP * m.ts;
  shotStep(ai, me, him, inp, dt);
  jumpStep(ai, me, m, inp, dt);
}

module.exports = { drive, onTarget, wantsJump };
