/* agar.io's FREE skins (Owen, 2026-10-15): a colour you pick in Customize and
   keep every life, instead of the colour the server deals each spawn.
   One list for both ends: the lobby's chooser lists these (after "Random
   colour", before the Shop's locked skins) and the /ag server accepts only an
   id from here (server/ag/agRoom.js), so a page can never ask for a colour
   that is not on it.

   A skin is a cell colour and nothing else. The colour rides the wire the cell
   already carries (shared/agWire.js rgb), so every player sees it with no new
   field, and agRender draws it exactly as it draws a dealt colour: the rim at
   0.9 of it, then the cell.

   The choice is stored in the lobby under duel.ag.skin and sent by the /ag page
   in its socket handshake (public/js/ag/agMain.js). Nothing stored, or an id
   not listed here, means a dealt colour, as before. Cosmetic only: no money
   path reads it. */
(function (root) {
  'use strict';
  var SKINS = [
    { id: 'cherry',    name: 'Cherry',    rgb: [232, 32, 58] },
    { id: 'coral',     name: 'Coral',     rgb: [255, 111, 97] },
    { id: 'tangerine', name: 'Tangerine', rgb: [255, 138, 31] },
    { id: 'peach',     name: 'Peach',     rgb: [255, 179, 138] },
    { id: 'lemon',     name: 'Lemon',     rgb: [255, 217, 59] },
    { id: 'lime',      name: 'Lime',      rgb: [143, 224, 58] },
    { id: 'emerald',   name: 'Emerald',   rgb: [25, 184, 102] },
    { id: 'mint',      name: 'Mint',      rgb: [95, 227, 192] },
    { id: 'aqua',      name: 'Aqua',      rgb: [32, 201, 230] },
    { id: 'sky',       name: 'Sky',       rgb: [90, 169, 255] },
    { id: 'cobalt',    name: 'Cobalt',    rgb: [47, 91, 234] },
    { id: 'indigo',    name: 'Indigo',    rgb: [91, 63, 214] },
    { id: 'grape',     name: 'Grape',     rgb: [154, 79, 224] },
    { id: 'bubblegum', name: 'Bubblegum', rgb: [255, 111, 192] },
    { id: 'chocolate', name: 'Chocolate', rgb: [122, 74, 42] },
    { id: 'slate',     name: 'Slate',     rgb: [91, 102, 117] },
    { id: 'charcoal',  name: 'Charcoal',  rgb: [43, 47, 54] },
  ];
  var BY = {};
  SKINS.forEach(function (s) { BY[s.id] = s; });
  /* The colour for an id, as a fresh [r, g, b], or null for anything not listed. */
  function rgbOf(id) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(BY, id)) return null;
    return BY[id].rgb.slice();
  }
  function hex(s) {
    return '#' + s.rgb.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  var api = { SKINS: SKINS, rgbOf: rgbOf, hex: hex, KEY: 'duel.ag.skin' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_AG_SKINS = api;
})(typeof window !== 'undefined' ? window : null);
