'use strict';
/* ─── Knockout, the "Big hits" look (option A of the 2026-11-04 picker) ─────────────────────────────────────────────
   A DEV PROTOTYPE: off unless the page is opened with ?fx=1 or localStorage 'ko.fx' is '1'. It changes only what is
   drawn: the camera tilts so the disc reads as a stone slab over the pit, pieces are pucks with a side and a shadow,
   every hit flashes and throws sparks and shakes the view, moving pieces leave a trail, a knocked off piece drops into
   the pit, the rim sheds chunks as the ring closes, and the knockout that decides the match plays in slow motion.

   IT DECIDES NOTHING. Every effect is read off the tape the server already sent (public/js/knockout.js plays it): a
   hit is two pieces coming into contact between two frames, an out is the tape's own out list. Slow motion only holds
   the tape back on THIS screen, inside the slack the server leaves after every tape (900 ms, then 3 s of hold once the
   match is decided), so the next turn never opens over a tape still playing. Reduced motion: no shake, no slow
   motion, no hit stop. */
(function (root) {
  const on = (() => {
    try { return /[?&]fx=1\b/.test(root.location.search) || root.localStorage.getItem('ko.fx') === '1'; } catch (_) { return false; }
  })();
  const reduce = (() => { try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } })();
  const TILT = on ? 0.78 : 1;
  const BONE = '#f4f1ea', RED = '#e0705f';

  let flashes = [], sparks = [], debris = [], trails = new Map();
  let shake = 0, shakeAt = 0, koAt = 0, koMine = false;
  let cur = null, seenF = -1, outsSeen = new Set(), pairAt = new Map(), bumpSeen = new Map();
  let lag = 0, lastNow = 0, slowUntil = 0, holdUntil = 0, budget = 0;

  /* The tape's clock offset on this screen: how far slow motion and hit stops have held it back. Budgeted per tape:
     450 ms for a turn that goes on, 2.2 s for the turn that decides it (the server holds 3 s before the card). */
  function lagFor(tape, now) {
    if (tape !== cur) return 0;
    const dt = lastNow ? Math.min(100, now - lastNow) : 0;
    lastNow = now;
    let rate = 1;
    if (!reduce) { if (holdUntil > now) rate = 0; else if (slowUntil > now) rate = 0.3; }
    lag = Math.min(budget, lag + dt * (1 - rate));
    return lag;
  }

  /* Read what happened between the last frame drawn and this one. pos(i, f) -> [x, y] in world units. */
  function onTape(tape, tapeAt, env) {
    if (!tape) return;
    if (tape !== cur) {
      cur = tape; seenF = 0; outsSeen = new Set(); pairAt = new Map(); bumpSeen = new Map(); lag = 0; lastNow = 0;
      slowUntil = 0; holdUntil = 0;
      budget = env.decides ? 2200 : 450;
    }
    const now = performance.now();
    const last = Math.min(tapeAt, tape.frames.length - 1);
    const n = tape.order.length, reach = env.pieceR * 2 + 2.5;
    const outAt = new Map((tape.out || []).map(o => [o.id, o.frame]));
    const live = (i, f) => { const o = outAt.get(tape.order[i]); return o === undefined || f < o; };
    for (let f = seenF + 1; f <= last; f++) {
      const A = tape.frames[f], P = tape.frames[f - 1];
      if (!A || !P) continue;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (!live(i, f) || !live(j, f)) continue;
        const ax = A[i * 2], ay = A[i * 2 + 1], bx = A[j * 2], by = A[j * 2 + 1];
        const pd = Math.hypot(P[j * 2] - P[i * 2], P[j * 2 + 1] - P[i * 2 + 1]);
        if (Math.hypot(bx - ax, by - ay) > reach || pd <= reach) continue;
        const key = i * 8 + j;
        if (f - (pairAt.get(key) || -99) < 10) continue;
        pairAt.set(key, f);
        // How hard: the two pieces' closing speed over the last frame, in units per second.
        const va = Math.hypot(ax - P[i * 2], ay - P[i * 2 + 1]) * 60, vb = Math.hypot(bx - P[j * 2], by - P[j * 2 + 1]) * 60;
        hit((ax + bx) / 2, (ay + by) / 2, va + vb, '#fff3d6', now);
      }
      for (const b of env.bumpers || []) {
        if (!b.alive) continue;
        for (let i = 0; i < n; i++) {
          if (!live(i, f)) continue;
          const d = Math.hypot(A[i * 2] - b.x, A[i * 2 + 1] - b.y);
          const key = b.x + ':' + i;
          if (d <= b.r + env.pieceR + 3 && f - (bumpSeen.get(key) || -99) > 8) {
            bumpSeen.set(key, f); b.litAt = now;
            const v = Math.hypot(A[i * 2] - P[i * 2], A[i * 2 + 1] - P[i * 2 + 1]) * 60;
            hit(b.x + (A[i * 2] - b.x) * b.r / d, b.y + (A[i * 2 + 1] - b.y) * b.r / d, Math.max(400, v), '#ffc860', now);
          }
        }
      }
      for (const o of tape.out || []) {
        if (o.frame !== f || outsSeen.has(o.id)) continue;
        outsSeen.add(o.id);
        const i = tape.order.indexOf(o.id);
        const isMine = env.ownerOf(o.id) === env.me;
        for (let k = 0; k < 12; k++) {
          const a = Math.random() * Math.PI * 2;
          debris.push({ x: A[i * 2], y: A[i * 2 + 1], vx: Math.cos(a) * 70, vy: Math.sin(a) * 70, at: now, life: 650, col: isMine ? BONE : RED, r: 3 + Math.random() * 3 });
        }
        // The last out of the tape that decides the match: slow motion and the word.
        if (env.decides && o === (tape.out || []).slice().sort((a, b) => a.frame - b.frame).pop()) {
          if (!reduce) slowUntil = now + 900;
          koAt = now; koMine = isMine;
        }
      }
    }
    seenF = Math.max(seenF, last);
  }

  function hit(x, y, power, col, now) {
    flashes.push({ x, y, at: now, big: power > 700, col });
    const k = Math.min(18, 6 + Math.round(power / 90));
    for (let j = 0; j < k; j++) {
      const a = Math.random() * Math.PI * 2, sp = 140 + Math.random() * power * 0.45;
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, at: now, life: 240 + Math.random() * 260 });
    }
    if (reduce) return;
    shake = Math.min(9, power / 120); shakeAt = now;
    if (power > 900) holdUntil = Math.max(holdUntil, now + 60);
  }

  /* The ring is closing: chunks of rim fall off into the pit. */
  function ringClosing(R) {
    if (reduce || Math.random() > 0.55) return;
    const a = Math.random() * Math.PI * 2, r = R + 3;
    debris.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30, at: performance.now(), life: 750, col: '#6a4c32', r: 4 + Math.random() * 5 });
  }

  function beginShake(ctx, now) {
    ctx.save();
    const k = Math.max(0, 1 - (now - shakeAt) / 240);
    if (shake > 0 && k > 0) ctx.translate((Math.random() * 2 - 1) * shake * k, (Math.random() * 2 - 1) * shake * k);
  }

  /* The disc: a thick slab seen at the camera's tilt, a lit top with turned rings, a hot band where a clean hit
     takes you off, hazard ticks and a lit rim. cx, cy: its centre on screen; R: its radius in pixels. */
  function disc(ctx, cx, cy, R, s, dangerPx) {
    const T = TILT, depth = R * 0.14;
    const side = ctx.createLinearGradient(0, cy, 0, cy + R * T + depth);
    side.addColorStop(0, '#7a5636'); side.addColorStop(0.55, '#3e2a1a'); side.addColorStop(1, '#140c07');
    ctx.beginPath(); ctx.ellipse(cx, cy + depth, R, R * T, 0, 0, Math.PI); ctx.lineTo(cx - R, cy);
    ctx.ellipse(cx, cy, R, R * T, 0, Math.PI, 0, true); ctx.closePath(); ctx.fillStyle = side; ctx.fill();
    ctx.save(); ctx.globalAlpha = 0.25; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    for (let k = 1; k < 3; k++) { ctx.beginPath(); ctx.ellipse(cx, cy + depth * k / 3, R, R * T, 0, 0, Math.PI); ctx.stroke(); }
    ctx.restore();
    const top = ctx.createRadialGradient(cx - R * 0.25, cy - R * T * 0.55, R * 0.05, cx, cy, R * 1.05);
    top.addColorStop(0, '#4a3a2b'); top.addColorStop(0.5, '#2c2219'); top.addColorStop(1, '#1d1610');
    ctx.beginPath(); ctx.ellipse(cx, cy, R, R * T, 0, 0, Math.PI * 2); ctx.fillStyle = top; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, R, R * T, 0, 0, Math.PI * 2); ctx.clip();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,230,190,0.04)';
    for (let rr = 30 * s; rr < R; rr += 30 * s) { ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * T, 0, 0, Math.PI * 2); ctx.stroke(); }
    if (dangerPx > 8) {
      ctx.translate(cx, cy); ctx.scale(1, T);
      const band = ctx.createRadialGradient(0, 0, dangerPx, 0, 0, R);
      band.addColorStop(0, 'rgba(240,110,40,0)'); band.addColorStop(1, 'rgba(240,110,40,0.11)');
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.arc(0, 0, dangerPx, 0, Math.PI * 2, true); ctx.fillStyle = band; ctx.fill();
    }
    ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(240,168,48,0.6)'; ctx.lineWidth = Math.max(1.5, 5 * s);
    const n = 40, spin = performance.now() / 9000;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + spin;
      ctx.beginPath(); ctx.ellipse(cx, cy, R - 9 * s, (R - 9 * s) * T, 0, a, a + Math.PI / n * 0.9); ctx.stroke();
    }
    ctx.restore();
    ctx.save(); ctx.shadowColor = 'rgba(255,180,60,0.8)'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.ellipse(cx, cy, R, R * T, 0, 0, Math.PI * 2); ctx.strokeStyle = '#ffc860'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  /* One puck. x, y: where it stands on the slab; r: radius in pixels; fall: -1 on the disc, else 0..1 into the pit.
     paintTop(ctx, x, y, r): an optional bought skin's face, drawn into the squashed top. Returns the top's y, where
     an arrow starts. */
  function puck(ctx, x, y, r, isMine, fall, paintTop, heavy) {
    const T = TILT, hgt = r * 0.45;
    let alpha = 1;
    if (fall >= 0) { const t = Math.min(1, fall); y += t * t * r * 2.2; r *= 1 - t * 0.55; alpha = 1 - t * t; }
    if (alpha <= 0.02) return y - hgt;
    ctx.save(); ctx.globalAlpha = alpha;
    if (fall < 0) { ctx.beginPath(); ctx.ellipse(x + r * 0.22, y + r * 0.2 * T, r * 1.08, r * T * 1.08, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill(); }
    const col = isMine ? BONE : RED;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * T, 0, 0, Math.PI); ctx.lineTo(x - r, y - hgt); ctx.ellipse(x, y - hgt, r, r * T, 0, Math.PI, 0, true); ctx.closePath();
    ctx.fillStyle = isMine ? '#b3a993' : '#9a4034'; ctx.fill();
    const ty = y - hgt;
    if (paintTop) {
      ctx.save(); ctx.translate(x, ty); ctx.scale(1, T); paintTop(ctx, 0, 0, r); ctx.restore();
    } else {
      const g = ctx.createRadialGradient(x - r * 0.35, ty - r * T * 0.45, r * 0.1, x, ty, r);
      g.addColorStop(0, isMine ? '#ffffff' : '#ffa392'); g.addColorStop(1, col);
      ctx.beginPath(); ctx.ellipse(x, ty, r, r * T, 0, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.ellipse(x, ty, r * 0.62, r * 0.62 * T, 0, 0, Math.PI * 2); ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.strokeStyle = isMine ? 'rgba(90,70,50,0.25)' : 'rgba(80,20,10,0.3)'; ctx.stroke();
    }
    if (fall >= 0 && fall < 1) { ctx.fillStyle = 'rgba(0,0,0,' + (fall * 0.7) + ')'; ctx.beginPath(); ctx.ellipse(x, y - hgt / 2, r, r * T + hgt / 2, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    return ty;
  }

  /* A bumper post (the bumpers arena): a short brass drum that lights when something comes off it. */
  function post(ctx, x, y, r, litAt, now, flat) {
    const T = flat ? 1 : TILT, hgt = flat ? r * 0.25 : r * 0.9;
    const lit = litAt ? Math.max(0, 1 - (now - litAt) / 300) : 0;
    ctx.save();
    if (!flat) { ctx.beginPath(); ctx.ellipse(x + r * 0.25, y + r * 0.15, r * 1.1, r * T * 1.1, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill(); }
    ctx.beginPath(); ctx.ellipse(x, y, r, r * T, 0, 0, Math.PI); ctx.lineTo(x - r, y - hgt); ctx.ellipse(x, y - hgt, r, r * T, 0, Math.PI, 0, true); ctx.closePath();
    ctx.fillStyle = '#6a3a12'; ctx.fill();
    const ty = y - hgt;
    const g = ctx.createRadialGradient(x - r * 0.3, ty - r * 0.4 * T, r * 0.1, x, ty, r);
    g.addColorStop(0, lit > 0 ? '#fff6d8' : '#ffd27a'); g.addColorStop(1, '#c07a18');
    ctx.beginPath(); ctx.ellipse(x, ty, r, r * T, 0, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, ty, r * 0.55, r * 0.55 * T, 0, 0, Math.PI * 2); ctx.fillStyle = '#7a4410'; ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, ty, r * (1 + lit * 0.5), r * (1 + lit * 0.5) * T, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2 + lit * 4; ctx.strokeStyle = 'rgba(255,220,120,' + (0.35 + lit * 0.65) + ')'; ctx.stroke();
    ctx.restore();
  }

  /* Trails behind fast pieces. list: [{ id, x, y (screen), mine, moving }]. */
  function drawTrails(ctx, list, pr) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      const t = trails.get(p.id) || [];
      const prev = t[t.length - 1];
      const sp = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0;
      if (p.moving && sp > 1.2) t.push({ x: p.x, y: p.y, sp }); else if (t.length) t.shift();
      if (t.length > 14) t.shift();
      trails.set(p.id, t);
      for (let i = 1; i < t.length; i++) {
        const k = i / t.length;
        ctx.beginPath(); ctx.moveTo(t[i - 1].x, t[i - 1].y); ctx.lineTo(t[i].x, t[i].y);
        ctx.lineCap = 'round'; ctx.lineWidth = pr * 1.5 * k;
        ctx.strokeStyle = (p.mine ? 'rgba(244,241,234,' : 'rgba(224,112,95,') + (0.22 * k * Math.min(1, t[i].sp / 8)) + ')';
        ctx.stroke();
      }
    }
    for (const id of trails.keys()) if (!seen.has(id)) trails.delete(id);
  }

  /* Flashes, sparks, falling chunks and the word, over everything. toX/toY: world to screen. */
  function overlay(ctx, toX, toY, pr, now, w, h) {
    flashes = flashes.filter(f => {
      const t = (now - f.at) / 280; if (t > 1) return false;
      const x = toX(f.x), y = toY(f.y) - pr * 0.45;
      ctx.save(); ctx.globalAlpha = 1 - t;
      ctx.beginPath(); ctx.ellipse(x, y, pr * (0.6 + t * (f.big ? 2.6 : 1.7)), pr * (0.6 + t * (f.big ? 2.6 : 1.7)) * TILT, 0, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, pr * 0.5 * (1 - t)); ctx.strokeStyle = f.col; ctx.stroke();
      if (t < 0.3) { ctx.beginPath(); ctx.arc(x, y, pr * (f.big ? 1.1 : 0.85), 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,250,235,' + (0.95 - t * 3) + ')'; ctx.fill(); }
      ctx.restore(); return true;
    });
    sparks = sparks.filter(p => {
      const t = (now - p.at) / p.life; if (t > 1) return false;
      const age = (now - p.at) / 1000, x = p.x + p.vx * age * (1 - t * 0.5), y = p.y + p.vy * age * (1 - t * 0.5);
      ctx.beginPath(); ctx.moveTo(toX(x), toY(y) - pr * 0.45); ctx.lineTo(toX(x - p.vx * 0.04), toY(y - p.vy * 0.04) - pr * 0.45);
      ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(255,214,140,' + (1 - t) + ')'; ctx.lineWidth = 3; ctx.stroke(); return true;
    });
    debris = debris.filter(d => {
      const t = (now - d.at) / d.life; if (t > 1) return false;
      const age = (now - d.at) / 1000, x = toX(d.x + d.vx * age), y = toY(d.y + d.vy * age) + t * t * pr * 1.6;
      const r = d.r * (1 - t * 0.5);
      ctx.save(); ctx.globalAlpha = (1 - t) * 0.9; ctx.fillStyle = d.col; ctx.fillRect(x - r / 2, y - r / 2, r, r); ctx.restore();
      return true;
    });
    if (koAt && now - koAt < 1200) {
      const t = (now - koAt) / 1200, sc = 1 + (1 - Math.min(1, t * 4)) * 0.6;
      ctx.save(); ctx.translate(w / 2, h * 0.3); ctx.scale(sc, sc); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 ' + Math.round(Math.min(64, w / 9)) + 'px Archivo, system-ui, sans-serif'; ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 6; ctx.strokeStyle = '#1a0f08'; ctx.strokeText('KNOCKOUT', 0, 0);
      ctx.fillStyle = koMine ? '#ff8a76' : '#ffc860'; ctx.fillText('KNOCKOUT', 0, 0);
      ctx.restore();
    }
  }

  function reset() { flashes = []; sparks = []; debris = []; trails = new Map(); koAt = 0; cur = null; lag = 0; }

  root.KnockoutFx = { on, TILT, lagFor, onTape, ringClosing, beginShake, disc, puck, post, drawTrails, overlay, reset };
})(window);
