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
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] : '';
  }

  function draw() {
    const list = $('up-list');
    if (!list) return;
    list.textContent = '';
    if (posts === null) return;
    if (!posts.length) {
      list.appendChild(el('p', 'upnone', failed ? 'Updates did not load. Check your connection and open the tab again.' : 'Nothing posted yet.'));
      return;
    }
    posts.forEach(p => {
      const a = el('article', 'uppost' + (marks.has(p.id) ? ' fresh' : ''));
      const d = el('time', 'upd num', when(p.date));
      d.dateTime = p.date;
      a.appendChild(d);
      const t = TAG[p.tag] ? p.tag : 'new';
      a.appendChild(el('span', 'uptag t-' + t, TAG[t]));
      a.appendChild(el('h3', 'uph', p.title));
      const all = pics(p);
      const hero = pic(p.image);
      if (hero) a.appendChild(thumb(hero, 'uphero', all, 0));
      String(p.body || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
        .forEach(par => a.appendChild(el('p', 'upb', par)));
      const rest = all.slice(hero ? 1 : 0);
      if (rest.length) {
        const g = el('div', 'upgal');
        rest.forEach((x, i) => g.appendChild(thumb(x, 'upthumb', all, i + (hero ? 1 : 0))));
        a.appendChild(g);
      }
      list.appendChild(a);
    });
  }

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
  let veil = null, shown = [], at = 0, back = null;
  function viewer() {
    if (veil) return veil;
    veil = el('div', 'upveil');
    veil.setAttribute('role', 'dialog'); veil.setAttribute('aria-modal', 'true'); veil.setAttribute('aria-label', 'Picture');
    veil.innerHTML = '<figure class="upfig"><img alt=""><figcaption></figcaption></figure>' +
      '<button type="button" class="upnav prev" aria-label="Previous picture">&#8249;</button>' +
      '<button type="button" class="upnav next" aria-label="Next picture">&#8250;</button>' +
      '<button type="button" class="upx" aria-label="Close">&#10005;</button>';
    veil.addEventListener('click', (e) => { if (e.target === veil || e.target.classList.contains('upfig')) close(); });
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
    const x = shown[at];
    const im = veil.querySelector('img');
    im.src = x.src; im.alt = x.alt;
    veil.querySelector('figcaption').textContent = x.alt;
    veil.classList.toggle('many', shown.length > 1);
  }
  function view(all, i, from) {
    viewer();
    shown = all; at = i; back = from;
    paint();
    veil.classList.add('on');
    veil.querySelector('.upx').focus();
  }
  function step(d) {
    if (shown.length < 2) return;
    at = (at + d + shown.length) % shown.length;
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
    draw();
    if (posts && posts.length) {
      try { localStorage.setItem(SEEN_KEY, posts[0].id); } catch (_) {}
    }
    markFresh();
    paintDot();
  }

  if (pc()) load();
  window.V2Updates = { render, unread, load, get posts() { return posts; } };
})();
