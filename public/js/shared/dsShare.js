// DuelSeries "Share your score" (the "get players first" push, 2026-10-26): the sheet a free game's end card opens from
// its Share pill (dsEnd.js), with a 1200 x 630 picture of the score drawn here and the invite link
// (duelseries.com/play/<slug>, shared/shareGames.js) that opens the game's free room for whoever gets it.
//
//   DSShare.open({ game, hero, unit, facts, z, zoom })   game: the lobby id ('snake', 'paper', 'agar')
//     hero/unit: the card's big figure and its words ('1,284', 'length'); facts: the card's [[label, value]], up to 3
//   DSShare.close(), DSShare.draw(opts) -> Promise<canvas>, DSShare.text(opts) -> the words that go with it
//
// Loaded on demand by DSEnd.share (no page includes it), after shared/shareGames.js. FREE PLAY ONLY: the end cards
// offer Share only on a free room's death, and nothing here ever says money, stake or winnings.
//
// What the buttons do: a phone that can share files gets one Share (its own share sheet, the picture with the words
// and the link); a computer copies the picture (Copy image) or saves it, and Copy invite link copies the link alone.
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;
  if (root.DSShare && root.DSShare.version) return;
  var SHARE = root.DS_SHARE;

  var W = 1200, H = 630;
  var INK = '#100e0b', BONE = '#f4f1ea', TX2 = '#a89c8a', TX3 = '#8d8171';
  var SANS = 'Archivo,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
  var MONO = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';

  function gameOf(id) { return SHARE && SHARE.byGame(id); }
  function linkOf(g) {
    var origin = '';
    try { origin = root.location.origin; } catch (e) { origin = ''; }
    if (!/^https?:\/\//.test(origin)) origin = SHARE ? SHARE.SITE : 'https://duelseries.com';
    return origin + '/play/' + g.slug;
  }
  function shortLink(url) { return String(url).replace(/^https?:\/\//, '').replace(/^www\./, ''); }

  function text(o) {
    var g = gameOf(o.game);
    if (!g) return '';
    var got = String(o.hero || '') + (o.unit ? ' ' + o.unit : '');
    return (got ? 'I got ' + got + ' in ' + g.name + ' on DuelSeries. Can you beat it?' : 'Play ' + g.name + ' with me on DuelSeries.');
  }

  // ---- the picture
  function loadImage(src) {
    return new Promise(function (resolve) {
      var im = new root.Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = src;
    });
  }
  function fontsReady() {
    var f = doc.fonts;
    if (!f || typeof f.load !== 'function') return Promise.resolve();
    var all = Promise.all([f.load('700 44px Archivo'), f.load('600 40px Archivo'), f.load('600 150px "IBM Plex Mono"')])
      .catch(function () {});
    return Promise.race([all, new Promise(function (r) { root.setTimeout(r, 1500); })]);
  }
  function cover(ctx, im) {
    var s = Math.max(W / im.width, H / im.height);
    var w = im.width * s, h = im.height * s;
    ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h);
  }
  // The longest text that fits in max px, cut with an ellipsis.
  function fit(ctx, s, max) {
    s = String(s);
    if (ctx.measureText(s).width <= max) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  }

  function draw(o) {
    var g = gameOf(o.game);
    var cv = doc.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    if (!g || !ctx) return Promise.resolve(cv);
    return Promise.all([loadImage(g.image), fontsReady()]).then(function (got) {
      var im = got[0];
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, W, H);
      if (im) cover(ctx, im);
      // the game shows on the right; the words sit on the warm ink on the left
      var sh = ctx.createLinearGradient(0, 0, W, 0);
      sh.addColorStop(0, 'rgba(16,14,11,.95)');
      sh.addColorStop(0.5, 'rgba(16,14,11,.8)');
      sh.addColorStop(1, 'rgba(16,14,11,.2)');
      ctx.fillStyle = sh;
      ctx.fillRect(0, 0, W, H);
      var x = 72;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillStyle = BONE;
      ctx.font = '700 40px ' + SANS;
      ctx.fillText('DuelSeries', x, 104);
      // the game's own colour, on a short rule under the name
      ctx.fillStyle = g.accent;
      ctx.font = '650 38px ' + SANS;
      ctx.fillText(g.name, x, 212);
      ctx.fillRect(x, 230, 56, 5);
      // the big figure and its words
      var hero = String(o.hero || '');
      ctx.fillStyle = BONE;
      // the figure and its words stay left of the game's picture (x 600 on): a long score is drawn smaller rather
      // than running its words into the art
      ctx.font = '500 40px ' + SANS;
      var uw = o.unit ? ctx.measureText(String(o.unit)).width + 18 : 0;
      var hs = 150;
      ctx.font = '600 ' + hs + 'px ' + MONO;
      while (hs > 90 && ctx.measureText(hero).width + uw > 528) { hs -= 6; ctx.font = '600 ' + hs + 'px ' + MONO; }
      hero = fit(ctx, hero, 760);
      ctx.fillText(hero, x - 6, 386);
      var hw = ctx.measureText(hero).width;
      if (o.unit) {
        ctx.fillStyle = TX2;
        ctx.font = '500 40px ' + SANS;
        ctx.fillText(fit(ctx, o.unit, Math.max(80, 1000 - hw)), x + hw + 18, 386);
      }
      // up to three facts, the value over its label like the card's
      var facts = (o.facts || []).slice(0, 3);
      for (var i = 0; i < facts.length; i++) {
        var f = Array.isArray(facts[i]) ? facts[i] : [facts[i].k || facts[i].label, facts[i].v || facts[i].value];
        var fx = x + i * 220;
        ctx.fillStyle = BONE;
        // a long value ("#2 of 10") is drawn smaller to fit its column rather than cut short
        var fs = 42;
        ctx.font = '600 ' + fs + 'px ' + MONO;
        while (fs > 28 && ctx.measureText(String(f[1])).width > 196) { fs -= 2; ctx.font = '600 ' + fs + 'px ' + MONO; }
        ctx.fillText(fit(ctx, f[1], 196), fx, 470);
        ctx.fillStyle = TX3;
        ctx.font = '500 24px ' + SANS;
        ctx.fillText(fit(ctx, f[0], 196), fx, 506);
      }
      // where to play
      ctx.font = '600 30px ' + SANS;
      ctx.fillStyle = TX2;
      var lead = 'Play free at ';
      ctx.fillText(lead, x, 574);
      ctx.fillStyle = BONE;
      ctx.fillText(shortLink(linkOf(g)), x + ctx.measureText(lead).width, 574);
      return cv;
    });
  }

  // ---- the sheet
  var CSS = [
    '.dss{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;' +
      'font-family:' + SANS + ';color:#f5f1e8;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;line-height:1.35}',
    '.dss *{box-sizing:border-box}',
    '.dss-scrim{position:absolute;inset:0;background:rgba(16,14,11,.72)}',
    '.dss-panel{position:relative;width:520px;max-width:100%;border-radius:18px;padding:18px;border:1px solid rgba(245,241,232,.09);' +
      'background:linear-gradient(180deg,#201c16,#16130f 72%);box-shadow:0 28px 56px -14px rgba(0,0,0,.72),0 10px 22px rgba(0,0,0,.34);' +
      'animation:dss-rise .26s cubic-bezier(.2,.8,.2,1) both}',
    '@keyframes dss-rise{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}',
    '.dss-top{display:flex;align-items:center;justify-content:space-between;margin:0 0 12px}',
    '.dss-top p{margin:0;font-size:16px;font-weight:650}',
    '.dss-x{width:34px;height:34px;border:0;border-radius:50%;background:rgba(245,241,232,.06);color:#a89c8a;font:600 20px/1 ' + SANS + ';' +
      'cursor:pointer;box-shadow:inset 0 0 0 1px rgba(245,241,232,.14)}',
    // the round close button is 34 px; its tap area reaches 42
    '.dss-x{position:relative}.dss-x:before{content:"";position:absolute;inset:-4px;border-radius:50%}',
    '.dss-x:hover{color:#f5f1e8;background:rgba(245,241,232,.11)}',
    '.dss-pic{display:block;width:100%;aspect-ratio:1200/630;border-radius:10px;background:#0d0b08;object-fit:cover;' +
      'box-shadow:inset 0 0 0 1px rgba(245,241,232,.08)}',
    '.dss-btns{display:flex;gap:8px;margin-top:14px}',
    '.dss-btn{flex:1 1 0;min-width:0;height:48px;border:0;border-radius:10px;padding:0 10px;font:650 15px ' + SANS + ';cursor:pointer;' +
      'background:rgba(245,241,232,.05);color:#f5f1e8;box-shadow:inset 0 0 0 1px rgba(245,241,232,.16);touch-action:manipulation}',
    '.dss-btn:hover{background:rgba(245,241,232,.1)}',
    '.dss-btn.pri{flex-grow:1.5;background:#f4f1ea;color:#100e0b;box-shadow:inset 0 -2px 0 rgba(16,14,11,.12),0 6px 16px rgba(0,0,0,.28)}',
    '.dss-btn.pri:hover{background:#fffaf0}',
    '.dss-btn:disabled{opacity:.5;cursor:default}',
    '.dss-btn:focus-visible,.dss-x:focus-visible{outline:2px solid #f0a830;outline-offset:2px}',
    // three buttons on a phone: the next step gets its own row, so Copy invite link is not squeezed onto three lines
    '@media (max-width:480px){.dss-btns.n3{flex-wrap:wrap}.dss-btns.n3 .dss-btn.pri{flex:1 1 100%}}',
  ].join('\n');

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = doc.createElement('style');
    s.setAttribute('data-ds-share', '1');
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }
  function el(tag, cls, t) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (t != null) e.textContent = String(t);
    return e;
  }

  // Copies text: the clipboard API, else a hidden textarea. Resolves true when it worked.
  function copyText(t) {
    var fallback = function () {
      var ta = el('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      ta.parentNode.removeChild(ta);
      return ok;
    };
    try {
      var nav = root.navigator;
      if (nav && nav.clipboard && root.isSecureContext) {
        return nav.clipboard.writeText(t).then(function () { return true; }, function () { return fallback(); });
      }
    } catch (e) { /* the fallback below */ }
    return Promise.resolve(fallback());
  }
  function toBlob(cv) {
    return new Promise(function (resolve) {
      try { cv.toBlob(function (b) { resolve(b); }, 'image/png'); } catch (e) { resolve(null); }
    });
  }
  // A button's label says what just happened for a moment, then goes back.
  function flash(btn, label) {
    var was = btn._label || btn.textContent;
    btn._label = was;
    btn.textContent = label;
    root.clearTimeout(btn._t);
    btn._t = root.setTimeout(function () { btn.textContent = was; }, 2000);
  }

  var sheet = null;
  function close() {
    if (sheet && sheet.el.parentNode) sheet.el.parentNode.removeChild(sheet.el);
    if (sheet && sheet.url) { try { root.URL.revokeObjectURL(sheet.url); } catch (e) { /* gone anyway */ } }
    sheet = null;
  }

  function open(o) {
    o = o || {};
    var g = gameOf(o.game);
    if (!g) return null;
    style();
    close();
    var link = linkOf(g);
    var words = text(o);
    var wrap = el('div', 'dss');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Share your score');
    wrap.style.zIndex = String(o.z != null ? Number(o.z) + 1 : 1001);
    if (o.zoom && o.zoom !== 1) wrap.style.zoom = String(o.zoom);
    // presses stay in the sheet: never the game's steering or boost under it
    ['pointerdown', 'mousedown', 'touchstart', 'click', 'wheel', 'keydown'].forEach(function (t) {
      wrap.addEventListener(t, function (e) { e.stopPropagation(); }, false);
    });
    var scrim = el('div', 'dss-scrim');
    scrim.addEventListener('click', close);
    wrap.appendChild(scrim);
    var panel = el('div', 'dss-panel');
    var top = el('div', 'dss-top');
    top.appendChild(el('p', null, 'Share your score'));
    var x = el('button', 'dss-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    top.appendChild(x);
    panel.appendChild(top);
    var pic = el('img', 'dss-pic');
    pic.alt = words;
    panel.appendChild(pic);
    var btns = el('div', 'dss-btns');
    panel.appendChild(btns);
    wrap.appendChild(panel);
    doc.body.appendChild(wrap);
    sheet = { el: wrap, url: null, blob: null };
    var mine = sheet;

    var nav = root.navigator || {};
    var copyLink = el('button', 'dss-btn', 'Copy invite link');
    copyLink.type = 'button';
    copyLink.addEventListener('click', function () {
      copyText(words + ' ' + link).then(function (ok) { flash(copyLink, ok ? 'Link copied' : 'Could not copy'); });
      track('link');
    });
    btns.appendChild(copyLink);
    var main = el('button', 'dss-btn pri', 'Share');
    main.type = 'button';
    main.disabled = true;
    btns.appendChild(main);
    root.setTimeout(function () { try { copyLink.focus(); } catch (e) { /* no focus here */ } }, 0);

    draw(o).then(toBlob).then(function (blob) {
      if (sheet !== mine) return;
      if (!blob) { main.textContent = 'Share'; main.disabled = false; main.onclick = shareLink; return; }
      mine.blob = blob;
      try { mine.url = root.URL.createObjectURL(blob); pic.src = mine.url; } catch (e) { /* no picture, the buttons still work */ }
      var file = null;
      try { file = new root.File([blob], 'duelseries-' + g.slug + '-score.png', { type: 'image/png' }); } catch (e) { file = null; }
      var canFiles = !!(file && typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] }));
      var canCopyImage = !!(nav.clipboard && typeof nav.clipboard.write === 'function' && typeof root.ClipboardItem === 'function');
      main.disabled = false;
      if (canFiles) {
        main.textContent = 'Share';
        main.onclick = function () {
          nav.share({ files: [file], text: words + ' ' + link }).catch(function () { /* closed by the player */ });
          track('native');
        };
      } else if (canCopyImage) {
        main.textContent = 'Copy image';
        main.onclick = function () {
          nav.clipboard.write([new root.ClipboardItem({ 'image/png': blob })])
            .then(function () { flash(main, 'Image copied'); }, function () { save(); });
          track('image');
        };
        var saveBtn = el('button', 'dss-btn', 'Save image');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', function () { save(); track('save'); });
        btns.insertBefore(saveBtn, main);
        btns.className = 'dss-btns n3';
      } else {
        main.textContent = 'Save image';
        main.onclick = function () { save(); track('save'); };
      }
      function save() {
        var a = el('a');
        a.href = mine.url;
        a.download = 'duelseries-' + g.slug + '-score.png';
        doc.body.appendChild(a);
        a.click();
        a.parentNode.removeChild(a);
        flash(main, 'Saved');
      }
    });
    function shareLink() {
      if (typeof nav.share === 'function') nav.share({ text: words, url: link }).catch(function () {});
      else copyText(words + ' ' + link).then(function (ok) { flash(main, ok ? 'Link copied' : 'Could not copy'); });
    }
    function track(how) {
      try { if (typeof root.phEvent === 'function') root.phEvent('score_shared', { game: o.game, how: how }); } catch (e) { /* none */ }
    }
    return { el: wrap, close: close };
  }

  root.DSShare = { version: 1, open: open, close: close, draw: draw, text: text, link: function (id) { var g = gameOf(id); return g ? linkOf(g) : null; } };
})(typeof window !== 'undefined' ? window : null);
