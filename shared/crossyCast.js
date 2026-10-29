/* Crossy Road's animals (Owen 2026-10-28: "proper voxel animals", a chicken by default, then a cat, a dog, a pig and
   a frog). Every one is OUR OWN design, not Crossy Road's or anybody else's: the chicken is a plump hen with a big
   round head set forward over its body, a three-lobed comb, grey-tipped wings and a stepped tail fan, never their
   tall single block.

   One model per animal, as boxes, for both ends that draw it: the game builds them in three.js
   (public/js/crossy/crossyScene.js critterGeo) and the lobby's Customize draws the same boxes in 2D
   (public/js/v2/shopArt.js paintCrossy), so the preview is the animal you play. A box is
   [x0, y0, z0, x1, y1, z1, colour, faces], the scene's own format: x across, y up from the ground, the animal facing
   -z, about 0.55 wide, under 1 tall and 0.8 deep (a cell is 1). faces overrides a face's colour: top, front (+z, its
   back end), back (-z, its face), side (+x), left (-x), sides (every face but the top).

   Each animal has a second coat, worn by the rival when both seats wear the same animal, so the two tell apart.
   Looks only: the hop, the hitbox and every rule are the same for all of them. The ids and names the lobby lists
   and the server checks are in shared/crossyLooks.js. Loaded as a plain script it is window.DS_CROSSY_CAST. */
(function (root) {
  'use strict';
  function B(cx, y, cz, w, h, d, colour, fc) { return [cx - w / 2, y, cz - d / 2, cx + w / 2, y + h, cz + d / 2, colour, fc]; }
  var BLACK = 0x1d1a1a, WHITE = 0xffffff;
  // A pair of eyes on the face (-z), each with a white glint, sx the side.
  function eyes(L, x, y, z, w, h, col) {
    for (var sx = -1; sx <= 1; sx += 2) {
      L.push(B(sx * x, y, z, w, h, 0.012, col));
      L.push(B(sx * x + w * 0.22, y + h * 0.58, z - 0.008, w * 0.36, h * 0.3, 0.006, WHITE));
    }
  }

  var COATS = {
    chicken: [
      { body: 0xf8f8f3, side: 0xe7e9ec, tip: 0xbfc8d4, comb: 0xe5323c, comb2: 0xc42531, beak: 0xffc21a, beakHi: 0xffd95e,
        beakLo: 0xe9a512, leg: 0xff9a1f, blush: 0xffb7bf },
      { body: 0xc98a4b, side: 0xb47738, tip: 0x7a4a24, comb: 0xe5323c, comb2: 0xc42531, beak: 0xffc21a, beakHi: 0xffd95e,
        beakLo: 0xe9a512, leg: 0xff9a1f, blush: 0xf2a08f },
    ],
    cat: [
      { fur: 0xf2a046, side: 0xdf8b33, stripe: 0xc0661c, white: 0xfff4e6, pink: 0xff9fb2, eye: 0x86d14a },
      { fur: 0xa9afb8, side: 0x959ba4, stripe: 0x6d737c, white: 0xf4f6f8, pink: 0xff9fb2, eye: 0xf2c94c },
    ],
    dog: [
      { fur: 0xd9a35e, side: 0xc68d48, dark: 0x6f4424, white: 0xfbf4e8, nose: 0x231a17, collar: 0xe0383e, tag: 0xffcf3a, tongue: 0xff7f95 },
      { fur: 0x55555e, side: 0x45454d, dark: 0x2a2a30, white: 0xf6f3ee, nose: 0x141414, collar: 0x3a8ee0, tag: 0xffcf3a, tongue: 0xff7f95 },
    ],
    pig: [
      { skin: 0xffb6c4, side: 0xf59bb0, snout: 0xff9aae, dark: 0xc9607a, hoof: 0x7a4b3a, blush: 0xff8fa5 },
      { skin: 0xc98f6b, side: 0xb57c5a, snout: 0xdba283, dark: 0x8a5236, hoof: 0x4a2e22, blush: 0xe58a78 },
    ],
    frog: [
      { skin: 0x6fcf4a, side: 0x58b23a, dark: 0x3f8a2a, belly: 0xe2f4a8, blush: 0xff9fb0 },
      { skin: 0x4aa8e8, side: 0x3a90cf, dark: 0x2a6aa8, belly: 0xd6ecff, blush: 0xff9fb0 },
    ],
  };

  var BUILD = {
    // A plump white hen: round body, big head forward, three-lobed comb, wattle, yellow beak, orange legs.
    chicken: function (p, L) {
      for (var sx = -1; sx <= 1; sx += 2) {
        L.push(B(sx * 0.1, 0, 0.06, 0.05, 0.14, 0.05, p.leg));                                  // legs
        L.push(B(sx * 0.1, 0, 0.0, 0.11, 0.035, 0.15, p.leg));                                  // feet, toes forward
        L.push(B(sx * 0.262, 0.22, 0.1, 0.025, 0.2, 0.32, p.side));                             // folded wings
        L.push(B(sx * 0.265, 0.22, 0.22, 0.025, 0.08, 0.14, p.tip));                            // their grey tips
        L.push(B(sx * 0.171, 0.57, -0.23, 0.012, 0.04, 0.05, p.blush));                          // cheeks
      }
      L.push(B(0, 0.1, 0.08, 0.42, 0.03, 0.46, p.side));                                         // the body, rounded
      L.push(B(0, 0.13, 0.08, 0.5, 0.36, 0.54, p.body, { sides: p.side }));
      L.push(B(0, 0.49, 0.1, 0.42, 0.05, 0.44, p.body, { sides: p.side }));
      L.push(B(0, 0.18, -0.21, 0.38, 0.26, 0.04, p.body));                                       // the puffed breast
      L.push(B(0, 0.4, 0.37, 0.32, 0.16, 0.06, p.body, { sides: p.side }));                      // the tail fan, stepped up
      L.push(B(0, 0.52, 0.41, 0.22, 0.14, 0.05, p.body, { sides: p.side }));
      L.push(B(0, 0.63, 0.44, 0.12, 0.1, 0.04, p.tip));
      L.push(B(0, 0.48, -0.13, 0.34, 0.32, 0.3, p.body, { sides: p.side }));                     // the head, set forward
      L.push(B(0, 0.8, -0.22, 0.08, 0.07, 0.07, p.comb));                                        // the comb: three lobes
      L.push(B(0, 0.8, -0.14, 0.08, 0.12, 0.08, p.comb));
      L.push(B(0, 0.8, -0.06, 0.08, 0.08, 0.07, p.comb2));
      L.push(B(0, 0.6, -0.32, 0.12, 0.05, 0.08, p.beak, { top: p.beakHi }));                    // the beak, upper and lower
      L.push(B(0, 0.565, -0.31, 0.1, 0.035, 0.06, p.beakLo));
      L.push(B(0, 0.47, -0.3, 0.07, 0.1, 0.04, p.comb));                                         // the wattle
      for (var s2 = -1; s2 <= 1; s2 += 2) {                                                       // eyes, one each side
        L.push(B(s2 * 0.171, 0.64, -0.19, 0.012, 0.08, 0.07, BLACK));
        L.push(B(s2 * 0.172, 0.69, -0.21, 0.012, 0.025, 0.025, WHITE));
      }
    },
    // An orange tabby: stripes over the back, white paws and muzzle, green eyes, pointed ears, tail curled up.
    cat: function (p, L) {
      for (var sx = -1; sx <= 1; sx += 2) {
        L.push(B(sx * 0.12, 0, -0.12, 0.1, 0.14, 0.1, p.fur), B(sx * 0.12, 0, -0.125, 0.105, 0.05, 0.11, p.white));
        L.push(B(sx * 0.12, 0, 0.24, 0.11, 0.14, 0.12, p.fur), B(sx * 0.12, 0, 0.24, 0.115, 0.05, 0.125, p.white));
        for (var z = 0; z < 3; z++) L.push(B(sx * 0.201, 0.26, 0.0 + z * 0.12, 0.006, 0.16, 0.05, p.stripe));
        L.push(B(sx * 0.14, 0.68, -0.15, 0.13, 0.08, 0.1, p.fur), B(sx * 0.15, 0.76, -0.15, 0.07, 0.07, 0.07, p.fur));   // ears
        L.push(B(sx * 0.14, 0.685, -0.203, 0.07, 0.07, 0.006, p.pink));
        L.push(B(sx * 0.23, 0.44, -0.3, 0.1, 0.012, 0.012, p.white), B(sx * 0.23, 0.41, -0.3, 0.1, 0.012, 0.012, p.white)); // whiskers
      }
      L.push(B(0, 0.12, 0.07, 0.4, 0.3, 0.5, p.fur, { sides: p.side }));                         // the body
      for (var i = 0; i < 3; i++) L.push(B(0, 0.42, i * 0.12, 0.404, 0.006, 0.05, p.stripe));
      L.push(B(0, 0.14, -0.185, 0.24, 0.22, 0.012, p.white));                                    // the white chest
      L.push(B(0, 0.36, -0.17, 0.42, 0.32, 0.3, p.fur, { sides: p.side }));                      // the head
      L.push(B(0, 0.6, -0.322, 0.04, 0.08, 0.006, p.stripe), B(-0.07, 0.62, -0.322, 0.03, 0.06, 0.006, p.stripe), B(0.07, 0.62, -0.322, 0.03, 0.06, 0.006, p.stripe));
      L.push(B(0, 0.38, -0.33, 0.18, 0.1, 0.03, p.white));                                       // the muzzle and nose
      L.push(B(0, 0.46, -0.345, 0.06, 0.04, 0.02, p.pink));
      eyes(L, 0.1, 0.5, -0.326, 0.09, 0.09, p.eye);
      L.push(B(-0.1, 0.5, -0.334, 0.028, 0.09, 0.004, BLACK), B(0.1, 0.5, -0.334, 0.028, 0.09, 0.004, BLACK));
      L.push(B(0, 0.28, 0.35, 0.07, 0.07, 0.08, p.fur), B(0, 0.28, 0.4, 0.07, 0.36, 0.07, p.fur));   // the tail, up
      L.push(B(0, 0.64, 0.37, 0.07, 0.08, 0.1, p.stripe));
    },
    // A puppy: tan with a dark saddle, floppy ears, white snout and blaze, a red collar with a gold tag.
    dog: function (p, L) {
      for (var sx = -1; sx <= 1; sx += 2) {
        L.push(B(sx * 0.12, 0, -0.1, 0.1, 0.16, 0.1, p.fur), B(sx * 0.12, 0, -0.105, 0.105, 0.05, 0.11, p.white));
        L.push(B(sx * 0.12, 0, 0.24, 0.1, 0.16, 0.1, p.fur), B(sx * 0.12, 0, 0.24, 0.105, 0.05, 0.105, p.white));
        L.push(B(sx * 0.191, 0.3, 0.14, 0.006, 0.12, 0.26, p.dark));                              // the saddle's sides
        L.push(B(sx * 0.195, 0.44, -0.15, 0.05, 0.27, 0.15, p.dark));                              // floppy ears
      }
      L.push(B(0, 0.14, 0.08, 0.38, 0.28, 0.5, p.fur, { sides: p.side }));                       // the body
      L.push(B(0, 0.42, 0.14, 0.3, 0.006, 0.26, p.dark));                                        // the saddle
      L.push(B(0, 0.16, -0.175, 0.22, 0.22, 0.012, p.white));                                    // the white chest
      L.push(B(0, 0.37, -0.14, 0.36, 0.05, 0.28, p.collar));                                     // the collar and tag
      L.push(B(0, 0.32, -0.29, 0.05, 0.05, 0.02, p.tag));
      L.push(B(0, 0.42, -0.16, 0.36, 0.3, 0.3, p.fur, { sides: p.side }));                       // the head
      L.push(B(0, 0.52, -0.312, 0.07, 0.2, 0.006, p.white));                                     // the blaze
      L.push(B(0, 0.42, -0.37, 0.2, 0.13, 0.12, p.white));                                       // the snout, nose, tongue
      L.push(B(0, 0.51, -0.435, 0.08, 0.05, 0.03, p.nose));
      L.push(B(0, 0.4, -0.432, 0.06, 0.05, 0.02, p.tongue));
      eyes(L, 0.09, 0.6, -0.316, 0.05, 0.06, p.nose);
      L.push(B(0, 0.38, 0.35, 0.06, 0.06, 0.06, p.fur), B(0, 0.42, 0.37, 0.06, 0.18, 0.06, p.fur));   // the tail, up
      L.push(B(0, 0.6, 0.37, 0.06, 0.05, 0.06, p.white));
    },
    // A round pink pig: a big snout with nostrils, ears tipped forward, rosy cheeks, a curly tail.
    pig: function (p, L) {
      for (var sx = -1; sx <= 1; sx += 2) {
        L.push(B(sx * 0.14, 0, -0.1, 0.1, 0.12, 0.1, p.skin), B(sx * 0.14, 0, -0.1, 0.105, 0.035, 0.105, p.hoof));
        L.push(B(sx * 0.14, 0, 0.24, 0.1, 0.12, 0.1, p.skin), B(sx * 0.14, 0, 0.24, 0.105, 0.035, 0.105, p.hoof));
        L.push(B(sx * 0.15, 0.6, -0.27, 0.12, 0.1, 0.06, p.side), B(sx * 0.15, 0.6, -0.31, 0.1, 0.05, 0.04, p.dark));   // ears
        L.push(B(sx * 0.15, 0.36, -0.342, 0.06, 0.04, 0.006, p.blush));
        L.push(B(sx * 0.045, 0.34, -0.432, 0.04, 0.05, 0.006, p.dark));                            // nostrils
      }
      L.push(B(0, 0.1, 0.06, 0.52, 0.4, 0.54, p.skin, { sides: p.side }));                       // the body
      L.push(B(0, 0.5, 0.06, 0.44, 0.05, 0.46, p.skin, { sides: p.side }));
      L.push(B(0, 0.08, 0.06, 0.44, 0.02, 0.46, p.side));
      L.push(B(0, 0.24, -0.27, 0.42, 0.36, 0.14, p.skin, { sides: p.side }));                    // the face
      L.push(B(0, 0.3, -0.385, 0.2, 0.14, 0.09, p.snout));                                       // the snout
      eyes(L, 0.11, 0.48, -0.343, 0.05, 0.06, BLACK);
      L.push(B(0, 0.4, 0.345, 0.05, 0.05, 0.05, p.side), B(0.04, 0.44, 0.355, 0.05, 0.05, 0.05, p.side), B(0, 0.48, 0.36, 0.05, 0.05, 0.05, p.side));
    },
    // A frog: squat and wide, eyes bulging on top, a pale belly, back legs folded out, spots on its back.
    frog: function (p, L) {
      for (var sx = -1; sx <= 1; sx += 2) {
        L.push(B(sx * 0.25, 0, 0.16, 0.12, 0.14, 0.3, p.skin, { sides: p.side }));                // back legs
        L.push(B(sx * 0.29, 0, -0.04, 0.16, 0.03, 0.14, p.side));
        L.push(B(sx * 0.16, 0, -0.2, 0.07, 0.14, 0.07, p.skin), B(sx * 0.17, 0, -0.24, 0.12, 0.025, 0.08, p.side));   // front legs
        L.push(B(sx * 0.14, 0.42, -0.16, 0.15, 0.15, 0.15, p.skin, { sides: p.side }));           // the eyes' domes
        L.push(B(sx * 0.14, 0.44, -0.237, 0.11, 0.11, 0.006, WHITE));
        L.push(B(sx * 0.14, 0.46, -0.241, 0.05, 0.07, 0.004, BLACK));
        L.push(B(sx * 0.19, 0.3, -0.292, 0.06, 0.035, 0.006, p.blush));
      }
      L.push(B(0, 0.06, 0.06, 0.44, 0.26, 0.5, p.skin, { sides: p.side }));                      // the body
      L.push(B(0, 0.08, -0.195, 0.3, 0.16, 0.012, p.belly));
      L.push(B(0, 0.28, -0.08, 0.48, 0.16, 0.42, p.skin, { sides: p.side }));                    // the head
      L.push(B(0, 0.33, -0.292, 0.32, 0.015, 0.006, p.dark));                                    // the smile
      L.push(B(0.1, 0.44, 0.02, 0.07, 0.006, 0.07, p.dark), B(-0.08, 0.44, 0.08, 0.06, 0.006, 0.06, p.dark));
      L.push(B(0.05, 0.32, 0.2, 0.08, 0.006, 0.08, p.dark), B(-0.1, 0.32, 0.24, 0.06, 0.006, 0.06, p.dark));
    },
  };

  var ANIMALS = ['chicken', 'cat', 'dog', 'pig', 'frog'];
  var cache = {};
  /* The boxes of an animal (alt: its second coat). Anything unknown is the chicken. */
  function model(id, alt) {
    if (!BUILD[id]) id = 'chicken';
    var key = id + (alt ? ':alt' : '');
    if (!cache[key]) { var L = []; BUILD[id](COATS[id][alt ? 1 : 0], L); cache[key] = L; }
    return cache[key];
  }
  // The colour a hit sends flying (feathers for the chicken); null for an animal that has none.
  function feathers(id, alt) { return id === 'chicken' ? COATS.chicken[alt ? 1 : 0].body : null; }
  var api = { ANIMALS: ANIMALS, model: model, feathers: feathers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_CROSSY_CAST = api;
})(typeof window !== 'undefined' ? window : null);
