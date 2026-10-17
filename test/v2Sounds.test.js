'use strict';
// The lobby's tap sounds (public/js/v2/sounds.js on the shared engine public/js/dsSfx.js), run in a fake
// page with a fake AudioContext that records what starts: every sound renders short and clean, the rules
// that keep it quiet (switch off, a game up, a hidden tab), no spam on fast clicks, sounding on the press
// (not the release), hover for a mouse only, and which click gets which sound.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = fs.readFileSync(path.join(__dirname, '../public/js/dsSfx.js'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '../public/js/v2/sounds.js'), 'utf8');

function page(store) {
  const started = [], listeners = {};
  let now = 1000;
  class Ctx {
    constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = {}; this.currentTime = 0; }
    createGain() { return { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
    createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, getChannelData: () => d }; }
    createBufferSource() {
      const s = { playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() { started.push(s); } };
      return s;
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
  }
  const body = { cls: new Set(), classList: { contains: c => body.cls.has(c) } };
  const frames = { 'game-frame': { style: { display: 'none' } }, 'agar-frame': { style: { display: 'none' } } };
  const document = { body, hidden: false, getElementById: id => frames[id] || null, addEventListener() {} };
  const perf = { now: () => now };
  const win = {
    AudioContext: Ctx, document, performance: perf,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    setTimeout: () => 0,
    requestIdleCallback: () => 0,      // no background warm-up: each sound renders on first play
  };
  const ls = store || {};
  const ctx = vm.createContext({
    window: win, document, performance: perf, Float32Array, Math, Object, Array, Promise, WeakMap,
    MutationObserver: class { observe() {} },
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
    setTimeout: () => 0,
  });
  vm.runInContext(ENGINE, ctx);
  vm.runInContext(SRC, ctx);
  const S = win.DSSound;
  return { S, E: win.DSSfx, started, body, frames, document, ls, tick: ms => { now += ms; },
    fire: (t, e) => (listeners[t] || []).forEach(fn => fn(e)) };
}

// A clicked element: matches() runs the real selector list against a tiny description.
function el(desc) {
  const { id = '', cls = [], attrs = {}, tag = 'button' } = desc;
  const has = c => cls.includes(c);
  const one = sel => {
    sel = sel.trim();
    if (sel.includes(':has(')) return false;
    let m;
    const parts = sel.match(/^([a-z]*)((?:[#.][\w-]+|\[[^\]]+\]|:not\([^)]*\))*)$/i);
    if (!parts) return false;
    if (parts[1] && parts[1] !== tag) return false;
    const re = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^*]?=)"([^"]*)"(?: i)?)?\]|:not\(([^)]*)\)/g;
    while ((m = re.exec(parts[2]))) {
      if (m[1] && m[1] !== id) return false;
      if (m[2] && !has(m[2])) return false;
      if (m[3]) {
        const v = attrs[m[3]];
        if (v == null) return false;
        if (m[4] === '=' && v !== m[5]) return false;
        if (m[4] === '^=' && !v.startsWith(m[5])) return false;
        if (m[4] === '*=' && !v.toLowerCase().includes(m[5].toLowerCase())) return false;
      }
      if (m[6] && one(m[6])) return false;
    }
    return true;
  };
  const node = {
    disabled: !!desc.disabled,
    getAttribute: a => (a in attrs ? attrs[a] : null),
    classList: { contains: has },
    matches: sel => sel.split(/,(?![^(]*\))/).some(s => s.trim().split(/\s+(?![^\[]*\])/).length === 1 && one(s)),
  };
  node.closest = () => node;
  node.contains = o => o === node;
  return node;
}

const render = (E, n) => E.render(E.def('ui.' + n), 48000);

test('every sound renders short, finite and below clipping', () => {
  const { S, E } = page();
  assert.ok(S.names().length >= 20);
  for (const n of S.names()) {
    const d = render(E, n);
    let peak = 0;
    for (const x of d) { assert.ok(Number.isFinite(x), n); peak = Math.max(peak, Math.abs(x)); }
    assert.ok(d.length / 48000 <= 1.6, n + ' is too long');
    assert.ok(peak > 0.02 && peak <= 0.95, n + ' peak ' + peak);
  }
});

test('the pecking order: money and Play are bigger than a tap', () => {
  const { E } = page();
  const rms = n => { const d = render(E, n); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length) * Math.sqrt(d.length); };
  for (const big of ['play', 'playPaid', 'money', 'buy']) assert.ok(rms(big) > 3 * rms('tap'), big);
});

test('nothing plays while switched off, in a game, or in a hidden tab', () => {
  const p = page();
  assert.strictEqual(p.S.play('tap'), true);
  p.tick(100);
  p.body.cls.add('ingame');
  assert.strictEqual(p.S.play('tap'), false);
  p.body.cls.delete('ingame');
  p.frames['agar-frame'].style.display = 'block';
  assert.strictEqual(p.S.play('tap'), false, 'a game frame up counts as in game');
  p.frames['agar-frame'].style.display = 'none';
  p.document.hidden = true;
  assert.strictEqual(p.S.play('tap'), false);
  p.document.hidden = false;
  p.S.setOn(false);
  assert.strictEqual(p.ls.dsSnd, '0');
  assert.strictEqual(p.S.play('tap'), false);
  assert.strictEqual(page({ dsSnd: '0' }).S.on(), false, 'remembered per device');
  assert.strictEqual(page().S.on(), true, 'on by default');
});

test('fast repeats of one sound are one sound', () => {
  const p = page();
  assert.strictEqual(p.S.play('tap'), true);
  p.tick(10);
  assert.strictEqual(p.S.play('tap'), false);
  p.tick(60);
  assert.strictEqual(p.S.play('tap'), true);
});

test('a toast right after a click stays quiet unless it is money or an error', () => {
  const p = page();
  p.fire('click', { button: 0, target: el({ cls: ['cp'] }) });
  const n = p.started.length;
  p.tick(50);
  p.S.toast('ok'); p.S.toast('info');
  assert.strictEqual(p.started.length, n);
  p.S.toast('err');
  assert.strictEqual(p.started.length, n + 1);
  p.tick(400);
  p.S.toast('ok');
  assert.strictEqual(p.started.length, n + 2);
  p.S.toast('info', true);    // a busy "working" card
  assert.strictEqual(p.started.length, n + 2);
});

test('money rolls only right after a click', () => {
  const p = page();
  p.S.roll();
  assert.strictEqual(p.started.length, 0, 'a background redraw is silent');
  p.fire('click', { button: 0, target: el({ cls: ['ni'], attrs: { onclick: "go('wallet')" } }) });
  p.tick(200);
  const n = p.started.length;
  p.S.roll();
  assert.strictEqual(p.started.length, n + 1);
});

test('each click gets its sound', () => {
  const { S } = page();
  const cases = [
    [{ id: 'gobtn', cls: ['go'] }, 'play'],
    [{ id: 'gobtn', cls: ['go', 'paid'] }, 'playPaid'],
    [{ id: 'specbtn' }, 'spectate'],
    [{ attrs: { onclick: 'V2Play.spectateEvent()' } }, 'spectate'],
    [{ cls: ['stk'] }, 'select'],
    [{ cls: ['card'], attrs: { onclick: "open_('sl')" } }, 'card'],
    [{ cls: ['ni'], attrs: { onclick: "go('wallet')" } }, 'tab'],
    [{ cls: ['ni', 'on'] }, 'tap'],
    [{ id: 'ap-prev', cls: ['ap-arrow'] }, 'arrow'],
    [{ id: 'ap-next', cls: ['ap-arrow'] }, 'arrow'],
    [{ id: 'bs-go', cls: ['bs-go'] }, 'buy'],
    [{ cls: ['howx'], attrs: { onclick: 'closeHow()' } }, 'close'],
    [{ attrs: { onclick: 'V2Wallet.cancelCash()' } }, 'close'],
    [{ attrs: { onclick: 'V2Wallet.fund()' } }, 'fund'],
    [{ attrs: { onclick: 'V2Wallet.cashOut()' } }, 'withdraw'],
    [{ attrs: { onclick: 'V2Wallet.confirmCash()' } }, 'withdrawGo'],
    [{ attrs: { onclick: 'V2Wallet.convert()' } }, 'convert'],
    [{ attrs: { onclick: 'V2Wallet.confirmConvert()' } }, 'convertGo'],
    [{ attrs: { onclick: 'V2Wallet.cancelConvert()' } }, 'close'],
    [{ cls: ['sw'], attrs: { role: 'switch', 'aria-checked': 'false' } }, 'toggleOn'],
    [{ cls: ['sw'], attrs: { role: 'switch', 'aria-checked': 'true' } }, 'toggleOff'],
    [{ cls: ['cp'] }, 'copy'],
    [{ tag: 'a', attrs: { href: '/terms.html' } }, 'tap'],
  ];
  for (const [d, want] of cases) {
    const got = S._pick(el(d));
    assert.strictEqual(Array.isArray(got) ? got[0] : got, want, JSON.stringify(d));
  }
  const prev = S._pick(el({ id: 'ap-prev', cls: ['ap-arrow'] })), next = S._pick(el({ id: 'ap-next', cls: ['ap-arrow'] }));
  assert.ok(prev[1].rate < 1 && next[1].rate > 1, 'back is lower than forward');
});

test('a mouse sounds on the press, and its click is not a second sound', () => {
  const p = page();
  const b = el({ cls: ['stk'] });
  p.fire('pointerdown', { button: 0, pointerType: 'mouse', target: b });
  assert.strictEqual(p.started.length, 1, 'on the press');
  p.tick(90);
  p.fire('click', { button: 0, target: b });
  assert.strictEqual(p.started.length, 1, 'the release adds nothing');
  p.tick(200);
  p.fire('click', { button: 0, target: el({ cls: ['card'] }) });
  assert.strictEqual(p.started.length, 2, 'a click with no press before it still sounds');
});

test('a finger sounds when it lifts in place, never at the start of a swipe', () => {
  const p = page();
  const b = el({ cls: ['card'] });
  p.fire('pointerdown', { button: 0, pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 50, target: b });
  assert.strictEqual(p.started.length, 0);
  p.fire('pointerup', { pointerId: 1, clientX: 52, clientY: 51 });
  assert.strictEqual(p.started.length, 1);
  p.tick(300);
  p.fire('pointerdown', { button: 0, pointerType: 'touch', pointerId: 2, clientX: 50, clientY: 50, target: b });
  p.fire('pointerup', { pointerId: 2, clientX: 140, clientY: 52 });
  assert.strictEqual(p.started.length, 1, 'a swipe is silent');
});

test('hover: mouse only, once per element, throttled, and it has its own switch', () => {
  const p = page();
  const a = el({ cls: ['card'] }), b = el({ cls: ['stk'] });
  p.fire('pointerover', { pointerType: 'touch', target: a });
  assert.strictEqual(p.started.length, 0, 'never on touch');
  p.fire('pointerover', { pointerType: 'mouse', target: a });
  assert.strictEqual(p.started.length, 1);
  p.tick(20);
  p.fire('pointerover', { pointerType: 'mouse', target: b });
  assert.strictEqual(p.started.length, 1, 'sweeping fast does not machine-gun');
  p.tick(200);
  p.fire('pointerover', { pointerType: 'mouse', target: b });
  assert.strictEqual(p.started.length, 1, 'moving within the same element is silent');
  p.tick(200);
  p.fire('pointerover', { pointerType: 'mouse', target: a });
  assert.strictEqual(p.started.length, 2);
  p.S.setHover(false);
  assert.strictEqual(p.ls.dsSndHover, '0');
  p.tick(200);
  p.fire('pointerover', { pointerType: 'mouse', target: b });
  assert.strictEqual(p.started.length, 2);
});

test('the important moments have their own sound', () => {
  const p = page();
  const names = p.S.names();
  for (const n of ['fund', 'deposit', 'withdraw', 'withdrawGo', 'sent', 'convert', 'convertGo', 'converted', 'unlock', 'clip']) assert.ok(names.includes(n), n);
  const startsOf = title => { p.tick(2000); const n = p.started.length; p.S.toast('ok', false, title); return p.started.length - n; };
  p.fire('click', { button: 0, target: el({ attrs: { onclick: 'V2Wallet.confirmCash()' } }) });
  p.tick(50);
  const n = p.started.length;
  p.S.toast('ok', false, 'Withdraw confirmed');
  assert.strictEqual(p.started.length, n + 1, 'a signature toast plays even right after a click');
  assert.strictEqual(startsOf('Unlocked Neon'), 1);
});
