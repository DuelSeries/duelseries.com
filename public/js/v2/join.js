'use strict';
/* ─── Join us: ways to get involved (Owen 2026-10-16, look 2 "Links") ──────────
   The Discord and the Whop clip team as two equal rows, X / TikTok / YouTube,
   then copy the site link, share a clip, report a bug, send an idea, and the
   newest Updates post. Styles in public/css/join.css. PC only, like Clips and
   Updates (v2.html's PC_ONLY and join.css), so a phone never builds it.

   Whop is the clip team: people post DuelSeries clips and Whop's content
   rewards pay them for the views. No rate is stated anywhere until Owen sets
   one. Nothing here moves money.

   The links live in LINKS, the one place to fill in. Owen sends a link to
   Claude, it goes here, and that row stops saying "Opening soon". Only https
   links are used; anything else stays "Opening soon". Every link opens in a new
   tab with rel="noopener noreferrer". */
(function () {
  const LINKS = {
    discord: 'https://discord.gg/TkFaefHDFr',   // the DuelSeries server (2026-10-26), lands in #welcome, never expires
    whop: '',      // the clip team page, like https://whop.com/duelseries
    x: '',         // like https://x.com/duelseries
    tiktok: '',    // like https://www.tiktok.com/@duelseries
    youtube: '',   // like https://www.youtube.com/@duelseries
  };
  const SITE = 'https://duelseries.com';
  const MAIL = 'playduelseries@gmail.com';
  const TAG = { 'new': 'New', fix: 'Fix', event: 'Event', 'heads-up': 'Heads up' };

  /* Drawn marks. Brand marks are filled; the small action icons are strokes in
     the lobby's own nav weight. */
  const MARK = {
    discord: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
    x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
    tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
    youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  };
  const ICON = {
    chev: 'm9 6 6 6-6 6',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    ok: 'M5 12.5 10 17l9-10',
    clip: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM10 9.2v5.6l4.6-2.8z',
    bug: 'M8 6V5a4 4 0 0 1 8 0v1M6 10h12v5a6 6 0 0 1-12 0zM3 13h3M18 13h3M4 7l2.5 2.5M20 7l-2.5 2.5M4 19l2.5-2M20 19l-2.5-2M12 10v11',
    idea: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  };

  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(d, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }
  // TikTok's mark is the note three times: cyan and red offset under white.
  function tiktok() {
    const w = el('span', 'jn-ttm');
    for (const c of ['c', 'r', 'w']) w.appendChild(svg(MARK.tiktok, c));
    return w;
  }

  /* A link Owen has set, or null. Only https, so a typo can never become a
     javascript: or http: link on the page. */
  function link(key) {
    const v = String(LINKS[key] || '').trim();
    if (!v) return null;
    try { const u = new URL(v); return u.protocol === 'https:' ? u.href : null; } catch (_) { return null; }
  }
  // A live link opens in a new tab; an unset one is a plain block that is plainly not pressable.
  function door(key, cls) {
    const href = link(key);
    const n = el(href ? 'a' : 'div', cls + (href ? '' : ' soon'));
    if (href) { n.href = href; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
    return n;
  }

  function bigRow(key, art, title, line) {
    const a = door(key, 'jn-lb');
    const t = el('span', 'jn-t');
    t.append(el('b', '', title), el('span', '', line));
    a.append(art, t, link(key) ? svg(ICON.chev, 'st jn-go') : el('span', 'jn-soon', 'Opening soon'));
    return a;
  }
  function discordArt() {
    const m = el('span', 'jn-m jn-dc');
    m.appendChild(svg(MARK.discord));
    return m;
  }
  function whopArt() {
    // A phone playing a DuelSeries clip on Whop orange: the clip team in one picture.
    const m = el('span', 'jn-m jn-wh');
    const ph = el('span', 'jn-phone');
    const img = el('img');
    img.src = '/img/games/snake.png'; img.alt = ''; img.draggable = false; img.decoding = 'async';
    ph.appendChild(img);
    m.appendChild(ph);
    return m;
  }
  function social(key, name, cls, mark) {
    const a = door(key, 'jn-sc ' + cls);
    if (!link(key)) a.setAttribute('role', 'img');
    a.setAttribute('aria-label', 'DuelSeries on ' + name + (link(key) ? '' : ', opening soon'));
    a.title = link(key) ? name : name + ', opening soon';
    a.appendChild(mark);
    return a;
  }
  function small(icon, text, onClick) {
    const b = el('button', 'jn-ls');
    b.type = 'button';
    b.append(svg(icon, 'st'), el('span', '', text));
    b.addEventListener('click', onClick);
    return b;
  }
  function mailto(subject, body) {
    const a = el('a', 'jn-ls');
    a.href = 'mailto:' + MAIL + '?subject=' + encodeURIComponent(subject) + (body ? '&body=' + encodeURIComponent(body) : '');
    return a;
  }

  /* Copy the site link. The clipboard API needs a secure page and a recent
     click; the hidden-textarea copy covers the rest. */
  function copySite(btn) {
    const done = () => {
      btn.classList.add('copied');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => btn.classList.remove('copied'), 2200);
    };
    const fallback = () => {
      const t = el('textarea');
      t.value = SITE; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      t.remove();
      if (ok) done();
      else if (window.DSToast) DSToast.show({ kind: 'info', title: 'Copy this link', code: SITE });
    };
    try {
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(SITE).then(done, fallback);
      else fallback();
    } catch (_) { fallback(); }
  }

  let built = false;
  function build() {
    const root = $('join-screen');
    if (!root) return;
    const box = el('div', 'jn');

    const fan = el('div', 'jn-fan');
    // Middle card first in the file, then out to the edges; join.css places them.
    ['snake', 'agar', 'paper', 'knockout', 'battleship'].forEach((g, i) => {
      const img = el('img', 'jn-c' + i);
      img.src = '/img/games/' + g + '.png'; img.alt = ''; img.draggable = false; img.decoding = 'async';
      fan.appendChild(img);
    });
    const icon = el('img', 'jn-icon');
    icon.src = '/img/icon-192.png'; icon.alt = 'DuelSeries'; icon.draggable = false;
    fan.appendChild(icon);

    const h = el('h2', '', 'Join us');
    h.id = 'jn-title';
    root.setAttribute('aria-labelledby', 'jn-title');
    const sub = el('p', 'jn-sub', 'Play with the community, make clips for DuelSeries, and tell us what to build next.');

    const big = el('div', 'jn-big');
    big.append(
      bigRow('discord', discordArt(), 'Join the Discord', 'Chat with players and hear about events first.'),
      bigRow('whop', whopArt(), 'Join the clip team on Whop', 'Post DuelSeries clips and get paid for the views.'));

    const soc = el('div', 'jn-soc');
    const xm = svg(MARK.x), ym = svg(MARK.youtube);
    soc.append(social('x', 'X', 'jn-x', xm), social('tiktok', 'TikTok', 'jn-tt', tiktok()), social('youtube', 'YouTube', 'jn-yt', ym));
    // The line names what is really there: the set ones to follow, the rest opening soon.
    const NAMES = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube' };
    const list = (ks) => ks.map(k => NAMES[k]).join(', ').replace(/, ([^,]*)$/, (_, last) => ' and ' + last);
    const live = Object.keys(NAMES).filter(link), dead = Object.keys(NAMES).filter(k => !link(k));
    const socl = el('p', 'jn-soclbl', [
      live.length ? 'Follow DuelSeries on ' + list(live) + '.' : '',
      dead.length ? (live.length ? ' ' : 'Our ') + list(dead) + (dead.length > 1 ? ' are' : ' is') + ' opening soon.' : '',
    ].join(''));

    const sm = el('div', 'jn-small');
    const copy = el('button', 'jn-ls');
    copy.type = 'button';
    copy.append(svg(ICON.link, 'st jn-cp'), svg(ICON.ok, 'st jn-ok'), el('span', 'jn-cp', 'Invite a friend'), el('span', 'jn-ok', 'Link copied'));
    copy.setAttribute('aria-live', 'polite');
    copy.addEventListener('click', () => copySite(copy));
    const bug = mailto('Bug report', 'Which game:\nWhat happened:\nRoughly when:\n');
    bug.append(svg(ICON.bug, 'st'), el('span', '', 'Report a bug'));
    const idea = mailto('Idea for DuelSeries', '');
    idea.append(svg(ICON.idea, 'st'), el('span', '', 'Send an idea'));
    sm.append(copy, small(ICON.clip, 'Share a clip', () => window.go && go('clips')), bug, idea);

    const upd = el('p', 'jn-upd');
    upd.id = 'jn-upd';
    upd.hidden = true;

    const mail = el('a', 'jn-mail', MAIL);
    mail.href = 'mailto:' + MAIL;

    box.append(fan, h, sub, big, soc, socl, sm, upd, mail);
    root.appendChild(box);
    built = true;
  }

  /* The newest post from public/updates.json, the same file and order the
     Updates tab uses (newest date first; on one day the top of the file wins).
     If it cannot be read the line just stays away. */
  let asked = false;
  function newest() {
    if (asked) return;
    asked = true;
    fetch('/updates.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(j => {
      const posts = (j && Array.isArray(j.posts) ? j.posts : [])
        .filter(p => p && typeof p.title === 'string' && p.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(p.date || ''));
      let top = null;
      for (const p of posts) if (!top || p.date > top.date) top = p;
      const line = $('jn-upd');
      if (!top || !line) return;
      const tag = el('span', 'jn-tag' + (TAG[top.tag] ? ' t-' + top.tag : ''), TAG[top.tag] || 'New');
      const see = el('button', '', 'See updates');
      see.type = 'button';
      see.addEventListener('click', () => window.go && go('updates'));
      line.replaceChildren(tag, el('span', '', top.title.trim()), see);
      line.hidden = false;
    }).catch(() => { asked = false; });
  }

  function render() {
    if (!built) build();
    newest();
  }

  window.V2Join = { render: render };
})();
