'use strict';
/* The home screen's Live wins strip (public/v2.html). Owen 2026-10-28: the last 50 wins, it holds still, only a new
   real win slides in, and it scrolls by hand. Site redo (2026-11-01, site audit 2026-10-31): real cash-outs only.
   The seeded sample names and amounts that filled the row out to 50 are gone (every money figure shown is real);
   with no real win yet the strip says so, and when the server says there is nothing to show (ok:false) the strip
   is not drawn at all.
   Dial-in (Owen 2026-11-02): config.js SAMPLE_WINS fills the row with made-up wins from socialPreview.js, a new one
   every few seconds, and the label says Sample unless SAMPLE_TAG is off. Off, it is real cash-outs only, as above. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8').replace(/\r\n/g, '\n');
const between = (a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, a); const j = html.indexOf(b, i); assert.ok(j > i, b); return html.slice(i, j); };
const GAMES = [
  { id: 'snake', name: 'Slither.io', ladder: 1 }, { id: 'paper', name: 'Paper.io', ladder: 1 }, { id: 'pool8', name: '8 Ball Pool', duel: 1, paid: 1 },
  { id: 'tanks', name: 'Bowmasters', duel: 1, freeOnly: 1 }, { id: 'stumble', name: 'Stumble Guys', soon: 1 },
];

// The strip's own script (from REAL_WINS to tkNew), run against a small game registry and a stand-in page.
function strip(answer, fill) {
  const section = { hidden: false };
  const run = { innerHTML: '', style: {}, classList: { add() {} } };
  const ctx = {
    GAMES, G: (id) => GAMES.find((g) => g.id === id), artSrc: (id) => '/img/games/' + id + '-card.webp?v=1',
    setInterval() {}, JSON, Number, String, Array, Promise, Math, Date,
    window: fill ? { V2SocialPreview: fill } : {}, V2SocialPreview: fill,
    document: { querySelector: (q) => (q === '#home .hwins' ? section : null), getElementById: (id) => (id === 'tkrun' ? run : null) },
    fetch: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ json: () => Promise.resolve(answer) })),
  };
  vm.createContext(ctx);
  vm.runInContext(between('let REAL_WINS=[];', '/* How many wins at the front') + between('const tkKey=', '/* The k newest')
    + ';this.t={buildWins,tkNew,loadRealWins,set:(r)=>{REAL_WINS=r;WINS=buildWins();return WINS;}};', ctx);
  return { t: ctx.t, section, run };
}
const settle = () => new Promise((r) => setImmediate(r));

test('wins strip: nothing made up, real wins only, never a game that is not open', () => {
  const src = between('let REAL_WINS=[];', '/* How many wins at the front');
  for (const gone of ['NAMES', 'SAMPLES', 'madeUpAmount', 'tkRng', 'Math.random']) assert.ok(!src.includes(gone), gone + ' is gone');
  assert.ok(src.includes('const FILL=()=>window.V2SocialPreview&&V2SocialPreview.winsOn?V2SocialPreview:null;'),
    'made-up wins come only from socialPreview.js, behind config.js SAMPLE_WINS');
  const { t } = strip({ ok: true, wins: [] });
  assert.deepStrictEqual(t.set([]), [], 'no real wins: an empty row, not samples');
  const w = t.set([{ who: 'MrPeanutK', g: 'snake', amt: 0.45 }, { who: 'ghost', g: 'stumble', amt: 1 }, { who: 'neo', g: 'pool8', amt: 0.9 }]);
  assert.deepStrictEqual(w.map((x) => x.who), ['MrPeanutK', 'neo'], 'a game not open yet never shows');
  assert.strictEqual(t.set(Array.from({ length: 60 }, (_, i) => ({ who: 'p' + i, g: 'paper', amt: 0.9 }))).length, 50, 'the last 50');
});

test('wins strip: the first answer draws it still; none yet says so; ok:false hides it', async () => {
  let s = strip({ ok: true, wins: [{ name: 'MrPeanutK', game: 'snake', amount: 1.77 }, { name: '<b>x</b>', game: 'paper', amount: 0.9 }] });
  s.t.loadRealWins(); await settle(); await settle();
  assert.strictEqual(s.section.hidden, false);
  assert.ok(s.run.innerHTML.includes('<b>MrPeanutK</b><em class="num">+$1.77</em>'), 'name and amount');
  assert.ok(s.run.innerHTML.includes('&lt;b&gt;x&lt;/b&gt;') && !s.run.innerHTML.includes('<b><b>'), 'a player\'s name is escaped');
  assert.ok(s.run.innerHTML.includes(' won in Slither.io'), 'read aloud with its game');

  s = strip({ ok: true, wins: [] });
  s.t.loadRealWins(); await settle(); await settle();
  assert.strictEqual(s.section.hidden, false);
  assert.ok(s.run.innerHTML.includes('No paid wins yet'), 'an honest empty state');

  for (const off of [{ ok: false, wins: [] }, new Error('offline')]) {
    s = strip(off);
    s.t.loadRealWins(); await settle(); await settle();
    assert.strictEqual(s.section.hidden, true, 'no strip: ' + (off instanceof Error ? 'a failed first read' : 'the server says off'));
    assert.ok(!/No paid wins yet/.test(s.run.innerHTML), 'and no claim that there are none');
  }
});

test('wins strip: how many wins are new at the front', () => {
  const { t } = strip({ ok: true, wins: [] });
  const was = t.set([]);
  const one = t.set([{ who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(was, one), 0, 'the first win into an empty row: redrawn still');
  const two = t.set([{ who: 'y', g: 'snake', amt: 2.5 }, { who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(one, two), 1);
  const same = t.set([{ who: 'x', g: 'pool8', amt: 0.9 }, { who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(one, same), 1, 'the same win twice in a row');
  assert.strictEqual(t.tkNew(two, one), 0, 'nothing new at the front: redrawn still');
});

test('wins strip: still on load and reload; moves only for a new real win; scrolls by hand', () => {
  const draw = between('function drawTicker(){', '/* How many wins');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(draw), 'drawing the row starts no motion');
  assert.ok(!/tkTimer/.test(html), 'no rotation timer');
  assert.ok(/if\(first\)drawTicker\(\); else tkSlide\(tkNew\(was,WINS\)\);/.test(html), 'the first answer after a load is drawn still');
  assert.ok(/setInterval\(loadRealWins,20000\);/.test(html));
  assert.ok(/\.tickerwrap\.top \.ticker\{overflow-x:auto;/.test(html), 'scrollable');
  assert.ok(/if\(box\.scrollLeft>4\)\{box\.scrollLeft\+=dx;return;\}/.test(html), 'a reader scrolled along keeps their place');
  const swipe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'v2', 'swipe.js'), 'utf8');
  assert.ok(/const EXEMPT = '[^']*\.tickerwrap\.top \.ticker'/.test(swipe), 'a sideways swipe on it scrolls it, not the tabs');
});

test('wins strip: made-up wins only behind SAMPLE_WINS, tagged Sample unless the tag is off', () => {
  const made = [{ who: 'Kestrel', g: 'snake', amt: 2.5 }, { who: 'zinc', g: 'stumble', amt: 1 }, { who: 'yuzu', g: 'pool8', amt: 0.9 }];
  const fill = { winsOn: true, wins: () => made, WIN_MS: 6000, liveLook: false, tag: 'Sample' };
  const { t } = strip({ ok: true, wins: [] }, fill);
  assert.deepStrictEqual(t.buildWins().map((x) => x.who), ['Kestrel', 'yuzu'], 'the made-up row, never a game not open');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'v2', 'config.js'), 'utf8');
  assert.ok(/SAMPLE_TAG: true,/.test(cfg), 'the Sample tag is on in the shipped config');
  const pv = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'v2', 'socialPreview.js'), 'utf8');
  assert.ok(/const LIVE_LOOK = CFG\.SAMPLE_TAG === false \|\| \(LOCAL && /.test(pv), 'only the config or a localhost preview drops the tag');
  assert.ok(html.includes("if(l&&f&&!f.liveLook)l.innerHTML='<span>Wins</span><span class=\"ds-chip lb-sample\">'+f.tag+'</span>';"),
    'the strip says Sample while the tag is on');
});
