'use strict';
/* An empty Watch never looks dead (Owen 2026-10-28): the games with no map to show behind "Nobody is playing yet"
   (Knockout, Battleship, Crossy Road, Pac-Man) ask the shared Spectate bar for their card art, drawn the way the
   lobby's game screen draws it. Source checks. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const bar = read('public/js/shared/dsWatchBar.js');
const lobby = read('public/v2.html');

test('the four pages with no empty map ask for the card art', () => {
  for (const f of ['public/js/knockout.js', 'public/js/battleship.js', 'public/js/crossy/crossyMain.js',
    'public/js/chomp/chompMain.js']) {
    assert.match(read(f), /emptyArt: true/, f);
  }
});

test('the bar shows the art only while empty, and only when asked', () => {
  assert.match(bar, /function emptyMap\(show\) \{\n    emptyArt\(show && opts\.emptyArt === true\);/);
  assert.match(bar, /watching: function \(n\) \{[\s\S]*?emptyMap\(false\);/);
  assert.match(bar, /close: function \(\) \{[\s\S]*?emptyMap\(false\);/);
  assert.match(bar, /\/\^\[a-z0-9\]\+\$\/\.test\(id\)/);
});

test('the art is the lobby card at the lobby version, with the game screen look', () => {
  const v = /const ART_V=(\d+);/.exec(lobby);
  assert.ok(v, 'v2.html ART_V');
  assert.match(bar, new RegExp('var ART_V = ' + v[1] + ';'));
  assert.match(lobby, /const artSrc=\(id,wide\)=>`\/img\/games\/\$\{id\}-card\$\{wide\?'-wide':''\}\.webp\?v=\$\{ART_V\}`;/);
  assert.match(bar, /'url\("\/img\/games\/' \+ id \+ '-card\.webp\?v=' \+ ART_V \+ '"\)'/);
  assert.match(bar, /filter:blur\(6px\) brightness\(\.4\) saturate\(1\.05\)/);
  assert.match(lobby, /\.gbg \.im\.still\{background-size:cover;background-position:center;\n  filter:blur\(6px\) brightness\(\.4\) saturate\(1\.05\)\}/);
});

test('the art sits under the bar and over the page', () => {
  assert.match(bar, /var ART_Z = Z - 200;/);
  assert.match(bar, /'\.dsw-art\{position:fixed;inset:0;z-index:' \+ ART_Z \+ ';[^']*pointer-events:none;/);
});
