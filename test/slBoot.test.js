'use strict';
// slBoot (SERVER-DESIGN 4.1, 13 items 1 to 3, 15.0, 18.1; task T11): the switch is OFF by default and fails closed on
// junk; the dev law table is refused where it could be the live server; the boot is refused with a PROPOSED row or an
// APPROVED row without approvedAt; the page is composed once before its single </body>; /sl answers by state; the
// biggest cash-out box never closes the game.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../server/sl/slBoot');
const routes = require('../server/slRoutes');
const { LAWS, STATUS } = require('../server/sl/slLaws');

const QUIET = { log() {}, warn() {}, error() {} };
const FIXTURE_FILE = path.join(__dirname, 'slLawsFixture.js');
const SL_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'sl.html'), 'utf8');

function logRec() {
  const said = [];
  return { said, log: { log: (m) => said.push(String(m)), warn: (m) => said.push(String(m)), error: (m) => said.push(String(m)) } };
}

// The real table with every row it refuses today settled (as Owen's answers and T15 will), so one row can be broken.
function shippableTable(patch) {
  const t = {};
  for (const id of Object.keys(LAWS)) t[id] = Object.assign({}, LAWS[id]);
  for (const id of Object.keys(t)) {
    const e = t[id];
    if (e.status === STATUS.PROPOSED || e.status === STATUS.NEEDS_MORE) {
      t[id] = Object.assign({}, e, { status: STATUS.CHOSEN, source: 'test: settled for the boot test',
        value: e.value === null ? 200 : e.value });
    }
  }
  for (const id of Object.keys(patch || {})) t[id] = Object.assign({}, t[id], patch[id]);
  return t;
}

function fakeIo() {
  const nsps = {};
  return {
    nsps,
    of(name) {
      if (!nsps[name]) nsps[name] = { uses: [], conns: [], use(f) { this.uses.push(f); }, on(ev, f) { if (ev === 'connection') this.conns.push(f); } };
      return nsps[name];
    },
  };
}

function boot(extra) {
  const opened = B.openSl(Object.assign({ log: QUIET, autoTick: false, monitor: null, bots: false,
    helpers: { socketRL: () => true }, every: () => ({ stop() {} }) }, extra));
  return opened;
}

test('the switch: OFF unless 1, true, on, yes; junk fails closed and says so; one copy with the T-1 routes', () => {
  assert.strictEqual(B.slSwitch, routes.slSwitch);
  for (const v of [undefined, '', '0', 'false', 'off', 'no', ' No ']) assert.strictEqual(B.slSwitch(v, QUIET), false);
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE']) assert.strictEqual(B.slSwitch(v, QUIET), true);
  const r = logRec();
  assert.strictEqual(B.slSwitch('maybe', r.log), false);
  assert.match(r.said[0], /fails closed/);
  for (const v of [undefined, '0', 'maybe', 'enabled']) {
    const o = boot({ env: { SL_ENABLED: v, SL_DEV_LAWS: FIXTURE_FILE } });
    assert.deepStrictEqual([o.arenas, o.page, o.why], [null, null, 'off'], String(v));
  }
});

test('dev laws: refused in production, with an escrow key or a DATABASE_URL; loaded otherwise', () => {
  assert.deepStrictEqual(B.loadSlLaws({}, QUIET), { laws: LAWS, dev: false });
  for (const env of [{ NODE_ENV: 'production' }, { ESCROW_PRIVATE_KEY: 'k' }, { DATABASE_URL: 'postgres://x' }]) {
    const e = Object.assign({ SL_DEV_LAWS: FIXTURE_FILE }, env);
    assert.throws(() => B.loadSlLaws(e, QUIET), /Refused: the dev law table never runs here/);
    const o = boot({ env: Object.assign({ SL_ENABLED: '1' }, e) });
    assert.strictEqual(o.arenas, null);
    assert.match(o.why, /Refused/);
  }
  const d = B.loadSlLaws({ SL_DEV_LAWS: FIXTURE_FILE }, QUIET);
  assert.strictEqual(d.dev, true);
  assert.strictEqual(d.laws.L1.status, 'FIXTURE');
  assert.throws(() => B.loadSlLaws({ SL_DEV_LAWS: path.join(__dirname, 'slNetFakes.js') }, QUIET), /exports no LAWS/);
});

test('the real table today: closed, and why names exactly the rows still waiting', () => {
  const o = boot({ env: { SL_ENABLED: '1' } });
  assert.strictEqual(o.arenas, null);
  assert.strictEqual(o.page, null);
  for (const id of ['C_TOP_EXCLUDE', 'C_TOP_LANDED', 'C_HIDDEN_STREAM', 'C_RESYNC_FADE', 'C_TIMING_BARS', 'C_ROOM_CAP',
    'C_HUMAN_CAP']) assert.ok(o.why.includes(id), id);
});

test('boot refused with a PROPOSED row, or an APPROVED row without approvedAt; open once every row is settled', () => {
  const ok = boot({ env: { SL_ENABLED: '1' }, laws: shippableTable(), io: fakeIo() });
  assert.strictEqual(ok.why, null, String(ok.why));
  assert.ok(ok.arenas && ok.page);
  ok.arenas.close();
  const proposed = boot({ env: { SL_ENABLED: '1' }, laws: shippableTable({ C_CHAT: { status: STATUS.PROPOSED } }) });
  assert.strictEqual(proposed.arenas, null);
  assert.match(proposed.why, /C_CHAT \(PROPOSED\)/);
  const noDate = shippableTable();
  const approvedId = Object.keys(noDate).find((id) => noDate[id].status === STATUS.APPROVED);
  delete noDate[approvedId].approvedAt;
  const nd = boot({ env: { SL_ENABLED: '1' }, laws: noDate });
  assert.strictEqual(nd.arenas, null);
  assert.ok(nd.why.includes(approvedId + ' (APPROVED without approvedAt)'), nd.why);
  const unknownRule = shippableTable({ C_KILLFEED: { value: { rule: 'noSuchRule' } } });
  const ur = boot({ env: { SL_ENABLED: '1' }, laws: unknownRule });
  assert.strictEqual(ur.arenas, null);
  assert.match(ur.why, /unknown rule/);
});

test('composePage: the tail once, right before the single </body>, after slMain.js; refusals', () => {
  const tail = '<script src="/js/slx/slxNet.js"></script>\n';
  const page = B.composePage(SL_HTML, tail);
  assert.strictEqual(page.length, SL_HTML.length + tail.length);
  const at = page.indexOf(tail);
  assert.ok(at > page.indexOf('/js/sl/slMain.js'), 'after slMain.js');
  assert.strictEqual(page.slice(at + tail.length, at + tail.length + 7), '</body>');
  assert.strictEqual(page.replace(tail, ''), SL_HTML, 'nothing else changes');
  assert.strictEqual(B.composePage(SL_HTML, ''), SL_HTML);
  assert.throws(() => B.composePage('<html><body></html>', tail), /exactly one <\/body>/);
  assert.throws(() => B.composePage('<body></body></body>', tail), /exactly one <\/body>/);
  assert.throws(() => B.composePage(page, tail), /already mentions \/js\/slx\//);
  assert.throws(() => B.composePage(null, tail), /page text/);
  const bad = boot({ env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, slHtml: '<html></html>' });
  assert.strictEqual(bad.arenas, null, 'a page that cannot be composed keeps the game closed');
  assert.match(bad.why, /exactly one/);
});

test('slxTail: the layer files present, in the SERVER-DESIGN 3.2 order, then any other by name; css first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slxtail-'));
  try {
    assert.strictEqual(B.slxTail(dir), '', 'no layer yet: an empty tail');
    fs.mkdirSync(path.join(dir, 'js', 'slx'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'css'));
    for (const f of ['slxTouch.js', 'zzExtra.js', 'slxNet.js', 'aaExtra.js', 'slxCard.js', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, 'js', 'slx', f), '');
    }
    assert.strictEqual(B.slxTail(dir), '<script src="/js/slx/slxNet.js"></script>\n' +
      '<script src="/js/slx/slxCard.js"></script>\n<script src="/js/slx/slxTouch.js"></script>\n' +
      '<script src="/js/slx/aaExtra.js"></script>\n<script src="/js/slx/zzExtra.js"></script>\n');
    fs.writeFileSync(path.join(dir, 'css', 'slx.css'), '');
    assert.ok(B.slxTail(dir).startsWith('<link rel="stylesheet" type="text/css" href="/css/slx.css" />\n<script src="/js/slx/slxNet.js">'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.strictEqual(B.SLX_TAIL, B.slxTail(B.PUBLIC_DIR), 'SLX_TAIL is built from the repo at load');
  assert.deepStrictEqual(B.SLX_FILES.slice(0, 3), ['slxNet.js', 'slxMain.js', 'slxDirect.js']);
});

function fakeRes() {
  return {
    code: 0, headers: {}, body: null, kind: null,
    set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.code = c; return this; },
    type(t) { this.kind = t; return this; },
    send(b) { this.body = b; return this; },
  };
}

test('/sl: the composed page when open; the closed page when the switch is on but the boot refused; else the T-1 route', () => {
  let nexted = 0;
  const next = () => { nexted++; };
  let res = fakeRes();
  B.slPageRoute({ arenas: {}, page: '<p>composed</p>', why: null })({}, res, next);
  assert.deepStrictEqual([res.code, res.headers['cache-control'], res.kind, res.body], [200, 'no-store', 'html', '<p>composed</p>']);
  res = fakeRes();
  B.slPageRoute({ arenas: null, page: null, why: 'slLaws: not shippable' })({}, res, next);
  assert.deepStrictEqual([res.code, res.headers['cache-control'], res.body], [503, 'no-store', routes.CLOSED_PAGE]);
  res = fakeRes();
  B.slPageRoute({ arenas: null, page: null, why: 'off' })({}, res, next);
  assert.strictEqual(nexted, 1, 'off: the T-1 route answers');
  assert.strictEqual(res.body, null);
  assert.strictEqual(B.CLOSED_PAGE, routes.CLOSED_PAGE, 'one closed page');
});

test('a dev boot opens /sl on its own namespace with the per-address middleware and a connection handler', () => {
  const io = fakeIo();
  const o = boot({ env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, io, slxTail: '' });
  assert.strictEqual(o.why, null);
  assert.strictEqual(o.dev, true);
  assert.strictEqual(o.page, SL_HTML);
  assert.deepStrictEqual(Object.keys(io.nsps), ['/sl']);
  assert.strictEqual(io.nsps['/sl'].uses.length, 1);
  assert.strictEqual(io.nsps['/sl'].conns.length, 1);
  assert.strictEqual(o.arenas.isOpen(), true);
  o.arenas.close();
});

test('the biggest cash-out box: pushed to the room; a fault in it never closes the game', async () => {
  const msgs = [];
  const o = boot({ env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, slxTail: '',
    topCashout: () => Promise.resolve({ name: 'Ann', rake: '0.5', wallet: 'w1', game: 'snake', at: 0 }),
    excludeWallets: ['owner', 'revenue'] });
  const room = o.arenas.room();
  const orig = room.setTop.bind(room);
  room.setTop = (m) => { msgs.push(m); orig(m); };
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(msgs, [{ t: 'top', name: 'Ann', amount: 4.5 }]);
  assert.ok(o.arenas.topBox);
  o.arenas.close();
  const r = logRec();
  const noWallets = boot({ env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, slxTail: '', log: r.log,
    topCashout: () => Promise.resolve(null), excludeWallets: [] });
  assert.strictEqual(noWallets.why, null, 'the game opens');
  assert.ok(r.said.some((m) => /biggest cash-out box off/.test(m)));
  noWallets.arenas.close();
});

test('openSl never throws: a namespace that throws keeps the game closed and says why', () => {
  const r = logRec();
  const o = boot({ env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, slxTail: '', log: r.log,
    io: { of() { throw new Error('no namespace'); } } });
  assert.strictEqual(o.arenas, null);
  assert.strictEqual(o.why, 'no namespace');
  assert.ok(r.said.some((m) => /stays closed: no namespace/.test(m)));
});
