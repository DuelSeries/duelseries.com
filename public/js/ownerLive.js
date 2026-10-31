'use strict';
/* The owner console's Live and Today tabs (owner.html; the server side is server/livePlayers.js).

   Live: every lobby of every game with the REAL people in it right now (no bots, no load test, not Owen, not our own
   test tools), pushed over the console's owner socket the moment somebody joins, queues or leaves. A real join pops
   a toast with a short sound and a Join button that opens the lobby straight into that room or queue (or watching
   it, when it is full or a match is under way). Rooms with real people sort to the top.

   Today: per lobby, the most real people at once and how many different real people came, with an hourly chart, in
   Toronto time.

   Nothing here can act on a game: Join only opens the lobby with ?ownerjoin=..., where a paid rung waits for Owen's
   own Play press (public/js/v2/ownerJoin.js). Every name is put on the page as text, never as markup. */
(function (root) {
  const doc = root.document;
  const TABS = [['control', 'Control'], ['live', 'Live'], ['today', 'Today']];
  const TOAST_MS = 25000;
  const TOASTS_MAX = 4;
  const store = {
    get(k, d) { try { const v = root.localStorage.getItem('dsLive.' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { root.localStorage.setItem('dsLive.' + k, String(v)); } catch (_) { /* private window */ } },
  };

  function h(tag, props, ...kids) {
    const el = doc.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  const plural = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  function clock(ms) {
    const d = new Date(n(ms));
    if (!n(ms) || isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s*([AP])\.?M\.?$/i, (m, p) => ' ' + p.toLowerCase() + 'm');
  }
  const hourName = (hr) => (hr % 12 === 0 ? 12 : hr % 12) + (hr < 12 ? ' am' : ' pm');

  // ── where Join goes ──
  /* What pressing Join on a lobby does, from the lobby's numbers as the server last sent them:
     { act: 'play' | 'watch', label } or null when nothing can be done there (a game not open yet). */
  function joinOf(l) {
    if (!l || l.soon) return null;
    const paid = n(l.stake) > 0;
    const money = paid ? ' $' + n(l.stake).toFixed(2) : '';
    if (l.kind === 'event') return l.joinable ? { act: 'play', label: 'Join' } : { act: 'watch', label: 'Watch' };
    if (l.kind === 'duel') {
      if (n(l.waiting) > 0) return { act: 'play', label: 'Join' + money };
      if (n(l.humans) > 0) return { act: 'watch', label: 'Watch' };
      return { act: 'play', label: 'Join' + money };
    }
    if (l.state === 'closed' || l.full) return { act: 'watch', label: 'Watch' };
    return { act: 'play', label: 'Join' + money };
  }
  function go(lobby, act) {
    if (!lobby) return;
    const q = new URLSearchParams({ ownerjoin: lobby.game, stake: String(n(lobby.stake)), do: act });
    // one tab for every Join, reused: pressing Join again never piles up tabs
    const w = root.open('/?' + q.toString(), 'dsjoin');
    if (w && typeof w.focus === 'function') { try { w.focus(); } catch (_) { /* another window */ } }
  }

  // ── sound, buzz and the hidden-tab notice ──
  let ac = null;
  function unlockAudio() {
    try {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!ac && AC) ac = new AC();
      if (ac && ac.state === 'suspended') ac.resume();
    } catch (_) { ac = null; }
  }
  function ding() {
    if (store.get('sound', '1') !== '1') return;
    try {
      unlockAudio();
      if (!ac || ac.state !== 'running') return;
      const t = ac.currentTime + 0.01;
      for (const [f, at] of [[880, 0], [1318.5, 0.09]]) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at);
        g.gain.exponentialRampToValueAtTime(0.16, t + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
        o.connect(g).connect(ac.destination);
        o.start(t + at);
        o.stop(t + at + 0.18);
      }
    } catch (_) { /* no sound is still a toast */ }
  }
  function buzz() {
    try { if (root.navigator && typeof root.navigator.vibrate === 'function') root.navigator.vibrate([70, 50, 70]); } catch (_) { /* fine */ }
  }
  const canNotify = () => typeof root.Notification === 'function';
  function notifyHidden(j, lobby) {
    if (!doc.hidden || !canNotify() || root.Notification.permission !== 'granted' || store.get('notify', '0') !== '1') return;
    try {
      const nt = new root.Notification(j.name + (j.queued ? ' queued' : ' joined'), {
        body: j.gameName + ' ' + j.rung + '. Tap to join.', tag: 'dslive-' + j.lobby, renotify: true,
      });
      nt.onclick = () => { try { root.focus(); } catch (_) { /* fine */ } const t = joinOf(lobby); if (t) go(lobby, t.act); nt.close(); };
    } catch (_) { /* a phone browser that only allows them from a service worker */ }
  }

  // ── state ──
  let socket = null;
  let S = null;          // the last 'owner:live'
  let day = null;        // the last 'owner:live:today'
  let dayWhich = 'today';
  let tab = store.get('tab', 'control');
  let conn = 'connecting';
  let built = false;
  const ui = {};
  const rows = new Map(); // lobby key -> { el, parts }
  const lobbyOf = (key) => (S && Array.isArray(S.lobbies) ? S.lobbies.find((l) => l.key === key) : null) || null;

  function build() {
    if (built) return;
    built = true;
    const main = doc.querySelector('main');
    const panel = doc.getElementById('panel');
    ui.badge = h('span', { class: 'lvbadge' });
    ui.tabs = h('nav', { class: 'lvtabs', 'aria-label': 'Console views', hidden: true },
      TABS.map(([id, name]) => {
        const b = h('button', { type: 'button', 'data-tab': id, on: { click: () => setTab(id) } }, name, id === 'live' ? ui.badge : null);
        return b;
      }));
    ui.live = h('section', { class: 'lv', id: 'live', 'aria-label': 'Live players' });
    ui.today = h('section', { class: 'lv', id: 'today', 'aria-label': 'Today' });
    ui.toasts = h('div', { class: 'lvtoasts', 'aria-live': 'polite' });
    main.insertBefore(ui.tabs, panel);
    main.append(ui.live, ui.today);
    doc.body.append(ui.toasts);

    // Live
    ui.head = h('div', { class: 'lvhd' });
    ui.big = h('div', { class: 'lvbig' });
    ui.sub = h('div', { class: 'lvsub' });
    ui.conn = h('span', { class: 'lvconn' });
    ui.sound = h('button', { type: 'button', class: 'btn', on: { click: () => {
      store.set('sound', store.get('sound', '1') === '1' ? '0' : '1');
      unlockAudio();
      drawControls();
      if (store.get('sound', '1') === '1') ding();
    } } });
    ui.notify = h('button', { type: 'button', class: 'btn', on: { click: askNotify } });
    ui.head.append(h('div', { class: 'lvtop' }, h('div', null, ui.big, ui.sub), h('div', { class: 'lvctl' }, ui.conn, ui.sound, ui.notify)));
    ui.list = h('div', { class: 'lvlist', role: 'list' });
    ui.testsH = h('h3', null, 'Our test clients');
    ui.tests = h('div', { class: 'lvtests' });
    ui.testsBox = h('div', { class: 'lvtestbox' }, ui.testsH, h('p', { class: 'dim lvnote' },
      'Our own tools and you. None of these count as real people.'), ui.tests);
    ui.live.append(ui.head, ui.list, ui.testsBox);

    // Today
    ui.tdHead = h('div', { class: 'lvhd' });
    ui.tdBig = h('div', { class: 'lvbig' });
    ui.tdSub = h('div', { class: 'lvsub' });
    ui.tdSwitch = h('div', { class: 'tg' }, ['today', 'yesterday'].map((w) =>
      h('button', { type: 'button', 'data-day': w, on: { click: () => { dayWhich = w; askDay(); drawDaySwitch(); } } },
        w === 'today' ? 'Today' : 'Yesterday')));
    ui.tdHead.append(h('div', { class: 'lvtop' }, h('div', null, ui.tdBig, ui.tdSub), h('div', { class: 'lvctl' }, ui.tdSwitch)));
    ui.tdChart = h('div', { class: 'lvchart', role: 'img' });
    ui.tdList = h('div', { class: 'lvdays' });
    ui.today.append(ui.tdHead, ui.tdChart, ui.tdList);

    doc.addEventListener('pointerdown', unlockAudio, { capture: true });
    doc.addEventListener('keydown', unlockAudio, { capture: true });
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden && socket && socket.connected) { socket.emit('owner:live:get', {}); if (tab === 'today') askDay(); }
    });
    setInterval(() => { if (tab === 'today' && !doc.hidden) askDay(); }, 30000);
    drawControls();
    drawDaySwitch();
    setTab(TABS.some(([id]) => id === tab) ? tab : 'control');
  }

  function setTab(id) {
    tab = id;
    store.set('tab', id);
    const main = doc.querySelector('main');
    if (main) main.setAttribute('data-tab', id);
    for (const b of ui.tabs.querySelectorAll('button')) {
      const on = b.getAttribute('data-tab') === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    }
    if (id === 'today') askDay();
    if (id === 'live' && socket && socket.connected) socket.emit('owner:live:get', {});
  }

  function drawControls() {
    ui.sound.textContent = store.get('sound', '1') === '1' ? 'Sound on' : 'Sound off';
    ui.sound.setAttribute('aria-pressed', store.get('sound', '1') === '1' ? 'true' : 'false');
    if (!canNotify()) { ui.notify.hidden = true; return; }
    const on = store.get('notify', '0') === '1' && root.Notification.permission === 'granted';
    ui.notify.textContent = on ? 'Alerts when hidden: on' : root.Notification.permission === 'denied' ? 'Alerts blocked' : 'Alerts when hidden';
    ui.notify.disabled = root.Notification.permission === 'denied';
  }
  function askNotify() {
    if (!canNotify()) return;
    if (store.get('notify', '0') === '1' && root.Notification.permission === 'granted') { store.set('notify', '0'); drawControls(); return; }
    Promise.resolve(root.Notification.requestPermission()).then((p) => {
      store.set('notify', p === 'granted' ? '1' : '0');
      drawControls();
    }, () => drawControls());
  }

  // ── Live ──
  function drawConn() {
    if (!ui.conn) return;
    const live = conn === 'listening';
    ui.conn.className = 'lvconn' + (live ? ' on' : '');
    ui.conn.textContent = live ? 'Live' : conn === 'unsigned' ? 'Not signed in' : 'Reconnecting';
  }

  function rowFor(l) {
    let r = rows.get(l.key);
    if (r) return r;
    const count = h('div', { class: 'lvn' });
    const name = h('b');
    const rung = h('span', { class: 'lvrung' });
    const names = h('div', { class: 'lvnames' });
    const extra = h('div', { class: 'lvextra' });
    const btn = h('button', { type: 'button', class: 'btn', on: { click: () => {
      const cur = lobbyOf(l.key);
      const t = joinOf(cur);
      if (t) go(cur, t.act);
    } } });
    const el = h('div', { class: 'lvrow', role: 'listitem' }, count,
      h('div', { class: 'lvmid' }, h('div', { class: 'lvname' }, name, rung), names, extra), btn);
    r = { el, count, name, rung, names, extra, btn };
    rows.set(l.key, r);
    return r;
  }
  function stateWords(l) {
    const out = [];
    if (l.soon) out.push('Coming soon');
    else if (l.state === 'closed') out.push('Closed');
    if (l.kind === 'duel' && n(l.real) > 0) out.push(n(l.waiting) > 0 ? plural(n(l.waiting), 'waiting', 'waiting') : 'in a match');
    if (l.kind === 'event' && l.state && l.state !== 'open') out.push(l.state === 'waiting' ? 'waiting room' : String(l.state));
    if (l.full) out.push('full');
    return out;
  }
  function drawRow(l) {
    const r = rowFor(l);
    const real = n(l.real);
    r.el.classList.toggle('has', real > 0);
    r.el.classList.toggle('soon', !!l.soon);
    r.count.textContent = String(real);
    r.name.textContent = l.name;
    r.rung.textContent = l.rung;
    r.rung.classList.toggle('paid', n(l.stake) > 0);
    r.names.textContent = real > 0 ? l.names.join(', ') + (real > l.names.length ? ' and ' + (real - l.names.length) + ' more' : '') : '';
    r.names.hidden = real === 0;
    const bits = stateWords(l);
    if (n(l.bots) > 0) bits.push(plural(n(l.bots), 'bot', 'bots'));
    const tests = n(l.auto) + n(l.load);
    if (tests > 0) bits.push(plural(tests, 'test client', 'test clients'));
    if (n(l.you) > 0) bits.push('you');
    r.extra.textContent = bits.join(', ');
    const t = joinOf(l);
    r.btn.hidden = !t;
    if (t) {
      r.btn.textContent = t.label;
      r.btn.className = 'btn' + (real > 0 ? ' main' : '');
      r.btn.setAttribute('aria-label', t.label + ' ' + l.name + ' ' + l.rung);
    }
    return r.el;
  }
  function drawLive() {
    if (!built || !S) return;
    const tot = S.totals || {};
    const real = n(tot.real);
    ui.big.textContent = real > 0 ? plural(real, 'real person', 'real people') + ' playing now' : 'Nobody real is playing right now';
    ui.big.classList.toggle('ok', real > 0);
    const td = S.today || {};
    ui.sub.textContent = 'Today: ' + plural(n(td.uniq), 'person', 'people') + ', most at once ' + n(td.peak) + '.';
    ui.badge.textContent = real > 0 ? String(real) : '';
    ui.badge.hidden = real === 0;
    const keys = new Set();
    let i = 0;
    for (const l of S.lobbies || []) {
      keys.add(l.key);
      const el = drawRow(l);
      if (ui.list.children[i] !== el) ui.list.insertBefore(el, ui.list.children[i] || null);
      i++;
    }
    for (const [k, r] of rows) if (!keys.has(k)) { r.el.remove(); rows.delete(k); }
    const tests = Array.isArray(S.tests) ? S.tests : [];
    ui.tests.replaceChildren(...tests.map((t) => h('div', { class: 'lvt' },
      h('span', { class: 'lvtn', text: t.name }), h('span', { text: t.where }),
      h('span', { class: 'lvtk', text: t.kind === 'you' ? 'you' : t.kind === 'load' ? 'load test' : 'our tool' }))));
    ui.testsBox.hidden = tests.length === 0;
    try { doc.title = (real > 0 ? '(' + real + ') ' : '') + 'DuelSeries · Control'; } catch (_) { /* fine */ }
  }

  // ── toasts ──
  function toast(j) {
    if (!built || !j || typeof j !== 'object') return;
    const lobby = lobbyOf(j.lobby) || { key: j.lobby, game: j.game, stake: j.stake, kind: j.kind, name: j.gameName,
      rung: j.rung, state: 'open', joinable: true, waiting: j.queued ? 1 : 0, humans: 1 };
    const t = joinOf(lobby);
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 180); };
    const join = h('button', { type: 'button', class: 'btn main', on: { click: () => {
      const cur = lobbyOf(j.lobby) || lobby;
      const tt = joinOf(cur) || t;
      if (tt) go(cur, tt.act);
      close();
    } } }, t ? t.label : 'Join');
    if (!t) join.hidden = true;
    const el = h('div', { class: 'lvtoast', role: 'status' },
      h('div', { class: 'lvtx' },
        h('b', { text: j.name }),
        h('span', { text: (j.queued ? 'queued for ' : 'joined ') + j.gameName + ' ' + j.rung }),
        h('span', { class: 'dim', text: clock(j.at) })),
      join,
      h('button', { type: 'button', class: 'link lvx', 'aria-label': 'Dismiss', on: { click: close } }, 'Close'));
    ui.toasts.prepend(el);
    while (ui.toasts.children.length > TOASTS_MAX) ui.toasts.lastChild.remove();
    setTimeout(close, TOAST_MS);
    ding();
    buzz();
    notifyHidden(j, lobby);
  }

  // ── Today ──
  function askDay() {
    if (socket && socket.connected) socket.emit('owner:live:today', { day: dayWhich });
  }
  function drawDaySwitch() {
    for (const b of ui.tdSwitch.querySelectorAll('button')) b.classList.toggle('on', b.getAttribute('data-day') === dayWhich);
  }
  function bars(hours, nowHour, cls) {
    const max = Math.max(1, ...hours.map((x) => n(x[1])));
    return h('div', { class: cls }, hours.map((x, hr) => {
      const v = n(x[1]);
      const b = h('i', { style: 'height:' + (v ? Math.max(8, Math.round((v / max) * 100)) : 0) + '%',
        title: hourName(hr) + ': ' + plural(v, 'person', 'people') + ', most at once ' + n(x[0]) });
      return h('span', { class: hr === nowHour ? 'now' : null }, b);
    }));
  }
  function drawDay() {
    if (!built || !day) return;
    if (day.error) { ui.tdBig.textContent = 'Today\'s numbers are not available right now.'; return; }
    const all = day.all || { uniq: 0, peak: 0, hours: [] };
    const isToday = dayWhich === 'today';
    ui.tdBig.textContent = plural(n(all.uniq), 'real person', 'real people') + (isToday ? ' today' : ' yesterday');
    ui.tdSub.textContent = n(all.peak) > 0 ? 'Most at once: ' + n(all.peak) + (all.peakAt ? ', at ' + clock(all.peakAt) : '') + '. Toronto time.'
      : 'Nobody real yet. Toronto time.';
    const nowHour = isToday ? n(day.hour) : -1;
    const hours = Array.isArray(all.hours) && all.hours.length === 24 ? all.hours : Array.from({ length: 24 }, () => [0, 0]);
    ui.tdChart.setAttribute('aria-label', 'Different real people in each hour of the day');
    ui.tdChart.replaceChildren(bars(hours, nowHour, 'lvbars'),
      h('div', { class: 'lvaxis' }, [0, 6, 12, 18].map((hr) => h('span', { text: hourName(hr) }))));
    const ls = Array.isArray(day.lobbies) ? day.lobbies : [];
    ui.tdList.replaceChildren(
      h('div', { class: 'lvdrow lvdh' }, h('span', null, 'Lobby'), h('span', null, 'People'), h('span', null, 'Most at once'),
        h('span', null, 'By hour')),
      ...(ls.length ? ls.map((l) => h('div', { class: 'lvdrow' },
        h('span', { class: 'lvdn' }, h('b', { text: l.name }), ' ', h('span', { class: 'lvrung' + (n(l.stake) > 0 ? ' paid' : ''), text: l.rung })),
        h('span', { class: 'lvdv', text: String(n(l.uniq)) }),
        h('span', { class: 'lvdv', text: n(l.peak) + (l.peakAt ? ' at ' + clock(l.peakAt) : '') }),
        bars(Array.isArray(l.hours) ? l.hours : [], nowHour, 'lvbars sm'))) : [h('p', { class: 'dim lvnote', text: 'No real players in any lobby yet.' })]));
  }

  // ── the socket ──
  function attach(s) {
    build();
    ui.tabs.hidden = false;
    if (!s || s === socket) return;
    socket = s;
    s.on('owner:live', (st) => { if (st && typeof st === 'object' && Array.isArray(st.lobbies)) { S = st; drawLive(); } });
    s.on('owner:live:join', (j) => { try { toast(j); } catch (_) { /* never takes the socket down */ } });
    s.on('owner:live:today', (d) => { if (d && typeof d === 'object') { day = d; drawDay(); } });
    s.on('connect', () => { conn = 'connecting'; drawConn(); });
    s.on('disconnect', () => { conn = 'offline'; drawConn(); });
    drawConn();
  }
  // owner.html's alert state: 'listening' once the server took this socket as the owner's
  function state(st) {
    conn = String(st || '');
    drawConn();
    if (conn === 'listening') setTimeout(() => { if (tab === 'today') askDay(); }, 300);
  }
  function stop() {
    if (!built) return;
    ui.tabs.hidden = true;
    const main = doc.querySelector('main');
    if (main) main.removeAttribute('data-tab');
    socket = null;
    S = null;
    conn = 'connecting';
  }
  function resume() {
    if (!built) return;
    ui.tabs.hidden = false;
    setTab(tab);
  }

  const api = { attach, state, stop, resume, joinOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OwnerLive = api;
})(typeof window !== 'undefined' ? window : this);
