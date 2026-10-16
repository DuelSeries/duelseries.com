/* slither's body sprites for the lobby's snake previews (public/js/v2/look.js),
   built off the main thread.

   slSprites.js buildSprites paints every colour's body frames pixel by pixel
   (42 colours, 7 frames each but 60 for colour 36, every one a getImageData,
   a fill and a putImageData): about a quarter of a second of main thread on a
   desktop and well over a second on a phone. Built where the preview was first
   painted, that froze the first swipe into the Shop (measured 2026-10-16: one
   ~250 ms long task at 375x812, against 4 to 17 ms for every other swipe).

   Here it is the same frozen file and the same call, onto OffscreenCanvases
   instead of the page's canvases, and only what look.js draws goes back: the
   outline ring and each colour's frames, as ImageBitmaps (moved, not copied).
   Nothing here can be bought, worn or sent to a game. */
'use strict';
importScripts('/js/sl/slSprites.js');

/* buildSprites only ever asks its document for canvases, then sets their size.
   Plain canvases: with willReadFrequently it ran twice as fast but 347 of the
   348 sprites came out different from the page's own build. These match it
   byte for byte. */
var doc = { createElement: function () { return new OffscreenCanvas(1, 1); } };

try {
  var S = {}, moved = [];
  self.DuelSlither.slSprites.buildSprites(S, { document: doc, nsr: false });
  var bmp = function (c) { var b = c.transferToImageBitmap(); moved.push(b); return b; };
  var out = {
    komc: bmp(S.komc),
    per_color_imgs: S.per_color_imgs.map(function (o) { return { kmcs: o.kmcs.map(bmp), klp: o.klp }; }),
  };
  self.postMessage(out, moved);
} catch (e) {
  self.postMessage({ error: String((e && e.message) || e) });
}
