'use strict';
/* The PC sidebar's Live games list (Owen 2026-10-28): a Watch on every game row, even with nobody in it, the New
   pills in one column, and shorter rows. Source checks plus V2Side's room picker run on its own. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8').replace(/\r\n/g, '\n');

function rowSource() {
  const a = html.indexOf('  function row(g,n){');
  const b = html.indexOf('  function paint(){', a);
  assert.ok(a > 0 && b > a, 'V2Side row() found');
  return html.slice(a, b);
}

test('every row has its Watch, not only the rows with people in them', () => {
  const src = rowSource();
  assert.match(src, /\+`<button class="sb-eye" type="button" data-watch="\$\{g\.id\}" aria-label="Watch \$\{nm\}"/);
  assert.doesNotMatch(src, /on\?`<button class="sb-eye"/);
});

/* Site redo (layout 1, 2026-11-01): the New pill left the rows (it sat on 7 of 10 of them, so it stopped meaning
   anything) and the count is the row's last column, in green; the Watch eye follows it. */
test('the count has a column of its own, and the rows carry no New pill', () => {
  assert.match(html, /\.sb-go\{[^}]*display:grid;grid-template-columns:calc\(21px \+ var\(--art\) \/ 2\) minmax\(0,1fr\) auto;/);
  assert.match(html, /\.sb-c\{grid-column:3;justify-self:end;/);
  assert.doesNotMatch(rowSource(), /sb-new/);
  assert.doesNotMatch(html, /\.sb-g\.idle \.sb-go\{[^}]*padding-right:38px/);
});

/* The sidebar is the tokens' 240px (216px on a narrow PC window), and its rows are sized so the whole column,
   ten-plus game rows and the pinned foot included, fits a 1440x900 window without scrolling. */
test('the game rows are shorter than the tabs at every height', () => {
  assert.match(html, /:root\{--sbw:var\(--ds-sbw\)\}/);
  assert.match(html, /:root\{--rh:32px;--gh:26px;--art:20px\}/);
  assert.match(html, /\(min-height:1000px\)\{:root\{--rh:36px;--gh:30px;--art:22px\}\}/);
  assert.match(html, /\(min-height:1060px\)\{:root\{--rh:38px;--gh:32px;--art:24px\}\}/);
  assert.match(html, /\.sb-g\{display:flex;align-items:center;height:var\(--gh\);/);
});

test('Watch goes to the busiest room, free on a tie or when nobody is anywhere', () => {
  const src = rowSource();
  const fn = src.slice(src.indexOf('  function watchRoom(id){'));
  assert.ok(fn.length > 20, 'watchRoom found');
  const box = { window: { V2Board: { lobbies: [] } } };
  vm.createContext(box);
  vm.runInContext('var V2Board=window.V2Board;' + fn + ';this.watchRoom=watchRoom;', box);
  const set = (rows) => { box.window.V2Board.lobbies = rows; box.V2Board = box.window.V2Board; };
  set([
    { game: 'snake', stake: 0, players: 0, bots: 59 },
    { game: 'snake', stake: 0.5, players: 2, bots: 0 },
    { game: 'agar', stake: 0, players: 0, bots: 0 },
    { game: 'agar', stake: 1, players: 3, bots: 0 },
    { game: 'paper', stake: 0, players: 2, bots: 0 },
    { game: 'paper', stake: 0.5, players: 2, bots: 0 },
    { game: 'chomp', stake: 0, players: 0, bots: 0 },
    { game: 'chomp', stake: 0.5, players: 0, bots: 0 },
  ]);
  assert.strictEqual(box.watchRoom('snake'), 0);
  assert.strictEqual(box.watchRoom('agar'), 1);
  assert.strictEqual(box.watchRoom('paper'), 0);
  assert.strictEqual(box.watchRoom('chomp'), 0);
  assert.strictEqual(box.watchRoom('knockout'), 0);   // the duels have no board rows
  set(null);
  assert.strictEqual(box.watchRoom('snake'), 0);
});

test('the eye hands that room to play.js spectate', () => {
  assert.match(html, /V2Play\.spectate\(w\.dataset\.watch,null,watchRoom\(w\.dataset\.watch\)\)/);
});
