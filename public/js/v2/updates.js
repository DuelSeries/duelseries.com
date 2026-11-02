'use strict';
/* ─── Updates: what is new, newest first (Owen 2026-10-16, look A "Timeline") ──
   The posts are public/updates.json. Owen adds one by asking Claude, which puts
   it at the top of that file and deploys; there is no form and no server route,
   so there is nothing here anyone else can post through.

   A red dot on the tab until the player opens it, and a filled stop on the
   line for each post they have not seen. "Seen" is the newest post's id in this
   browser's storage; a first visit counts the last three days as new. PC only,
   like Clips (the .pconly rules in v2.html), so a phone never fetches it.

   Pictures (Owen 2026-10-16: "make it more interesting instead of just
   words"): a post may carry one big picture (image) and a few small ones
   (gallery), files under public/updates/. Any of them opens large in a
   viewer; with more than one, the arrows step through that post's pictures. */
(function () {
  const $ = (id) => document.getElementById(id);
  const SEEN_KEY = 'dsUpdatesSeen';
  const TAG = { 'new': 'New', fix: 'Fix', event: 'Event', 'heads-up': 'Heads up' };
  const FIRST_VISIT_DAYS = 3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let posts = null;      // null until loaded
  let failed = false;
  let loading = null;
  let fresh = new Set();   // not seen yet: what the tab's dot means
  let marks = new Set();   // drawn as new on this visit (kept after the visit marks them seen)
  /* Layout 1 (site redo stage 3): eight posts at a time, Show older posts for the next eight (the stage 3 audit found
     all 104 posts and their pictures drawn at once), and a filter by kind. */
  const PAGE = 8;
  let kind = 'all', shown = PAGE;
  const kindOf = (p) => (TAG[p.tag] ? p.tag : 'new');
  /* The kit's stroke marks for the tags and the buttons. */
  const MARK = { 'new': 'M12 5v14M5 12h14', fix: 'M5 12l5 5 9-10', event: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
    'heads-up': 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4', up: 'M12 19V5M5 12l7-7 7 7', chev: 'M9 6l6 6-6 6', x: 'M6 6l12 12M18 6L6 18',
    list: 'M4 5h16M4 12h16M4 19h10' };
  const NS = 'http://www.w3.org/2000/svg';
  function ic(name, size) {
    const v = document.createElementNS(NS, 'svg');
    v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('width', size || 14); v.setAttribute('height', size || 14); v.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', MARK[name]); v.appendChild(p);
    return v;
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const pc = () => !matchMedia('(max-width:760px),(hover:none) and (pointer:coarse)').matches;
  const seen = () => { try { return localStorage.getItem(SEEN_KEY) || ''; } catch (_) { return ''; } };

  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Only our own files: a typo in the JSON can never point a post at another site.
  const SRC = /^\/updates\/[a-z0-9][a-z0-9-]*\.(webp|png|jpe?g)$/;
  const GALLERY_MAX = 4;
  const pic = (x) => {
    const o = typeof x === 'string' ? { src: x } : x;
    return o && typeof o.src === 'string' && SRC.test(o.src) ? { src: o.src, alt: typeof o.alt === 'string' ? o.alt : '' } : null;
  };
  const pics = (p) => [pic(p.image)].concat((Array.isArray(p.gallery) ? p.gallery : []).slice(0, GALLERY_MAX).map(pic)).filter(Boolean);
  function clean(list) {
    return (Array.isArray(list) ? list : []).filter(p => p && typeof p.id === 'string' && DATE.test(p.date || '')
      && typeof p.title === 'string' && p.title.trim())
      // Newest date first; posts on the same day keep the file's order (the top one is the newest).
      .map((p, i) => ({ p, i })).sort((a, b) => (a.p.date < b.p.date ? 1 : a.p.date > b.p.date ? -1 : a.i - b.i))
      .map(x => x.p);
  }
  function load() {
    if (!loading) {
      loading = fetch('/updates.json', { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => { posts = clean(j && j.posts); failed = false; })
        .catch(() => { failed = true; if (!posts) posts = []; })
        .then(() => { loading = null; markFresh(); paintDot(); });
    }
    return loading;
  }

  function markFresh() {
    fresh = new Set();
    if (!posts || !posts.length) return;
    const s = seen();
    const at = s ? posts.findIndex(p => p.id === s) : -1;
    if (s && at >= 0) { posts.slice(0, at).forEach(p => fresh.add(p.id)); return; }
    if (s) return;                       // the post they saw is gone from the file: nothing to flag
    const cut = Date.now() - FIRST_VISIT_DAYS * 864e5;
    posts.forEach(p => { if (Date.parse(p.date + 'T12:00:00') >= cut) fresh.add(p.id); });
  }

  const unread = () => fresh.size > 0;
  function paintDot() {
    document.querySelectorAll('.ni[data-tab="updates"]').forEach(b => b.classList.toggle('isnew', unread()));
  }

  function when(d) {
    const m = DATE.exec(d);
    return m ? { day: Number(m[3]), mon: MONTHS[Number(m[2]) - 1] } : { day: '', mon: '' };
  }

  const list = () => (kind === 'all' ? posts : posts.filter(p => kindOf(p) === kind));
  function post(p) {
    const a = el('article', 'uppost' + (marks.has(p.id) ? ' fresh' : ''));
    const stop = el('i', 'upstop'); stop.setAttribute('aria-hidden', 'true'); a.appendChild(stop);
    const t = kindOf(p);
    // A blinking green dot before the kind, like Join us's newest-update line (Owen 2026-11-02).
    const tag = el('span', 'ds-chip uptag t-' + t); tag.appendChild(el('i', 'updot')); tag.appendChild(document.createTextNode(TAG[t]));
    a.appendChild(tag);
    const h = el('h3', 'uph');
    if (marks.has(p.id)) h.appendChild(el('span', 'ds-sr', 'Not seen yet: '));
    h.appendChild(document.createTextNode(p.title));
    a.appendChild(h);
    const all = pics(p);
    const hero = pic(p.image);
    if (hero) a.appendChild(thumb(hero, 'uphero', all, 0));
    String(p.body || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)
      .forEach(par => a.appendChild(el('p', 'upb', par)));
    const rest = all.slice(hero ? 1 : 0);
    if (rest.length) {
      const g = el('div', 'upgal');
      rest.forEach((x, i) => g.appendChild(thumb(x, 'upthumb', all, i + (hero ? 1 : 0))));
      a.appendChild(g);
    }
    return a;
  }

  function draw() {
    const box = $('up-list');
    if (!box) return;
    box.textContent = '';
    const rail = $('up-rail');
    if (posts === null) { if (rail) rail.hidden = true; return; }
    if (!posts.length) {
      if (rail) rail.hidden = true;
      const n = el('div', 'ds-panel upnone');
      const i = el('span', 'upnone-ic'); i.appendChild(ic('list', 26)); n.appendChild(i);
      if (failed) {
        n.appendChild(el('b', '', 'Updates did not load'));
        n.appendChild(el('span', '', 'Updates did not load. Check your connection and open the tab again.'));
        const again = el('button', 'ds-btn ds-btn-secondary', 'Try again'); again.type = 'button';
        again.addEventListener('click', () => { again.classList.add('is-loading'); load().then(() => { marks = new Set(fresh); draw(); rail && drawRail(); }); });
        n.appendChild(again);
      } else {
        n.appendChild(el('b', '', 'Nothing posted yet'));
        n.appendChild(el('span', '', 'Every change you can see on DuelSeries gets a short post here, most with a picture.'));
      }
      box.appendChild(n);
      return;
    }
    if (rail) rail.hidden = false;
    const l = list(), some = l.slice(0, shown);
    const days = [];
    some.forEach(p => { const d = days[days.length - 1]; if (d && d.date === p.date) d.posts.push(p); else days.push({ date: p.date, posts: [p] }); });
    const tl = el('ol', 'uptl');
    tl.setAttribute('aria-label', 'Posts by day');
    days.forEach(d => {
      const w = when(d.date);
      const li = el('li', 'upday');
      const tm = el('time', 'upday-d'); tm.dateTime = d.date;
      tm.appendChild(el('b', '', String(w.day))); tm.appendChild(el('span', '', w.mon));
      li.appendChild(tm);
      const ps = el('div', 'upday-posts');
      d.posts.forEach(p => ps.appendChild(post(p)));
      li.appendChild(ps);
      tl.appendChild(li);
    });
    box.appendChild(tl);
    const more = el('div', 'up-more');
    if (l.length > shown) {
      const b = el('button', 'ds-btn ds-btn-secondary', 'Show older posts'); b.type = 'button';
      b.addEventListener('click', () => {
        const was = shown; shown += PAGE; draw();
        const h = box.querySelectorAll('.uph')[was];
        if (h) { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (_) {} }
      });
      more.append(b, el('span', 'ds-t-meta', (l.length - shown) + ' more'));
    } else {
      more.appendChild(el('span', 'ds-t-meta', 'That is every ' + (kind === 'all' ? '' : TAG[kind].toLowerCase() + ' ') + 'post.'));
      const t = el('button', 'ds-btn ds-btn-quiet ds-btn-sm'); t.type = 'button';
      t.append(ic('up', 16), document.createTextNode('Back to top'));
      t.addEventListener('click', toTop);
      more.appendChild(t);
    }
    box.appendChild(more);
  }

  /* The rail: Show (All and each kind there are posts of, with how many), what the filled stops mean, Back to top. */
  function drawRail() {
    const chips = $('up-filter'), key = $('up-key');
    if (!chips || !posts || !posts.length) return;
    const count = (k) => (k === 'all' ? posts.length : posts.filter(p => kindOf(p) === k).length);
    chips.textContent = '';
    [['all', 'All']].concat(Object.keys(TAG).map(k => [k, TAG[k]])).filter(([k]) => count(k)).forEach(([k, n]) => {
      const b = el('button', 'ds-fchip', n); b.type = 'button';
      b.setAttribute('aria-pressed', String(k === kind));
      b.appendChild(el('small', '', String(count(k))));
      b.addEventListener('click', () => {
        kind = k; shown = PAGE;
        chips.querySelectorAll('.ds-fchip').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        draw();
      });
      chips.appendChild(b);
    });
    if (key) {
      key.textContent = '';
      const row = (fresh_, text) => { const r = el('span'); const st = el('i', 'upstop' + (fresh_ ? ' is-fresh' : '')); st.setAttribute('aria-hidden', 'true'); r.append(st, document.createTextNode(text)); key.appendChild(r); };
      const n = marks.size;
      row(true, n ? n + (n === 1 ? ' post you have not seen' : ' posts you have not seen') : 'You have seen every post');
      row(false, 'Seen before');
    }
  }
  function toTop() {
    const sc = $('updates-screen');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0, 0); }
    if (sc && sc.scrollTop) try { sc.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { sc.scrollTop = 0; }
    const h = $('up-t'); if (h) try { h.focus({ preventScroll: true }); } catch (_) {}
  }
  document.addEventListener('click', (e) => { if (e.target && e.target.closest && e.target.closest('#up-top')) toTop(); });

  function thumb(x, cls, all, i) {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', 'Open picture' + (x.alt ? ': ' + x.alt : ''));
    const im = el('img');
    im.src = x.src; im.alt = x.alt; im.loading = 'lazy'; im.decoding = 'async'; im.draggable = false;
    b.appendChild(im);
    b.addEventListener('click', () => view(all, i, b));
    return b;
  }

  /* The viewer: one picture large, its words under it, arrows when the post has more. */
  let veil = null, shown_ = [], at = 0, back = null;
  function viewer() {
    if (veil) return veil;
    veil = el('div', 'upveil');
    veil.setAttribute('role', 'dialog'); veil.setAttribute('aria-modal', 'true'); veil.setAttribute('aria-label', 'Picture');
    const x = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="' + MARK.x + '"/></svg>';
    const ch = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="' + MARK.chev + '"/></svg>';
    veil.innerHTML = '<figure class="upfig"><div class="upstage"><img alt=""></div><div class="upcap"><figcaption></figcaption>' +
      '<div class="upnavs"><button type="button" class="ds-btn ds-btn-secondary ds-btn-icon upnav prev" aria-label="Previous picture">' + ch + '</button>' +
      '<span class="ds-t-meta" aria-live="polite"></span>' +
      '<button type="button" class="ds-btn ds-btn-secondary ds-btn-icon upnav next" aria-label="Next picture">' + ch + '</button></div></div>' +
      '<button type="button" class="upx" aria-label="Close">' + x + '</button></figure>';
    veil.addEventListener('click', (e) => { if (e.target === veil) close(); });
    veil.querySelector('.upx').addEventListener('click', close);
    veil.querySelector('.prev').addEventListener('click', () => step(-1));
    veil.querySelector('.next').addEventListener('click', () => step(1));
    document.addEventListener('keydown', (e) => {
      if (!veil.classList.contains('on')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
    document.body.appendChild(veil);
    return veil;
  }
  function paint() {
    const x = shown_[at];
    const im = veil.querySelector('img');
    im.src = x.src; im.alt = x.alt;
    veil.querySelector('figcaption').textContent = x.alt;
    veil.classList.toggle('many', shown_.length > 1);
    const n = veil.querySelector('.upnavs .ds-t-meta'); if (n) n.textContent = (at + 1) + ' of ' + shown_.length;
  }
  function view(all, i, from) {
    viewer();
    shown_ = all; at = i; back = from;
    paint();
    veil.classList.add('on');
    veil.querySelector('.upx').focus();
  }
  function step(d) {
    if (shown_.length < 2) return;
    at = (at + d + shown_.length) % shown_.length;
    paint();
  }
  function close() {
    veil.classList.remove('on');
    if (back && back.isConnected) back.focus();
  }

  // Opening the tab: draw what is new as new, then remember it as seen, so the dot goes but the marks stay this visit.
  async function render() {
    marks = new Set(fresh);
    draw();
    await load();
    marks = new Set(fresh);
    draw(); drawRail();
    if (posts && posts.length) {
      try { localStorage.setItem(SEEN_KEY, posts[0].id); } catch (_) {}
    }
    markFresh();
    paintDot();
  }

  if (pc()) load();
  window.V2Updates = { render, unread, load, get posts() { return posts; } };
})();
