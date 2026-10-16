// DuelSeries shared end screens: ONE result card (death, cash-out, win) and ONE in-game leaderboard for every game
// (Owen 2026-10-16: "one cashout screen, one death screen and one leaderboard ... for all the games"). Look "Gold coin",
// Owen's pick the same evening ("actually can you do the gold coin"), after the cream "Ticket" and a short-lived "Lobby
// panel": a small dark screen that pops up with a struck coin on its top edge. Money coming to you strikes a gold coin (the
// in-game money: breathing gold with a small $), a battle royale win puts a crown on it, anything else (a loss, a free
// death) leaves a blank iron coin and lets the figure say it. The board is fully clear, text only; your row is a gold pill.
//
// Each game keeps its own logic and money flow and only maps its data in (a small adapter in the game's own files):
//   DSEnd.show(card)  -> the card on screen (replaces the one showing). card:
//     tone     'plain' | 'win' | 'loss'          colours the big figure and picks the coin (gold or iron)
//     verdict  'Killed by Kestrel'                the line above the big figure
//     hero     '$2.16' | '1,284' | '1st'          the big figure; unit: the words after it ('to your wallet')
//     podium   [{ rank, name, me }]               battle royale top 3
//     facts    [[label, value]]                   up to three (Owen: time, rank, score)
//     ledger   [[label, value]]                   money rows; with two or more, the last is the net row
//     status   { text, state: 'pending'|'ok'|'err', link: { href, text } }
//     notes    ['...']                            small lines under the money (refusals, hints)
//     buttons  [{ id, text, primary, disabled, onClick }]
//     z, zoom, root                               stacking order, a page-zoom fix (/sl's 0.7 viewport), parent node
//   -> { update(partial), hide(), el, button(id), opacity(x) }
//   DSEnd.hide(), DSEnd.shown()
//   DSEnd.ring(ctx, x, y, r, p, t, o)  the hold-to-cash-out ring every game draws (see "the ring" below)
//   DSEnd.board(opts) -> { set(rows, me), show(), hide(), destroy(), el }
//     opts: { money, light, title, z, zoom, top, right, rowsPhone (5), rowsPC (10), root }
//     light: a game drawn on a light map (agar.io): ink text with a light halo instead of cream with a shadow
//     rows: [{ name, value, me }] in rank order; me: { rank, name, value } (pinned under the list when outside it,
//     after a small space only when ranks were skipped: never a "…" row, which Owen read as dots over his name)
//
// On a phone the card sits low, so every button is under the thumb, and the buttons always share one row with the
// next step widest on the left (the same spot in every game). A computer gets the same card a size up, centred.
// Motion plays for everyone (Owen's PC reports reduced motion, so gated motion would be invisible to him): one entrance
// under half a second (the panel rises, the gold coin turns once and lands with one glint, iron just drops) and the
// payout status changing. Nothing loops except the small pending dot. The big figure never counts up.
//
// Display only. Every amount is a string the game formatted from the SERVER's own numbers (DSEnd.usd for micro-USDC);
// nothing here is ever read back for money. Player names go in as text, never markup.
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;
  if (root.DSEnd && root.DSEnd.version) return;

  var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&family=IBM+Plex+Mono:wght@500;600&display=swap';
  var PHONE_MAX = 760;
  var MONO = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';
  var SANS = 'Archivo,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
  var PANEL_BG = 'linear-gradient(180deg,var(--dse-p1),var(--dse-p2) 72%) border-box';

  var CSS = [
    // the card: the lobby's warm ink, gold only where there is money. Phone first: low on the screen, near the thumb.
    '.dse{--dse-ink:#100e0b;--dse-p1:#201c16;--dse-p2:#16130f;--dse-tx:#f5f1e8;--dse-tx2:#a89c8a;--dse-tx3:#8d8171;' +
      '--dse-bone:#f4f1ea;--dse-gold:#f0a830;--dse-loss:#ff6b57;--dse-line:rgba(245,241,232,.09);' +
      'position:fixed;inset:0;display:flex;align-items:flex-end;justify-content:center;' +
      'padding:12px 16px calc(14px + env(safe-area-inset-bottom,0px));box-sizing:border-box;' +
      'font-family:' + SANS + ';color:var(--dse-tx);-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;' +
      'text-align:center;line-height:1.35}',
    '.dse *{box-sizing:border-box}',
    // :where keeps this reset weaker than the parts' own margins below
    '.dse :where(p),.dse :where(ol),.dse :where(dl),.dse :where(dd){margin:0;padding:0;list-style:none}',
    // the game stays visible above the card, darker where the card sits
    '.dse-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(16,14,11,.38),rgba(16,14,11,.74) 72%)}',
    '.dse-card{position:relative;width:360px;max-width:100%}',
    '.dse-card.coined{padding-top:24px}',
    '.dse-panel{position:relative;border-radius:18px;padding:20px 18px 18px;border:1px solid rgba(245,241,232,.09);' +
      'background:' + PANEL_BG + ';' +
      'box-shadow:inset 0 1px 0 rgba(255,236,200,.06),0 28px 56px -14px rgba(0,0,0,.72),0 10px 22px rgba(0,0,0,.34)}',
    '.dse-card.coined .dse-panel{padding-top:50px}',
    // gold light from the coin falls on the top of the panel
    '.dse-card.g-gold .dse-panel{background:radial-gradient(170px 96px at 50% 0,rgba(240,168,48,.15),rgba(240,168,48,0)),' +
      PANEL_BG + '}',
    '.dse-card.in .dse-panel{animation:dse-rise .3s cubic-bezier(.2,.8,.2,1) both}',
    '@keyframes dse-rise{from{opacity:0;transform:translateY(22px) scale(.97)}to{opacity:1;transform:none}}',

    // the coin, half on the panel's top edge: a milled edge, a polished lip, a top-lit face with a ring of beads,
    // the glyph struck into it. All CSS, no images.
    '.dse-coin{position:absolute;left:50%;top:0;width:64px;height:64px;margin-left:-32px;border-radius:50%;z-index:1;padding:6px}',
    '.dse-coin>span{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;' +
      'border-radius:50%;overflow:hidden}',
    '.dse-coin>span:before{content:"";position:absolute;inset:3.5px;border-radius:50%;border:1.5px dotted}',
    '.dse-coin b{position:relative;display:block;font:600 27px/1 ' + MONO + ';letter-spacing:-.04em}',
    // the crown (a battle royale win): three points over a band
    '.dse-coin b.crown{width:24px;height:19px;margin-top:-1px}',
    '.dse-coin b.crown:before,.dse-coin b.crown:after{content:"";position:absolute;left:0;right:0;background:currentColor}',
    '.dse-coin b.crown:before{top:0;height:76%;-webkit-clip-path:polygon(0 22%,27% 58%,50% 0,73% 58%,100% 22%,88% 100%,12% 100%);' +
      'clip-path:polygon(0 22%,27% 58%,50% 0,73% 58%,100% 22%,88% 100%,12% 100%)}',
    '.dse-coin b.crown:after{bottom:0;height:15%;left:12%;right:12%;border-radius:1px}',
    // gold: the money, with a soft bloom
    '.dse-coin.m-gold{background:linear-gradient(180deg,rgba(255,249,226,.62),rgba(255,249,226,0) 42%,rgba(74,40,0,0) 58%,rgba(74,40,0,.55)),' +
      'repeating-conic-gradient(#f6c860 0deg 2.6deg,#ad6f16 2.6deg 6deg);' +
      'box-shadow:0 0 0 1px rgba(88,52,4,.75),0 0 28px 3px rgba(240,168,48,.36),0 9px 14px -4px rgba(0,0,0,.66),0 2px 3px rgba(0,0,0,.36)}',
    '.dse-coin.m-gold>span{background:radial-gradient(circle at 38% 20%,#ffefbc 0%,#fad06c 28%,#eeaa39 62%,#c98612 100%);' +
      'box-shadow:0 0 0 1.5px #f9d98c,0 0 0 2.5px rgba(96,56,4,.7),inset 0 2px 2px rgba(255,250,232,.6),inset 0 -2px 3px rgba(120,66,0,.42)}',
    '.dse-coin.m-gold>span:before{border-color:rgba(146,88,8,.55)}',
    '.dse-coin.m-gold b{color:#9a5e06;text-shadow:0 1px 0 rgba(255,240,196,.9),0 -1px 0 rgba(110,60,0,.45)}',
    '.dse-coin.m-gold b.crown{filter:drop-shadow(0 1px 0 rgba(255,240,196,.9)) drop-shadow(0 -.5px 0 rgba(110,60,0,.5))}',
    // iron: nothing won. Blank, dull, with a light rim so it still reads on the dark panel.
    '.dse-coin.m-iron{background:linear-gradient(180deg,rgba(255,246,232,.34),rgba(255,246,232,0) 42%,rgba(0,0,0,0) 58%,rgba(0,0,0,.5)),' +
      'repeating-conic-gradient(#80776c 0deg 2.6deg,#3e3831 2.6deg 6deg);' +
      'box-shadow:0 0 0 1px rgba(255,240,220,.22),0 9px 14px -4px rgba(0,0,0,.66),0 2px 3px rgba(0,0,0,.36)}',
    '.dse-coin.m-iron>span{background:radial-gradient(circle at 38% 20%,#6b6359 0%,#544d45 40%,#423c35 78%,#37322c 100%);' +
      'box-shadow:0 0 0 1.5px #91887b,0 0 0 2.5px rgba(0,0,0,.55),inset 0 1.5px 1px rgba(255,246,232,.16),inset 0 -1.5px 2px rgba(0,0,0,.38)}',
    '.dse-coin.m-iron>span:before{border-color:rgba(222,208,188,.26)}',
    // landing: gold turns once and lands with one glint; iron just drops into place
    '.dse-card.in .m-gold{animation:dse-strike .42s cubic-bezier(.22,.8,.3,1) .04s both}',
    '.dse-card.in .m-iron{animation:dse-drop .3s cubic-bezier(.3,.9,.4,1) .06s both}',
    '.dse-card.in .m-gold>span:after{content:"";position:absolute;inset:0;border-radius:50%;' +
      'background:linear-gradient(110deg,rgba(255,255,255,0) 36%,rgba(255,252,236,.8) 50%,rgba(255,255,255,0) 64%);' +
      'transform:translateX(-110%);animation:dse-glint .2s ease-out .28s both}',
    '@keyframes dse-strike{0%{opacity:0;transform:perspective(300px) translateY(-10px) scale(1.12) rotateY(-360deg)}' +
      '22%{opacity:1}' +
      '72%{transform:perspective(300px) translateY(0) scale(.95) rotateY(0deg)}' +
      '100%{opacity:1;transform:perspective(300px) translateY(0) scale(1) rotateY(0deg)}}',
    '@keyframes dse-drop{0%{opacity:0;transform:translateY(-10px) scale(1.08)}65%{opacity:1;transform:translateY(0) scale(.97)}' +
      '100%{opacity:1;transform:none}}',
    '@keyframes dse-glint{from{transform:translateX(-110%)}to{transform:translateX(110%)}}',

    // the result: the verdict, then the figure with its unit on the same line
    '.dse-v{font-size:15px;font-weight:600;color:var(--dse-tx2);overflow-wrap:anywhere}',
    '.dse-hero{display:flex;flex-wrap:wrap;justify-content:center;align-items:baseline;column-gap:9px;margin-top:2px}',
    '.dse-big{min-width:0;font:600 52px/1.08 ' + MONO + ';letter-spacing:-.03em;' +
      'font-variant-numeric:tabular-nums;color:var(--dse-tx);overflow-wrap:anywhere}',
    '.dse.t-win .dse-big{color:var(--dse-gold);background:linear-gradient(180deg,#ffdc8f 12%,#f3ad35 58%,#d98d18 100%);' +
      '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
    '.dse.t-loss .dse-big{color:var(--dse-loss)}',
    '.dse-cur{font-size:.5em;vertical-align:.7em;margin-right:.05em;letter-spacing:0}',
    '.dse-suf{font-size:.42em;vertical-align:.98em;margin-left:.06em;letter-spacing:0}',
    '.dse-unit{font-size:15px;font-weight:500;color:var(--dse-tx2)}',
    '.dse-pod{margin:14px 0 0;text-align:left}',
    '.dse-pod li{display:flex;align-items:baseline;gap:12px;padding:8px 10px;font-size:15px;color:var(--dse-tx2);' +
      'border-top:1px solid var(--dse-line);overflow-wrap:anywhere}',
    '.dse-pod li:first-child{border-top-color:transparent}',
    '.dse-pod li i{font:600 13px ' + MONO + ';font-style:normal;color:var(--dse-tx3);width:14px;flex:0 0 auto}',
    '.dse-pod li.me{color:var(--dse-tx);font-weight:650;border-radius:8px;border-top-color:transparent;' +
      'background:rgba(240,168,48,.1);box-shadow:inset 0 0 0 1px rgba(240,168,48,.24)}',
    '.dse-pod li.me+li{border-top-color:transparent}',
    '.dse-pod li.me i{color:var(--dse-gold)}',
    '.dse-facts{display:flex;margin:17px 0 0}',
    '.dse-facts>div{display:flex;flex-direction:column-reverse;flex:1 1 0;min-width:0;padding:0 6px}',
    '.dse-facts>div+div{border-left:1px solid var(--dse-line)}',
    '.dse-facts dt{margin-top:1px;font-size:12.5px;color:var(--dse-tx3)}',
    '.dse-facts dd{font:600 17px ' + MONO + ';font-variant-numeric:tabular-nums;color:var(--dse-tx);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

    // the money: what moved and where it is going, recessed under the result; the net row reads biggest
    '.dse-tray{margin:16px 0 0;padding:5px 14px;border-radius:10px;background:rgba(8,7,5,.42);' +
      'box-shadow:inset 0 0 0 1px rgba(245,241,232,.06);text-align:left}',
    '.dse-lr{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:6px 0;font-size:15px;color:var(--dse-tx2)}',
    '.dse-lr b{font:500 15.5px ' + MONO + ';font-variant-numeric:tabular-nums;color:var(--dse-tx);white-space:nowrap}',
    '.dse-lr.net{margin-top:2px;padding-top:9px;border-top:1px solid var(--dse-line);color:var(--dse-tx);font-weight:650}',
    '.dse-lr.net b{font-weight:600;font-size:20px;line-height:1.1}',
    '.dse.t-win .dse-lr.net b{color:var(--dse-gold)}',
    '.dse.t-loss .dse-lr.net b{color:var(--dse-loss)}',
    '.dse-st{display:flex;align-items:center;flex-wrap:wrap;column-gap:9px;row-gap:2px;padding:9px 0 8px;font-size:14px;' +
      'color:var(--dse-tx2);border-top:1px solid var(--dse-line)}',
    '.dse-st:first-child{border-top:0}',
    '.dse-st i{position:relative;flex:0 0 auto;width:8px;height:8px;margin:0 3px;border-radius:50%;background:var(--dse-gold);' +
      'animation:dse-breathe 1.4s ease-in-out infinite}',
    // sent: a pulsing green dot (Owen 2026-10-16, his one green: the lobby's live dot, --live #8ed081), for everyone
    '.dse-st.ok{color:var(--dse-tx)}',
    '.dse-st.ok i{width:9px;height:9px;background:#8ed081;animation:none;box-shadow:0 0 7px rgba(142,208,129,.55)}',
    '.dse-st.ok i:after{content:"";position:absolute;inset:0;border-radius:50%;background:#8ed081;' +
      'animation:dse-ping 1.6s cubic-bezier(0,0,.2,1) infinite}',
    '@keyframes dse-ping{0%{transform:scale(1);opacity:.75}80%,100%{transform:scale(2.7);opacity:0}}',
    '.dse-st.err{color:#ff8a78}',
    '.dse-st.err i{background:var(--dse-loss);animation:none}',
    '.dse-st a{margin-left:auto;color:var(--dse-tx);font-weight:650;text-decoration:underline;' +
      'text-decoration-color:rgba(240,168,48,.65);text-underline-offset:3px}',
    '.dse-st a:hover{color:var(--dse-gold)}',
    '.dse-st[data-chg] i{animation:dse-pop .28s cubic-bezier(.25,1,.5,1) both}',
    '.dse-st[data-chg] a{animation:dse-fade .22s ease-out both}',
    '@keyframes dse-breathe{0%,100%{opacity:.4;transform:scale(.75)}50%{opacity:1;transform:scale(1)}}',
    '@keyframes dse-pop{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:none}}',
    '@keyframes dse-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}',
    '.dse-note{font-size:14px;color:var(--dse-tx2);margin:12px 0 0;overflow-wrap:anywhere}',
    // a notice (no figure: a refusal, a closed room) reads as a short message
    '.dse-card.notice .dse-v{font-size:19px;font-weight:650;color:var(--dse-tx)}',
    '.dse-card.notice .dse-note{margin-top:8px;font-size:14.5px}',

    // buttons: always one row, the next step (bone) widest, quiet outlines for the rest
    '.dse-btns{display:flex;gap:8px;margin-top:16px}',
    '.dse-btn{flex:1 1 0;min-width:0;height:52px;border:0;border-radius:10px;padding:0 10px;font:650 15px ' + SANS + ';cursor:pointer;' +
      'background:rgba(245,241,232,.05);color:var(--dse-tx);box-shadow:inset 0 0 0 1px rgba(245,241,232,.16);' +
      'line-height:1.15;touch-action:manipulation;-webkit-user-select:none;user-select:none}',
    '.dse-btn:hover{background:rgba(245,241,232,.1)}',
    '.dse-btn em{font:600 .95em ' + MONO + ';font-style:normal;letter-spacing:-.01em;white-space:nowrap}',
    '.dse-btn.pri{flex-grow:1.75;font-size:16px;background:var(--dse-bone);color:var(--dse-ink);' +
      'box-shadow:inset 0 -2px 0 rgba(16,14,11,.12),0 6px 16px rgba(0,0,0,.28)}',
    '.dse-btns.n3 .dse-btn{padding:0 8px}.dse-btns.n3 .dse-btn.pri{flex-grow:1.6}',
    '.dse-btns.n4{flex-wrap:wrap}.dse-btns.n4 .dse-btn.pri{flex:1 1 100%}',
    '.dse-btn.pri:hover{background:#fffaf0}',
    '.dse-btn:disabled{cursor:default;opacity:.42}',
    '.dse-btn:disabled:hover{background:rgba(245,241,232,.05)}',
    // a disabled next step is a wait (next match, wallet, starting): it stays the main thing, in gold
    '.dse-btn.pri:disabled,.dse-btn.pri:disabled:hover{opacity:1;background:rgba(240,168,48,.1);color:var(--dse-gold);' +
      'box-shadow:inset 0 0 0 1px rgba(240,168,48,.42)}',
    '.dse-btn:focus-visible{outline:2px solid var(--dse-gold);outline-offset:2px}',
    '.dse-panel>.dse-btns:first-child{margin-top:0}',

    // a computer: the same card a size up, centred
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dse{align-items:center;padding:16px}' +
      '.dse-scrim{background:rgba(16,14,11,.58)}' +
      '.dse-card{width:416px}.dse-card.coined{padding-top:30px}' +
      '.dse-panel{padding:24px 26px 24px}.dse-card.coined .dse-panel{padding-top:60px}' +
      '.dse-card.g-gold .dse-panel{background:radial-gradient(200px 110px at 50% 0,rgba(240,168,48,.15),rgba(240,168,48,0)),' + PANEL_BG + '}' +
      '.dse-coin{width:80px;height:80px;margin-left:-40px;padding:7px}.dse-coin>span:before{inset:4.5px}' +
      '.dse-coin b{font-size:34px}.dse-coin b.crown{width:30px;height:24px}' +
      '.dse-big{font-size:62px}.dse-v{font-size:16px}.dse-unit{font-size:16px}' +
      '.dse-facts{margin-top:19px}.dse-facts dd{font-size:18px}.dse-btn{height:54px}}',

    // a paid loss and a free game (Owen 2026-10-16, his picks "Coin falls away" and "Free"): an empty slot on the
    // card's top edge whose coin falls away as the card arrives (gold with its $ when money was lost, silver with a
    // star in a free game), the stats as rows in the recessed tray like the cash-out's money, the figure alone and
    // centred (the red amount lost, or Free)
    '.dse-coin.m-slot{background:rgba(8,7,5,.6);box-shadow:inset 0 3px 8px rgba(0,0,0,.7),0 0 0 1px rgba(245,241,232,.22)}',
    '.dse-coin.m-slot>span{border:1.5px dashed rgba(245,241,232,.38)}',
    '.dse-coin.m-slot>span:before{display:none}',
    '.dse-coin.m-slot.s-red{box-shadow:inset 0 3px 8px rgba(0,0,0,.7),0 0 0 1px rgba(255,107,87,.3)}',
    '.dse-coin.m-slot.s-red>span{border-color:rgba(255,107,87,.5)}',
    '.dse-card.in .dse-coin.m-slot{animation:dse-drop .3s cubic-bezier(.3,.9,.4,1) .06s both}',
    '.dse-ghost{position:absolute;inset:6px;display:flex;align-items:center;justify-content:center;border-radius:50%;opacity:0;' +
      'background:radial-gradient(circle at 38% 20%,#ffefbc 0%,#fad06c 28%,#eeaa39 62%,#c98612 100%);box-shadow:0 0 0 1.5px #f9d98c,0 0 18px rgba(240,168,48,.45)}',
    '.dse-ghost b{color:#9a5e06;text-shadow:0 1px 0 rgba(255,240,196,.9)}',
    '.dse-ghost.g-silver{background:radial-gradient(circle at 38% 20%,#ffffff 0%,#eceff3 28%,#c3c9d1 62%,#959ca7 100%);' +
      'box-shadow:0 0 0 1.5px #f2f4f7,0 0 16px rgba(220,230,244,.35)}',
    '.dse-ghost.g-silver b{color:#5d6570;text-shadow:none;filter:drop-shadow(0 1px 0 rgba(255,255,255,.9))}',
    '.dse-card.in .dse-ghost{animation:dse-fall .66s cubic-bezier(.5,0,.75,0) .22s both}',
    '@keyframes dse-fall{0%{opacity:1;transform:none}100%{opacity:0;transform:translateY(40px) rotate(24deg) scale(.82)}}',
    '.dse-coin b.star{width:22px;height:21px}',
    '.dse-coin b.star:before{content:"";position:absolute;inset:0;background:currentColor;' +
      '-webkit-clip-path:polygon(50% 0,61.8% 35.1%,98.1% 35.1%,68.7% 56.7%,79.4% 91%,50% 70%,20.6% 91%,31.3% 56.7%,1.9% 35.1%,38.2% 35.1%);' +
      'clip-path:polygon(50% 0,61.8% 35.1%,98.1% 35.1%,68.7% 56.7%,79.4% 91%,50% 70%,20.6% 91%,31.3% 56.7%,1.9% 35.1%,38.2% 35.1%)}',
    '.dse-card.g-slot .dse-panel{background:radial-gradient(170px 96px at 50% 0,rgba(245,241,232,.06),rgba(245,241,232,0)),' + PANEL_BG + '}',
    '.dse-card.g-slot.s-red .dse-panel{background:radial-gradient(170px 96px at 50% 0,rgba(255,107,87,.11),rgba(255,107,87,0)),' + PANEL_BG + '}',
    '.dse.k-free .dse-big{color:#d9d1c3}',
    // the stats as tray rows: the same dl, laid out like the money rows
    '.dse-facts.rows{display:block;margin:0}',
    '.dse-facts.rows>div{flex-direction:row;justify-content:space-between;align-items:baseline;gap:12px;padding:6px 0}',
    '.dse-facts.rows>div+div{border-left:0}',
    '.dse-facts.rows dt{margin:0;font-size:15px;color:var(--dse-tx2)}',
    '.dse-facts.rows dd{font-size:15.5px}',
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dse-coin b.star{width:28px;height:27px}.dse-facts.rows dd{font-size:15.5px}' +
      '.dse-card.g-slot .dse-panel{background:radial-gradient(200px 110px at 50% 0,rgba(245,241,232,.06),rgba(245,241,232,0)),' + PANEL_BG + '}' +
      '.dse-card.g-slot.s-red .dse-panel{background:radial-gradient(200px 110px at 50% 0,rgba(255,107,87,.11),rgba(255,107,87,0)),' + PANEL_BG + '}}',
    // the board: fully clear (Owen 2026-10-16), text with a shadow, your row on a gold pill. Compact on a phone
    // (Owen: it never takes a big part of the screen): 11.5 px rows 16 px apart, names cut at about 10 characters.
    '.dsb{position:fixed;top:8px;right:8px;width:128px;pointer-events:none;color:#f5f1e8;font:600 11.5px ' + SANS + ';' +
      'text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 2px #000;-webkit-text-size-adjust:100%;line-height:1.3;text-align:left}',
    '.dsb p,.dsb ol{margin:0;padding:0;list-style:none}',
    '.dsb-t{font-size:10.5px;color:rgba(245,241,232,.75);margin:0 0 1px 1px}',
    '.dsb li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:4px;align-items:baseline;line-height:16px;padding:0 4px;margin:0 -3px}',
    '.dsb li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:10ch}',
    '.dsb li i{font-style:normal;font-family:' + MONO + ';font-size:10.5px;color:rgba(245,241,232,.7)}',
    '.dsb li b{font:600 11px ' + MONO + ';font-variant-numeric:tabular-nums}',
    '.dsb.money li b{color:#f0a830}',
    '.dsb li.me{background:linear-gradient(180deg,#ffd982,#eba232);color:#100e0b;border-radius:5px;text-shadow:none;font-weight:700;' +
      'box-shadow:inset 0 1px 0 rgba(255,248,222,.65),0 1px 3px rgba(0,0,0,.35)}',
    '.dsb li.me i{color:rgba(16,14,11,.62)}',
    '.dsb li.me b,.dsb.money li.me b{color:#100e0b}',
    '.dsb li.gap{height:5px}',
    // a light map: ink text and a white halo; your row keeps its gold pill
    '.dsb.light{color:#100e0b;text-shadow:0 0 2px #fff,0 0 3px #fff,0 1px 1px rgba(255,255,255,.9)}',
    '.dsb.light .dsb-t,.dsb.light li i{color:rgba(16,14,11,.7)}',
    '.dsb.light.money li b{color:#8a5600}',
    '.dsb.light li.me{text-shadow:none;box-shadow:inset 0 1px 0 rgba(255,248,222,.65),0 0 0 1px rgba(122,74,6,.35)}',
    '.dsb.light li.me i{color:rgba(16,14,11,.62)}',
    '.dsb.light li.me b,.dsb.light.money li.me b{color:#100e0b}',
    // a computer: a little more room, still small
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dsb{width:196px;font-size:13.5px;top:14px;right:14px}' +
      '.dsb-t{font-size:12px;margin-bottom:3px}' +
      '.dsb li{grid-template-columns:20px minmax(0,1fr) auto;gap:6px;line-height:21px;padding:0 6px;margin:0 -4px}' +
      '.dsb li span{max-width:14ch}.dsb li i{font-size:11.5px}.dsb li b{font-size:12.5px}' +
      '.dsb li.me{border-radius:6px}.dsb li.gap{height:7px}}'
  ].join('\n');

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var head = doc.head || doc.body;
    if (!doc.querySelector || !doc.querySelector('link[data-dse-font]')) {
      var l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = FONT_HREF;
      l.setAttribute('data-dse-font', '1');
      head.appendChild(l);
    }
    var s = doc.createElement('style');
    s.setAttribute('data-dse', '1');
    s.textContent = CSS;
    head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  // [label, value] or { k, v }
  function pair(x) {
    if (x && typeof x === 'object' && !Array.isArray(x)) return [x.k != null ? x.k : x.label, x.v != null ? x.v : x.value];
    return Array.isArray(x) ? x : [String(x), ''];
  }
  // Clicks and touches on our nodes never reach the game under them (steering, boost, split).
  function guard(node) {
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'wheel', 'contextmenu'].forEach(function (t) {
      node.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true });
    });
  }

  // Classes a game put on our node (slxCard marks it slx-card) survive a re-render; ours are rebuilt.
  function foreign(cls) {
    return String(cls || '').split(/\s+/).filter(function (c) { return c && !/^(dse|t-)/.test(c); });
  }

  var MONEY_RE = /^([−-]?)\$(.+)$/;         // '$2.16', '−$1.00'
  var ORD_RE = /^(\d+)(st|nd|rd|th)$/;       // '1st'

  // The big figure as text nodes: the $ set small (like the gold pellets' small $), an ordinal's suffix raised.
  function heroNode(text) {
    var big = el('span', 'dse-big');
    var m = MONEY_RE.exec(text), r = ORD_RE.exec(text);
    if (m) {
      if (m[1]) big.appendChild(doc.createTextNode(m[1]));
      big.appendChild(el('span', 'dse-cur', '$'));
      big.appendChild(doc.createTextNode(m[2]));
    } else if (r) {
      big.appendChild(doc.createTextNode(r[1]));
      big.appendChild(el('span', 'dse-suf', r[2]));
    } else {
      big.textContent = text;
    }
    return big;
  }

  // The coin on the card's top edge. Gold when something comes to you: a win, or money back (a refund in plain tone);
  // its face shows $ for money, else a crown (a battle royale place, a free win). Iron, blank, for everything else
  // (a loss, a free death): the figure under it says what happened, the coin never looks like a reward.
  function coinMetal(o) {
    var money = String(o.hero).indexOf('$') >= 0;
    return o.tone === 'win' || (o.tone !== 'loss' && money) ? 'gold' : 'iron';
  }
  // What the card is: money lost ('loss'), a free game ('free': a plain card whose figure is a score, not money, and
  // not a battle royale podium), else money won or back or a place ('paid': the gold coin, or iron).
  function kindOf(o) {
    if (o.tone === 'loss') return 'loss';
    var hero = o.hero != null ? String(o.hero) : '';
    if (o.tone !== 'win' && hero && hero.indexOf('$') < 0 && !(o.podium && o.podium.length)) return 'free';
    return 'paid';
  }
  // A free game's card (Owen: "Free" as the figure): its score goes first in the tray, under its unit's name.
  function freeCard(o) {
    var c = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) c[k] = o[k];
    var u = String(o.unit || 'Score');
    var facts = o.facts || [];
    // a duel already lists its count (Turns 4): never the same figure twice
    var listed = facts.some(function (f) { return String(pair(f)[1]) === String(o.hero); });
    c.facts = listed ? facts : [[u.charAt(0).toUpperCase() + u.slice(1), String(o.hero)]].concat(facts);
    c.hero = 'Free';
    c.unit = '';
    return c;
  }
  // The empty slot of a loss or a free game, and the coin that falls out of it (gold with $, or silver with a star).
  function slotNode(kind) {
    var slot = el('div', 'dse-coin m-slot' + (kind === 'loss' ? ' s-red' : ''));
    slot.setAttribute('aria-hidden', 'true');
    slot.appendChild(el('span'));
    var ghost = el('i', 'dse-ghost' + (kind === 'free' ? ' g-silver' : ''));
    ghost.appendChild(kind === 'free' ? el('b', 'star') : el('b', null, '$'));
    slot.appendChild(ghost);
    return slot;
  }
  function coinNode(o) {
    var metal = coinMetal(o);
    var coin = el('div', 'dse-coin m-' + metal);
    coin.setAttribute('aria-hidden', 'true');
    var face = el('span');
    if (metal === 'gold') face.appendChild(String(o.hero).indexOf('$') >= 0 ? el('b', null, '$') : el('b', 'crown'));
    coin.appendChild(face);
    return coin;
  }

  // Button text with a trailing amount or clock ('Play again $1.00', 'Next match 0:12'): that part goes in the figures'
  // mono face.
  function buttonText(btn, text) {
    var m = /^(.*\S)\s+([−-]?\$[\d,.]+|\d{1,2}:\d{2})$/.exec(text);
    if (!m) { btn.textContent = text; return; }
    btn.appendChild(doc.createTextNode(m[1] + ' '));   // a narrow button breaks here, never inside the amount
    btn.appendChild(el('em', null, m[2]));
  }

  // ---- the card
  var card = null;        // { el, opts, btns, fresh, st }

  function render(o) {
    var kind = kindOf(o);
    if (kind === 'free') o = freeCard(o);
    var wrap = card.el;
    wrap.className = ['dse', 't-' + (o.tone === 'win' || o.tone === 'loss' ? o.tone : 'plain'), 'k-' + kind].concat(foreign(wrap.className)).join(' ');
    wrap.style.zIndex = String(o.z != null ? o.z : 1000);
    if (o.zoom && o.zoom !== 1) wrap.style.zoom = String(o.zoom); else wrap.style.zoom = '';
    var had = doc.activeElement && doc.activeElement.getAttribute && doc.activeElement.getAttribute('data-dse-btn');
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el('div', 'dse-scrim'));
    var hasHero = o.hero != null && o.hero !== '';
    // slides in once per show, not on every update
    var box = el('div', 'dse-card' + (hasHero ? ' coined ' + (kind === 'paid' ? 'g-' + coinMetal(o) : 'g-slot' + (kind === 'loss' ? ' s-red' : '')) : ' notice') + (card.fresh ? ' in' : ''));
    var panel = el('div', 'dse-panel');
    if (o.verdict) panel.appendChild(el('p', 'dse-v', o.verdict));
    if (hasHero) {
      var hero = el('p', 'dse-hero');
      hero.appendChild(heroNode(String(o.hero)));
      // money won or lost stands alone, centred (Owen: no "to your wallet"; the coin and the tray already say it)
      if (o.unit && !((o.tone === 'win' || o.tone === 'loss') && MONEY_RE.test(String(o.hero)))) hero.appendChild(el('span', 'dse-unit', o.unit));
      panel.appendChild(hero);
    }
    if (o.podium && o.podium.length) {
      var pod = el('ol', 'dse-pod');
      o.podium.forEach(function (p) {
        var li = el('li', p.me ? 'me' : '');
        li.appendChild(el('i', null, p.rank));
        li.appendChild(el('span', null, p.name));
        pod.appendChild(li);
      });
      panel.appendChild(pod);
    }
    var tray = el('div', 'dse-tray' + (o.ledger && o.ledger.length ? ' dse-led' : ''));
    var inTray = kind !== 'paid';
    if (o.facts && o.facts.length) {
      var dl = el('dl', 'dse-facts' + (inTray ? ' rows' : ''));
      o.facts.slice(0, inTray ? 4 : 3).forEach(function (f) {
        f = pair(f);
        var d = el('div');
        d.appendChild(el('dt', null, f[0]));
        d.appendChild(el('dd', null, f[1]));
        dl.appendChild(d);
      });
      (inTray ? tray : panel).appendChild(dl);
    }
    if (o.ledger && o.ledger.length) {
      o.ledger.forEach(function (r, i) {
        r = pair(r);
        var row = el('div', 'dse-lr' + (o.ledger.length > 1 && i === o.ledger.length - 1 ? ' net' : ''));
        row.appendChild(el('span', null, r[0]));
        row.appendChild(el('b', null, r[1]));
        tray.appendChild(row);
      });
    }
    var st = o.status && o.status.text ? (o.status.state === 'ok' || o.status.state === 'err' ? o.status.state : 'pending') : '';
    if (st) {
      // the dot pops only when the payout state changes under an open card
      var line = el('p', 'dse-st' + (st !== 'pending' ? ' ' + st : ''));
      if (!card.fresh && card.st && card.st !== st) line.setAttribute('data-chg', '1');
      line.appendChild(el('i'));
      line.appendChild(doc.createTextNode(String(o.status.text)));
      if (o.status.link && /^https:\/\//.test(String(o.status.link.href || ''))) {
        var a = el('a', null, o.status.link.text || 'View');
        a.href = o.status.link.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        line.appendChild(a);
      }
      tray.appendChild(line);
    }
    card.st = st;
    if (tray.firstChild) panel.appendChild(tray);
    (o.notes || []).forEach(function (n) { if (n) panel.appendChild(el('p', 'dse-note', n)); });
    card.btns = {};
    var list = (o.buttons || []).filter(function (b) { return b && b.text; });
    if (list.length) {
      // one row in every game: the next step keeps the same spot under the thumb
      // four or more: the next step on its own row, the others sharing the row under it
      var btns = el('div', 'dse-btns' + (list.length > 3 ? ' n4' : list.length > 2 ? ' n3' : ''));
      list.forEach(function (b) {
        var btn = el('button', 'dse-btn' + (b.primary ? ' pri' : ''));
        buttonText(btn, String(b.text));
        btn.type = 'button';
        if (b.id) btn.setAttribute('data-dse-btn', b.id);
        btn.disabled = !!b.disabled;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (btn.disabled || typeof b.onClick !== 'function') return;
          b.onClick(e);
        });
        btns.appendChild(btn);
        if (b.id) card.btns[b.id] = btn;
      });
      panel.appendChild(btns);
    }
    box.appendChild(panel);
    if (hasHero) box.appendChild(kind === 'paid' ? coinNode(o) : slotNode(kind));
    wrap.appendChild(box);
    if (had && card.btns[had] && card.btns[had].focus) card.btns[had].focus();
  }

  function lastKid(n) { return n.lastChild || (n.children && n.children[n.children.length - 1]) || null; }
  // A card taller than the window (a phone on its side) is scaled down to fit, never cut off.
  function fit(box) {
    if (!box || !box.style) return;
    box.style.zoom = '';
    if (typeof box.getBoundingClientRect !== 'function') return;
    var h = box.getBoundingClientRect().height;
    // the room inside the card's own padding (a phone keeps a little more under the card for the home bar)
    var pad = 24;
    try {
      var cs = root.getComputedStyle(box.parentNode);
      pad = Math.max(24, (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0));
    } catch (_) {}
    var avail = (root.innerHeight || 0) - pad;
    if (h > 0 && avail > 0 && h > avail) box.style.zoom = String(Math.max(0.5, avail / h));
  }

  function show(o) {
    style();
    o = o || {};
    if (!card) {
      var wrap = el('div', 'dse');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-live', 'polite');
      guard(wrap);
      card = { el: wrap, opts: {}, btns: {}, st: '' };
    }
    card.opts = o;
    card.fresh = !shown();
    render(o);
    var parent = o.root || doc.body;
    if (card.el.parentNode !== parent) parent.appendChild(card.el);
    card.el.style.display = '';
    card.el.style.opacity = '';
    fit(lastKid(card.el));
    return handle;
  }
  var handle = {
    update: function (partial) {
      if (!card) return handle;
      var o = {}, k;
      for (k in card.opts) if (Object.prototype.hasOwnProperty.call(card.opts, k)) o[k] = card.opts[k];
      for (k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) o[k] = partial[k];
      card.opts = o;
      card.fresh = false;
      render(o);
      fit(lastKid(card.el));
      return handle;
    },
    hide: function () { hide(); },
    button: function (id) { return card && card.btns[id] || null; },
    opacity: function (x) { if (card) card.el.style.opacity = String(Math.max(0, Math.min(1, x))); },
    get el() { return card && card.el; }
  };
  function hide() {
    if (card && card.el.parentNode) card.el.parentNode.removeChild(card.el);
  }
  function shown() { return !!(card && card.el.parentNode); }

  // ---- the board
  function phone() {
    try { return root.matchMedia ? root.matchMedia('(max-width:' + PHONE_MAX + 'px)').matches : (root.innerWidth || 1000) <= PHONE_MAX; }
    catch (_) { return false; }
  }
  function board(opts) {
    style();
    opts = opts || {};
    var node = el('div', 'dsb' + (opts.money ? ' money' : '') + (opts.light ? ' light' : ''));
    node.setAttribute('aria-label', opts.title || 'Leaderboard');
    node.style.zIndex = String(opts.z != null ? opts.z : 900);
    if (opts.zoom && opts.zoom !== 1) node.style.zoom = String(opts.zoom);
    if (opts.top != null) node.style.top = opts.top + 'px';
    if (opts.right != null) node.style.right = opts.right + 'px';
    node.appendChild(el('p', 'dsb-t', opts.title || 'Leaderboard'));
    var ol = el('ol');
    node.appendChild(ol);
    (opts.root || doc.body).appendChild(node);
    var last = '';
    var b = {
      el: node,
      set: function (rows, me) {
        rows = Array.isArray(rows) ? rows : [];
        var n = phone() ? (opts.rowsPhone || 5) : (opts.rowsPC || 10);
        var shownRows = rows.slice(0, n);
        var mine = shownRows.some(function (r) { return r && r.me; });
        var out = shownRows.map(function (r, i) {
          return [r.rank != null ? r.rank : i + 1, r.name == null ? '' : String(r.name), r.value == null ? '' : String(r.value), !!r.me];
        });
        if (!mine && me && me.rank > 0) {
          // ranks skipped since the last row shown: a small space, never a "…" row; right after it, nothing between
          var lastRank = out.length ? Number(out[out.length - 1][0]) || out.length : 0;
          if (me.rank > lastRank + 1) out.push(null);
          out.push([me.rank, me.name == null ? '' : String(me.name), me.value == null ? '' : String(me.value), true]);
        }
        var key = JSON.stringify(out) + n;
        if (key === last) return;
        last = key;
        while (ol.firstChild) ol.removeChild(ol.firstChild);
        out.forEach(function (r) {
          var li;
          if (!r) {
            li = el('li', 'gap');
            li.setAttribute('aria-hidden', 'true');
          } else {
            li = el('li', r[3] ? 'me' : '');
            li.appendChild(el('i', null, r[0]));
            li.appendChild(el('span', null, r[1]));
            li.appendChild(el('b', null, r[2]));
          }
          ol.appendChild(li);
        });
      },
      show: function () { node.style.display = ''; },
      hide: function () { node.style.display = 'none'; },
      destroy: function () { if (node.parentNode) node.parentNode.removeChild(node); }
    };
    return b;
  }

  // ---- the hold-to-cash-out ring (Owen 2026-10-16, his pick "Three Count" over the old green ring: "nothing else in
  // my game is green"). One ring for every game that holds to cash out (slither.io slxHold, agar.io agRender, Paper.io
  // paperHud): the 3 s hold as three gold seconds, so it shows the time left. A pale gold spark leads the fill, each
  // finished second flashes once, and when it is full the gaps close into one gold ring that breathes at the paid
  // money's 1.2 s pace. The track is warm ink, never grey, so it never reads as a loading spinner; on a light map
  // (agar.io) a bronze edge keeps the gold readable on white. Display only: the server owns the hold and the cash-out.
  //   DSEnd.ring(ctx, x, y, r, p, t, o): ctx in the units given; x, y the centre; r the radius; p the hold 0..1;
  //   t a ms clock; o = { lw (line width), mobile (no shadowBlur: phones are slow), light (a light map), waiting (held,
  //   the server has not confirmed yet), since (ms since p reached 1, for the one-shot finish; left out, settled) }.
  // No allocations per frame beyond the path; shadowBlur only when !o.mobile.
  var R_PI2 = Math.PI * 2;
  var R_TOP = -Math.PI / 2;
  var R_SEG = R_PI2 / 3;
  var R_BRONZE = 'rgba(64,38,6,0.72)';        // the warm dark edge under the gold
  var R_GOLD = '#f5b335';
  var R_GOLD_HI = '#ffd76e';
  var R_SPARK = '#ffeaa8';                    // pale gold, never white
  var R_SPARK_LIGHT = '#ffd25e';              // a deeper gold tip on a light map (with the bronze edge)
  var R_FLASH = '#fff1cc';                    // bone-gold flash on a dark map
  var R_FLASH_LIGHT = '#ffd04a';              // the flash on a light map, where cream would vanish
  var R_NONE = {};
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeOut(v) { v = 1 - v; return 1 - v * v * v; }
  // Seconds i0..i1 (second i from 12 o'clock clockwise), each trimmed by the gap (radians), the last filled to q.
  function segPath(ctx, x, y, r, gap, i0, i1, q) {
    ctx.beginPath();
    if (gap === 0 && i0 === 0 && i1 === 2 && q >= 1) { ctx.arc(x, y, r, 0, R_PI2); return; }   // closed: no seams
    for (var i = i0; i <= i1; i++) {
      var a0 = R_TOP + i * R_SEG + gap / 2;
      var a1 = R_TOP + (i + 1) * R_SEG - gap / 2;
      var f = i === i1 ? q : 1;
      if (!(f > 0)) continue;
      ctx.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0));
      ctx.arc(x, y, r, a0, a0 + (a1 - a0) * f);
    }
  }
  function ring(ctx, x, y, r, p, t, o) {
    if (!ctx || !(r > 0)) return;
    o = o || R_NONE;
    t = Number(t) || 0;
    var lw = o.lw > 0 ? o.lw : r * 0.16;
    if (lw < 2.5) lw = 2.5;
    var light = !!o.light;
    var glow = !o.mobile;
    p = clamp01(Number(p) || 0);
    var full = p >= 1 && !o.waiting;
    var since = full ? (o.since >= 0 ? o.since : 1e9) : 0;
    // the gap between seconds on the ring's centre line (at least 4 px, so 1-2-3 reads on a phone); it closes over
    // 240 ms at the finish
    var gap = Math.max(4, lw * 0.85) / r;
    if (full) gap *= 1 - easeOut(clamp01(since / 240));
    if (gap < 0.0005) gap = 0;

    ctx.save();
    ctx.lineCap = 'butt';
    // the track: a warm ink groove on a dark map, a faint dark band on a light one
    segPath(ctx, x, y, r, gap, 0, 2, 1);
    if (light) {
      ctx.strokeStyle = 'rgba(16,14,11,0.12)';
      ctx.lineWidth = lw + 2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(16,14,11,0.16)';
      ctx.lineWidth = lw;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(16,14,11,0.3)';
      ctx.lineWidth = lw + 2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(40,34,25,0.58)';
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(244,224,180,0.12)';
      ctx.lineWidth = Math.max(1, lw * 0.35);
      ctx.stroke();
    }
    if (o.waiting) {
      // pressed, not confirmed yet: the three seconds light in turn, like a count waiting to start
      for (var w = 0; w < 3; w++) {
        var ph = ((t / 260) - w) % 3;
        if (ph < 0) ph += 3;
        var a = ph < 1 ? Math.sin(ph * Math.PI) : 0;
        segPath(ctx, x, y, r, gap, w, w, 1);
        ctx.globalAlpha = light ? 0.3 + 0.7 * a : 0.2 + 0.8 * a;
        ctx.strokeStyle = light ? '#c8841a' : R_GOLD;
        ctx.lineWidth = lw;
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    if (p > 0) {
      var k = p * 3;
      var last = full ? 2 : Math.min(2, Math.floor(k));
      var q = full ? 1 : k - last;
      // the warm dark edge under the gold, then the gold with its glow
      segPath(ctx, x, y, r, gap, 0, last, q);
      if (light || !glow) {
        ctx.strokeStyle = R_BRONZE;
        ctx.lineWidth = lw + 2.5;
        ctx.stroke();
      }
      if (glow) {
        ctx.shadowColor = light ? 'rgba(200,132,26,0.45)' : 'rgba(255,184,56,0.7)';
        ctx.shadowBlur = lw * (light ? 0.9 : 1.6);
      } else {
        // phones: a wide soft stroke stands in for the blur
        ctx.strokeStyle = 'rgba(255,190,60,0.22)';
        ctx.lineWidth = lw * 2.1;
        ctx.stroke();
      }
      ctx.strokeStyle = R_GOLD;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'rgba(0,0,0,0)';
      // each finished second flashes for about 150 ms
      for (var s = 0; s < 2 && !full; s++) {
        var age = k - (s + 1);
        if (!(age >= 0 && age < 0.45)) continue;
        var fl = 1 - age / 0.45;
        segPath(ctx, x, y, r, gap, s, s, 1);
        ctx.globalAlpha = 0.85 * fl * fl;
        ctx.strokeStyle = light ? R_FLASH_LIGHT : R_FLASH;
        ctx.lineWidth = lw * (1 + 0.2 * fl);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (!full) {
        // the leading spark: a brighter stretch of gold behind it and a pale gold dot on the tip
        var b0 = R_TOP + last * R_SEG + gap / 2;
        var b1 = R_TOP + (last + 1) * R_SEG - gap / 2;
        var ah = b0 + (b1 - b0) * q;
        var tail = Math.min(ah - b0, (lw * 3.2) / r);
        if (tail > 0) {
          ctx.beginPath();
          ctx.arc(x, y, r, ah - tail, ah);
          ctx.strokeStyle = R_GOLD_HI;
          ctx.lineWidth = lw;
          ctx.stroke();
        }
        var hx = x + r * Math.cos(ah);
        var hy = y + r * Math.sin(ah);
        var sr = Math.max(lw * 0.66, 2.2);
        if (glow) {
          ctx.shadowColor = light ? 'rgba(190,120,20,0.7)' : 'rgba(255,214,110,0.95)';
          ctx.shadowBlur = lw * (light ? 1.4 : 2.4);
        } else if (!light) {
          ctx.beginPath();
          ctx.arc(hx, hy, sr * 1.6, 0, R_PI2);
          ctx.fillStyle = 'rgba(255,214,110,0.35)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(hx, hy, sr, 0, R_PI2);
        ctx.fillStyle = light ? R_SPARK_LIGHT : R_SPARK;
        ctx.fill();
        ctx.shadowBlur = 0;
        if (light) {
          ctx.strokeStyle = R_BRONZE;
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }
      } else {
        // full: the closed ring flashes bone-gold, then breathes softly
        var fl2 = 1 - clamp01(since / 420);
        var br = 0.5 - 0.5 * Math.cos((t / 1200) * R_PI2);
        var hi = Math.max(0.85 * fl2 * fl2, 0.18 * br);
        if (hi > 0.01) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, R_PI2);
          ctx.globalAlpha = hi;
          ctx.strokeStyle = light ? R_FLASH_LIGHT : R_FLASH;
          ctx.lineWidth = lw * (1 + 0.25 * fl2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();
  }

  // ---- formatting (the games' own numbers in, text out)
  function usd(micro, sign) {
    var n = Math.round(Number(micro) || 0);
    var neg = n < 0 || sign === '-';
    var a = Math.abs(n) / 1e6;
    return (neg && a > 0 ? '−' : '') + '$' + a.toFixed(2);
  }
  function clock(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function int(n) {
    var v = Math.round(Number(n) || 0);
    return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, v < 0 ? '−' : '');
  }
  function ordinal(n) {
    var v = Math.round(Number(n) || 0);
    var t = v % 100, o = v % 10;
    return v + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }

  root.DSEnd = { version: 1, show: show, hide: hide, shown: shown, board: board, ring: ring,
    usd: usd, clock: clock, int: int, ordinal: ordinal, isPhone: phone };
})(typeof window !== 'undefined' ? window : null);
