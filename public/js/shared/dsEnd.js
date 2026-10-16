// DuelSeries shared end screens: ONE result card (death, cash-out, win) and ONE in-game leaderboard for every game
// (Owen 2026-10-16: "one cashout screen, one death screen and one leaderboard ... for all the games"). The look is
// "Lobby panel", Owen's pick A the same evening over the cream "Ticket" ("a little extra screen that pops up, not a
// ticket"): the card is a piece of the lobby (public/v2.html) popping up over the game, so every game reads as
// one product. Its surfaces, radii, buttons and money figures are the lobby's own: an s1 panel lit from its top edge
// by the lobby's warm pool of light, the result centred like the Wallet tab's balance, the figures in the tote-board
// mono, the net money row lit gold, the payout a quiet line with a plain receipt link, Play in the game screen's
// struck finish beside an outlined secondary, and the Events tab's podium for a battle royale. On a phone the card
// sits low, buttons under the thumb, the game left in view above it; on a computer it is centred.
// The board is fully clear, text only; your row takes the lobby's picked-rung colours (gold paid, bone free).
//
// Each game keeps its own logic and money flow and only maps its data in (a small adapter in the game's own files):
//   DSEnd.show(card)  -> the card on screen (replaces the one showing). card:
//     tone     'plain' | 'win' | 'loss'          colours the big figure and the light behind it
//     verdict  'Killed by Kestrel'                the line above the big figure (the headline when there is none)
//     hero     '$2.16' | '1,284' | '1st'          the big figure; unit: the words under it ('to your wallet')
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
//     rows: [{ name, value, me }] in rank order; me: { rank, name, value } (pinned under the list when outside it)
//
// Display only. Every amount is a string the game formatted from the SERVER's own numbers (DSEnd.usd for micro-USDC);
// nothing here is ever read back for money. Player names go in as text, never markup.
//
// Motion plays for everyone, never behind prefers-reduced-motion (Owen's own Windows reports reduce, and gated motion
// was invisible to him): one rise when the card arrives, the money figure catching the light once on a win, and the
// status dot settling when a payout lands. The only thing that repeats is the pending dot's slow fade.
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;
  if (root.DSEnd && root.DSEnd.version) return;

  var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&family=IBM+Plex+Mono:wght@500;600&display=swap';
  var PHONE_MAX = 760;
  var MONO = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';

  var CSS = [
    // the lobby's tokens (v2.html :root), scoped to the card so a game's own variables never reach in or out
    '.dse{--ds-bg:#100e0b;--ds-s1:#17140f;--ds-s2:#1f1b15;--ds-s3:#282219;--ds-tx:#f5f1e8;--ds-tx2:#a89c8a;--ds-tx3:#8d8171;' +
      '--ds-bone:#f4f1ea;--ds-ink:#100e0b;--ds-money:#f0a830;--ds-loss:#f2705b;' +
      // the light on the panel: a pool from the top edge and a rim that catches it, gold on a win, ember on a loss
      '--ds-pool:rgba(244,241,234,.035);--ds-rim:#3a3226;--ds-halo:rgba(0,0,0,0)}',
    '.dse.t-win{--ds-pool:rgba(240,168,48,.2);--ds-rim:#6b4f22;--ds-halo:rgba(240,168,48,.13)}',
    '.dse.t-loss{--ds-pool:rgba(242,112,91,.075);--ds-rim:#4d2c22}',
    // the card
    '.dse{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;' +
      'font-family:Archivo,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ds-tx);' +
      '-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;text-align:center;line-height:1.35;' +
      '-webkit-font-smoothing:antialiased}',
    '.dse *{box-sizing:border-box}',
    // reset with no weight (:where), so each part's own margin below is the one that counts
    '.dse :where(p),.dse :where(ol),.dse :where(li),.dse :where(dl),.dse :where(dt),.dse :where(dd){margin:0;padding:0;list-style:none}',
    // darkest where the card sits, like the game screen's own backdrop, so the game survives at the edges
    '.dse-scrim{position:absolute;inset:0;background:radial-gradient(85% 70% at 50% 50%,rgba(10,9,7,.68),rgba(10,9,7,.42))}',
    // a lobby panel (s1, r3) lit from its top edge: the pool of light on the face, a rim brightest at the top fading
    // into the s3 hairline, and on a win a faint warm halo so it lifts off a dark map as clearly as off a white one
    '.dse-card{position:relative;width:344px;max-width:100%;padding:18px 16px 16px;border:1px solid transparent;border-radius:18px;' +
      'background:radial-gradient(120% 52% at 50% 0,var(--ds-pool),rgba(23,20,15,0) 78%) padding-box,' +
      'linear-gradient(var(--ds-s1),var(--ds-s1)) padding-box,' +
      'linear-gradient(180deg,var(--ds-rim),var(--ds-s3) 34%) border-box;' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 24px 60px rgba(0,0,0,.55),0 0 90px -18px var(--ds-halo)}',
    // the verdict, then the figure: centred like the Wallet tab's balance, the one thing the eye lands on
    '.dse-v{font-size:14.5px;font-weight:600;color:var(--ds-tx2);overflow-wrap:anywhere}',
    '.dse-hero{margin:4px 0 0}',
    '.dse-big{display:block;font-family:' + MONO + ';font-weight:600;font-size:48px;line-height:1.04;letter-spacing:-.045em;' +
      'font-variant-numeric:tabular-nums;color:var(--ds-tx);overflow-wrap:anywhere}',
    // money's small $, the way paid money is drawn in the games
    '.dse-cur{font-size:.52em;vertical-align:.62em;letter-spacing:0;margin:0 .04em 0 .02em}',
    // the words under the figure, one treatment for all of them ('to your wallet', 'lost', 'land', 'of 24')
    '.dse-unit{display:block;margin-top:3px;font-size:14px;font-weight:500;color:var(--ds-tx2)}',
    '.dse.t-win .dse-big{color:var(--ds-money);text-shadow:0 0 26px rgba(240,168,48,.22)}',
    '.dse.t-loss .dse-big{color:var(--ds-loss)}',
    // a notice with nothing to count (refused, match ended): the verdict is the headline
    '.dse-card.bare{padding-top:22px}',
    '.dse-card.bare .dse-v{font-size:20px;font-weight:650;letter-spacing:-.3px;color:var(--ds-tx)}',
    '.dse-card.bare .dse-note{font-size:14px;margin-top:8px}',
    // the battle royale podium, after the Events tab's: tallest in the middle, the heights are the ranking. Names stand
    // on the plinths and each plinth carries its place, so nothing stacks above the names; first wears a gold top
    // edge, your own seat a bone one, an empty seat is a dim plinth (never a gap)
    '.dse-pod{display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:end;column-gap:6px;margin:14px 0 0}',
    '.dse-pod:after{content:"";grid-column:1/-1;grid-row:2;height:2px;border-radius:2px;background:var(--ds-s3)}',
    '.dse-pod li{grid-row:1;min-width:0;display:flex;flex-direction:column-reverse}',   // the place first in reading order, drawn under the name
    '.dse-pod li.p1{grid-column:2}.dse-pod li.p2{grid-column:1}.dse-pod li.p3{grid-column:3}',
    '.dse-pn{min-height:20px;margin-bottom:7px;font-size:15px;font-weight:650;color:var(--ds-tx2);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dse-pod .p1 .dse-pn{min-height:23px;font-size:17px;color:var(--ds-tx)}',
    '.dse-pod .me .dse-pn{color:var(--ds-tx);font-weight:700}',
    '.dse-pb{display:flex;justify-content:center;height:42px;padding-top:7px;border-radius:10px 10px 0 0;' +
      'font:600 16px/1.2 ' + MONO + ';color:var(--ds-tx3);background:linear-gradient(var(--ds-s3),var(--ds-s2) 80%);' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}',
    '.dse-pod .p2 .dse-pb{height:56px}',
    '.dse-pod .p1 .dse-pb{height:74px;padding-top:9px;font-size:21px;color:var(--ds-money);' +
      'background:linear-gradient(#30281b,var(--ds-s2) 80%);box-shadow:inset 0 2px 0 var(--ds-money)}',
    '.dse-pod .me:not(.p1) .dse-pb{color:var(--ds-tx);box-shadow:inset 0 2px 0 var(--ds-bone)}',
    '.dse-pod .empty .dse-pb{opacity:.45}',
    // the facts: one dark well (the lobby's address-row well), the figures in mono
    '.dse-facts{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);margin:12px 0 0;padding:8px 0;' +
      'border-radius:10px;background:var(--ds-bg)}',
    '.dse-facts>div{min-width:0;padding:0 8px}',
    '.dse-facts>div+div{box-shadow:inset 1px 0 0 var(--ds-s2)}',
    '.dse-facts dt{font-size:12px;color:var(--ds-tx3)}',
    '.dse-facts dd{margin-top:2px;font:600 16px/1.25 ' + MONO + ';font-variant-numeric:tabular-nums;color:var(--ds-tx);' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dse-facts dd.long{font-size:13.5px;line-height:1.48}',   // 1,234,567 still fits a phone's third
    // the money rows, ruled like the Wallet tab's transactions. The net row is the answer: a gold-lit band, its own
    // figure larger, inset so its words and figure line up with the rows above
    '.dse-led{margin:8px 0 0;text-align:left}',
    '.dse-lr{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:6px 10px;font-size:14px;color:var(--ds-tx2)}',
    '.dse-lr+.dse-lr{box-shadow:inset 0 1px 0 var(--ds-s2)}',
    '.dse-lr b{font:600 14.5px ' + MONO + ';font-variant-numeric:tabular-nums;color:var(--ds-tx);white-space:nowrap}',
    '.dse-led>.dse-lr:first-child:last-child{padding-top:9px}',
    '.dse-lr.net,.dse-lr+.dse-lr.net{margin-top:3px;padding:8px 10px;border-radius:10px;font-size:15px;font-weight:650;' +
      'color:var(--ds-tx);background:rgba(240,168,48,.075);box-shadow:inset 0 0 0 1px rgba(240,168,48,.1)}',
    '.dse-lr.net b{font-size:19px;color:var(--ds-money)}',
    // the payout: one quiet line under the money, its receipt a plain underlined link at the end (Play stays the only
    // thing that looks pressable). Pending is a slow bone fade, sent a gold disc with a tick, failed a red one with a
    // cross: never green.
    '.dse-st{display:flex;align-items:center;gap:9px;min-height:38px;margin:3px 0 0;padding:0 10px;' +
      'font-size:13.5px;color:var(--ds-tx2);text-align:left;overflow-wrap:anywhere}',
    '.dse-st i{position:relative;flex:none;width:8px;height:8px;margin:0 4px;border-radius:50%;background:var(--ds-bone);' +
      'animation:dse-wait 1.6s ease-in-out infinite}',
    '.dse-st.err{color:var(--ds-tx);padding-top:6px;padding-bottom:6px}',
    '.dse-st.ok i,.dse-st.err i{width:16px;height:16px;margin:0;animation:none}',
    '.dse-st.ok i{background:var(--ds-money)}',
    '.dse-st.ok i:after{content:"";position:absolute;left:5.5px;top:2.8px;width:3.5px;height:7.5px;' +
      'border:solid var(--ds-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.dse-st.err i{background:var(--ds-loss)}',
    '.dse-st.err i:before,.dse-st.err i:after{content:"";position:absolute;left:7px;top:3.5px;width:2px;height:9px;' +
      'border-radius:1px;background:var(--ds-ink);transform:rotate(45deg)}',
    '.dse-st.err i:after{transform:rotate(-45deg)}',
    '.dse-st a{position:relative;flex:none;margin-left:auto;color:var(--ds-tx2);font-size:13.5px;font-weight:500;text-decoration:underline;' +
      'text-decoration-color:rgba(168,156,138,.5);text-underline-offset:3px;transition:color .14s,text-decoration-color .14s}',
    '.dse-st a:after{content:"";position:absolute;inset:-12px -10px}',   // a thumb's worth to press around small words
    '.dse-st a:hover{color:var(--ds-tx);text-decoration-color:currentColor}',
    '.dse-st a:focus-visible{outline:2px solid var(--ds-bone);outline-offset:3px;border-radius:2px}',
    '.dse-st[data-chg] i{animation:dse-pop .42s cubic-bezier(.3,1.4,.5,1)}',
    '.dse-st[data-chg] a{animation:dse-fade .3s ease-out}',
    '.dse-note{font-size:13px;line-height:1.5;color:var(--ds-tx2);margin:10px 0 0;overflow-wrap:anywhere}',
    // the buttons: six columns, so Play and one more share a row two to one like the game screen's Play and Spectate
    '.dse-btns{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:12px}',
    // the quiet one is still plainly a button: an s2 face, an s3 rim, full-strength words
    '.dse-btn{grid-column:span 6;height:48px;min-width:0;border:0;border-radius:10px;padding:0 10px;' +
      'font:600 14.5px Archivo,ui-sans-serif,system-ui,sans-serif;color:var(--ds-tx);background:var(--ds-s2);cursor:pointer;' +
      'box-shadow:inset 0 0 0 1px #342c21;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;touch-action:manipulation;-webkit-user-select:none;user-select:none;' +
      'transition:background .15s,color .15s,box-shadow .2s,transform .15s}',
    '.dse-btn.w4{grid-column:span 4}.dse-btn.w3{grid-column:span 3}.dse-btn.w2{grid-column:span 2}',
    '.dse-btn.first{order:-1}',
    '.dse-btn:hover{background:var(--ds-s3);box-shadow:inset 0 0 0 1px #3d3427}',
    // the lobby's Play: bone, the light running top to bottom like a struck coin, one soft glow under it
    '.dse-btn.pri{color:var(--ds-ink);font-size:15px;font-weight:650;' +
      'background:linear-gradient(180deg,#fff 0%,#f4f1ea 48%,#dcd4c5 100%);' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(70,58,40,.3),0 8px 24px -8px rgba(244,241,234,.38)}',
    '.dse-btn.pri:hover{color:var(--ds-ink);transform:translateY(-1px);' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(70,58,40,.3),0 10px 30px -8px rgba(244,241,234,.55)}',
    // over a second row of buttons the glow stays tight, so it never clouds the two under it
    '.dse-btn.pri.first{box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(70,58,40,.3),0 6px 14px -8px rgba(244,241,234,.3)}',
    '.dse-btn:disabled,.dse-btn:disabled:hover{cursor:default;opacity:.45;background:var(--ds-s2);transform:none;' +
      'box-shadow:inset 0 0 0 1px #342c21}',
    // shut, like the Events tab's Join before it opens: the slot stays, an empty outline with quiet words, so the
    // button beside it is plainly the one to press for now
    '.dse-btn.pri:disabled,.dse-btn.pri:disabled:hover{opacity:1;background:transparent;color:var(--ds-tx3);font-weight:600;' +
      'box-shadow:inset 0 0 0 1px var(--ds-s3)}',
    '.dse-btn:focus-visible{outline:2px solid var(--ds-bone);outline-offset:3px}',
    // a phone: the card sits low, its buttons where a thumb already is, the game left in view above it
    '@media (max-width:' + PHONE_MAX + 'px){.dse{align-items:flex-end;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px))}' +
      '.dse-scrim{background:linear-gradient(180deg,rgba(10,9,7,.34),rgba(10,9,7,.6) 50%,rgba(10,9,7,.8))}' +
      '.dse-card{transform-origin:50% 100%}}',
    // a computer: a bigger panel and figure, the same layout
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dse-card{width:424px;padding:26px 26px 24px}' +
      '.dse-v{font-size:16px}.dse-big{font-size:64px}.dse-unit{font-size:15px}.dse-hero{margin-top:6px}' +
      '.dse-card.bare .dse-v{font-size:22px}.dse-facts{margin-top:18px;padding:11px 0}.dse-facts dd{font-size:18px}' +
      '.dse-facts dd.long{font-size:16px;line-height:1.4}.dse-led{margin-top:12px}.dse-lr{padding:8px 12px}' +
      '.dse-lr.net,.dse-lr+.dse-lr.net{padding:10px 12px}.dse-lr.net b{font-size:20px}.dse-st{padding:0 12px;min-height:44px}' +
      '.dse-pn{font-size:16px}.dse-pod .p1 .dse-pn{font-size:19px;min-height:26px}.dse-pb{height:48px;font-size:17px}' +
      '.dse-pod .p2 .dse-pb{height:64px}.dse-pod .p1 .dse-pb{height:86px;font-size:23px}' +
      '.dse-btns{margin-top:18px}.dse-btn{height:50px}.dse-btn.pri{font-size:15.5px}}',
    // motion: the card rises in from a touch smaller, the backdrop dims, a win's figure catches the light once (all
    // within half a second)
    '.dse-scrim.in{animation:dse-fade .24s ease-out both}',
    '.dse-card.in{animation:dse-rise .34s cubic-bezier(.2,.8,.2,1) both}',
    '.dse.t-win .dse-card.in .dse-big{animation:dse-glint .5s ease-out both}',
    '@keyframes dse-rise{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes dse-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes dse-glint{0%{text-shadow:0 0 0 rgba(240,168,48,0)}55%{text-shadow:0 0 30px rgba(240,168,48,.65)}' +
      '100%{text-shadow:0 0 26px rgba(240,168,48,.22)}}',
    '@keyframes dse-wait{0%,100%{opacity:1}50%{opacity:.3}}',
    '@keyframes dse-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.2);opacity:1}100%{transform:scale(1)}}',
    // the board: fully clear (Owen 2026-10-16), text with a shadow. Your row takes the lobby's picked-rung colours:
    // gold on a money board, bone on a free one. Compact on a phone (Owen: it never takes a big part of the screen):
    // 11.5 px rows 16 px apart, names cut at about 10 characters.
    '.dsb{position:fixed;top:8px;right:8px;width:128px;pointer-events:none;color:#f5f1e8;font:600 11.5px Archivo,ui-sans-serif,system-ui,sans-serif;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 2px #000;-webkit-text-size-adjust:100%;line-height:1.3;text-align:left}',
    '.dsb p,.dsb ol{margin:0;padding:0;list-style:none}',
    '.dsb-t{font-size:10.5px;color:rgba(245,241,232,.75);margin:0 0 1px 1px}',
    '.dsb li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:4px;align-items:baseline;line-height:16px;padding:0 4px;margin:0 -3px}',
    '.dsb li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:10ch}',
    '.dsb li i{font-style:normal;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10.5px;color:rgba(245,241,232,.7)}',
    '.dsb li b{font:600 11px "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}',
    '.dsb.money li b{color:#f0a830}',
    '.dsb li.me{background:#f4f1ea;color:#100e0b;border-radius:5px;text-shadow:none;font-weight:700}',
    '.dsb.money li.me{background:#f0a830}',
    '.dsb li.me i,.dsb li.me b,.dsb.money li.me b{color:#100e0b}',
    '.dsb li.gap{line-height:8px}',
    // a light map: ink text, a white halo; your row an ink pill on a free board, still gold on a money one
    '.dsb.light{color:#100e0b;text-shadow:0 0 2px #fff,0 0 3px #fff,0 1px 1px rgba(255,255,255,.9)}',
    '.dsb.light .dsb-t,.dsb.light li i{color:rgba(16,14,11,.7)}',
    '.dsb.light.money li b{color:#8a5600}',
    '.dsb.light li.me{background:#100e0b;color:#f4f1ea}',
    '.dsb.light li.me i,.dsb.light li.me b{color:#f4f1ea}',
    '.dsb.light.money li.me{background:#f0a830;color:#100e0b}',
    '.dsb.light.money li.me i,.dsb.light.money li.me b{color:#100e0b}',
    // a computer: a little more room, still small
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dsb{width:196px;font-size:13.5px;top:14px;right:14px}' +
      '.dsb-t{font-size:12px;margin-bottom:3px}' +
      '.dsb li{grid-template-columns:20px minmax(0,1fr) auto;gap:6px;line-height:21px;padding:0 6px;margin:0 -4px}' +
      '.dsb li span{max-width:14ch}.dsb li i{font-size:11.5px}.dsb li b{font-size:12.5px}' +
      '.dsb li.me{border-radius:6px}.dsb li.gap{line-height:10px}}'
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

  // The big figure. An amount ('$2.16', '−$1.00') gets money's small $; anything else goes in as it came.
  var MONEY_RE = /^([−+-]?)\$(\d[\d,]*(?:\.\d+)?)$/;
  function figure(text) {
    var big = el('span', 'dse-big');
    var s = String(text);
    var m = MONEY_RE.exec(s);
    if (!m) { big.textContent = s; return big; }
    big.setAttribute('aria-label', s);
    if (m[1]) big.appendChild(doc.createTextNode(m[1]));
    big.appendChild(el('span', 'dse-cur', '$'));
    big.appendChild(doc.createTextNode(m[2]));
    return big;
  }

  // The podium in rank order (read in that order), each seat placed in its column by CSS: second, first, third.
  // A seat nobody holds (a two-player final) is still drawn, an empty plinth, so the podium keeps its shape.
  function podium(list) {
    var ol = el('ol', 'dse-pod');
    var taken = {};
    list.slice(0, 3).forEach(function (p) {
      if (!p) return;
      var r = Math.round(Number(p.rank));
      var place = r >= 1 && r <= 3 && !taken[r] ? r : 0;
      for (var k = 1; !place && k <= 3; k++) if (!taken[k]) place = k;
      if (!place) return;
      taken[place] = true;
      var li = el('li', 'p' + place + (p.me ? ' me' : ''));
      li.appendChild(el('div', 'dse-pb', p.rank != null ? p.rank : place));
      li.appendChild(el('p', 'dse-pn', p.name == null ? '' : p.name));
      ol.appendChild(li);
    });
    for (var k = 1; k <= 3; k++) {
      if (taken[k]) continue;
      var seat = el('li', 'p' + k + ' empty');
      seat.setAttribute('aria-hidden', 'true');
      seat.appendChild(el('div', 'dse-pb'));
      seat.appendChild(el('p', 'dse-pn'));
      ol.appendChild(seat);
    }
    return ol;
  }

  // ---- the card
  var card = null;        // { el, opts, btns, fresh, st }

  function render(o) {
    var wrap = card.el;
    var tone = o.tone === 'win' || o.tone === 'loss' ? o.tone : 'plain';
    wrap.className = ['dse', 't-' + tone].concat(foreign(wrap.className)).join(' ');
    wrap.style.zIndex = String(o.z != null ? o.z : 1000);
    if (o.zoom && o.zoom !== 1) wrap.style.zoom = String(o.zoom); else wrap.style.zoom = '';
    var had = doc.activeElement && doc.activeElement.getAttribute && doc.activeElement.getAttribute('data-dse-btn');
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el('div', 'dse-scrim' + (card.fresh ? ' in' : '')));
    var hasHero = o.hero != null && o.hero !== '';
    var bare = !hasHero && !(o.podium && o.podium.length) && !(o.facts && o.facts.length) &&
      !(o.ledger && o.ledger.length) && !(o.status && o.status.text);
    var box = el('div', 'dse-card' + (bare ? ' bare' : '') + (card.fresh ? ' in' : ''));   // rises in once, not on every update
    if (o.verdict) box.appendChild(el('p', 'dse-v', o.verdict));
    if (hasHero) {
      var hero = el('p', 'dse-hero');
      hero.appendChild(figure(o.hero));
      if (o.unit) hero.appendChild(el('span', 'dse-unit', o.unit));
      box.appendChild(hero);
    }
    if (o.podium && o.podium.length) box.appendChild(podium(o.podium));
    if (o.facts && o.facts.length) {
      var dl = el('dl', 'dse-facts');
      o.facts.slice(0, 3).forEach(function (f) {
        f = pair(f);
        var d = el('div');
        d.appendChild(el('dt', null, f[0]));
        // a long figure (1,234,567) steps down a size instead of losing its end to an ellipsis
        d.appendChild(el('dd', String(f[1] == null ? '' : f[1]).length > 7 ? 'long' : null, f[1]));
        dl.appendChild(d);
      });
      box.appendChild(dl);
    }
    if (o.ledger && o.ledger.length) {
      var led = el('div', 'dse-led');
      o.ledger.forEach(function (r, i) {
        r = pair(r);
        var row = el('div', 'dse-lr' + (o.ledger.length > 1 && i === o.ledger.length - 1 ? ' net' : ''));
        row.appendChild(el('span', null, r[0]));
        row.appendChild(el('b', null, r[1]));
        led.appendChild(row);
      });
      box.appendChild(led);
    }
    var stNow = '';
    if (o.status && o.status.text) {
      stNow = o.status.state === 'ok' || o.status.state === 'err' ? o.status.state : 'pending';
      var link = o.status.link && /^https:\/\//.test(String(o.status.link.href || '')) ? o.status.link : null;
      // the dot settles and the words fade in only when the state really changed (pending to sent), never on arrival
      var changed = !card.fresh && card.st && card.st !== stNow;
      var st = el('p', 'dse-st' + (stNow !== 'pending' ? ' ' + stNow : ''));
      if (changed) st.setAttribute('data-chg', '1');
      st.appendChild(el('i'));
      st.appendChild(doc.createTextNode(String(o.status.text)));
      if (link) {
        var a = el('a', null, link.text || 'View');
        a.href = link.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        st.appendChild(a);
      }
      box.appendChild(st);
    }
    card.st = stNow;
    (o.notes || []).forEach(function (n) { if (n) box.appendChild(el('p', 'dse-note', n)); });
    card.btns = {};
    var list = (o.buttons || []).filter(function (b) { return b && b.text; });
    if (list.length) {
      var btns = el('div', 'dse-btns');
      var lead = -1;
      list.forEach(function (b, i) { if (lead < 0 && b.primary) lead = i; });
      list.forEach(function (b, i) {
        // one: the whole row. two: Play takes two thirds beside the other (halves when neither leads).
        // three or four: the leading one takes its own row, the others share the next (halves, or thirds for three
        // such as Spectate, Lobby and Menu).
        var w = 'w6';
        if (list.length === 2) w = lead < 0 ? 'w3' : i === lead ? 'w4' : 'w2';
        else if (list.length >= 3) w = i === (lead < 0 ? 0 : lead) ? 'w6 first' : list.length >= 4 ? 'w2' : 'w3';
        var btn = el('button', 'dse-btn ' + w + (b.primary ? ' pri' : ''), b.text);
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
      box.appendChild(btns);
    }
    wrap.appendChild(box);
    if (had && card.btns[had] && card.btns[had].focus) card.btns[had].focus();
  }

  function lastKid(n) { return n.lastChild || (n.children && n.children[n.children.length - 1]) || null; }
  // A card taller than the window (a phone on its side) is scaled down to fit, never cut off. The room is the window
  // less the wrap's own padding (more at the bottom on a phone, where the card sits low).
  function pad(node) {
    try {
      var cs = root.getComputedStyle ? root.getComputedStyle(node) : null;
      var p = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
      return p > 24 ? p : 24;
    } catch (_) { return 24; }
  }
  function fit(box) {
    if (!box || !box.style) return;
    box.style.zoom = '';
    if (typeof box.getBoundingClientRect !== 'function') return;
    var h = box.getBoundingClientRect().height;
    var avail = (root.innerHeight || 0) - (box.parentNode ? pad(box.parentNode) : 24);
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
    if (card.fresh) card.st = '';
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
          out.push(null);
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
            li.appendChild(el('i'));
            li.appendChild(el('span', null, '…'));
            li.appendChild(el('b'));
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
