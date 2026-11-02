'use strict';
/* The share page of a player's clip, /clip/<id> (server/clips.js sharePage): Download, Copy link, Post on X.
   The addresses come from the page's own data attributes, which the server wrote. Shared with the lobby's Clips
   wall as window.DSClipShare. */
(function () {
  /* A button's words, leaving any mark beside them: the lobby's kit buttons carry an icon before their label
     (site redo stage 3), and setting textContent would wipe it. */
  const textNode = (btn) => Array.prototype.slice.call(btn.childNodes).reverse().find((x) => x.nodeType === 3 && x.textContent.trim());
  const words = (btn) => { const n = textNode(btn); return n ? n.textContent : btn.textContent; };
  function say(btn, text) { const n = textNode(btn); if (n) n.textContent = text; else btn.textContent = text; }

  /* Saves the clip as a file. CloudFront serves an approved clip as an attachment with its file name
     (server/clips.js), so opening its address downloads it and this page stays where it is; a <video> plays the
     same address as usual. A fetch would need CORS, which CloudFront's free plan only half supports. */
  function download(video, id, btn) {
    const a = document.createElement('a');
    a.href = video; a.download = 'duelseries-clip-' + String(id).replace(/[^a-f0-9]/g, '') + '.mp4';
    a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    if (btn) {
      const was = words(btn);
      btn.disabled = true; say(btn, 'Downloading');
      setTimeout(() => { btn.disabled = false; say(btn, was); }, 2500);
    }
  }
  async function copy(text, btn) {
    const was = btn ? words(btn) : '';
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
      const t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch (_) {}
      t.remove();
    }
    if (btn) { say(btn, ok ? 'Link copied' : 'Could not copy'); setTimeout(() => { say(btn, was); }, 2000); }
    return ok;
  }
  function postX(page, title) {
    window.open('https://x.com/intent/post?text=' + encodeURIComponent(title || 'A clip from DuelSeries')
      + '&url=' + encodeURIComponent(page), '_blank', 'noopener,noreferrer');
  }
  window.DSClipShare = { download, copy, postX };

  const box = document.getElementById('cpacts');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const d = box.dataset;
    if (b.dataset.act === 'download') download(d.video, d.id, b);
    else if (b.dataset.act === 'copy') copy(d.page, b);
    else if (b.dataset.act === 'x') postX(d.page, d.title);
  });
})();
