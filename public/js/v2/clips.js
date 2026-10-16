'use strict';
/* ─── Clips: player clips from X, YouTube and TikTok (Owen 2026-10-16, look A) ─────
   Like onlinemoneygames.com/clips: a player posts a clip on their own X, YouTube
   or TikTok, pastes the link here, the owner approves it, and it goes on the
   wall. The video plays from that site; this server never stores or serves it.
   PC only (the tab is hidden on phones, see the .pconly rules in v2.html).

     GET  /api/clips            -> { clips: [...], top: [{ name, clips }], waiting }
     POST /api/clips/submit     signed 'clip:submit' { url, caption, game }
     POST /api/clips/queue      signed 'clips:queue' {}  -> { owner, waiting }
     POST /api/clips/decide     signed 'clip:decide' { id, verdict }   owner only
   (server/clips.js). Every signature is the wallet widget's duelWalletSignAction,
   silent, the same proof the games use to say who is playing.

   Every word a player typed is set as text, never as markup, and every player
   or picture is built from an id the server already checked, never from a URL a
   player sent. ?clips=preview fills the wall and the queue with sample clips made
   in this browser only. */
(function () {
  const $ = (id) => document.getElementById(id);
  const GAME = { slither: 'slither.io', agar: 'agar.io', paper: 'Paper.io', br: 'Battle royale', other: 'Other' };
  const ART = { slither: 'snake', agar: 'agar', paper: 'paper', br: 'snake', other: 'snake' };
  const SRC = { x: 'X', youtube: 'YouTube', tiktok: 'TikTok' };
  const ON_SITE = { x: 'Watch on X', youtube: 'Watch on YouTube', tiktok: 'Watch on TikTok' };
  const PREVIEW = /[?&]clips=preview\b/.test(location.search);

  let data = { clips: [], top: [], waiting: 0 };
  let failed = false;
  let queue = [];
  let busy = false;

  /* Owner or not, per wallet, kept in this browser: asking costs a signature, and
     a player who is not the owner should never be asked twice. It only decides
     what is drawn; the server checks the owner's signature on every decision. */
  const OWNER_KEY = 'dsClipsOwner';
  const addr = () => { const w = window.duelWallet || {}; return w.authenticated && w.address ? w.address : ''; };
  function ownerVerdict() {
    try { const v = JSON.parse(localStorage.getItem(OWNER_KEY) || 'null'); return v && v.w === addr() ? v.owner : null; } catch (_) { return null; }
  }
  function keepVerdict(owner) {
    try { localStorage.setItem(OWNER_KEY, JSON.stringify({ w: addr(), owner: !!owner })); } catch (_) {}
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const toast = (o) => { if (window.DSToast) window.DSToast.show(o); };

  function poster(c) {
    if (c.provider === 'youtube') return 'https://i.ytimg.com/vi/' + encodeURIComponent(c.vid) + '/hqdefault.jpg';
    if (c.media && c.media.poster) return c.media.poster;
    return '/img/games/' + (ART[c.game] || 'snake') + '-wide.png';
  }
  function clock(ms) {
    const s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // One clip as a card: the picture, where it is from, its words and who sent it.
  function card(c, opts) {
    const o = opts || {};
    const wrap = el('div', 'clcard');
    const pic = el('button', 'clpic');
    pic.type = 'button';
    pic.setAttribute('aria-label', 'Play ' + (c.caption || 'clip') + ' by ' + c.name);
    pic.style.backgroundImage = 'url("' + poster(c) + '")';
    pic.appendChild(el('span', 'clplay'));
    pic.appendChild(el('span', 'clsrc', SRC[c.provider] || ''));
    if (c.media && c.media.ms) pic.appendChild(el('span', 'cldur num', clock(c.media.ms)));
    pic.onclick = () => openPlayer(c);
    wrap.appendChild(pic);
    if (c.caption) wrap.appendChild(el('div', 'clcap', c.caption));
    const by = el('div', 'clby');
    by.appendChild(el('span', 'clname', c.name));
    by.appendChild(el('span', 'clgame', GAME[c.game] || ''));
    wrap.appendChild(by);
    if (o.owner) {
      const acts = el('div', 'clacts');
      if (c.status === 'waiting') {
        const ok = el('button', 'clok', 'Approve'); ok.type = 'button';
        ok.onclick = () => decide(c, 'live', ok);
        const no = el('button', 'clno', 'Reject'); no.type = 'button';
        no.onclick = () => decide(c, 'rejected', no);
        acts.appendChild(ok); acts.appendChild(no);
      } else {
        const rm = el('button', 'clno', 'Take down'); rm.type = 'button';
        rm.onclick = () => decide(c, 'removed', rm);
        acts.appendChild(rm);
      }
      const open = el('a', 'cllink', ON_SITE[c.provider] || 'Open');
      open.href = c.url; open.target = '_blank'; open.rel = 'noopener noreferrer';
      acts.appendChild(open);
      wrap.appendChild(acts);
    }
    return wrap;
  }

  function drawWall() {
    const grid = $('cl-grid'); const top = $('cl-top');
    if (!grid || !top) return;
    grid.textContent = '';
    const owner = ownerVerdict() === true;
    if (failed && !data.clips.length) {
      grid.appendChild(el('p', 'clempty', 'Clips did not load. Check your connection and open the tab again.'));
    } else if (!data.clips.length) {
      const e = el('div', 'clempty');
      e.appendChild(el('b', '', 'No clips yet'));
      e.appendChild(el('span', '', 'Post your best moment on X, YouTube or TikTok and send the link. The first one goes right here.'));
      grid.appendChild(e);
    } else {
      data.clips.forEach(c => grid.appendChild(card(Object.assign({ status: 'live' }, c), { owner })));
    }
    top.textContent = '';
    top.appendChild(el('h3', 'cltoph', 'Top clippers'));
    if (!data.top.length) top.appendChild(el('p', 'cltopnone', 'Nobody yet. Get a clip on the wall to lead this board.'));
    data.top.forEach((t, i) => {
      const r = el('div', 'cltr');
      r.appendChild(el('span', 'cltn num', String(i + 1)));
      r.appendChild(el('span', 'cltnm', t.name));
      r.appendChild(el('span', 'cltc num', t.clips + (t.clips === 1 ? ' clip' : ' clips')));
      top.appendChild(r);
    });
  }

  function drawQueue() {
    const q = $('cl-queue');
    if (!q) return;
    const owner = ownerVerdict() === true;
    q.hidden = !owner;
    if (!owner) return;
    q.textContent = '';
    const h = el('h3', 'clqh', 'Waiting for you');
    h.appendChild(el('span', 'clqn num', String(queue.length)));
    q.appendChild(h);
    if (!queue.length) { q.appendChild(el('p', 'clqnone', 'Nothing to review. New clips show up here and you get a note when one arrives.')); return; }
    const list = el('div', 'clqlist');
    queue.forEach(c => list.appendChild(card(c, { owner: true })));
    q.appendChild(list);
  }

  async function pull() {
    if (PREVIEW) { data = sample(); failed = false; return; }
    try {
      const r = await fetch('/api/clips', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      data = { clips: Array.isArray(j.clips) ? j.clips : [], top: Array.isArray(j.top) ? j.top : [], waiting: j.waiting | 0 };
      failed = false;
    } catch (_) { failed = true; }
  }

  async function sign(action, args) {
    if (typeof window.duelWalletSignAction !== 'function') throw new Error('The wallet has not loaded yet. Give it a moment.');
    const proof = await Promise.race([
      window.duelWalletSignAction(action, args),
      new Promise((_, no) => setTimeout(() => no(new Error('The wallet did not answer. Try again.')), 10000)),
    ]);
    if (!proof) throw new Error('Log in to do that.');
    return proof;
  }
  async function postSigned(path, action, args) {
    const proof = await sign(action, args);
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proof) });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  }

  // Asked once per wallet per tab life; the answer decides whether the queue exists.
  async function pullQueue() {
    if (PREVIEW) { keepVerdict(true); queue = sample().queue; return; }
    if (!addr()) return;
    const v = ownerVerdict();
    if (v === false) return;
    try {
      const j = await postSigned('/api/clips/queue', 'clips:queue', {});
      keepVerdict(!!j.owner);
      queue = j.owner && Array.isArray(j.waiting) ? j.waiting : [];
      if (j.owner) seenWaiting = data.waiting;
    } catch (_) { /* not logged in yet, or the wallet is still loading: ask again next visit */ }
  }

  async function decide(c, verdict, btn) {
    if (busy) return;
    if (PREVIEW) { toast({ kind: 'info', title: 'Preview', detail: 'Nothing is sent from the preview.' }); return; }
    busy = true; btn.disabled = true;
    try {
      const j = await postSigned('/api/clips/decide', 'clip:decide', { id: c.id, verdict });
      queue = Array.isArray(j.waiting) ? j.waiting : queue.filter(x => x.id !== c.id);
      toast({ kind: 'ok', title: verdict === 'live' ? 'Clip approved' : verdict === 'rejected' ? 'Clip rejected' : 'Clip taken down', detail: c.caption || c.name });
      await pull();
      seenWaiting = data.waiting;
      drawQueue(); drawWall(); paintDot();
    } catch (e) {
      toast({ kind: 'err', title: 'Could not save that', detail: e.message });
      btn.disabled = false;
    } finally { busy = false; }
  }

  async function render() {
    drawWall(); drawQueue();
    await pull();
    drawWall();
    await pullQueue();
    drawQueue(); drawWall(); paintDot();
  }

  /* ── the player ─────────────────────────────────────────────────────────
     A dimmed sheet with the clip in it, built when opened and emptied when
     closed, so nothing keeps playing (or loading) behind the lobby. */
  function playerFor(c) {
    if (c.provider === 'youtube') {
      const f = document.createElement('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(c.vid) + '?autoplay=1&rel=0&playsinline=1';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true; f.title = c.caption || 'Clip';
      return f;
    }
    if (c.provider === 'tiktok') {
      const f = document.createElement('iframe');
      f.src = 'https://www.tiktok.com/player/v1/' + encodeURIComponent(c.vid) + '?autoplay=1&music_info=0&description=0&rel=0';
      f.allow = 'autoplay; encrypted-media; fullscreen';
      f.allowFullscreen = true; f.title = c.caption || 'Clip';
      return f;
    }
    if (c.media && c.media.video) {
      const v = document.createElement('video');
      v.src = c.media.video; v.controls = true; v.autoplay = true; v.playsInline = true;
      v.preload = 'auto';
      if (c.media.poster) v.poster = c.media.poster;
      return v;
    }
    // An X post we could not read the video out of: say so and send them there.
    const n = el('div', 'clnovid');
    n.appendChild(el('b', '', PREVIEW ? 'Sample clip' : 'This clip plays on X'));
    n.appendChild(el('span', '', PREVIEW ? 'Preview clips have no video.' : 'Open the post to watch it.'));
    return n;
  }
  function openPlayer(c) {
    const veil = $('clveil'); const box = $('clbox');
    if (!veil || !box) return;
    box.textContent = '';
    box.classList.toggle('tall', !!c.vertical);
    const stage = el('div', 'clstage');
    stage.appendChild(playerFor(c));
    box.appendChild(stage);
    const meta = el('div', 'clmeta');
    const words = el('div', 'clmw');
    if (c.caption) words.appendChild(el('b', 'clmcap', c.caption));
    const by = el('div', 'clby');
    by.appendChild(el('span', 'clname', c.name));
    by.appendChild(el('span', 'clgame', GAME[c.game] || ''));
    words.appendChild(by);
    meta.appendChild(words);
    if (!PREVIEW) {
      const a = el('a', 'cllink', ON_SITE[c.provider] || 'Open');
      a.href = c.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      meta.appendChild(a);
    }
    const x = el('button', 'clx'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '\u2715';
    x.onclick = closePlayer;
    meta.appendChild(x);
    box.appendChild(meta);
    veil.classList.add('on');
    x.focus();
  }
  function closePlayer() {
    const veil = $('clveil'); const box = $('clbox');
    if (!veil || !veil.classList.contains('on')) return false;
    veil.classList.remove('on');
    if (box) box.textContent = '';     // stops the video or the frame
    return true;
  }

  /* ── sending one ─────────────────────────────────────────────────────── */
  let pick = 'slither';
  function openSubmit() {
    if (!addr() && !PREVIEW) {
      if (typeof window.duelWalletLogin === 'function') window.duelWalletLogin();
      toast({ kind: 'info', title: 'Log in to send a clip', detail: 'Every clip on the wall has a player name on it.' });
      return;
    }
    const veil = $('clsubveil');
    if (!veil) return;
    $('cl-url').value = ''; $('cl-cap').value = '';
    $('cl-err').textContent = '';
    pick = 'slither'; drawPick();
    veil.classList.add('on');
    setTimeout(() => $('cl-url').focus(), 30);
  }
  function closeSubmit() {
    const veil = $('clsubveil');
    if (!veil || !veil.classList.contains('on')) return false;
    veil.classList.remove('on');
    return true;
  }
  function drawPick() {
    const seg = $('cl-games');
    if (!seg) return;
    seg.textContent = '';
    Object.keys(GAME).forEach(g => {
      const b = el('button', 'clseg' + (g === pick ? ' on' : ''), GAME[g]);
      b.type = 'button';
      b.setAttribute('aria-pressed', g === pick ? 'true' : 'false');
      b.onclick = () => { pick = g; drawPick(); };
      seg.appendChild(b);
    });
  }
  // Same three shapes the server takes, so a wrong link is caught before the wallet signs anything.
  const LINK = /^(https?:\/\/)?((www|m|mobile)\.)?((x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}|youtu\.be\/[A-Za-z0-9_-]{11}|youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/|live\/)[A-Za-z0-9_-]{11}|tiktok\.com\/@[A-Za-z0-9._]{1,30}\/video\/\d{8,25})/i;
  async function send() {
    if (busy) return;
    const url = $('cl-url').value.trim();
    const caption = $('cl-cap').value.trim().slice(0, 140);
    const err = $('cl-err');
    if (!LINK.test(url)) {
      err.textContent = /vm\.tiktok|vt\.tiktok/i.test(url)
        ? 'Open the TikTok in a browser and copy the full link, like tiktok.com/@you/video/123.'
        : 'Paste the link to your post on X, YouTube or TikTok, like x.com/you/status/123.';
      $('cl-url').focus();
      return;
    }
    if (PREVIEW) { closeSubmit(); toast({ kind: 'info', title: 'Preview', detail: 'Nothing is sent from the preview.' }); return; }
    busy = true;
    const btn = $('cl-send'); btn.disabled = true; btn.textContent = 'Sending…';
    err.textContent = '';
    try {
      await postSigned('/api/clips/submit', 'clip:submit', { url, caption, game: pick });
      closeSubmit();
      toast({ kind: 'ok', title: 'Clip sent', detail: 'It shows on the wall once it is approved.' });
    } catch (e) {
      err.textContent = e.message;
    } finally {
      busy = false; btn.disabled = false; btn.textContent = 'Submit clip';
    }
  }

  /* ── the owner's note when a clip comes in ──────────────────────────────
     Only for a wallet already known to be the owner. The waiting count is on
     the public GET, so watching it costs no signature; a rise is a toast and a
     dot on the Clips tab. Once a minute, and not while the page is hidden. */
  let seenWaiting = null;
  function paintDot() {
    const owner = ownerVerdict() === true;
    document.querySelectorAll('.ni[data-tab="clips"]').forEach(b => {
      b.classList.toggle('dot', owner && data.waiting > 0);
    });
  }
  async function watch() {
    if (PREVIEW || document.hidden || ownerVerdict() !== true) return;
    await pull();
    if (seenWaiting !== null && data.waiting > seenWaiting) {
      const n = data.waiting - seenWaiting;
      toast({ kind: 'info', title: n === 1 ? 'New clip to review' : n + ' new clips to review', detail: 'Open Clips to approve or reject.' });
    }
    seenWaiting = data.waiting;
    paintDot();
    if (window.route === 'clips') drawWall();
  }
  setInterval(watch, 60000);
  setTimeout(watch, 4000);   // an owner already known this tab hears about a waiting clip without opening Clips
  window.addEventListener('duelwallet:change', () => { setTimeout(() => { watch(); paintDot(); }, 500); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (closePlayer() || closeSubmit()) e.stopPropagation();
  });
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'clveil') closePlayer();
    if (e.target && e.target.id === 'clsubveil') closeSubmit();
  });
  document.addEventListener('submit', (e) => {
    if (e.target && e.target.id === 'cl-form') { e.preventDefault(); send(); }
  });

  /* ── ?clips=preview ─────────────────────────────────────────────────── */
  function sample() {
    const now = Date.now();
    const mk = (i, name, game, provider, caption, extra) => Object.assign({
      id: 'pv' + i, name, game, provider, caption, vid: provider === 'youtube' ? 'aaaaaaaaaaa' : String(10000 + i),
      url: '#', vertical: false, at: now - i * 3600e3, media: null, status: 'live',
    }, extra || {});
    const clips = [
      mk(1, 'nightcoil', 'slither', 'x', 'Cut off three snakes in ten seconds', { media: { video: '', poster: '', w: 16, h: 9, ms: 24000 } }),
      mk(2, 'cellmate', 'agar', 'x', 'Split and ate the biggest cell on the map'),
      mk(3, 'paperboy', 'paper', 'tiktok', 'Closed the loop with one square to spare', { vertical: true }),
      mk(4, 'nightcoil', 'br', 'x', 'Last two in the battle royale'),
      mk(5, 'slinky', 'slither', 'x', 'Comeback from the smallest snake in the room'),
      mk(6, 'cellmate', 'agar', 'tiktok', 'Two splits, one big cell gone', { vertical: true }),
    ];
    const queueS = [
      mk(7, 'zigzag', 'slither', 'x', 'Boosted through a gap I should not fit', { status: 'waiting', wallet: 'preview' }),
      mk(8, 'blobby', 'agar', 'tiktok', 'Fed the virus into a 400 mass cell', { status: 'waiting', wallet: 'preview', vertical: true }),
    ];
    return { clips, queue: queueS, waiting: queueS.length,
             top: [{ name: 'nightcoil', clips: 2 }, { name: 'cellmate', clips: 2 }, { name: 'paperboy', clips: 1 }, { name: 'slinky', clips: 1 }] };
  }

  const dot = () => ownerVerdict() === true && data.waiting > 0;
  window.V2Clips = { render, openSubmit, closeSubmit, send, openPlayer, closePlayer, dot, get preview() { return PREVIEW; } };
})();
