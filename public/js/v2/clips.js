'use strict';
/* ─── Clips: player clips (Owen 2026-10-16, look A) ───────────────────────────────
   Two ways in. Mostly: a player presses P in a game and Share to DuelSeries
   (public/js/clip/clipRec.js); the video goes to our own bucket and, once the
   owner approves it, plays here from CloudFront with Download, Copy link and
   Post on X (provider 'upload'). Or, like onlinemoneygames.com/clips: a player
   posts a clip on their own X, YouTube or TikTok and pastes the link; that video
   plays from their site. Either way the owner approves it first. PC only (the
   tab is hidden on phones, see the .pconly rules in v2.html). A shared link,
   /clip/<id>, is its own page that works on a phone too (server/clips.js).

     GET  /api/clips            -> { clips: [...], top: [{ name, clips }], waiting }
     POST /api/clips/submit     signed 'clip:submit' { url, caption, game }
     POST /api/clips/queue      signed 'clips:queue' {}  -> { owner, waiting }
     POST /api/clips/decide     signed 'clip:decide' { id, verdict }   owner only
     POST /api/clips/mine       signed 'clips:mine' {}  -> { clips }: the player's own, any state
     POST /api/clips/delete     signed 'clip:delete' { id }: a player deletes their own, any time
     POST /api/clips/upload     signed 'clip:upload' { size, psize, game, caption } -> upload links
     POST /api/clips/uploaded   { id, ticket } once the bytes are in
   (server/clips.js). Every signature is the wallet widget's duelWalletSignAction,
   silent, the same proof the games use to say who is playing.

   Every word a player typed is set as text, never as markup, and every player
   or picture is built from an id the server already checked, never from a URL a
   player sent. ?clips=preview fills the wall and the queue with sample clips made
   in this browser only. */
(function () {
  const $ = (id) => document.getElementById(id);
  const GAME = { slither: 'slither.io', paper: 'Paper.io', agar: 'agar.io', br: 'Battle royale', other: 'Other' };
  const ART = { slither: 'snake', agar: 'agar', paper: 'paper', br: 'snake', other: 'snake' };
  const SRC = { x: 'X', youtube: 'YouTube', tiktok: 'TikTok', upload: '' };
  const ON_SITE = { x: 'Watch on X', youtube: 'Watch on YouTube', tiktok: 'Watch on TikTok' };
  const PREVIEW = /[?&]clips=preview\b/.test(location.search);

  let data = { clips: [], top: [], waiting: 0 };
  let mineList = [];          // this player's own clips (Your clips)
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

  const isUp = (c) => c.provider === 'upload';
  const pageOf = (c) => location.origin + '/clip/' + encodeURIComponent(c.id);
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
    if (SRC[c.provider]) pic.appendChild(el('span', 'clsrc', SRC[c.provider]));
    if (c.media && c.media.ms) pic.appendChild(el('span', 'cldur num', clock(c.media.ms)));
    pic.onclick = () => openPlayer(c);
    wrap.appendChild(pic);
    if (c.caption) wrap.appendChild(el('div', 'clcap', c.caption));
    const by = el('div', 'clby');
    by.appendChild(el('span', 'clname', c.name));
    by.appendChild(el('span', 'clgame', GAME[c.game] || ''));
    wrap.appendChild(by);
    if (isUp(c) && c.status === 'live' && c.media && c.media.video && o.share !== false) wrap.appendChild(shareRow(c, 'clsh'));
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
      if (!isUp(c)) {
        const open = el('a', 'cllink', ON_SITE[c.provider] || 'Open');
        open.href = c.url; open.target = '_blank'; open.rel = 'noopener noreferrer';
        acts.appendChild(open);
      } else if (c.status === 'waiting') {
        acts.appendChild(el('span', 'clnote', c.media && c.media.ms ? 'Uploaded, ' + clock(c.media.ms) : 'Uploaded'));
      }
      wrap.appendChild(acts);
    }
    return wrap;
  }

  /* Download, Copy link, Post on X for a clip on the wall (public/js/clipPage.js does the work, the same
     buttons as the clip's own page). */
  function shareRow(c, cls) {
    const row = el('div', cls);
    const share = window.DSClipShare;
    const b = (label, fn) => { const x = el('button', '', label); x.type = 'button'; x.onclick = (e) => { e.stopPropagation(); fn(x); }; row.appendChild(x); return x; };
    b('Download', (x) => share && share.download(c.media.video, c.id, x));
    b('Copy link', (x) => share && share.copy(pageOf(c), x));
    b('Post on X', () => share && share.postX(pageOf(c), c.caption || (c.name + ' on DuelSeries')));
    return row;
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
      e.appendChild(el('span', '', 'Press P in any game to save the last 30 seconds, then Share to DuelSeries. The first one goes right here.'));
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

  /* ── Your clips: the upload box, then the player's own clips, each with Delete ──
     Only for a logged-in player. Delete asks once more on the same button, then the clip and its file are gone,
     waiting or on the wall (Owen 2026-10-16). */
  const STATE = { uploading: 'Uploading', waiting: 'Waiting for review', live: 'On the wall', rejected: 'Not approved' };
  function drawMine() {
    const m = $('cl-mine');
    if (!m) return;
    m.hidden = !addr() && !PREVIEW;
    if (m.hidden) return;
    m.textContent = '';
    const h = el('h3', 'clqh', 'Your clips');
    if (mineList.length) h.appendChild(el('span', 'clqn num', String(mineList.length)));
    m.appendChild(h);
    const list = el('div', 'clqlist');
    list.appendChild(dropBox());
    mineList.forEach(c => {
      const w = card(c, { share: false });
      const acts = el('div', 'clacts');
      acts.appendChild(el('span', 'clst ' + c.status, STATE[c.status] || ''));
      const del = el('button', 'clno', 'Delete'); del.type = 'button';
      del.onclick = () => deleteMine(c, del);
      acts.appendChild(del);
      w.appendChild(acts);
      list.appendChild(w);
    });
    m.appendChild(list);
  }
  function dropBox() {
    const b = el('div', 'cldrop');
    b.id = 'cl-drop';
    b.appendChild(el('b', '', 'Upload a clip'));
    b.appendChild(el('span', '', 'Drop an MP4 here, up to 30 seconds and 25 MB. It is reviewed before anyone else can see it.'));
    const pick = el('button', 'clok', 'Choose file'); pick.type = 'button';
    pick.onclick = () => openUpload();
    b.appendChild(pick);
    return b;
  }
  async function pullMine() {
    if (PREVIEW || !addr()) { mineList = []; return; }
    try {
      const j = await postSigned('/api/clips/mine', 'clips:mine', {});
      mineList = Array.isArray(j.clips) ? j.clips : [];
    } catch (_) { /* the wallet is still loading: the box still shows, the list comes next visit */ }
  }
  async function deleteMine(c, btn) {
    if (btn.dataset.sure !== '1') {
      btn.dataset.sure = '1';
      btn.textContent = 'Delete for good?';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.sure = ''; btn.textContent = 'Delete'; } }, 4000);
      return;
    }
    if (busy) return;
    busy = true; btn.disabled = true;
    try {
      const j = await postSigned('/api/clips/delete', 'clip:delete', { id: c.id });
      mineList = Array.isArray(j.clips) ? j.clips : mineList.filter(x => x.id !== c.id);
      toast({ kind: 'ok', title: 'Clip deleted', detail: c.status === 'live' ? 'It is off the wall.' : 'Nobody will see it.' });
      await pull();
      drawMine(); drawWall();
    } catch (e) {
      toast({ kind: 'err', title: 'Could not delete that', detail: e.message });
      btn.disabled = false;
    } finally { busy = false; }
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
    drawMine(); drawWall(); drawQueue();
    await pull();
    drawWall();
    await pullMine();
    drawMine();
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
    if (isUp(c)) {
      const n = el('div', 'clnovid');
      n.appendChild(el('b', '', 'This clip cannot play'));
      n.appendChild(el('span', '', c.status === 'rejected' ? 'It was not approved.' : 'It is still being checked.'));
      return n;
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
    if (isUp(c)) {
      if (c.status === 'live' && c.media && c.media.video && !PREVIEW) meta.appendChild(shareRow(c, 'clmsh'));
    } else if (!PREVIEW) {
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
  let file = null;            // { f, url, secs, w, h, poster } when the dialog sends a file, null for a link
  function needLogin() {
    if (addr() || PREVIEW) return false;
    if (typeof window.duelWalletLogin === 'function') window.duelWalletLogin();
    toast({ kind: 'info', title: 'Log in to share a clip', detail: 'Every clip on the wall has a player name on it.' });
    return true;
  }
  function openSubmit() {
    if (needLogin()) return;
    const veil = $('clsubveil');
    if (!veil) return;
    setMode(null);
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
    setMode(null);
    return true;
  }
  // The dialog's words and fields for a link (fl null) or for a file the player picked or dropped.
  function setMode(fl) {
    if (file && file !== fl && file.url) URL.revokeObjectURL(file.url);
    file = fl;
    const urlLabel = document.querySelector('label[for="cl-url"]');
    const show = (n, on) => { if (n) n.hidden = !on; };
    show(urlLabel, !fl); show($('cl-url'), !fl);
    const title = $('clsubtitle'); if (title) title.textContent = fl ? 'Share a clip' : 'Send a link';
    const p = document.querySelector('#clsubveil .clsubp');
    if (p) p.textContent = fl ? 'It is reviewed before anyone else can see it. You can delete it any time under Your clips.'
                              : 'Post your clip on X, YouTube or TikTok first, then paste the link. It shows on the wall once it is approved.';
    const btn = $('cl-send'); if (btn) btn.textContent = fl ? 'Share clip' : 'Send link';
    let box = $('cl-fileinfo');
    if (fl) {
      if (!box) { box = el('div', 'clfile'); box.id = 'cl-fileinfo'; $('cl-form').prepend(box); }
      box.textContent = '';
      const v = document.createElement('video');
      v.src = fl.url; v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.controls = true;
      box.appendChild(v);
      const t = el('div', 'clfmeta');
      t.appendChild(el('b', '', fl.f.name));
      t.appendChild(el('span', 'num', clock(fl.secs * 1000) + ', ' + (fl.f.size / 1048576).toFixed(1) + ' MB'));
      box.appendChild(t);
    } else if (box) box.remove();
  }

  /* ── Upload a clip: an MP4 from the player's PC (Owen 2026-10-16) ─────────
     Dropped on the Clips tab or picked with Choose file. Checked here first so a
     wrong file says why at once, then checked again by the server, which is the
     check that counts: MP4 only, up to 30 seconds and 25 MB, logged in, a few a day. */
  const UP_MAX = 25 * 1024 * 1024, UP_SECS = 31.5;
  function openUpload() {
    if (needLogin()) return;
    const inp = $('cl-file');
    if (inp) { inp.value = ''; inp.click(); }
  }
  // Reads the file's length, size and a still for its card, then opens the dialog in file mode.
  function takeFile(f) {
    if (!f || needLogin()) return;
    const bad = (why) => toast({ kind: 'err', title: 'Could not use that file', detail: why });
    if (!(f.type === 'video/mp4' || /\.mp4$/i.test(f.name))) return bad('Clips have to be MP4 videos.');
    if (f.size > UP_MAX) return bad('That file is ' + (f.size / 1048576).toFixed(0) + ' MB. Clips can be up to 25 MB.');
    if (f.size < 1024) return bad('That file is empty.');
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    let done = false;
    const fail = () => { if (done) return; done = true; URL.revokeObjectURL(url); bad('That file does not play as a video here.'); };
    v.onerror = fail;
    setTimeout(fail, 10000);
    v.onloadedmetadata = () => {
      if (done) return;
      if (!(v.duration > 0) || v.duration > UP_SECS) { done = true; URL.revokeObjectURL(url); return bad('Clips can be up to 30 seconds. That one is ' + Math.round(v.duration || 0) + '.'); }
      v.currentTime = Math.min(1, v.duration / 2);
    };
    v.onseeked = () => {
      if (done) return;
      done = true;
      const k = Math.min(1, 640 / (v.videoWidth || 640));
      const c = document.createElement('canvas');
      c.width = Math.max(2, Math.round((v.videoWidth || 640) * k)); c.height = Math.max(2, Math.round((v.videoHeight || 360) * k));
      try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); } catch (_) {}
      c.toBlob((b) => {
        const fl = { f, url, secs: v.duration, w: v.videoWidth, h: v.videoHeight, poster: b && b.size <= 380 * 1024 ? b : null };
        const veil = $('clsubveil');
        if (!veil) return;
        $('cl-cap').value = ''; $('cl-err').textContent = '';
        pick = 'other'; drawPick();
        setMode(fl);
        veil.classList.add('on');
        setTimeout(() => $('cl-cap').focus(), 30);
      }, 'image/jpeg', 0.8);
    };
    v.src = url;
  }
  function put(url, blob, type, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Type', type);
      x.setRequestHeader('If-None-Match', '*');      // the link is signed to write its file once
      x.timeout = 5 * 60 * 1000;
      if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('The upload was refused. Try again.')));
      x.onerror = x.ontimeout = () => reject(new Error('The upload did not finish. Check your connection and try again.'));
      x.send(blob);
    });
  }
  async function sendFile() {
    const fl = file;
    const caption = $('cl-cap').value.trim().slice(0, 140);
    const err = $('cl-err');
    if (PREVIEW) { closeSubmit(); toast({ kind: 'info', title: 'Preview', detail: 'Nothing is sent from the preview.' }); return; }
    busy = true;
    const btn = $('cl-send'); btn.disabled = true; btn.textContent = 'Uploading 0%';
    err.textContent = '';
    try {
      const args = { size: fl.f.size, psize: fl.poster ? fl.poster.size : 0, game: pick, caption };
      const up = await postSigned('/api/clips/upload', 'clip:upload', args);
      await put(up.video, fl.f, 'video/mp4', (x) => { btn.textContent = 'Uploading ' + Math.round(x * 100) + '%'; });
      if (fl.poster && up.poster) await put(up.poster, fl.poster, 'image/jpeg').catch(() => {});
      btn.textContent = 'Checking…';
      const r = await fetch('/api/clips/uploaded', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: up.id, ticket: up.ticket }) });
      let j = {}; try { j = await r.json(); } catch (_) {}
      if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
      closeSubmit();
      toast({ kind: 'ok', title: 'Sent for review', detail: 'It shows on the wall once it is approved. Delete it any time under Your clips.' });
      await pullMine(); drawMine();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      busy = false; btn.disabled = false; btn.textContent = file ? 'Share clip' : 'Send link';
    }
  }

  // Drag and drop on the Clips tab: the box lights up while a file is over the page.
  let dragDepth = 0;
  // The Clips screen is on show (v2.html keeps its route in a script-level let, not on window).
  const onClips = () => { const sc = $('clips-screen'); return !!sc && sc.getClientRects().length > 0; };
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!onClips() || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    const b = $('cl-drop'); if (b) b.classList.add('over');
    document.body.classList.add('cldragging');
  });
  document.addEventListener('dragover', (e) => { if (onClips() && hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  document.addEventListener('dragleave', (e) => {
    if (!onClips() || !hasFiles(e)) return;
    if (--dragDepth > 0) return;
    dragDepth = 0;
    const b = $('cl-drop'); if (b) b.classList.remove('over');
    document.body.classList.remove('cldragging');
  });
  document.addEventListener('drop', (e) => {
    if (!onClips() || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    const b = $('cl-drop'); if (b) b.classList.remove('over');
    document.body.classList.remove('cldragging');
    takeFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'cl-file') takeFile(e.target.files && e.target.files[0]);
  });
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
    if (file) return sendFile();
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
      busy = false; btn.disabled = false; btn.textContent = 'Send link';
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
      b.classList.toggle('isnew', owner && data.waiting > 0);
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
  window.addEventListener('duelwallet:change', () => {
    setTimeout(() => { watch(); paintDot(); if (onClips()) { drawMine(); pullMine().then(drawMine); } }, 500);
  });

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
  window.V2Clips = { render, openSubmit, openUpload, closeSubmit, send, openPlayer, closePlayer, dot, get preview() { return PREVIEW; } };
})();
