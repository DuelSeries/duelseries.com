'use strict';
/* ─── The free table's Rooftop Snipers opponent ───────────────────────────────
   It presses the same buttons a person does, through the same input the room
   reads from a socket, so it can do nothing a player cannot: jump, raise the
   gun, let go.

   HOW IT PLAYS IS THE REFERENCE'S CPU (Rooftop Snipers, Scripts/ComputerInput.gd,
   read 2026-10-27), step for step at the reference's default difficulty
   (GameInfo.difficulty 1, "Medium", so inv_diff() = 3 - 1 = 2):
     · it waits randf() x (inv x 2 - 1) + 0.5 s (0.5 to 3.5 s) between shots and
       aims off by randf_range(-1, 1) x inv^3 x 2 degrees (up to 16) each time
     · it raises the gun, then lets go the first frame the gun points within 60
       degrees past the target's chest (20 above its origin, seen from 55 above
       its own), or after 0.6 s whatever it points at
     · it waits randf() x 3 x inv + 0.5 s (0.5 to 6.5 s) between jump checks and
       jumps when it leans away from the nearer roof edge by more than the
       distance to that edge allows (check_jump)
   It reads the match after each step, which is when the reference's _process
   runs, and its presses are applied on the next step, the same as a person's. */

const Sim = require('../shared/rtSim');

const INV = 2;                                  // S: GameInfo.inv_diff() at difficulty 1

function brainFor(room, bot) {
  if (!bot.brain) bot.brain = { shootT: 0, shootWait: 0, offset: 0, shooting: false, waited: 0, jumpT: 0, jumpWait: 0,
                                 armed: false, rng: (Math.random() * 4294967296) >>> 0 };
  return bot.brain;
}
function rnd(ai) {                              // its own random numbers, never the match's
  let t = (ai.rng = (ai.rng + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function resetShoot(ai) {
  ai.shootWait = rnd(ai) * (INV * 2 - 1) + 0.5;
  ai.shootT = 0;
  ai.offset = (rnd(ai) * 2 - 1) * (INV * INV * INV * 2);
  ai.shooting = false;
}
function resetJump(ai) {
  ai.jumpWait = rnd(ai) * 3 * INV + 0.5;
  ai.jumpT = 0;
}
const clampAng = (d) => (d > 0 ? d : d + 360);
const wrapDeg = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d === -180 ? 180 : d; };

// S: is_aimed_at_target
function aimed(me, him, offset) {
  const tp = Sim.toWorld(him.body, 0, -20);
  const at = Sim.toWorld(me.body, 0, -55);
  let angle = Math.atan2(tp[1] - at[1], tp[0] - at[0]) * 180 / Math.PI;
  let arm = wrapDeg(Sim.armAngle(me) * 180 / Math.PI);
  const scale = me.sx;
  arm = clampAng(arm + 90 * scale);
  angle = ((scale > 0 ? clampAng(angle) : angle + 180) + offset) % 360;
  return (arm < angle) !== (scale > 0) && Math.abs(arm - angle) < 60;
}

// S: check_jump
// m: the match, for its map's edge (S: map_edge = Map/MapEdge.global_position.x, which each map sets)
function wantsJump(me, m) {
  const at = Sim.toWorld(me.body, 0, -55);
  const edgeDir = at[0] < 0 ? 1 : -1;
  const toEdge = (m ? Sim.mapOf(m).edge : Sim.RT.EDGE_X) - Math.abs(me.body.x);
  return me.body.a * edgeDir >= Math.min((100 - toEdge) / 400, -0.01);
}

function drive(room, now, who) {
  const bot = who || room.bot;
  if (!bot || !room.match) return;
  if (room.state === 'waiting' || room.state === 'over') return;
  const side = room.sideOfSocket(bot.id);
  if (side === null) return;
  const m = room.match, me = m.p[side], him = m.p[1 - side];
  const inp = room.inputs[side];
  const ai = brainFor(room, bot);
  // The first round waits for a jump press to ready up: the bot readies after its first look.
  if (m.phase === 'ready') { if (!m.ready[side] && inp.j <= me.nj) inp.j++; ai.armed = false; return; }
  if (!me.enabled) { ai.armed = false; ai.shooting = false; return; }
  if (!ai.armed) { ai.armed = true; resetJump(ai); resetShoot(ai); }   // S: _on_PlayerManager_enable_player(true)
  // Only once the room has caught up with what it pressed last.
  if (inp.d > me.nd || inp.r > me.nr || inp.j > me.nj) return;
  const dt = Sim.RT.STEP * m.ts;
  // S: shoot(delta)
  if (ai.shootT < ai.shootWait) ai.shootT += dt;
  else if (!ai.shooting) {
    if (!me.reloaded) resetShoot(ai);
    else { ai.shooting = true; ai.waited = -1; inp.d++; }
  } else if (me.raising) {
    // S: the shoot_loop coroutine, one frame at a time after raise_gun
    if (ai.waited < 0) ai.waited = 0;
    else if (!aimed(me, him, ai.offset) && ai.waited < 0.6) ai.waited += dt;
    else { inp.n = me.held; inp.r++; resetShoot(ai); }
  } else if (ai.waited >= 0 || me.nd === inp.d) {
    resetShoot(ai);                              // the raise was refused (not reloaded): start over
  }
  // S: jump(delta)
  if (ai.jumpT < ai.jumpWait) ai.jumpT += dt;
  else { if (wantsJump(me, m)) inp.j++; resetJump(ai); }
}

module.exports = { drive, aimed, wantsJump, INV };
