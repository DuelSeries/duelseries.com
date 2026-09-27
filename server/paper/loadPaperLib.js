'use strict';
// Loads the solo Paper simulation into node, unchanged (design 4.1). The modules are IIFEs over
// globalThis that fill globalThis.DuelPaperLib; the order is the page's (public/paper.html).
// paperInput, paperRender and paperMain are browser-only and never load here. No per-arena
// state may ever be put on the shared namespace: every arena gets its own grid, border, skins,
// names and config through makeArena.
const path = require('path');

const DIR = path.join(__dirname, '../../public/js/paper');
const MODULES = ['paperGeom', 'paperTerritory', 'paperBots', 'paperUnits', 'paperGame', 'paperGameMoves', 'paperSkins'];

for (const name of MODULES) require(path.join(DIR, name + '.js'));
require(path.join(DIR, 'mp/paperWire.js'));

const P = globalThis.DuelPaperLib;
if (!P || !P.Game || !P.MP || typeof P.Game.prototype.getMovement !== 'function') {
  throw new Error('loadPaperLib: the solo Paper modules did not load');
}

module.exports = P;
