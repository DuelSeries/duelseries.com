'use strict';
/* ─── The fleet ───────────────────────────────────────────────────────────────
   Five ships, drawn top-down, each one recognisably a different vessel.

   WHY THEY ARE DRAWN RATHER THAN STAMPED. A sprite sheet would have to be
   authored at one size and would then be soft on a phone and blocky on a 4K
   monitor, and every ship has to fit its own square count exactly — a carrier
   is five cells and a destroyer is two, on a grid that resizes with the window.
   Drawn to a unit box and scaled at paint time, each hull lands on its squares
   at any size and stays sharp.

   Each ship is built the same way: a hull outline with a raked bow and a
   squared-off stern, a deck inset one shade lighter so the hull reads as having
   sides, then the fittings that say which ship it is — an angled flight deck
   and a starboard island for the carrier, stepped main turrets for the
   battleship, a low conning tower and a rounded hull for the submarine, and so
   on. All of it in the product's palette rather than navy grey, because this
   screen sits next to the rest of the lobby.

   Everything below works in a unit space: x from 0 to `len` (one per grid
   square) and y from 0 to 1, with the ship pointing along +x. The caller sets
   up the transform, so rotation is the caller's problem and none of this has to
   know which way the ship is facing. */

(function (root) {
  const HULL = {
    steel:  '#7c8aa0',
    steelHi:'#95a3ba',
    steelLo:'#5a6779',
    deck:   '#46505f',
    deckHi: '#5a6472',
    trim:   '#2b323c',
    glass:  '#9fd0e8',
  };

  /* The silhouette every ship starts from: a raked bow, parallel sides, and a
     transom stern. `taper` is how much of the length the bow rake eats. */
  function hullPath(ctx, len, taper) {
    const t = taper === undefined ? 0.58 : taper;
    ctx.beginPath();
    ctx.moveTo(len - 0.06, 0.5);                 // the point of the bow
    ctx.bezierCurveTo(len - t * 0.55, 0.10, len - t, 0.06, len - t - 0.30, 0.08);
    ctx.lineTo(0.20, 0.10);                      // port side, running aft
    ctx.quadraticCurveTo(0.05, 0.12, 0.05, 0.28);
    ctx.lineTo(0.05, 0.72);                      // the transom
    ctx.quadraticCurveTo(0.05, 0.88, 0.20, 0.90);
    ctx.lineTo(len - t - 0.30, 0.92);            // starboard side, running forward
    ctx.bezierCurveTo(len - t, 0.94, len - t * 0.55, 0.90, len - 0.06, 0.5);
    ctx.closePath();
  }

  function shade(ctx, len) {
    /* Lit from the top of the screen, so the port side catches it. The gradient
       is what stops a flat grey shape reading as a sticker. */
    const g = ctx.createLinearGradient(0, 0, 0, 1);
    g.addColorStop(0, HULL.steelHi);
    g.addColorStop(0.45, HULL.steel);
    g.addColorStop(1, HULL.steelLo);
    return g;
  }

  function deckPlate(ctx, x0, x1, y0, y1, fill) {
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = fill || HULL.deck;
    ctx.fill();
  }

  function turret(ctx, cx, cy, r, aim) {
    /* A barbette with two barrels over it. Small, but it is the thing that says
       "warship" at a glance. */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = HULL.deckHi; ctx.fill();
    ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.012; ctx.stroke();
    const dir = aim === undefined ? 1 : aim;
    ctx.strokeStyle = HULL.trim;
    ctx.lineWidth = r * 0.34;
    for (const off of [-r * 0.36, r * 0.36]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + off);
      ctx.lineTo(cx + dir * r * 2.0, cy + off);
      ctx.stroke();
    }
  }

  /* ── the five ──────────────────────────────────────────────────────────── */

  const SHIPS = {
    /* Five squares. The angled flight deck and the island to starboard are what
       make a carrier read as a carrier and not just a long ship. */
    carrier(ctx, len) {
      hullPath(ctx, len, 0.75);
      ctx.fillStyle = shade(ctx, len); ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.018; ctx.stroke();

      ctx.save(); ctx.clip();
      deckPlate(ctx, 0.10, len - 0.18, 0.13, 0.87, '#3d4552');
      /* The angled deck, running off to port. */
      ctx.beginPath();
      ctx.moveTo(len - 0.55, 0.16); ctx.lineTo(0.30, 0.30);
      ctx.lineTo(0.30, 0.50); ctx.lineTo(len - 0.55, 0.34);
      ctx.closePath();
      ctx.fillStyle = '#333a46'; ctx.fill();
      /* Centreline markings. */
      ctx.strokeStyle = 'rgba(245,241,232,0.30)';
      ctx.lineWidth = 0.020; ctx.setLineDash([0.12, 0.10]);
      ctx.beginPath(); ctx.moveTo(0.35, 0.62); ctx.lineTo(len - 0.30, 0.62); ctx.stroke();
      ctx.setLineDash([]);
      /* The island: superstructure, mast, radar. */
      deckPlate(ctx, len * 0.46, len * 0.46 + 0.34, 0.66, 0.86, HULL.steelHi);
      deckPlate(ctx, len * 0.46 + 0.06, len * 0.46 + 0.20, 0.70, 0.80, HULL.deckHi);
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.moveTo(len * 0.46 + 0.27, 0.76); ctx.lineTo(len * 0.46 + 0.27, 0.60); ctx.stroke();
      ctx.restore();
    },

    /* Four squares. Stacked main turrets fore and aft, a bridge tower in the
       middle, and a pair of funnels. */
    battleship(ctx, len) {
      hullPath(ctx, len, 0.62);
      ctx.fillStyle = shade(ctx, len); ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.018; ctx.stroke();

      ctx.save(); ctx.clip();
      deckPlate(ctx, 0.10, len - 0.22, 0.16, 0.84);
      /* Superstructure amidships. */
      deckPlate(ctx, len * 0.40, len * 0.40 + 0.52, 0.28, 0.72, HULL.steelHi);
      deckPlate(ctx, len * 0.40 + 0.10, len * 0.40 + 0.30, 0.36, 0.64, HULL.deckHi);
      /* Funnels. */
      for (const fx of [len * 0.40 + 0.60, len * 0.40 + 0.78]) {
        ctx.beginPath(); ctx.ellipse(fx, 0.50, 0.055, 0.10, 0, 0, Math.PI * 2);
        ctx.fillStyle = HULL.trim; ctx.fill();
      }
      /* Main battery: two forward, one aft, the classic arrangement. */
      turret(ctx, len - 0.62, 0.50, 0.115, 1);
      turret(ctx, len - 0.98, 0.50, 0.115, 1);
      turret(ctx, 0.42, 0.50, 0.105, -1);
      ctx.restore();
    },

    /* Three squares. Leaner than the battleship, a single tower, one turret
       forward and a helipad aft. */
    cruiser(ctx, len) {
      hullPath(ctx, len, 0.66);
      ctx.fillStyle = shade(ctx, len); ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.018; ctx.stroke();

      ctx.save(); ctx.clip();
      deckPlate(ctx, 0.10, len - 0.24, 0.18, 0.82);
      deckPlate(ctx, len * 0.34, len * 0.34 + 0.46, 0.30, 0.70, HULL.steelHi);
      deckPlate(ctx, len * 0.34 + 0.08, len * 0.34 + 0.24, 0.38, 0.62, HULL.deckHi);
      ctx.beginPath(); ctx.ellipse(len * 0.34 + 0.56, 0.50, 0.05, 0.09, 0, 0, Math.PI * 2);
      ctx.fillStyle = HULL.trim; ctx.fill();
      turret(ctx, len - 0.60, 0.50, 0.105, 1);
      /* Helipad on the quarterdeck: a circle with a cross in it. */
      ctx.beginPath(); ctx.arc(0.40, 0.50, 0.15, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(245,241,232,0.34)'; ctx.lineWidth = 0.022; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.32, 0.50); ctx.lineTo(0.48, 0.50); ctx.stroke();
      ctx.restore();
    },

    /* Three squares. A rounded pressure hull rather than a ship's deck, a low
       conning tower, and dive planes. */
    submarine(ctx, len) {
      ctx.beginPath();
      ctx.moveTo(len - 0.10, 0.50);
      ctx.bezierCurveTo(len - 0.35, 0.16, len - 0.75, 0.18, len * 0.5, 0.19);
      ctx.lineTo(0.30, 0.22);
      ctx.quadraticCurveTo(0.06, 0.28, 0.06, 0.50);
      ctx.quadraticCurveTo(0.06, 0.72, 0.30, 0.78);
      ctx.lineTo(len * 0.5, 0.81);
      ctx.bezierCurveTo(len - 0.75, 0.82, len - 0.35, 0.84, len - 0.10, 0.50);
      ctx.closePath();
      /* Its own gradient. A submarine sits lower in the water and reads
         darker than a surface ship, which is most of what tells the two apart
         when you are looking straight down on them. */
      const g = ctx.createLinearGradient(0, 0.15, 0, 0.85);
      g.addColorStop(0, '#6b7a8e');
      g.addColorStop(0.5, '#5a6675');
      g.addColorStop(1, '#414c5b');
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.018; ctx.stroke();

      ctx.save(); ctx.clip();
      /* A highlight along the top of the hull, which is what makes a tube read
         as round rather than as a flat lozenge. */
      ctx.beginPath();
      ctx.moveTo(0.20, 0.31); ctx.lineTo(len - 0.40, 0.28);
      ctx.strokeStyle = 'rgba(245,241,232,0.20)'; ctx.lineWidth = 0.055; ctx.stroke();
      /* Sail, with periscopes. */
      ctx.beginPath();
      ctx.moveTo(len * 0.52, 0.36); ctx.lineTo(len * 0.52 + 0.34, 0.38);
      ctx.lineTo(len * 0.52 + 0.34, 0.62); ctx.lineTo(len * 0.52, 0.64);
      ctx.closePath();
      ctx.fillStyle = HULL.deckHi; ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.014; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(len * 0.52 + 0.10, 0.36); ctx.lineTo(len * 0.52 + 0.10, 0.24);
      ctx.moveTo(len * 0.52 + 0.20, 0.36); ctx.lineTo(len * 0.52 + 0.20, 0.27);
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.022; ctx.stroke();
      /* Dive planes. */
      deckPlate(ctx, len * 0.52 - 0.02, len * 0.52 + 0.36, 0.44, 0.56, 'rgba(43,50,60,0.55)');
      ctx.restore();
    },

    /* Two squares. Small, fast, one gun and a funnel: the whole point is that
       it is unmistakably the little one. */
    destroyer(ctx, len) {
      hullPath(ctx, len, 0.55);
      ctx.fillStyle = shade(ctx, len); ctx.fill();
      ctx.strokeStyle = HULL.trim; ctx.lineWidth = 0.018; ctx.stroke();

      ctx.save(); ctx.clip();
      deckPlate(ctx, 0.10, len - 0.20, 0.20, 0.80);
      deckPlate(ctx, len * 0.30, len * 0.30 + 0.40, 0.32, 0.68, HULL.steelHi);
      deckPlate(ctx, len * 0.30 + 0.07, len * 0.30 + 0.20, 0.40, 0.60, HULL.deckHi);
      ctx.beginPath(); ctx.ellipse(len * 0.30 + 0.50, 0.50, 0.045, 0.085, 0, 0, Math.PI * 2);
      ctx.fillStyle = HULL.trim; ctx.fill();
      turret(ctx, len - 0.46, 0.50, 0.095, 1);
      ctx.restore();
    },
  };

  /* Draw `key` into a box whose top-left is (px, py), where one grid square is
     `cell` pixels. `horiz` false rotates it a quarter turn, bow up.

     The transform does all the work, which is why nothing above needs to know
     about rotation: the ship is always drawn pointing along +x in its own unit
     space, and this decides where that space sits on screen. */
  function drawShip(ctx, key, len, px, py, cell, horiz, alpha) {
    const fn = SHIPS[key];
    if (!fn) return;
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    if (horiz) {
      ctx.translate(px, py);
      ctx.scale(cell, cell);
    } else {
      /* A quarter turn about the top-left of the footprint, then the same draw.
         The footprint is one cell wide and `len` cells tall on screen. */
      ctx.translate(px + cell, py);
      ctx.rotate(Math.PI / 2);
      ctx.scale(cell, cell);
    }
    ctx.lineJoin = 'round';
    fn(ctx, len);
    ctx.restore();
  }

  root.BattleshipArt = { drawShip, SHIPS, HULL };
})(window);
