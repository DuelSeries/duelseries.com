'use strict';
/* ─── Updates: what is new, newest first (Owen 2026-10-16, look A "Timeline") ──
   The posts are public/updates.json. Owen adds one by asking Claude, which puts
   it at the top of that file and deploys; there is no form and no server route,
   so there is nothing here anyone else can post through.

   A red dot on the tab until the player opens it, and a filled stop on the
   line for each post they have not seen. "Seen" is the newest post's id in this
   browser's storage; a first visit counts the last three days as new. PC only,
   like Clips (the .pconly rules in v2.html), so a phone never fetches it. */
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
      String(p.body || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
        .forEach(par => a.appendChild(el('p', 'upb', par)));
      list.appendChild(a);
    });
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
