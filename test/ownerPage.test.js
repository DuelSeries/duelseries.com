'use strict';
// The owner console page (public/owner.html), rebuilt as Owen's pick "1 · The sheet" on the owner session. Two kinds
// of check: the source pins below hold the rules that keep a year-long cookie safe and the page honest (no wallet
// widget until Sign in is pressed, X-DS-Owner on every request, server strings only ever as text, no "+5" buttons),
// and the page's own script is then run in a small fake DOM against test/ownerPageStub.js, the fake owner API, to
// see it draw a state, debounce the bot stepper into one bots:set and fall back to the sign-in card on a 401.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createOwnerPageStub } = require('./ownerPageStub');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'owner.html'), 'utf8').replace(/\r\n/g, '\n');
const inline = [...HTML.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\ssrc\s*=/i.test(m[1]));
const SCRIPT = inline.map((m) => m[2]).join('\n');
const fnBody = (name) => {
  const at = SCRIPT.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(at >= 0, 'function ' + name + ' exists');
  const open = SCRIPT.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') depth++;
    else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(at, i + 1);
  }
  return SCRIPT.slice(at);
};

test('the wallet widget is not in the page: it is injected only by Sign in', () => {
  assert.doesNotMatch(HTML, /<script[^>]*src\s*=\s*["'][^"']*wallet\/widget/i);
  // the one place it is added, and the one caller of that place
  assert.match(fnBody('loadWidget'), /tag\.src = '\/wallet\/widget\.js'/);
  const callers = SCRIPT.split('loadWidget(').length - 1;
  assert.equal(callers, 2, 'loadWidget is defined once and called once');
  assert.match(fnBody('signIn'), /await loadWidget\(\);/);
  // the node-global shim runs before it, and #wallet-root is in the page for it to mount into
  assert.match(fnBody('loadWidget'), /window\.global = window\.global \|\| window; window\.process = window\.process \|\| \{ env: \{ NODE_ENV: 'production' \} \};[\s\S]*document\.body\.appendChild\(tag\)/);
  assert.match(HTML, /<div id="wallet-root"><\/div>/);
  // a signed-in device asks the session, never the wallet: boot reads /api/owner/session before anything else
  assert.match(fnBody('boot'), /api\('GET', '\/api\/owner\/session'\)/);
});

test('every request goes through one fetch, and it always carries X-DS-Owner', () => {
  assert.equal(SCRIPT.split('fetch(').length - 1, 1, 'exactly one fetch call in the page');
  const api = fnBody('api');
  assert.match(api, /await fetch\(path, opts\)/);
  assert.match(api, /headers: \{ 'X-DS-Owner': '1' \}/);
  assert.match(api, /credentials: 'same-origin'/);
  assert.match(api, /cache: 'no-store'/);
  assert.doesNotMatch(SCRIPT, /XMLHttpRequest|sendBeacon|new EventSource/);
});

test('server strings only ever reach the page as text', () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const h = fnBody('h');
  assert.match(h, /el\.textContent = String\(v\)/);
  assert.match(h, /el\.append\(c instanceof Node \? c : String\(c\)\)/);
  // alerts and the Done today log
  assert.match(fnBody('drawAlerts'), /x\.textContent = String\(a\.text \|\| ''\)/);
  assert.match(fnBody('partLog'), /String\(a\.note \|\| a\.action \|\| ''\)/);
});

test('no +5 buttons, no legends: bots are one stepper per room', () => {
  assert.ok(!HTML.includes('+5'), 'no +5');
  assert.ok(!HTML.includes("'+1'") && !HTML.includes('>+1<'), 'no +1 button');
  assert.doesNotMatch(SCRIPT, /'bots:add'|'bots:clear'/);
  assert.match(fnBody('flushBots'), /act\(key, 'bots:set', \{ room, count: p\.count \}\)/);
  assert.match(fnBody('backToAuto'), /'bots:set', \{ room, auto: true \}/);
  assert.match(fnBody('nudge'), /setTimeout\(\(\) => \{ flushBots\(room\); \}, 400\)/);
});

test('the actions that cannot be taken back ask first', () => {
  const asks = (re) => assert.match(SCRIPT, re);
  asks(/act\('open', 'maintenance:on', \{ message: 'Back shortly\.' \}, \{ confirm:/);
  asks(/act\('door:' \+ gid, p\.action \+ ':off', \{\}, \{ confirm:/);
  asks(/act\('engine', 'br:engine:old', \{\}, \{ confirm:/);
  asks(/act\('br', 'br:stop', \{\}, \{ confirm:/);
  asks(/act\('announce', 'announce', \{ text \}, \{ confirm:/);
  asks(/window\.confirm\('Sign out every other device\?[\s\S]{0,200}revoke\(\{ others: true \}/);
  // opening things back up does not
  assert.match(SCRIPT, /if \(on\) act\('door:' \+ gid, p\.action \+ ':on'\);/);
});

test('it stays out of search engines and polls only while the tab is in front', () => {
  assert.match(HTML, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(fnBody('startPoll'), /if \(document\.hidden \|\| mode !== 'panel'\) return;\n\s+\/\/ .*\n\s+pollT = setInterval\(\(\) => \{ if \(!S \|\| updating\(S\) \|\| \+\+slowTick % 3 === 0\) refresh\(\); \}, 2000\);/);
  assert.match(SCRIPT, /if \(document\.hidden\) stopPoll\(\);/);
  assert.match(fnBody('refresh'), /api\('POST', '\/api\/owner\/state', \{\}\)/);
});

/* ── the page's script, run ─────────────────────────────────────────────────
   A fake DOM just big enough for owner.html: elements with children, text,
   attributes, classes and click listeners; getElementById that hands out the
   page's fixed elements; fetch forwarded to the stub over HTTP. */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '#text').toUpperCase();
    this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this._text = ''; this.hidden = false; this.disabled = false; this.className = ''; this.title = ''; this.value = '';
  }
  get classList() {
    const self = this;
    const set = () => new Set(self.className.split(/\s+/).filter(Boolean));
    return {
      toggle(c, on) { const s = set(); const want = on === undefined ? !s.has(c) : !!on; if (want) s.add(c); else s.delete(c); self.className = [...s].join(' '); return want; },
      contains(c) { return set().has(c); },
      add(c) { const s = set(); s.add(c); self.className = [...s].join(' '); },
      remove(c) { const s = set(); s.delete(c); self.className = [...s].join(' '); },
    };
  }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === 'string' ? FakeNode.text(k) : k;
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = this;
      this.children.push(n);
    }
  }
  appendChild(n) { this.append(n); return n; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  replaceChildren(...kids) { for (const c of this.children) c.parent = null; this.children = []; this.append(...kids); }
  get textContent() { return this.tagName === '#TEXT' ? this._text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (String(v)) this.append(String(v)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  click() { if (!this.disabled) for (const f of this.listeners.click || []) f({ target: this, preventDefault() {} }); }
  focus() {}
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find(pred); if (f) return f; } return null; }
  byKey(k) { return this.find((n) => n.attrs['data-k'] === k); }
  querySelector(sel) { const m = /^\[data-k="(.*)"\]$/.exec(sel); return m ? this.byKey(m[1]) : null; }
  static text(s) { const n = new FakeNode('#text'); n._text = s; return n; }
}

async function runPage({ signedIn }) {
  const stub = createOwnerPageStub({ signedIn });
  const port = await stub.listen(0);
  const base = 'http://127.0.0.1:' + port;
  const timers = new Set();
  const ids = {};
  const body = new FakeNode('body');
  const appended = [];
  body.appendChild = (n) => { appended.push(n); return FakeNode.prototype.appendChild.call(body, n); };
  const confirms = [];
  const ctx = {
    console, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error, isNaN, Symbol,
    AbortController,
    Node: FakeNode,
    setTimeout: (f, ms) => { const t = setTimeout(() => { timers.delete(t); f(); }, ms); timers.add(t); return t; },
    clearTimeout: (t) => { clearTimeout(t); timers.delete(t); },
    setInterval: (f, ms) => { const t = setInterval(f, ms); timers.add(t); return t; },
    clearInterval: (t) => { clearInterval(t); timers.delete(t); },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
    location: { host: '127.0.0.1:' + port },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    confirm: (m) => { confirms.push(m); return true; },
    addEventListener() {}, removeEventListener() {},
    fetch: (p, opts) => fetch(base + p, { method: opts.method, headers: opts.headers, body: opts.body }),
    document: {
      hidden: false, activeElement: null, body,
      getElementById: (id) => { if (!ids[id]) { ids[id] = new FakeNode(id === 'devices' ? 'dialog' : 'div'); ids[id].attrs.id = id; } return ids[id]; },
      createElement: (t) => new FakeNode(t),
      addEventListener() {},
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const stop = async () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } await stub.close(); };
  return { stub, ctx, ids, appended, confirms, settle, stop };
}

test('signed in: draws the sheet from the state and never loads the wallet', async () => {
  const pg = await runPage({ signedIn: true });
  try {
    await pg.settle(150);
    const panel = pg.ids.panel;
    assert.equal(panel.hidden, false, 'panel shown');
    assert.equal(pg.ids.signin.hidden, true, 'sign-in card hidden');
    assert.equal(pg.appended.length, 0, 'no script was added to the page');
    const text = panel.textContent;
    for (const s of ["Don't restart yet", '1 person has $1.85 on the table.', 'people playing', '$2.35', 'Escrow (all money held)',
      'Slither', 'agar.io', 'Paper.io', 'Knockout', 'Battleship', 'Battle royale', 'bot joins after 15 s', 'people only',
      'not running', 'Off on this server', 'Waiting', '3 people', '$20 prize', 'Cashed-out strip in the lobby', 'Smooth turning']) {
      assert.ok(text.includes(s), 'shows ' + JSON.stringify(s));
    }
    // the bot bank is its own big number, and the address says it is the only one
    for (const s of ['Bot bank', '$0.50', 'Escrow address (the only address; send bot money here)']) {
      assert.ok(text.includes(s), 'shows ' + JSON.stringify(s));
    }
    // the escrow's breakdown adds up to it: 0.5 + 1.85 + 0.05 + 510 = 512.4
    for (const s of ['Bot bank $0.50', 'Money in play $1.85', 'Owed to players $0.05', 'Spare (not owed to anyone) $510.00']) {
      assert.ok(panel.byKey('escrowparts').textContent.includes(s), 'breakdown shows ' + JSON.stringify(s));
    }
    // the audit note that is markup is there as the literal text
    assert.ok(text.includes('<img src=x onerror="window.__xss=1">Unknown room'));
    // a paid rung: stepper disabled, the note as its title, nothing else said
    const paidPlus = panel.byKey('bots:slither:0.5:+');
    assert.equal(paidPlus.disabled, true);
    assert.equal(paidPlus.title, 'Paid duels stay people only: a bot would win or lose a real stake');
    // a held room offers Auto, an automatic one does not
    assert.equal(panel.byKey('bots:agar:0:auto').hidden, false);
    assert.equal(panel.byKey('bots:slither:0:auto').hidden, true);
    // segments say which side is pressed
    assert.equal(panel.byKey('door:agar:n').getAttribute('aria-pressed'), 'true');
    assert.equal(panel.byKey('door:slither:y').getAttribute('aria-pressed'), 'true');
  } finally { await pg.stop(); }
});

test('three quick presses on a stepper are one bots:set, and every request carries the header', async () => {
  const pg = await runPage({ signedIn: true });
  try {
    await pg.settle(150);
    const plus = pg.ids.panel.byKey('bots:slither:0:+');
    plus.click(); plus.click(); plus.click();
    // the pending number shows at once
    assert.equal(plus.parent.children[1].textContent, '15');
    assert.equal(pg.stub.log.actions.length, 0, 'nothing sent yet');
    await pg.settle(700);
    assert.deepEqual(pg.stub.log.actions, [{ action: 'bots:set', args: { room: 'sl_na_s0', count: 15 } }]);
    assert.equal(pg.ids.panel.byKey('bots:slither:0:auto').hidden, false, 'held now, so Auto shows');
    pg.ids.panel.byKey('bots:slither:0:auto').click();
    await pg.settle(150);
    assert.deepEqual(pg.stub.log.actions[1], { action: 'bots:set', args: { room: 'sl_na_s0', auto: true } });
    // a paid door close asks first
    pg.ids.panel.byKey('door:paper:n').click();
    await pg.settle(150);
    assert.equal(pg.confirms.length, 1);
    assert.equal(pg.stub.log.actions[2].action, 'paper:paid:off');
    assert.ok(pg.stub.log.requests.length >= 5);
    assert.deepEqual(pg.stub.log.missingHeader, []);
    assert.ok(pg.stub.log.requests.every((r) => r.header), 'X-DS-Owner on every request');
  } finally { await pg.stop(); }
});

test('a 401 drops to the sign-in card with a plain reason', async () => {
  const pg = await runPage({ signedIn: true });
  try {
    await pg.settle(150);
    await fetch('http://' + pg.ctx.location.host + '/api/owner/session/logout', { method: 'POST', headers: { 'X-DS-Owner': '1' } });
    pg.ids.panel.byKey('smooth:n').click();
    await pg.settle(150);
    assert.equal(pg.ids.signin.hidden, false);
    assert.equal(pg.ids.panel.hidden, true);
    assert.match(pg.ids.signinWhy.textContent, /signed out|ran out/);
  } finally { await pg.stop(); }
});

test('signed out: one card, and the widget loads only when Sign in is pressed, after the shim', async () => {
  const pg = await runPage({ signedIn: false });
  try {
    await pg.settle(150);
    assert.equal(pg.ids.signin.hidden, false);
    assert.equal(pg.ids.panel.hidden, true);
    assert.equal(pg.appended.length, 0, 'no widget before the press');
    assert.equal(pg.ctx.process, undefined);
    pg.ids.signinBtn.click();
    await pg.settle(20);
    assert.equal(pg.appended.length, 1);
    assert.equal(pg.appended[0].src, '/wallet/widget.js');
    assert.ok(pg.ctx.global && pg.ctx.process && pg.ctx.process.env.NODE_ENV === 'production', 'shim ran first');
    pg.ids.signinBtn.click();
    await pg.settle(20);
    assert.equal(pg.appended.length, 1, 'a second press does not load it twice');
  } finally { await pg.stop(); }
});
