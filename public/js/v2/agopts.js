'use strict';
/* ─── agar.io's game settings, on the lobby's agar.io screen ─────────────────
   Inside this lobby agar.io opens straight into the game, with no menu card of
   its own (Owen 2026-10-09), so the card's settings live here: Sound, Names,
   Colours, Show mass, Dark theme and Quality, with the card's own defaults.

   Nothing is relayed or translated. The game runs on this origin and reads two
   localStorage keys when it boots (agSettings, public/js/ag/agMain.js, and
   agSoundOn, public/js/ag/agSound.js), so this writes exactly those keys in
   exactly the game's shape. A game page already open hears the write as a
   storage event and applies it at once; one opened later reads it at boot.
   test/agLobbyMenu.test.js holds the lists below to the game's own
   (agScreens SETTINGS_DEFAULTS, SETTING_BOXES, QUALITY_OPTIONS), so the two
   cannot drift apart. */
(function () {
  const SETTINGS_KEY = 'agSettings';
  const SOUND_KEY = 'agSoundOn';
  const DEFAULTS = { names: true, colors: true, showMass: false, dark: false, quality: 'Retina' };
  const FLAGS = [['names', 'Names'], ['colors', 'Colours'], ['showMass', 'Show mass'], ['dark', 'Dark theme']];
  const QUALITY = [['Retina', 'Retina'], ['High', 'High'], ['Medium', 'Medium'], ['Low', 'Low'],
                   ['VeryLow', 'Very low']];
  const el = id => document.getElementById(id);

  function store() { try { return window.localStorage || null; } catch (_) { return null; } }

  /* What the game will use: the stored values over the defaults, read the way
     agMain reads them (a flag only when it is a boolean, a quality only when it
     is one of the five; anything else is the default). */
  function read() {
    const v = Object.assign({}, DEFAULTS);
    let s = null;
    try { const st = store(); s = JSON.parse((st && st.getItem(SETTINGS_KEY)) || '{}'); } catch (_) { s = null; }
    if (!s || typeof s !== 'object') s = {};
    FLAGS.forEach(([k]) => { if (typeof s[k] === 'boolean') v[k] = s[k]; });
    if (QUALITY.some(([q]) => q === s.quality)) v.quality = s.quality;
    return v;
  }
  /* The whole object every time, in agMain's own order, as its storeSettings
     writes it. A private window or full storage just keeps the defaults. */
  function write(v) {
    const out = { quality: v.quality };
    FLAGS.forEach(([k]) => { out[k] = !!v[k]; });
    try { const st = store(); if (st) st.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (_) {}
  }
  /* Sound is the game's own key: '1' on, anything else off (off by default). */
  function soundOn() {
    try { const st = store(); return !!st && st.getItem(SOUND_KEY) === '1'; } catch (_) { return false; }
  }
  function setSound(on) {
    try { const st = store(); if (st) st.setItem(SOUND_KEY, on ? '1' : '0'); } catch (_) {}
  }

  function toggle(key) {
    if (key === 'sound') setSound(!soundOn());
    else if (FLAGS.some(([k]) => k === key)) { const v = read(); v[key] = !v[key]; write(v); }
    paint();
  }
  function setQuality(q) {
    if (!QUALITY.some(([n]) => n === q)) return;
    const v = read();
    v.quality = q;
    write(v);
    paint();
  }

  /* One pill per switch: the state dot, then the word. */
  function pill(key, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'agt';
    b.setAttribute('data-opt', key);
    b.setAttribute('aria-pressed', 'false');
    const dot = document.createElement('span');
    dot.className = 'agd';
    dot.setAttribute('aria-hidden', 'true');
    b.appendChild(dot);
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', () => toggle(key));
    return b;
  }

  function build() {
    const box = el('agtg');
    if (!box || box.children.length) return;
    box.appendChild(pill('sound', 'Sound'));
    FLAGS.forEach(([k, label]) => box.appendChild(pill(k, label)));
    const q = document.createElement('label');
    q.className = 'agt agq';
    const k = document.createElement('span');
    k.className = 'agqk';
    k.textContent = 'Quality';
    const val = document.createElement('span');
    val.className = 'agqv';
    val.id = 'agqv';
    const sel = document.createElement('select');
    sel.id = 'agq';
    sel.setAttribute('aria-label', 'Quality');
    QUALITY.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => setQuality(sel.value));
    q.appendChild(k);
    q.appendChild(val);
    q.appendChild(sel);
    box.appendChild(q);
  }

  function paint() {
    const box = el('agtg');
    if (!box) return;
    const v = read();
    const snd = soundOn();
    Array.prototype.forEach.call(box.children, (b) => {
      const key = b.getAttribute && b.getAttribute('data-opt');
      if (!key) return;
      b.setAttribute('aria-pressed', (key === 'sound' ? snd : !!v[key]) ? 'true' : 'false');
    });
    const sel = el('agq'), shown = el('agqv');
    if (sel) sel.value = v.quality;
    if (shown) shown.textContent = (QUALITY.find(([n]) => n === v.quality) || QUALITY[0])[1];
  }

  /* The other way round too: the game's own menu on a direct visit to /ag (in
     another tab) writes the same keys, and this screen follows. */
  window.addEventListener('storage', (e) => {
    if (!e || e.key === SETTINGS_KEY || e.key === SOUND_KEY || e.key === null) paint();
  });
  function start() { build(); paint(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.V2AgOpts = { read: read, toggle: toggle, setQuality: setQuality, soundOn: soundOn, paint: paint,
                      SETTINGS_KEY: SETTINGS_KEY, SOUND_KEY: SOUND_KEY, DEFAULTS: DEFAULTS, FLAGS: FLAGS,
                      QUALITY: QUALITY };
})();
