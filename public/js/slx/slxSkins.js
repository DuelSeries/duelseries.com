// DuelSeries layer on the frozen slither.io client: paints the 12 picture-skin canvases (SERVER-DESIGN 15.5; Owen Q3
// "everything they have, picture skins included, for now"; task T18). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// ONE off switch, and it is the server's: PICTURE_SKINS (server/sl/slLaws.js, default {on: false}). While it is off
// the server never sends a picture skin id to anyone (bots skip them, server/sl/slBots.js botSkins; a player's chosen
// one becomes a plain colour, server/sl/slSockets.js), so this file never sees one and loads nothing. The first
// snake_add of a picture skin (cv 37, 39 to 42, 45 to 49, 59, 62, public/js/sl/slSprites.js:409) is the sign the
// switch is on: then, once, the 12 images load from /img/slx/ and each one, as it loads, is drawn into the SAME blank
// canvas their client made for it (slSprites.js:409-424, 552-556) exactly as their onload does (their game.js
// 3130-3295): a padded bulb is drawn into a fresh canvas of the bulb's size at (21, 21), then into the bulb with
// shadowColor #000000 and shadowBlur 20; the two face parts (jmou, sest) are drawn at (0, 0). Their draw code already
// reads those canvases, so nothing else changes. Until an image arrives (or if a file is missing) the canvas stays
// blank, as theirs does before its load.
//
// LEGAL FLAG (SERVER-DESIGN 15.5): these are slither.io's own image files on a real-money site. The files go into
// public/img/slx/ only after Owen has looked at each one; PICTURE_SKINS goes on only through an APPROVED row naming them.
//
// Adds to DuelSlither.slx: skins = {painted(), loads()}.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !doc) return;

  var BASE = '/img/slx/';
  // [canvas on S, file, padded bulb], in their load order (their game.js 3130-3295; files SERVER-DESIGN 15.5).
  var PICTURES = [
    ['kwkbulb', 'kwk6.png', true],
    ['jmou', 'jmou3.png', false],
    ['pwdbulb', 'pewd.png', true],
    ['sest', 'sest5.png', false],
    ['playbulb', 'play.png', true],
    ['bonkbulb', 'bonkers2.png', true],
    ['leafbulb', 'leaf.png', true],
    ['swissbulb', 'swiss.png', true],
    ['moldovabulb', 'moldova.png', true],
    ['vietnambulb', 'vietnam.png', true],
    ['argentinabulb', 'argentina.png', true],
    ['movbulb', 'mov2.png', true]
  ];
  var PAD = 21;                                  // image offset inside a padded bulb (their game.js:3139)
  var SHADOW = '#000000';                        // their game.js:3141
  var BLUR = 20;                                 // their game.js:3142
  // The 12 picture skin ids (public/js/sl/slSprites.js:409; server/sl/slBots.js PICTURE_SKIN_CVS).
  var PICTURE_CVS = [37, 39, 40, 41, 42, 45, 46, 47, 48, 49, 59, 62];
  var isPicture = {};
  for (var i = 0; i < PICTURE_CVS.length; i++) isPicture[PICTURE_CVS[i]] = true;

  var painted = false;
  var loads = 0;

  function load(entry) {
    var target = S[entry[0]];
    if (!target || typeof target.getContext !== 'function') return;
    var img = doc.createElement('img');
    img.onload = function () {
      try {
        if (entry[2]) {
          var tmc = doc.createElement('canvas');
          tmc.width = target.width;
          tmc.height = target.height;
          tmc.getContext('2d').drawImage(img, PAD, PAD);
          var ctx = target.getContext('2d');
          ctx.shadowColor = SHADOW;
          ctx.shadowBlur = BLUR;
          ctx.drawImage(tmc, 0, 0);
        } else {
          target.getContext('2d').drawImage(img, 0, 0);
        }
        loads++;
      } catch (e) {
        slx.errors = (slx.errors || 0) + 1;
      }
    };
    img.src = BASE + entry[1];
  }

  function paint() {
    if (painted) return;
    painted = true;
    off();
    for (var n = 0; n < PICTURES.length; n++) load(PICTURES[n]);
  }

  var off = slx.on('frame', function (events) {
    if (painted || !events) return;
    for (var n = 0; n < events.length; n++) {
      var ev = events[n];
      if (ev && ev.type === 'snake_add' && isPicture[ev.cv] === true) {
        paint();
        return;
      }
    }
  });

  slx.skins = {
    painted: function () { return painted; },
    loads: function () { return loads; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
