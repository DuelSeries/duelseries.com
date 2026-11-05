'use strict';
/* ─── Wallet ──────────────────────────────────────────────────────────────────
   This screen is a view over the Privy widget, not a second wallet. Every
   money action is delegated to the globals public/wallet/widget.js publishes,
   so there is exactly one implementation of funding and sending in the product
   and this lobby cannot drift from the live one:

     window.duelWallet          { ready, authenticated, address, balance, unit, sol, swap, mode, usdc, solUsd, stale }
                                mode 'usdc': balance is the USDC, sol the SOL beside it.
                                mode 'sol' (the games still count in dollars): balance is the dollar value of the
                                wallet's SOL (null with no price), sol the SOL itself, usdc any old USDC left,
                                solUsd the server's display rate.
                                stale: the figures are the server's last read (up to 5 min old), not a read now.
     'duelwallet:change'        fired on any of the above changing
     window.duelWalletLogin()   opens the Privy login
     window.duelWalletFund(method)  Privy funding flow (Pay with card, Receive funds; 'card' or 'manual' opens on one)
     window.duelWallet.linked / .linkable, duelWalletLink(id), duelWalletUnlink(), duelWalletLinkedBalance(),
     duelWalletAddFromLinked(lamports)   a Google/email player's linked Phantom, Solflare or Backpack: a row in Add
                                funds and "To Phantom" in Withdraw (never the game wallet; wallet-widget linkedWallet.mjs)
     window.duelWalletSend(a,t,asset)  send `a` to address `t` (SOL mode: SOL, or USDC when asset is 'usdc')
     window.duelWalletRefresh() re-read the on-chain balance
     window.duelWalletSwapQuote(dir, amount, receiver)  a checked price, nothing signed
     window.duelWalletUsdcToSolQuote()                  SOL mode: a checked price for ALL the old USDC, nothing signed
     window.duelWalletSwapRun(quote)                    sign and send a confirmed price

   Nothing here signs, quotes or verifies anything. If a call is missing the
   widget has not mounted yet, and the screen says so rather than pretending
   the balance is zero — a real balance of 0 and "not connected" are very
   different things to show someone about their money. */

(function () {
  const el = id => document.getElementById(id);
  const w = () => window.duelWallet || {};
  // no sign of a session in this browser (v2.html DSWalletBoot): nobody can be signed in, widget or not
  const noSession = () => !!(window.DSWalletBoot && window.DSWalletBoot.session === false);
  /* Which step the cash-out panel is on. Module state rather than DOM state,
     because a balance refresh re-renders the panel and would otherwise throw
     away whatever was half-typed into it. */
  let cashing = false, pending = null;
  /* How the withdrawal is paid: 'usdc' sends the dollars as they are, 'sol' converts them on the
     way out (server/swap.js) and the address receives SOL. */
  let payAs = 'usdc';
  /* SOL mode (the server's MONEY_MODE=sol): the games count in dollars as ever, but the money in the wallet is
     SOL. The big number is the SOL's value in dollars (the server's own figure, never a price of ours), the SOL
     itself sits small under it, and old USDC, if any, gets its own line. A withdrawal there sends 'sol' (the
     default) or 'usdc'. */
  let wdAsset = 'sol';
  const solMode = () => w().mode === 'sol';
  /* Every SOL send leaves the wallet at least 0.001 SOL after the amount and the fee: under about 0.00089 SOL
     the network refuses the account, and a wallet down to dust cannot pay for its next move. Same numbers as
     wallet-widget/src/solReserve.mjs, which re-checks every send against a fresh balance. */
  const KEEP_LAMPORTS = 1000000, SEND_FEE_LAMPORTS = 5000;
  /* And every SOL send is at least 0.001 SOL (withdraw fee review 2026-11-05): an address the network has never seen
     must be given at least its rent minimum (890,880 lamports) or the whole transfer fails on chain. Same number as
     solReserve.mjs MIN_SEND_LAMPORTS, which the widget checks again before it signs. */
  const MIN_SEND_LAMPORTS = 1000000;
  const connected = () => !!(w().authenticated && w().address);
  /* SOL beside the dollars (Owen, 2026-10-15: "Accept both, play in USDC"). Card top-ups and
     exchange sends land as SOL; everything but the reserve kept for network fees can become
     USDC with one tap. Lamports, so the amount sent is exact. */
  const swapOn = () => !!(w().swap && window.duelWalletSwapQuote && window.duelWalletSwapRun);
  const solLamports = () => Math.max(0, Math.round((Number(w().sol) || 0) * 1e9));
  function convertible() {
    const s = w().swap; if (!s || solMode()) return 0;   // SOL mode never converts SOL: SOL is the money
    const n = solLamports() - Math.round((Number(s.solReserve) || 0) * 1e9);
    return n >= Math.round((Number(s.minConvertSol) || 0) * 1e9) ? n : 0;
  }
  const solTxt = lamports => (Number(lamports) / 1e9).toFixed(4) + ' SOL';
  // A SOL amount exactly as typed, up to the six places the form takes: the confirm step shows what is sent.
  const solPlain = sol => parseFloat((Number(sol) || 0).toFixed(9)) + ' SOL';
  const maxSendLamports = () => Math.max(0, solLamports() - KEEP_LAMPORTS - SEND_FEE_LAMPORTS);
  // Whether a read balance leaves anything to send as SOL: the most it can send is at least the smallest send.
  const canSendSol = () => maxSendLamports() >= MIN_SEND_LAMPORTS;
  /* Whether the wallet's SOL has been read at all (night review 2026-10-29, third pass). Unread (a busy moment on the
     server's reads), Withdraw still opens and sends: the widget checks a fresh balance when it can, and the network
     refuses more than the wallet has. A read balance is checked here exactly as before.
     Stale (night review 2026-10-29, fourth pass): the server's last read of the address, up to 5 minutes old, given when
     it could not read the chain just now. It is shown as it is, but checked as unread: a payout or a top-up that landed
     since must never be refused as "more than you have", and Max never offers the old figure. */
  const stale = () => w().stale === true;
  const solKnown = () => !stale() && typeof w().sol === 'number' && isFinite(w().sol);
  // SOL mode's Max needs a figure read now: the SOL for a SOL send, and (stale or not) the old USDC for a USDC one.
  const maxOff = as => (as === 'sol' ? !solKnown() : stale());
  // Old USDC, in whole cents, in SOL mode only; a smaller dust figure would read $0.00 and is left alone.
  const usdcBal = () => (solMode() ? cents(w().usdc) : 0);
  const usdcOn = () => usdcBal() > 0;
  // What a SOL-mode withdrawal sends now: USDC only while there is some to send, else SOL.
  const curAsset = () => (wdAsset === 'usdc' && usdcOn() ? 'usdc' : 'sol');
  // SOL mode before the server has a price: the SOL is known, its dollars are not (shown as "…" until they are).
  const noPrice = () => solMode() && w().balance == null;
  const bigBal = n => (noPrice() ? '…' : balMoney(n));
  const usdTxt = units => money(Number(units) / 1e6);
  // A floor ("at least") rounds down, so the figure shown is never more than what arrives.
  const usdFloor = units => balMoney(Number(units) / 1e6);
  const solFloor = lamports => (Math.floor(Number(lamports) / 1e5) / 1e4).toFixed(4) + ' SOL';
  /* The small line under the balance: the SOL in the wallet, and Convert to USDC when there is
     any to convert. Hidden while the SOL figure is unknown (SOL money mode, or not read yet). */
  function solLine() {
    if (w().sol == null) return '';
    // SOL mode: just the SOL, quietly. No Convert to USDC, ever.
    if (solMode()) return '<span class="num">' + solTxt(solLamports()) + '</span>' +
      (noPrice() ? '<span>price unavailable</span>' : '');
    if (!w().swap) return '';
    const c = convertible();
    return '<span class="num">' + solTxt(solLamports()) + '</span>' +
      (c && swapOn() ? '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm wcv" onclick="V2Wallet.convert()">Convert to USDC</button>' : '');
  }
  /* SOL mode: old USDC still in the wallet (from before the switch, or sent by habit). One line, two actions:
     Convert to SOL (the price sheet, then one tap) and Withdraw USDC. It says the big figure above leaves it out
     (stage 3 audit: the headline balance was not all the money and nothing said so). */
  function usdcLine() {
    if (!usdcOn()) return '';
    return '<span class="ph-no-capture">You have <b class="num">' + money(usdcBal()) + '</b> USDC</span>' +
      '<span class="wusdc-k"> as well, not counted in the balance above</span>' +
      // the server's smallest convert is $0.10 (server/swap.js MIN_USDC_CONVERT)
      (swapOn() && window.duelWalletUsdcToSolQuote && usdcBal() >= 0.10
        ? '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm wcv" onclick="V2Wallet.convertUsdc()">Convert to SOL</button>' : '') +
      '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm wcv" onclick="V2Wallet.cashOut(\'usdc\')">Withdraw USDC</button>';
  }
  // Thousands separated, so $1,234.56 never reads as $1234.56.
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  /* A balance is shown, and Max fills it, rounded DOWN to the cent. toFixed
     rounds up, so $3.216 read as $3.22 and Max filled an amount the form then
     refused as more than you have. */
  const cents = n => Math.floor((Number(n) || 0) * 100 + 1e-6) / 100;
  const balMoney = n => money(cents(n));
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function shortAddr(a) {
    return !a ? '' : a.length <= 16 ? a : a.slice(0, 6) + '…' + a.slice(-6);
  }
  /* The player's own address, everywhere it shows (Owen, 2026-10-15): one
     line, the first and last four, and a Copy button that copies all of it.
     The full 44 characters wrapped onto a second line on a phone and nobody
     reads them anyway; the button is how an address actually gets used. */
  const ownShort = a => !a ? '' : a.length <= 12 ? a : a.slice(0, 4) + '…' + a.slice(-4);
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/>' +
    '<path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>';
  /* The in and out marks on a history row (they were the characters ↓ and ↑, drawn in whatever font had them). */
  const ARROW_IN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13M6.5 12.5L12 18l5.5-5.5"/></svg>';
  const ARROW_OUT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/></svg>';
  /* A list that did not load says so and offers the way to ask again right there: "Tap refresh" pointed at a round
     arrow far up the page, and nobody taps on a PC (stage 3 audit). Refresh reads the balance and every list. */
  const AGAIN = ' <button type="button" class="ds-btn ds-btn-secondary ds-btn-sm wagain" onclick="V2Wallet.refresh()">Try again</button>';
  function addrRow(id, a) {
    return '<div class="waddr" id="' + id + '">' +
      '<code class="ph-no-capture" title="' + esc(a) + '">' + esc(ownShort(a)) + '</code>' +
      '<button type="button" class="cp" onclick="V2Wallet.copy(\'' + id + '\')" ' +
        'aria-label="Copy wallet address">' + COPY_ICON + '<span>Copy</span></button></div>';
  }

  function clearMoves() {
    mvGen++; clearTimeout(mvTimer);
    const mv = el('w-moves'); if (mv) mv.innerHTML = '';
  }
  /* History (site redo stage 3): one panel beside the balance, Transactions (with Add funds and Withdrawals under
     them) or Earnings. Shown only for a signed-in wallet; anything else is one panel across the screen. The view is
     kept across redraws. Display only: both views are loaded either way, as they always were. */
  let histView = 'earn';      // opens on Earnings (Owen 2026-11-02)
  function hist(on) {
    const g = el('w-grid'); if (g) g.classList.toggle('in', !!on);
    const h = el('w-hist'); if (h) h.hidden = !on;
    if (!on) { const t = el('w-txs'); if (t) t.innerHTML = ''; }
  }
  function view(v) {
    if (v !== 'tx' && v !== 'earn') return;
    histView = v;
    const h = el('w-hist'); if (!h) return;
    h.setAttribute('data-view', v);
    if (h.querySelectorAll) h.querySelectorAll('[data-hv]').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-hv') === v)));
  }
  // The balance figure's length, for the lit figure to fit its panel (v2.html #w-bal): "$1,234.56" sits smaller than "$4.20".
  const fitLen = s => String(s == null ? '' : s).length;

  /* The header readout. Not connected shows "…" (the box is hidden once signed out is known), never $0.00. */
  function renderHeader() {
    const v = el('hdr-balance');
    if (!v) return;
    v.textContent = connected() ? bigBal(w().balance) : '…';
    /* Target the label span, not lastChild: the button's last node is the
       whitespace after the span, so writing to it appends a second label. */
    const label = document.querySelector('#wbtn span');
    /* Signed out (known, not merely not loaded yet): the header drops the
       empty balance box and says Sign in, on a phone too, where it was a lone
       dash beside an unlabelled icon. While the wallet is still starting it
       says Add funds, so a signed-in player never sees a Sign in flash by. A
       browser with no sign of a session at all (DSWalletBoot.session, the top
       of v2.html) is known signed out from the start: the widget now comes in
       once the page is idle, and the header said Add funds until then. */
    const out = (!!w().ready || noSession()) && !connected();
    if (label) label.textContent = out ? 'Sign in' : 'Add funds';
    // A name for screen readers too: on a phone the label is hidden and only the icon shows.
    const btn = el('wbtn'); if (btn) btn.setAttribute('aria-label', out ? 'Sign in' : 'Add funds');
    document.body.classList.toggle('signedout', out);
  }
  // Which Add funds was pressed, for add_funds_opened (addFundsOpened): the Wallet tab's, or the header's for its call.
  let fundWhere = 'wallet';
  /* The header button signs you in when you are signed out, instead of
     opening a Wallet tab whose only content is a second Sign in button. */
  function headerTap() {
    /* Before the widget is in, too, when nobody can be signed in: Sign in fetches it and hands over (v2.html
       stub), where the Wallet tab would only say Starting your wallet and ask for a second tap. */
    if ((w().ready || noSession()) && !connected()) return login('header');
    /* Signed in it is Add funds (site redo, layout 1: the balance beside it opens the Wallet tab), the same
       fund() as the Wallet tab's own button. A wallet still starting goes to the Wallet tab, as before. */
    if (connected()) { fundWhere = 'header'; try { return fund(); } finally { fundWhere = 'wallet'; } }
    if (window.go) window.go('wallet');
  }

  /* light: a balance tick from the widget. The screen is already drawn for
     this wallet, so only the number changes; rebuilding it would throw away
     every page of transactions already shown and fetch the first one again. */
  let drawnFor = null, drawnLink = '';
  /* A Google or email player's linked browser wallet (Owen 2026-10-26): Phantom, Solflare or Backpack as a way to
     move money in and out. Never the game wallet: the Privy wallet still stakes and holds the balance. It shows as
     a row in Add funds, as "To Phantom" in Withdraw, and here with Unlink. A player who signed in with a browser
     wallet has none of this (theirs already is the game wallet). */
  const linkKey = () => { const W = w(), L = W.linked;
    return (L ? L.address + '|' + (L.here ? 1 : 0) : '') + '|' + addChip(); };
  function linkedRow() {
    const L = w().linked;
    if (!L || w().external) return '';
    // Unlink reads as a leaving action (red tint, like Settings' Sign out), never as a second Copy (stage 3 audit).
    return '<span class="ds-t-label wlinklab">Linked wallet</span>' +
      '<div class="waddr wlink"><code class="ph-no-capture" title="' + esc(L.address) + '">' + esc(L.name) + ' ' + esc(ownShort(L.address)) + '</code>' +
        '<button type="button" class="cp wunl" onclick="V2Wallet.unlink()">Unlink</button></div>';
  }
  const CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const LOCK = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/>' +
    '<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
  function render(light) {
    renderHeader();
    const body = el('w-body');
    if (!body) return;

    if (!w().ready) {
      drawnFor = null;
      clearMoves();
      hist(false);
      body.innerHTML = '<div class="ds-panel wstart" role="status"><span class="ds-spin" aria-hidden="true"></span>' +
        '<p class="ds-hint">Starting your wallet…</p></div>';
      return;
    }
    if (!connected()) {
      drawnFor = null;
      const earn = el('w-earn'); if (earn) earn.hidden = true;
      clearMoves();
      hist(false);
      /* Signed out (stage 3 audit: an empty box with one button): what the wallet is, why to sign in, and the one
         Sign in. The balance beside it is shut and says so, never a $0.00 for money nobody has looked at. */
      body.innerHTML =
        '<section class="ds-panel ds-out wout" aria-labelledby="wout-t"><div>' +
          '<h2 class="ds-t-page" id="wout-t">Sign in to see your wallet</h2>' +
          '<p class="ds-t-body">Your DuelSeries wallet holds the money you use for paid rooms. It belongs to you, and only you can move money out of it.</p>' +
          '<ul><li>' + CHECK + 'Add funds with a card or from another wallet.</li>' +
            '<li>' + CHECK + 'Your balance shows in dollars.</li>' +
            '<li>' + CHECK + 'Withdraw to any Solana wallet whenever you like.</li></ul>' +
          '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg" onclick="V2Wallet.login()">Sign in</button>' +
          '<p class="ds-hint">Free rooms work without signing in.</p></div>' +
        '<div class="ds-panel ds-lit is-off ds-out-bal" aria-hidden="true"><span class="ds-t-label">Your balance</span>' +
          '<span class="ds-out-lock">' + LOCK + '</span><b class="wout-what">Signed out</b>' +
          '<p class="ds-t-meta">Shows here once you sign in</p></div></section>';
      return;
    }
    if (light === true && drawnFor === w().address && drawnLink === linkKey() && el('w-bal')) {
      el('w-bal').textContent = bigBal(w().balance);
      const st = el('w-bal').style; if (st && st.setProperty) st.setProperty('--n', fitLen(bigBal(w().balance)));
      const s = el('w-sol'); if (s) s.innerHTML = solLine();
      const u = el('w-usdc'); if (u) u.innerHTML = usdcLine();
      return;
    }

    const addr = w().address;
    const bal = Number(w().balance) || 0;
    hist(true);
    view(histView);
    body.innerHTML =
      /* The balance leads, at the size of the thing it is: the one lit panel on the site (the kit's .ds-lit and
         .ds-led). Add funds and Withdraw sit under it because they are what you came to do, and Refresh is beside
         them rather than hidden, because an on-chain balance can be a few seconds behind and the only honest answer
         to "is it there yet" is a button that asks again. */
      '<section class="ds-panel ds-lit ds-balp wbal" aria-labelledby="w-bal-t">' +
        /* Owen's pick W2 "Centered" with W1's buttons (2026-11-03, mockup tab-mockups/w2.html): the address as a chip
           on top, the balance big and centred under it, the SOL under that, then Add funds, Withdraw and Refresh in
           one row. The two labels stay for screen readers. */
        '<div class="wtop"><div class="wtop-addr"><span class="ds-sr" id="w-addr-t">Your wallet address</span>' + addrRow('w-addr', addr) + '</div>' +
        '<div class="wtop-bal">' +
        '<span class="ds-sr" id="w-bal-t">Your balance</span>' +
        '<div style="--n:' + fitLen(bigBal(bal)) + '" class="ds-led num ph-no-capture" id="w-bal" data-cu>' + bigBal(bal) + '</div>' +
        /* The SOL under the dollars, small, like the DamnBruh wallet's "$1.03 / 0.0098 SOL"
           (Owen, 2026-10-15), with the one tap that turns it into dollars. */
        '<div class="wsol ph-no-capture" id="w-sol">' + solLine() + '</div>' +
        '</div></div>' +
        /* SOL mode only (empty, and not drawn, otherwise): "You have $X USDC" with its two actions. */
        '<div class="wsol wusdc" id="w-usdc">' + usdcLine() + '</div>' +
        /* The form lives in its own sheet now, so this row never swaps out. */
        ('<div class="wacts">' +
            '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg wa-add" onclick="V2Wallet.fund()">Add funds</button>' +
            '<button type="button" class="ds-btn ds-btn-secondary ds-btn-lg wa-wd" onclick="V2Wallet.cashOut()">Withdraw</button>' +
            '<button type="button" class="ds-btn ds-btn-secondary ds-btn-lg ds-btn-icon wref" id="w-refresh" onclick="V2Wallet.refresh()" ' +
              'aria-label="Refresh balance" title="Refresh balance">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
                'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">' +
                '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>' +
            '</button>' +
          '</div>') +
        addChip() +
        /* The one sentence kept. The rest of the copy on this screen was
           explanation; this is the only line whose absence can cost somebody
           their money. SOL mode says SOL only, the same as Add funds' Receive page (stage 3 audit); USDC mode
           takes SOL too, since card top-ups arrive as SOL (Owen, 2026-10-15). */
        '<p class="ds-t-meta">' + (solMode()
          ? 'Send only SOL on the Solana network to this address. Anything else sent here is lost.'
          : 'SOL or USDC on Solana only. Anything else is unrecoverable.') + '</p>' +
      '</section>' +
      (linkedRow() ? '<section class="ds-panel wdep">' + linkedRow() + '</section>' : '');
    /* Five rows tall, the rest a scroll away inside the card, and the next
       page asked for as the scroll nears the end (Owen, 2026-10-15). A Show
       more button under a list that long was a page of buttons to tap. */
    const txs = el('w-txs');
    if (txs) txs.innerHTML = '<div class="txcard"><div class="txl sc" id="w-tx" onscroll="V2Wallet.txScroll()">' +
        '<div class="none">Loading…</div></div></div>';
    drawnFor = addr;
    drawnLink = linkKey();
    loadTx();
    loadMoves();
    /* The earnings chart and the payout list, which used to be their own tab. */
    if (window.V2Stats) window.V2Stats.load();
  }

  /* Read off the chain, because that is the only place these exist: the
     transfers are self-custody and never touch our server, and the old
     deposits/withdrawals tables are vestigial from the custodial system.

     Every one of them, a page at a time: the server answers 20 and a cursor,
     and scrolling near the end of the card asks for the next 20 until the
     cursor runs out. A stake
     goes to the game escrow and a payout comes back from it, so those are
     named as games rather than as a deposit and a withdrawal they are not. */
  let txFor = null, txNext = null, txBusy = false;
  /* Which load of the list is current. Refresh starts a new one while a page
     of the old one may still be on its way; that page is dropped instead of
     being appended to the new list as duplicates. */
  let txGen = 0;
  // 'Skin: Candy Cane' from '<game>:<skin>' (shared/shopSkins.js), or just 'Skin' when it cannot be named. Escaped:
  // the list is built as HTML.
  function skinName(item) {
    const SK = window.DS_SHOP_SKINS;
    const m = /^([a-z][a-z0-9]*):([a-z][a-z0-9]*)$/.exec(typeof item === 'string' ? item : '');
    const k = m && SK ? SK.byId(m[1], m[2]) : null;
    return k ? 'Skin: ' + esc(k.name) : 'Skin';
  }
  function txRow(t) {
    const inb = t.direction === 'in';
    /* The player's own money is named by the button that moves it (Owen,
       2026-10-15): Add funds and Withdraw, the same words as on the buttons. */
    /* A skin bought from Customize is named as the skin (server: Usdc.historyRowOf finds its memo, the route adds
       which skin), never as a game entry. */
    const name = t.kind === 'skin' ? skinName(t.skinItem)
      : t.game ? (inb ? 'Game payout' : 'Game entry')
      : t.kind === 'convert' ? 'Convert to USDC' : t.kind === 'convertSol' ? 'Convert to SOL'
      : (inb ? 'Add funds' : 'Withdraw');
    /* A real minus sign, the arrow kept from screen readers, and the link
       says where it goes: each row opens the transaction on Solscan. */
    return '<a class="tx ph-no-capture" href="https://solscan.io/tx/' + esc(t.signature) + '" ' +
      'target="_blank" rel="noopener noreferrer" title="View on Solscan">' +
      '<span class="txi ' + (inb ? 'in' : 'out') + '" aria-hidden="true">' + (inb ? ARROW_IN : ARROW_OUT) + '</span>' +
      '<span class="txw"><span class="txn">' + name + '</span>' +
        '<span class="txd">' + when(t.at) + '</span></span>' +
      '<span class="txa num ' + (inb ? 'in' : 'out') + '">' +
        (inb ? '+' : '−') + money(t.usdc) + '</span></a>';
  }
  async function fetchTx(a, before) {
    try {
      const r = await fetch('/api/my-transactions?wallet=' + encodeURIComponent(a) +
        (before ? '&before=' + encodeURIComponent(before) : ''));
      const j = await r.json();
      return Array.isArray(j.transactions) ? j : null;
    } catch (_) { return null; }
  }
  async function loadTx() {
    const a = w().address; if (!a) return;
    txFor = a; txNext = null; txBusy = true;
    const gen = ++txGen;
    const page = await fetchTx(a);
    if (gen !== txGen) return;                // a newer load owns the list now
    txBusy = false;
    const box = el('w-tx');
    if (!box || txFor !== a) return;          // screen changed under us
    if (!page) {
      box.innerHTML = '<div class="none">Could not load transactions.' + AGAIN + '</div>';
      return edge(box);
    }
    if (!page.transactions.length) {
      box.innerHTML = '<div class="none">No transactions yet.</div>';
      return edge(box);
    }
    box.scrollTop = 0;
    box.innerHTML = page.transactions.map(txRow).join('');
    txNext = page.next || null;
    fill();
  }
  /* The next page, at the end of the list. A row at the bottom says it is
     coming, and a failed page leaves a row to tap that asks again, so a
     dropped request never ends the list early without saying so. */
  async function more() {
    const a = w().address, box = el('w-tx');
    if (!a || a !== txFor || !txNext || txBusy || !box) return;
    txBusy = true;
    const gen = txGen;
    const old = box.querySelector('.txtail'); if (old) old.remove();
    box.insertAdjacentHTML('beforeend', '<div class="none txtail">Loading…</div>');
    const page = await fetchTx(a, txNext);
    if (gen !== txGen) return;                // refreshed meanwhile: not this list's page
    txBusy = false;
    if (a !== txFor || el('w-tx') !== box) return;
    const tail = box.querySelector('.txtail'); if (tail) tail.remove();
    if (!page) {
      box.insertAdjacentHTML('beforeend', '<button type="button" class="none txtail txretry" ' +
        'onclick="V2Wallet.more()">Could not load more. Press to try again.</button>');
      return edge(box);
    }
    box.insertAdjacentHTML('beforeend', page.transactions.map(txRow).join(''));
    txNext = page.next || null;
    fill();
  }
  /* A page can be short (failed and empty transactions are left out), so a
     list that does not reach the bottom of its card yet asks for the next
     page itself: there would be no scroll to ask with. */
  function fill() {
    const box = el('w-tx'); if (!box) return;
    edge(box);
    if (txNext && box.scrollHeight - box.clientHeight < ROW_H) more();
  }
  const ROW_H = 62;   // one row, as .txl.sc .tx sets it
  function txScroll() {
    const box = el('w-tx'); if (!box) return;
    edge(box);
    // Two rows from the end, so the next page is usually there before the end is.
    if (txNext && !txBusy && box.scrollTop + box.clientHeight >= box.scrollHeight - 2 * ROW_H) more();
  }
  /* The fade over the last row says there is more below, and goes once there
     is not, so the end of the list never looks cut off. */
  function edge(box) {
    box.classList.toggle('more', box.scrollTop + box.clientHeight < box.scrollHeight - 4);
  }
  const when = ms => {
    if (!ms) return '';
    const d = new Date(ms);
    // The year only once it is not this one, so a long history never reads ambiguously.
    return d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  };
  // The date and the time, for money the player moved themselves.
  const whenAt = ms => {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleString('en-US', d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  /* Add funds and Withdrawals, in place of the old "Recent payouts" (Owen,
     2026-10-15): the money the player moved in and out themselves, each with
     the other wallet's address, short, and a button that copies all of it.
     The server reads it off the chain and leaves out every transfer with the
     house (server/Usdc.js usdcTransfers). A long history is read a part at a
     time; while the answer says it stopped short, what it found shows and the
     screen asks again, and the server carries on from there. */
  let mvGen = 0, mvTimer = null;   // the current load, as txGen
  /* What a row is, by its kind (server/Usdc.js historyRowOf; Owen, 2026-10-15): the name, the
     amount on the right, and a second figure after the date. SOL rows came with card top-ups. */
  const solAmt = n => (Number(n) || 0).toFixed(4) + ' SOL';
  function moveParts(t, inb) {
    const sign = inb ? '+' : '−';
    switch (t.kind) {
      /* Dollars on the right on every row, like the balance and Transactions; the SOL that actually moved is the
         small figure after the date (stage 3 audit: the list switched units row by row). No price, no dollars. */
      case 'sol':
        return t.usd > 0
          ? { name: inb ? 'Add funds' : 'Withdraw', amt: sign + money(t.usd), extra: solAmt(t.sol) }
          : { name: inb ? 'Add funds' : 'Withdraw', amt: sign + solAmt(t.sol), extra: '' };
      case 'convert':
        return { name: 'Convert to USDC', amt: '+' + money(t.usdc), extra: t.sol > 0 ? 'from ' + solAmt(t.sol) : '', noPeer: true };
      case 'convertSol':
        return { name: 'Convert to SOL', amt: money(t.usdc), extra: t.sol > 0 ? 'as ' + solAmt(t.sol) : 'as SOL', noPeer: true };
      case 'withdrawSol':
        return { name: 'Withdraw', amt: '−' + money(t.usdc), extra: t.sol > 0 ? 'as ' + solAmt(t.sol) : 'as SOL' };
      default:
        return { name: inb ? 'Add funds' : 'Withdraw', amt: sign + money(t.usdc), extra: '' };
    }
  }
  function moveRow(t) {
    const inb = t.direction === 'in';
    const p = moveParts(t, inb);
    const peer = !p.noPeer && typeof t.peer === 'string' && SOL_ADDR.test(t.peer) ? t.peer : '';
    return '<div class="tx mv ph-no-capture">' +
      '<a class="mvl" href="https://solscan.io/tx/' + esc(t.signature) + '" ' +
        'target="_blank" rel="noopener noreferrer" title="View on Solscan">' +
        '<span class="txi ' + (inb ? 'in' : 'out') + '" aria-hidden="true">' + (inb ? ARROW_IN : ARROW_OUT) + '</span>' +
        '<span class="txw"><span class="txn">' + esc(p.name) + '</span>' +
          '<span class="txd">' + whenAt(t.at) + (p.extra ? ', ' + esc(p.extra) : '') + '</span></span>' +
        /* The amount sits in the link with what and when; the other wallet, with its copy button, is its own part
           of the row (a button cannot sit inside a link), beside it on a PC and under it on a phone. */
        '<span class="txa num ' + (inb ? 'in' : 'out') + '">' + esc(p.amt) + '</span></a>' +
      '<span class="mvr">' +
        (peer
          ? '<span class="mvp">' + (inb ? 'from ' : 'to ') +
              '<code title="' + esc(peer) + '">' + esc(ownShort(peer)) + '</code>' +
              '<button type="button" class="mcp" data-a="' + esc(peer) + '" ' +
                'onclick="V2Wallet.copyPeer(this)" aria-label="Copy the ' +
                (inb ? 'sender' : 'recipient') + ' address">' + COPY_ICON + '</button></span>'
          : '') +
      '</span></div>';
  }
  async function loadMoves(again, gen) {
    const a = w().address; if (!a) return;
    if (!again) { clearTimeout(mvTimer); gen = ++mvGen; again = 0; }
    const sec = el('w-moves'); if (!sec) return;
    if (!again) {
      sec.innerHTML = '<div class="whd"><h2>Add funds and Withdrawals</h2></div>' +
        '<div class="txcard"><div class="txl sc" id="w-mv" onscroll="V2Wallet.mvScroll()">' +
          '<div class="none">Loading…</div></div></div>';
    }
    let page = null;
    try {
      const r = await fetch('/api/my-transfers?wallet=' + encodeURIComponent(a));
      const j = await r.json();
      if (r.ok && Array.isArray(j.transfers)) page = j;
    } catch (_) {}
    const box = el('w-mv');
    if (!box || gen !== mvGen || w().address !== a) return;   // a newer load, or another wallet
    if (!page) {
      // What an earlier part found stays; the row under it says the rest did not come.
      const kept = box.querySelector('.mv');
      const tail = '<div class="none txtail">Could not load ' + (kept ? 'the rest' : 'these') +
        '.' + AGAIN + '</div>';
      if (kept) { const t = box.querySelector('.txtail'); if (t) t.remove(); box.insertAdjacentHTML('beforeend', tail); }
      else box.innerHTML = tail;
      return edge(box);
    }
    const rows = page.transfers.map(moveRow).join('');
    const going = !page.complete && again < 40;
    const top = box.scrollTop;
    box.innerHTML = rows + (going ? '<div class="none txtail">Looking further back…</div>'
      : rows ? '' : '<div class="none">Nothing added or withdrawn yet.</div>');
    box.scrollTop = top;                       // a part arriving never jumps the list
    edge(box);
    if (going) mvTimer = setTimeout(() => { if (gen === mvGen) loadMoves(again + 1, gen); }, 600);
  }
  function mvScroll() { const b = el('w-mv'); if (b) edge(b); }
  /* Copies the other wallet's whole address. Where the clipboard refuses, the
     row shows it in full, selected, as the player's own address row does. */
  function copyPeer(btn) {
    const a = btn && btn.getAttribute('data-a'); if (!a) return;
    const box = btn.parentNode;
    const done = (ok) => {
      if (!ok) {
        const code = box.querySelector('code');
        if (code) {
          code.textContent = a; box.classList.add('full');
          try { const r = document.createRange(); r.selectNodeContents(code);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (_) {}
        }
        return;
      }
      box.classList.add('done');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => box.classList.remove('done'), 1400);
      copied(a);
    };
    try { navigator.clipboard.writeText(a).then(() => done(true), () => done(false)); }
    catch (_) { done(false); }
  }
  /* Asks the chain again for both numbers, and says it is doing it. */
  async function refresh() {
    const b = el('w-refresh'); if (b) b.classList.add('spin');
    try { if (window.duelWalletRefresh) await window.duelWalletRefresh(); } catch (_) {}
    // The earnings under it too: it was the one section refresh left as it was.
    if (window.V2Stats) window.V2Stats.load();
    loadMoves();
    await loadTx();
    if (b) setTimeout(() => b.classList.remove('spin'), 300);
  }

  /* Two steps in one panel, replacing three stacked browser dialogs: a prompt
     for the address, a prompt for the amount, then a confirm. Those cannot be
     styled, cannot show the balance while you type an amount against it, and
     on a phone each one covers the whole screen. */
  function cashForm(bal) {
    if (solMode()) return cashFormSol();
    if (pending && pending.as === 'sol') {
      /* Withdraw as SOL: the dollars are converted on the way out, so the
         confirm step shows the SOL the address gets, from a price checked on
         the server, and the floor it cannot fall under. */
      const q = pending.quote;
      return '<div class="cashout">' +
        (q
          ? '<p class="note ph-no-capture">Send <b>' + money(pending.amt) + '</b> as about <b>' + solTxt(q.outAmount) + '</b> to</p>'
          : '<p class="note ph-no-capture">Send <b>' + money(pending.amt) + '</b> as SOL to</p>') +
        '<code class="cofull ph-no-capture">' + esc(pending.to) + '</code>' +
        (q
          ? '<p class="note ph-no-capture">At least ' + solFloor(q.minOut) + ' arrives if the price moves. On-chain transfers cannot be reversed.</p>'
          : '<p class="note" aria-live="polite">Getting a price…</p>') +
        '<div class="brow">' +
          '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.confirmCash()"' + (q && !pending.busy ? '' : ' disabled') + '>' +
            (pending.busy ? 'Sending…' : 'Send it') + '</button>' +
          '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.backCash()"' + (pending.busy ? ' disabled' : '') + '>Back</button>' +
        '</div></div>';
    }
    if (pending) {
      /* No "Confirm" label over it: the sentence and its "Send it" say so. */
      return '<div class="cashout">' +
        /* The destination in FULL here, the one place it has to be checked:
           a look-alike address can share its first and last characters with
           the real one, which is exactly what a shortened form shows. */
        '<p class="note ph-no-capture">Send <b>' + money(pending.amt) + '</b> to</p>' +
        '<code class="cofull ph-no-capture">' + esc(pending.to) + '</code>' +
        '<p class="note">On-chain transfers cannot be reversed.</p>' +
        '<div class="brow">' +
          '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.confirmCash()">Send it</button>' +
          '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.backCash()">Back</button>' +
        '</div></div>';
    }
    if (!swapOn()) payAs = 'usdc';
    /* Send as USDC or SOL (Owen, 2026-10-15). The amount stays in dollars
       either way; SOL is converted from it as it is sent. */
    const asRow = swapOn()
      ? '<div class="payas"><span class="k">Send as</span><div class="ds-seg" role="radiogroup" aria-label="Send as">' +
          ['usdc', 'sol'].map(v => '<button type="button" role="radio" aria-checked="' + (payAs === v) + '"' +
            ' class="pa' + (payAs === v ? ' on' : '') + '" onclick="V2Wallet.setPayAs(\'' + v + '\')">' +
            (v === 'usdc' ? 'USDC' : 'SOL') + '</button>').join('') +
        '</div></div>' +
        (payAs === 'sol'
          ? '<p class="note pahint">Converted from your USDC as it is sent. ' +
              money((w().swap && w().swap.minWithdrawSolUsd) || 1) + ' or more.</p>'
          : '')
      : '';
    /* The balance alone (the sheet is titled Withdraw), and the can't-be-
       reversed warning once, on the confirm step where it is read before
       sending, rather than on both steps (2026-10-15 audit). */
    /* Each box says what goes in it, and the amount's unit shows in the box itself (stage 3 audit: the unit was only
       in a placeholder). The To chip sits right before the address box (refreshChip puts it back there). */
    return '<div class="cashout">' +
      '<div class="ds-avail ph-no-capture"><span>Available</span><b class="num">' + balMoney(bal) + '</b></div>' +
      asRow +
      /* Enter in either field does what the Withdraw button does. */
      '<div class="ds-field"><label for="co-to">Send to</label>' +
      linkChip() +
      '<input class="fld ds-input" id="co-to" placeholder="Solana address" autocomplete="off" ' +
        'spellcheck="false" aria-label="Destination Solana address" ' +
        'onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()"></div>' +
      '<div class="ds-field"><label for="co-amt">Amount in dollars</label>' +
      '<div class="amtrow ds-input-wrap"><span class="ds-input-pre" aria-hidden="true">$</span>' +
        '<input class="fld num ds-input ds-input-money" id="co-amt" inputmode="decimal" placeholder="0.00" ' +
          'autocomplete="off" aria-label="Amount in US dollars" ' +
          'onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()">' +
        '<button type="button" class="maxbtn" onclick="V2Wallet.max()">Max</button>' +
      '</div></div>' +
      /* Empty until there is something to say: the available figure is
         already the big number at the top of this sheet. */
      '<p class="note ph-no-capture" id="co-msg"></p>' +
      '<div class="brow">' +
        /* Withdraw, like the button and the sheet: "Cash out" is what you do
           to leave a game with your winnings, a different thing. */
        '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.submitCash()">Withdraw</button>' +
        '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelCash()">Cancel</button>' +
      '</div></div>';
  }

  /* ── The Withdraw amount in dollars or SOL (Owen 2026-11-05) ──────────────────────────────────────────────────
     A SOL withdraw's amount can be typed in USD (the default) or in SOL, with a small toggle beside the box, and the
     other unit shown live under it. Dollars become SOL at the server's own display rate (the price every dollar
     figure on the site is shown at: money.price, /api/money-config), read for this sheet and used only while it is
     under a minute old. With no such price a dollar amount is refused, never guessed: switch to SOL, or wait.
     Dollars to SOL rounds DOWN to the 0.000001 SOL the form shows, so $20 never sends more than $20 of SOL, and
     every check is on the lamports themselves, so no rounding can take a send past the balance after the fee.
     Every open starts in USD (money review 2026-11-05): a remembered SOL would turn a "20" typed as dollars into
     20 SOL, so the choice lasts only while the sheet is open. */
  const PRICE_MAX_AGE_MS = 60000;
  let wdUnit = 'usd';
  let wdExact = null;       // { unit, text, lamports }: Max (or a unit switch) filled exactly this many lamports
  let wdTicket = 0;         // bumped on every open, close, back and switch: a price that comes back late is dropped
  let px = null, pxAsk = null;   // { usd, at }: the last price asked for (usd 0: none came), and the ask in flight
  /* Integer-exact on the lamport side, like the server's solPrice.js: micro-dollars first, then BigInt. */
  function usdToLamports(usd, rate) {
    const micro = Math.round(Number(usd) * 1e6), rateMicro = Math.round(Number(rate) * 1e6);
    if (!Number.isSafeInteger(micro) || micro < 0 || !(rateMicro > 0) || !Number.isSafeInteger(rateMicro)) return 0;
    const l = Number((BigInt(micro) * 1000000000n) / BigInt(rateMicro));
    return Math.floor(l / 1000) * 1000;      // down to the 0.000001 SOL the form shows
  }
  // What lamports are worth, in whole cents: down for a figure that must never overstate, up for a smallest amount.
  function lamportsToCents(lamports, rate, up) {
    const l = Math.floor(Number(lamports)), rateMicro = Math.round(Number(rate) * 1e6);
    if (!(l >= 0) || !Number.isSafeInteger(l) || !(rateMicro > 0)) return 0;
    const n = BigInt(l) * BigInt(rateMicro), d = 10000000000000n;   // lamports * micro-dollars per SOL / 1e9 / 1e4
    return Number(up ? (n + d - 1n) / d : n / d);
  }
  const centsText = c => (c / 100).toFixed(2);
  // Lamports as SOL in the box: six places at most, no trailing zeros.
  const solText = lamports => (Math.floor(Number(lamports) / 1000) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  // The price, while it is under a minute old (a clock set back never makes it younger); else 0.
  function rateNow() {
    const p = px, t = Date.now();
    return p && p.usd > 0 && t >= p.at - 5000 && t - p.at < PRICE_MAX_AGE_MS ? p.usd : 0;
  }
  // Asks the server for its price now. Resolves to rateNow(). One ask at a time; aged from when it was asked.
  function askPrice() {
    if (pxAsk) return pxAsk;
    const at = Date.now();
    const got = usd => { px = { usd: usd, at: at }; };
    pxAsk = Promise.resolve()
      .then(() => window.fetch('/api/money-config', { cache: 'no-store' }))
      .then(r => (r && r.ok ? r.json() : null))
      .then(j => { const u = Number(j && j.solUsd); got(isFinite(u) && u > 0 ? u : 0); }, () => got(0))
      .then(() => { pxAsk = null; wdFigures(); return rateNow(); });
    return pxAsk;
  }
  /* Asked again once the one held is half its life old (or from a clock since set back); a failed ask waits as long
     before the next, so never a loop. */
  function priceWanted() {
    if (pxAsk) return false;
    const age = px ? Date.now() - px.at : Infinity;
    return !(age >= 0 && age < PRICE_MAX_AGE_MS / 2);
  }
  const NO_PRICE = 'The SOL price is not available right now, so dollars cannot be turned into SOL. Try again in a moment, or switch to SOL.';
  const usdUnit = () => curAsset() === 'sol' && wdUnit === 'usd';
  const amountRaw = () => ((el('co-amt') || {}).value || '').trim().replace(',', '.').replace(/^\$\s*/, '');
  // The lamports the box holds now, in its unit: 0 for nothing, or for dollars with no price.
  function typedLamports(raw, rate) {
    if (wdExact && wdExact.unit === wdUnit && raw === wdExact.text) return wdExact.lamports;
    const n = Number(raw);
    if (!raw || !isFinite(n) || n <= 0) return 0;
    if (wdUnit === 'usd') return rate ? usdToLamports(n, rate) : 0;
    return Math.round(n * 1e9);
  }
  /* What is wrong with sending `lamports` of SOL, in words, or '' (rate 0: the words are in SOL). The widget checks the
     same against a fresh balance before it signs (main.jsx duelWalletSend); an unread or stale balance is left to it. */
  function solProblem(lamports, rate) {
    const usd = !!rate && wdUnit === 'usd';
    const dollars = l => money(lamportsToCents(l, rate) / 100);
    if (!(lamports >= MIN_SEND_LAMPORTS)) return 'The smallest withdrawal is ' +
      (usd ? money(lamportsToCents(MIN_SEND_LAMPORTS, rate, true) / 100) + ' (0.001 SOL)' : '0.001 SOL') +
      '. The network refuses less to a wallet that is new to it.';
    if (!solKnown()) return '';
    if (!canSendSol()) return 'The SOL in your wallet is kept for network fees.';
    if (lamports > solLamports() - SEND_FEE_LAMPORTS) return usd
      ? 'That is more than the ' + dollars(solLamports()) + ' you have. Max sends the most you can.'
      : 'That is more than the ' + solTxt(solLamports()) + ' you have.';
    if (lamports > maxSendLamports()) return usd
      ? 'You can withdraw up to ' + dollars(Math.floor(maxSendLamports() / 1000) * 1000) + '. 0.001 SOL stays in your wallet for network fees. Max sends the most you can.'
      : 'Keep at least 0.001 SOL in your wallet for network fees. Max sends the most you can.';
    return '';
  }
  /* The line under the box: the other unit, live. Written in place (a redraw would drop the box's focus and a phone's
     keyboard), and only ever words: it decides nothing. */
  function wdFigures() {
    const alt = el('co-alt');
    if (!alt || !cashing || pending || !solMode() || curAsset() !== 'sol') return;
    if (priceWanted()) askPrice();
    const r = rateNow(), raw = amountRaw();
    if (wdUnit === 'usd') {
      if (!r) {
        alt.textContent = pxAsk || !px ? 'Getting the SOL price…' : 'The SOL price is not available right now.';
        return;
      }
      const lam = typedLamports(raw, r);
      alt.textContent = lam > 0 ? '≈ ' + solFloor(lam) : '';
      return;
    }
    const lam = typedLamports(raw, r);
    alt.textContent = lam > 0 && r ? '≈ ' + money(lamportsToCents(lam, r) / 100) : '';
  }
  /* The toggle: the amount keeps its value in the other unit (the lamports it stood for, exactly), the address stays.
     Switched straight back with the box untouched, it shows what was typed there before, as it was typed. */
  function setUnit(u) {
    if ((u !== 'usd' && u !== 'sol') || !solMode() || pending || !cashing) return;
    if (u === wdUnit) return;
    const to = (el('co-to') || {}).value || '', r = rateNow(), raw = amountRaw();
    const was = wdExact, untouched = !!(was && was.unit === wdUnit && raw === was.text);
    const lam = Math.floor(typedLamports(raw, r) / 1000) * 1000;
    const from = { unit: wdUnit, text: raw, exact: untouched ? was : null };
    wdUnit = u; wdTicket++; wdExact = null;
    drawCash();
    if (el('co-to')) el('co-to').value = to;
    const box = el('co-amt');
    if (box && untouched && was.back && was.back.unit === u) {
      box.value = was.back.text; wdExact = was.back.exact;
    } else if (box && lam > 0 && (u === 'sol' || r)) {
      const text = u === 'sol' ? solText(lam) : centsText(lamportsToCents(lam, r));
      wdExact = { unit: u, text: text, lamports: lam, back: from };
      box.value = text;
    } else if (box && raw) {
      box.value = '';
      wdExact = { unit: u, text: '', lamports: 0, back: from };   // no price to convert at: empty, and back gives it again
    }
    wdFigures();
  }

  /* The withdraw sheet in SOL mode: SOL by default, USDC too while old USDC is in the wallet. A SOL amount is typed in
     dollars or in SOL (the toggle above); old USDC is typed in USDC. */
  function cashFormSol() {
    const as = curAsset();
    if (pending) {
      const p = pending;
      const fee = solPlain(SEND_FEE_LAMPORTS / 1e9);
      const what = p.asset === 'usdc' ? '<b>' + money(p.amt) + ' USDC</b>'
        : p.unit === 'usd' ? '<b>' + money(p.usd) + '</b> as <b>' + solPlain(p.amt) + '</b>'
        : '<b>' + solPlain(p.amt) + '</b>' + (p.rate > 0 ? ' (about ' + money(lamportsToCents(p.lamports, p.rate) / 100) + ')' : '');
      const sub = p.asset === 'usdc' ? '' : p.unit === 'usd'
        ? 'At ' + money(p.rate) + ' a SOL, plus the ' + fee + ' network fee. '
        : 'Plus the ' + fee + ' network fee. ';
      return '<div class="cashout">' +
        '<p class="note ph-no-capture">Send ' + what + ' to</p>' +
        '<code class="cofull ph-no-capture">' + esc(p.to) + '</code>' +
        (p.moved ? '<p class="note" data-state="bad">The SOL price moved while this was open. This is the amount at the price now.</p>' : '') +
        '<p class="note ph-no-capture">' + sub + 'On-chain transfers cannot be reversed.</p>' +
        '<div class="brow">' +
          '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.confirmCash()"' + (p.busy ? ' disabled' : '') + '>' +
            (p.busy ? 'Getting the SOL price…' : 'Send it') + '</button>' +
          '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.backCash()"' + (p.busy ? ' disabled' : '') + '>Back</button>' +
        '</div></div>';
    }
    const asRow = usdcOn()
      ? '<div class="payas"><span class="k">Send as</span><div class="ds-seg" role="radiogroup" aria-label="Send as">' +
          ['sol', 'usdc'].map(v => '<button type="button" role="radio" aria-checked="' + (as === v) + '"' +
            ' class="pa' + (as === v ? ' on' : '') + '" onclick="V2Wallet.setPayAs(\'' + v + '\')">' +
            (v === 'sol' ? 'SOL' : 'USDC') + '</button>').join('') +
        '</div></div>'
      : '';
    const usd = as === 'sol' && wdUnit === 'usd', dollarBox = as === 'usdc' || usd;
    const label = as === 'usdc' ? 'Amount in USDC' : usd ? 'Amount in dollars' : 'Amount in SOL';
    // USD or SOL, beside the box's label: the kit's segmented control, small.
    const unitSeg = as !== 'sol' ? '' :
      '<div class="ds-seg unitseg" role="radiogroup" aria-label="Type the amount in">' +
        [['usd', 'USD'], ['sol', 'SOL']].map(v => '<button type="button" role="radio" aria-checked="' + (wdUnit === v[0]) + '"' +
          ' onclick="V2Wallet.setUnit(\'' + v[0] + '\')">' + v[1] + '</button>').join('') +
      '</div>';
    /* What can go, in dollars (the USDC as USDC), then the SOL itself small under it. */
    return '<div class="cashout">' +
      '<div class="ds-avail ph-no-capture"><span>Available</span><b class="num">' +
        (as === 'usdc' ? money(usdcBal()) + '<span class="cvu"> USDC</span>' : bigBal(w().balance)) + '</b></div>' +
      (as !== 'sol' ? '' : solKnown() ? '<p class="note ph-no-capture">You have ' + solTxt(solLamports()) + '. Keep ' + solTxt(KEEP_LAMPORTS) +
        ' in your wallet for network fees.</p>'
        : '<p class="note">Could not read your balance just now. You can still withdraw: the network refuses more than your wallet has.</p>') +
      asRow +
      '<div class="ds-field"><label for="co-to">Send to</label>' +
      linkChip() +
      '<input class="fld ds-input" id="co-to" placeholder="Solana address" autocomplete="off" ' +
        'spellcheck="false" aria-label="Destination Solana address" ' +
        'onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()"></div>' +
      '<div class="ds-field"><div class="amthead"><label for="co-amt">' + label + '</label>' + unitSeg + '</div>' +
      '<div class="amtrow ds-input-wrap">' + (dollarBox ? '<span class="ds-input-pre" aria-hidden="true">$</span>' : '') +
        '<input class="fld num ds-input ds-input-money" id="co-amt" inputmode="decimal" placeholder="' + (dollarBox ? '0.00' : '0.0000') + '" ' +
          'autocomplete="off" aria-label="' + (as === 'usdc' ? 'Amount in USDC' : usd ? 'Amount in US dollars' : 'Amount in SOL') + '" ' +
          'oninput="V2Wallet.hint()" onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()">' +
        (dollarBox ? '' : '<span class="co-unit" aria-hidden="true">SOL</span>') +
        '<button type="button" class="maxbtn" onclick="V2Wallet.max()"' + (maxOff(as) ? ' disabled' : '') + '>Max</button>' +
      '</div>' +
      (as === 'sol' ? '<p class="note num ph-no-capture" id="co-alt" aria-live="polite"></p>' : '') +
      '</div>' +
      '<p class="note ph-no-capture" id="co-msg"></p>' +
      '<div class="brow">' +
        '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.submitCash()">Withdraw</button>' +
        '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelCash()">Cancel</button>' +
      '</div></div>';
  }

  // where: which button asked, for the sign-in funnel (signin_opened); the Wallet tab's own Sign in by default
  function login(where) { if (window.duelWalletLogin) window.duelWalletLogin(typeof where === 'string' ? where : 'wallet'); }

  /* Product tracking (shared/trackPlan.js, public/js/shared/dsTrack.js): Add funds and Withdraw opening, and a withdraw
     that did not go through. Never a figure or an address: an error is sent as its words, with every number and
     anything shaped like an address or a signature taken out. A fault in it never reaches the money code around it. */
  const errWords = m => String(m || '').replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '…').replace(/\$?\d+(?:[.,]\d+)*/g, '#').slice(0, 100);
  function addFundsOpened(method) {
    try { if (window.DSTrack) window.DSTrack.event('add_funds_opened', { where: fundWhere, method: method }); } catch (_) {}
  }
  function withdrawFailed(e, asset) {
    try { if (window.DSTrack) window.DSTrack.event('withdraw_failed', { error: errWords(e && e.message ? e.message : e), asset: asset }); } catch (_) {}
  }

  function fund() {
    if (!connected()) return login();
    if (!window.duelWalletFund) return note('Your wallet is still starting. Try again in a moment.');
    /* Always Privy's own sheet (Owen 2026-10-26: its look reads as safe). Phantom is in it as Transfer from wallet
       once the dashboard has that on; until then addChip() puts "Add from Phantom" beside this button. */
    privyFund();
  }
  /* The widget owns the funding flow; a rejection here is the user closing
     it or the provider refusing, not something to swallow silently. */
  /* Privy's sheet, Pay with card and Receive funds (Owen, 2026-10-15, like
     playpulp.io). A card buys SOL, which Convert to USDC turns into dollars;
     the amount is chosen on MoonPay's own screen, in the player's currency.
     method 'card' or 'manual' opens it on that one. */
  function privyFund(method) {
    addFundsOpened(method === 'card' ? 'card' : method === 'manual' ? 'crypto' : 'any');
    window.duelWalletFund(method).catch(e => {
      const why = e && e.message ? e.message : 'Try again.';
      if (window.DSToast) window.DSToast.show({ kind: 'err', title: 'Add funds did not open', detail: why });
      else note('Add funds did not open: ' + why);
    });
  }
  /* Add from a browser wallet, for a Google or email player while Privy's sheet has no Transfer from wallet: the
     linked one, or an installed one, which links on the tap. Our own sheet, never with Privy's badge on it. */
  function addFromWallet() {
    const W = w();
    if (W.walletFunding || W.external) return fund();
    if (W.linked) {
      if (!W.linked.here) return note('Open DuelSeries in the browser where ' + W.linked.name + ' is installed to add funds from it.');
      return openAdd();
    }
    const x = (W.linkable || [])[0];
    if (!x) return fund();
    linkFlow(x).then(ok => { if (ok && w().linked && w().linked.here) openAdd(); });
  }
  function addChip() {
    const W = w();
    if (W.walletFunding || W.external) return '';
    const name = W.linked ? W.linked.name : ((W.linkable || [])[0] || {}).label;
    return name ? '<div class="wadd"><button type="button" class="ds-btn ds-btn-quiet ds-btn-sm tolink" onclick="V2Wallet.addFromWallet()">Add from ' + esc(name) + '</button></div>' : '';
  }
  /* Link a browser wallet: its connect, then one signature Privy keeps on the account. Resolves true once the
     widget shows it linked. */
  async function linkFlow(x) {
    const D = window.DSDialog;
    if (!window.duelWalletLink) { note('Your wallet is still starting. Try again in a moment.'); return false; }
    if (D) D.busy({ title: 'Linking ' + x.label, line: 'Approve the connection, then sign the message in ' + x.label +
      '. It moves no money. ' + x.label + ' can then also sign you in to this account.' });
    try {
      const r = await window.duelWalletLink(x.id);
      for (let i = 0; i < 40 && !(w().linked && w().linked.address === r.address); i++) await new Promise(res => setTimeout(res, 125));
      if (D) D.close();
      if (!w().linked) { note('Linked, but the page has not caught up. Reload and try again.'); return false; }
      if (window.DSToast) window.DSToast.show({ kind: 'ok', title: x.label + ' linked', code: ownShort(r.address) });
      return true;
    } catch (e) {
      if (D) D.close();
      const m = (e && e.message) || '';
      if (Number(e && e.code) === 4001 || /reject|denied|declin|cancel|closed/i.test(m)) return false;
      if (D) D.alert({ title: 'Could not link ' + x.label, line: m || 'Try again.' });
      return false;
    }
  }
  function unlink() {
    const L = w().linked, D = window.DSDialog;
    if (!L || !window.duelWalletUnlink) return;
    const go = D ? D.confirm({ title: 'Unlink ' + L.name + '?', line: 'Nothing moves: its money stays in it, and it stops signing you in here. You can link it again any time.', ok: 'Unlink', cancel: 'Keep it' })
                 : Promise.resolve(true);
    go.then(yes => {
      if (!yes) return;
      return window.duelWalletUnlink().then(() => {
        if (window.DSToast) window.DSToast.show({ kind: 'ok', title: L.name + ' unlinked', code: ownShort(L.address) });
      }, e => note('Could not unlink: ' + (e && e.message ? e.message : 'try again.')));
    });
  }

  /* -- Add funds from the linked wallet: an amount in dollars (shown in SOL), one approval in that wallet -- */
  /* { have, max, exact, rate } while the sheet is open. rate is the server's display rate when the sheet opened, or
     0 (then the amount is typed in SOL): fixed for the sheet's life, so a balance read that drops the rate can never
     turn "5" typed as dollars into 5 SOL (Fable review 2026-10-26). */
  let adding = null;
  const rate = () => (Number(w().solUsd) > 0 ? Number(w().solUsd) : 0);
  function openAdd() {
    adding = { have: null, max: 0, exact: null, rate: rate() };
    addFundsOpened('linked');
    drawAdd();
    el('adveil').classList.add('on');
    if (window.sheetFocus) window.sheetFocus.open('adveil');
    readLinked();
  }
  function readLinked() {
    const mine = adding;
    if (!mine) return;
    mine.have = null; addFigures();
    window.duelWalletLinkedBalance().then(b => {
      if (adding !== mine) return;
      mine.have = b.lamports; mine.max = b.max || 0; addFigures();
    }, () => { if (adding === mine) { mine.have = -1; mine.max = 0; addFigures(); } });
  }
  // The linked wallet's figures, in place: redrawing the form would drop the field's focus (and a phone's keyboard).
  function addFigures() {
    const a = adding, L = w().linked;
    if (!a || !L) return;
    const r = a.rate;
    const fig = el('ad-fig'), have = el('ad-have'), mx = document.querySelector('#ad-body .maxbtn');
    if (fig) fig.textContent = a.have > 0 && r ? balMoney(a.have / 1e9 * r) : a.have > 0 ? solTxt(a.have) : a.have === 0 ? (r ? money(0) : solTxt(0)) : '…';
    // unreadable just now, the add still goes: the linked wallet shows what it can send (night review 2026-10-29)
    if (have) have.textContent = a.have == null ? 'Reading ' + L.name + '…' : a.have < 0 ? 'Could not read ' + L.name + '\'s balance just now. You can still add: ' + L.name + ' shows what it can send.'
      : L.name + ' has ' + solTxt(a.have) + '. It keeps ' + solTxt(KEEP_LAMPORTS) + ' for network fees.';
    if (mx) mx.disabled = !(a.max > 0);
  }
  function drawAdd() {
    const b = el('ad-body'), L = w().linked;
    if (!b || !adding || !L) return;
    const t = el('ad-title'); if (t) t.textContent = 'Add from ' + L.name;
    const a = adding, r = a.rate;
    const typed = el('ad-amt') ? el('ad-amt').value : '';
    b.innerHTML = '<div class="cashout">' +
      '<p class="note">From <b>' + esc(L.name) + '</b> <code class="ph-no-capture">' + esc(ownShort(L.address)) + '</code> to your DuelSeries wallet</p>' +
      // the linked wallet's figure on the right, its name on the left (the Withdraw sheet's Available row)
      '<div class="mfig ph-no-capture"><div class="v num" id="ad-fig">…</div><div class="k">In ' + esc(L.name) + '</div></div>' +
      '<p class="note ph-no-capture" id="ad-have"></p>' +
      '<div class="ds-field"><label for="ad-amt">' + (r ? 'Amount in dollars' : 'Amount in SOL') + '</label>' +
      '<div class="amtrow ds-input-wrap">' + (r ? '<span class="ds-input-pre" aria-hidden="true">$</span>' : '') +
        // the unit shows in the field itself: dollars when the sheet opened with a price, else SOL
        '<input class="fld num ds-input ds-input-money" id="ad-amt" inputmode="decimal" placeholder="' + (r ? '0.00' : '0.0000') + '" autocomplete="off" ' +
          'aria-label="' + (r ? 'Amount in US dollars' : 'Amount in SOL') + '" oninput="V2Wallet.addHint()" ' +
          'onkeydown="if(event.key===\'Enter\')V2Wallet.submitAdd()">' +
        (r ? '' : '<span class="co-unit" aria-hidden="true">SOL</span>') +
        '<button type="button" class="maxbtn" onclick="V2Wallet.addMax()"' + (a.max > 0 ? '' : ' disabled') + '>Max</button>' +
      '</div></div>' +
      '<p class="note ph-no-capture" id="ad-msg"></p>' +
      '<div class="brow">' +
        '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.submitAdd()"' + (a.busy ? ' disabled' : '') + '>Add funds</button>' +
        '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelAdd()">Cancel</button>' +
      '</div></div>';
    addFigures();
    if (typed && el('ad-amt')) { el('ad-amt').value = typed; addHint(); }
  }
  // The amount typed, in lamports: dollars at the server's display rate (SOL mode), or SOL as typed.
  function addLamports() {
    const raw = ((el('ad-amt') || {}).value || '').trim().replace(',', '.').replace(/^\$\s*/, '');
    const n = Number(raw);
    if (!raw || !isFinite(n) || n <= 0) return 0;
    if (adding && adding.exact && raw === adding.exact.text) return adding.exact.lamports;
    const r = adding ? adding.rate : 0;
    return Math.floor((r ? n / r : n) * 1e9);
  }
  function addSay(msg, bad) {
    const m = el('ad-msg'); if (!m) return;
    m.textContent = msg || ''; m.dataset.state = bad ? 'bad' : '';
  }
  function addHint() {
    const lam = addLamports(), r = adding ? adding.rate : 0;
    addSay(lam > 0 && r ? 'About ' + solTxt(lam) : '', false);
  }
  function addMax() {
    if (!adding || !(adding.max > 0)) return;
    const r = adding.rate;
    const text = r ? (Math.floor(adding.max / 1e9 * r * 100) / 100).toFixed(2) : (Math.floor(adding.max / 1000) / 1e6).toFixed(6);
    adding.exact = { text: text, lamports: adding.max };
    const f = el('ad-amt'); if (f) f.value = text;
    addHint();
  }
  function cancelAdd() {
    if (adding && adding.busy) return;
    adding = null;
    if (!el('adveil') || !el('adveil').classList.contains('on')) return;
    el('adveil').classList.remove('on');
    if (window.sheetFocus) window.sheetFocus.close();
  }
  function submitAdd() {
    const a = adding, L = w().linked;
    if (!a || a.busy || !L) return;
    const lam = addLamports(), r = a.rate;
    if (!(lam > 0)) return addSay('Enter an amount to add.', true);
    if (lam < 1000000) return addSay('Add at least ' + (r ? 'about ' + money(0.001 * r) : '0.001 SOL') + '.', true);
    if (a.have == null) return addSay('Still reading ' + L.name + '\'s balance.', true);
    /* An unreadable balance does not stop the add (night review 2026-10-29, third pass): the widget reads it again
       fresh before it builds anything, and the linked wallet and the chain refuse what it cannot send. */
    if (a.have >= 0 && lam > a.max) return addSay('That is more than ' + L.name + ' can send. It keeps 0.001 SOL for network fees.', true);
    // The sheet closes; one card follows the transfer: approve, then done or failed in place.
    adding = null;
    el('adveil').classList.remove('on');
    if (window.sheetFocus) window.sheetFocus.close();
    const usd = r ? lam / 1e9 * r : 0;
    const amt = r ? money(usd) : solTxt(lam);
    const T = window.DSToast;
    let card = null, unexpect = null;
    try { if (T) card = T.show({ kind: 'info', title: 'Approve in ' + L.name, amount: amt, detail: 'to add to your wallet', sticky: true }); } catch (_) {}
    const upd = (o, plain, good) => { try { if (card) return card.update(o); } catch (_) {} note(plain, good); };
    const onSigned = () => {
      try { if (T && T.expectRise && usd) unexpect = T.expectRise(usd); } catch (_) {}
      upd({ kind: 'info', title: 'Adding funds', amount: amt, detail: 'from ' + L.name, sticky: true }, 'Adding funds.');
    };
    window.duelWalletAddFromLinked(lam, { onSigned: onSigned }).then(() => {
      upd({ kind: 'money', title: 'Funds added', amount: '+' + amt, detail: 'from ' + L.name, code: '' }, 'Funds added: ' + amt + '.', true);
      if (window.duelWalletRefresh) window.duelWalletRefresh();
      if (onScreen()) { loadTx(); loadMoves(); }
    }, e => {
      const m = (e && e.message) || 'Try again.';
      // sent but not confirmed yet: it may still land, so it is never "try again" (that could add twice)
      if (/not confirmed in time|still confirming|timed? ?out/i.test(m)) {
        upd({ kind: 'info', title: 'Still confirming', amount: amt, detail: 'Check your balance before trying again', code: '' }, 'Still confirming. Check your balance before trying again.');
        if (window.duelWalletRefresh) setTimeout(window.duelWalletRefresh, 15000);
        return;
      }
      try { if (unexpect) unexpect(); } catch (_) {}
      const refused = Number(e && e.code) === 4001 || /reject|denied|declin|cancel|closed/i.test(m);
      upd(refused ? { kind: 'info', title: 'Nothing was sent', amount: '', detail: 'You closed it in ' + L.name, code: '' }
                  : { kind: 'err', title: 'Add funds failed', amount: '', detail: m, code: '' },
          refused ? 'Nothing was sent.' : 'Add funds failed: ' + m);
    });
  }

  /* Withdraw: "To Phantom" fills the address with the linked wallet (linking it first when it is only installed).
     The rest is the ordinary withdraw, its checks and its confirm step. */
  function linkChip() {
    const W = w();
    if (W.external) return '';
    if (W.linked) return '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm tolink" onclick="V2Wallet.toLinked()">To ' + esc(W.linked.name) +
      ' <span class="num ph-no-capture">' + esc(ownShort(W.linked.address)) + '</span></button>';
    const L = W.linkable || [];
    return L.length ? '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm tolink" onclick="V2Wallet.toLinked()">To ' + esc(L[0].label) + '</button>' : '';
  }
  /* The withdraw sheet is not redrawn while open (it would lose what was typed); its To chip follows the linked
     wallet on its own, so an Unlink, or a link from elsewhere, never leaves an old address behind it. */
  function refreshChip() {
    const body = el('wdr-body'); if (!body) return;
    const chip = body.querySelector('.tolink');
    const html = linkChip();
    if (chip) { if (html) chip.outerHTML = html; else chip.remove(); return; }
    const to = el('co-to');
    if (html && to && to.parentNode) to.insertAdjacentHTML('beforebegin', html);
  }
  async function toLinked() {
    let L = w().linked;
    if (!L) {
      const x = (w().linkable || [])[0];
      if (!x || !(await linkFlow(x))) return;
      L = w().linked;
      if (!L) return;
      // the sheet keeps what was typed; only the chip's words change
      const chip = document.querySelector('#wdr-body .tolink');
      if (chip) chip.innerHTML = 'To ' + esc(L.name) + ' <span class="num ph-no-capture">' + esc(ownShort(L.address)) + '</span>';
    }
    const f = el('co-to');
    if (f) { f.value = L.address; say(''); }
  }

  /* Cash out sends from the player's own wallet to an address they give us.
     The amount and destination are theirs; this screen only collects them and
     hands both to the widget, which owns every part of the money. */
  /* Add funds opens the QR code and the card and exchange options straight
     away (fund, above). It used to open our own sheet first, which repeated
     the address and warning already on the Wallet tab (Owen, 2026-10-15). */

  function cashOut(asset) {
    if (!connected()) return login();
    if (!window.duelWalletSend) return note('Your wallet is still starting. Try again in a moment.');
    if (solMode()) {
      // SOL mode: the SOL less what is kept for fees, or the old USDC, whichever there is. "Withdraw USDC" opens on USDC.
      // (an unread balance still opens it: solKnown)
      if (solKnown() && !canSendSol() && !usdcOn()) return note(solLamports() > 0
        ? 'The SOL in your wallet is kept for network fees.' : 'There is nothing to withdraw yet.');
      wdAsset = (asset === 'usdc' && usdcOn()) || (solKnown() && !canSendSol()) ? 'usdc' : 'sol';
      // USD on every open; a fresh price for the dollars, asked now
      wdUnit = 'usd'; wdExact = null; wdTicket++;
      if (priceWanted()) askPrice();
    } else if ((Number(w().balance) || 0) <= 0) return note('There is nothing to withdraw yet.');
    cashing = true; pending = null;
    drawCash();
    el('wdrveil').classList.add('on');
    try { if (window.DSTrack) window.DSTrack.event('withdraw_opened', { where: asset === 'usdc' ? 'usdc_line' : 'wallet' }); } catch (_) {}
    /* No field is focused on open (Owen, 2026-10-15). Focusing the address
       field threw the phone keyboard over the sheet before anybody had read
       it; the keyboard comes up when they tap a field, which is when they want
       it. Focus goes to the close button instead (sheetFocus), which raises
       nothing. */
    if (window.sheetFocus) window.sheetFocus.open('wdrveil');
  }
  function drawCash() {
    const b = el('wdr-body'); if (b) b.innerHTML = cashForm(Number(w().balance) || 0);
    wdFigures();
  }
  function cancelCash() {
    if (pending && pending.busy && pending.as === 'sol') return;   // a withdrawal as SOL is being sent (USDC mode)
    cashing = false; pending = null; wdTicket++; wdExact = null;
    if (!el('wdrveil').classList.contains('on')) return;
    el('wdrveil').classList.remove('on');
    if (window.sheetFocus) window.sheetFocus.close();
  }
  function backCash() {
    if (pending && pending.busy && pending.as === 'sol') return;
    const p = pending;
    pending = null; wdTicket++; drawCash();
    // Back to the form with what was typed still in it (a SOL send: as it was typed, in its unit).
    if (p && el('co-to')) el('co-to').value = p.to;
    if (p && el('co-amt')) el('co-amt').value = p.text != null ? p.text : String(p.amt);
    wdFigures();
  }
  function max() {
    const a = el('co-amt');
    // Filled, not focused: a tap on Max should not raise the keyboard either.
    if (a && solMode()) {
      if (maxOff(curAsset())) return;
      /* SOL mode: Max is the SOL less 0.001 SOL and the fee, rounded DOWN to six places, so the wallet is never
         left holding dust; old USDC goes whole (to the cent). In dollars it is those same lamports, exactly: the box
         shows what they are worth, down to the cent, and sends them (wdExact), so Max is never a cent short or over. */
      if (curAsset() === 'usdc') { a.value = cents(w().usdc).toFixed(2); return hint(); }
      const lam = Math.floor(maxSendLamports() / 1000) * 1000;
      if (wdUnit === 'sol') { wdExact = null; a.value = (lam / 1e9).toFixed(6); return hint(); }
      const t = wdTicket;
      const fill = () => {
        const r = rateNow();
        if (t !== wdTicket || pending || el('co-amt') !== a) return;
        if (!r) return say(NO_PRICE);
        const c = lamportsToCents(lam, r);
        // (a few thousandths of a dollar at a very low price: $0.00 is not an amount to send)
        if (!(c > 0)) return say('That is less than a cent at the SOL price now. Switch to SOL to send it.');
        const text = centsText(c);
        wdExact = { unit: 'usd', text: text, lamports: lam };
        a.value = text; say(''); hint();
      };
      return rateNow() ? fill() : askPrice().then(fill);
    }
    if (a) a.value = cents(w().balance).toFixed(2);
  }
  // SOL mode: the amount in the other unit under the box (wdFigures), and a refusal under it cleared as it is typed.
  function hint() {
    if (!solMode() || curAsset() !== 'sol') return;
    const m = el('co-msg');
    if (m && m.dataset.state === 'bad') say('');
    wdFigures();
  }
  // A refusal in the form reads as one: the error red, not the hint grey (calm: a plain line, like a wait).
  function say(msg, calm) {
    const m = el('co-msg');
    if (!m) return note(msg);
    m.textContent = msg; m.dataset.state = msg && !calm ? 'bad' : '';
  }

  /* Checked here as well as in the widget, so a bad amount is answered in the
     form instead of by a rejected transaction. The widget stays the authority
     on what actually sends; this only catches the obvious cases early: a
     destination that is not a Solana address at all, or is this wallet's own,
     and an amount in more than cents, which the confirm step could only show
     rounded. A comma is read as the decimal point. */
  const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  /* SOL mode: the same destination checks, then the amount in the asset being sent. A SOL send must leave 0.001
     SOL after the fee (Max does); anything more is refused here in words, and again by the widget. */
  function submitCashSol() {
    const as = curAsset();
    const to = ((el('co-to') || {}).value || '').trim();
    const raw = amountRaw();   // a comma read as the point, a typed $ left out
    const amt = Number(raw);
    if (!to) return say('Paste the Solana address to send to.');
    if (!SOL_ADDR.test(to)) return say('That is not a Solana address.');
    if (to === w().address) return say('That is this wallet\'s own address.');
    if (!raw || !isFinite(amt) || amt <= 0) return say('Enter an amount to withdraw.');
    if (as === 'usdc') {
      if (/\.\d{3,}$/.test(raw)) return say('Use dollars and cents, two decimal places at most.');
      // (a stale USDC figure is not checked against: the widget sends and the network refuses an overdraw)
      if (!stale() && amt > usdcBal()) return say('That is more than the ' + money(usdcBal()) + ' USDC you have.');
      /* the fee, the receiver's USDC account rent if it has none (the sender pays it), then 0.001 SOL left over; only on
         a SOL balance that was read, like the widget's own check (night review 2026-10-29, fourth pass) */
      if (solKnown() && solLamports() < KEEP_LAMPORTS + SEND_FEE_LAMPORTS + 2039280) return say('Add a little SOL first. Sending USDC needs about 0.003 SOL for network fees.');
      pending = { to: to, amt: amt, asset: as };
      return drawCash();
    }
    const usd = wdUnit === 'usd';
    if (usd && /\.\d{3,}$/.test(raw)) return say('Use dollars and cents, two decimal places at most.');
    if (!usd && /\.\d{7,}$/.test(raw)) return say('Use six decimal places at most.');
    const r = rateNow();
    if (usd && !r) {
      // Dollars wait for a price under a minute old, asked for now; with none, they are refused, never guessed.
      const t = ++wdTicket;
      say('Getting the SOL price…', true);
      return askPrice().then(() => {
        if (t !== wdTicket || !cashing || pending) return;
        if (!rateNow()) return say(NO_PRICE);
        say('');
        submitCashSol();
      });
    }
    const lamports = typedLamports(raw, r);
    const why = solProblem(lamports, r);
    if (why) return say(why);
    // usd: the dollars typed (Max's or a switch's exact lamports: what they are worth now, down to the cent)
    const exact = !!(wdExact && wdExact.unit === wdUnit && raw === wdExact.text);
    pending = { to: to, asset: 'sol', unit: wdUnit, text: raw, lamports: lamports, amt: lamports / 1e9, rate: r, at: Date.now(),
                usd: usd ? (exact ? lamportsToCents(lamports, r) / 100 : amt) : 0, exact: exact };
    drawCash();
  }
  /* The confirm step in dollars, open for a minute or more: the price is asked again, and the amount at it shown for a
     second tap, never sent at the old one. The same checks as the form; one that fails goes back to it, in words. */
  function repriceSol(p) {
    p.busy = true; drawCash();
    const t = wdTicket;
    return askPrice().then(() => {
      if (pending !== p || t !== wdTicket) return;
      p.busy = false;
      const r = rateNow();
      const back = msg => { backCash(); say(msg); };
      if (!r) return back(NO_PRICE);
      const lamports = p.exact ? p.lamports : usdToLamports(p.usd, r);
      const why = solProblem(lamports, r);
      if (why) return back(why);
      p.moved = p.moved || lamports !== p.lamports;
      p.lamports = lamports; p.amt = lamports / 1e9; p.rate = r; p.at = Date.now();
      if (p.exact) p.usd = lamportsToCents(lamports, r) / 100;
      drawCash();
    });
  }
  function submitCash() {
    if (solMode()) return submitCashSol();
    const bal = Number(w().balance) || 0;
    const to = ((el('co-to') || {}).value || '').trim();
    const raw = ((el('co-amt') || {}).value || '').trim().replace(',', '.');
    const amt = Number(raw);
    if (!to) return say('Paste the Solana address to send to.');
    if (!SOL_ADDR.test(to)) return say('That is not a Solana address.');
    if (to === w().address) return say('That is this wallet\'s own address.');
    if (!raw || !isFinite(amt) || amt <= 0) return say('Enter an amount to withdraw.');
    if (/\.\d{3,}$/.test(raw)) return say('Use dollars and cents, two decimal places at most.');
    if (amt > bal) return say('That is more than the ' + balMoney(bal) + ' you have.');
    if (payAs === 'sol' && swapOn()) {
      const least = Number((w().swap && w().swap.minWithdrawSolUsd) || 1);
      if (amt < least) return say('The smallest withdrawal as SOL is ' + money(least) + '.');
      pending = { to: to, amt: amt, as: 'sol', quote: null };
      drawCash();
      return priceSol(pending);
    }
    pending = { to: to, amt: amt };
    drawCash();
  }
  /* A checked price for this withdrawal. The pending object is the ticket:
     an answer for one the player has since left (Back, Cancel, a new amount)
     is dropped. */
  function priceSol(p) {
    p.quote = null;
    return window.duelWalletSwapQuote('toSol', Math.round(p.amt * 1e6), p.to).then(q => {
      if (pending !== p) return;
      p.quote = q; drawCash();
    }, e => {
      if (pending !== p) return;
      pending = null; drawCash();
      say(e && e.message ? e.message : 'Could not get a price. Try again.');
    });
  }
  // A price is used only while there are a few seconds left on it.
  const fresh = q => !!q && Date.now() < Number(q.expiresAt || 0) - 4000;
  function confirmCash() {
    if (!pending || pending.busy) return;
    if (pending.as === 'sol') return confirmSol();
    const p = pending;
    if (p.asset === 'sol' && p.unit === 'usd') {
      const age = Date.now() - p.at;
      if (!(age >= 0 && age < PRICE_MAX_AGE_MS)) return repriceSol(p);
    }
    pending = null; cashing = false;
    el('wdrveil').classList.remove('on');
    render();
    /* One card that follows the send: running while the chain confirms it
       (the widget resolves only once it is confirmed), then done or failed in
       place, so the answer is where the question was. */
    /* The card can never stand in the send's way or change what it reports:
       a fault in it is swallowed here, before the send and inside each answer,
       so a confirmed send can never fall through to the failed branch. */
    const T = window.DSToast;
    const what = p.asset === 'sol' && p.unit === 'usd'
      ? { amount: money(p.usd), detail: 'as ' + solPlain(p.amt) + ' to', code: ownShort(p.to) }
      : { amount: p.asset === 'sol' ? solPlain(p.amt) : money(p.amt) + ' USDC', detail: 'to', code: ownShort(p.to) };
    let card = null;
    try { if (T) card = T.show(Object.assign({ kind: 'info', title: 'Sending your withdraw', sticky: true }, what)); } catch (_) {}
    const tell = (o, plain, good) => {
      try { if (card) return card.update(o); } catch (_) {}
      note(plain, good);
    };
    window.duelWalletSend(p.amt, p.to, p.asset)
      .then(() => {
        tell(Object.assign({ kind: 'ok', title: 'Withdraw confirmed' }, what), 'Sent.', true);
        if (window.duelWalletRefresh) window.duelWalletRefresh();
      }, e => {
        const why = e && e.message ? e.message : 'Try again.';
        tell({ kind: 'err', title: 'Withdraw failed', amount: '', detail: why, code: '' }, 'Send failed: ' + why);
        withdrawFailed(why, p.asset || 'usdc');
      });
  }
  function confirmSol() {
    const p = pending;
    if (!p.quote || p.busy) return;
    // Gone stale while it was read: a new price, shown, and a second tap to send at it.
    if (!fresh(p.quote)) { const asked = priceSol(p); drawCash(); return asked; }
    p.busy = true; drawCash();
    window.duelWalletSwapRun(p.quote).then(r => {
      if (pending === p) { pending = null; cashing = false; }
      el('wdrveil').classList.remove('on');
      if (window.sheetFocus) window.sheetFocus.close();
      render();
      const got = r && r.outAmount ? solTxt(r.outAmount) : 'SOL';
      // The same words as a USDC withdraw's card, with what the address got.
      tell({ kind: 'ok', title: 'Withdraw confirmed', amount: got, detail: 'to', code: ownShort(p.to) },
           'Sent ' + got + '.', true);
    }, e => {
      if (pending !== p) return;
      pending = null; drawCash();
      say(e && e.message ? e.message : 'The withdrawal did not go through. Check your balance before trying again.');
      withdrawFailed(e, 'sol');
    });
  }
  /* Keeps what was typed when the form is drawn again for a new choice. */
  function setPayAs(v) {
    if (v !== 'usdc' && v !== 'sol') return;
    if (solMode()) {
      // SOL mode: SOL or old USDC. The amount is in a different asset now, so only the address is kept.
      if (v === 'usdc' && !usdcOn()) return;
      const to = (el('co-to') || {}).value || '';
      wdAsset = v; wdExact = null; wdTicket++; drawCash();
      if (el('co-to')) el('co-to').value = to;
      return;
    }
    const to = (el('co-to') || {}).value || '', amt = (el('co-amt') || {}).value || '';
    payAs = v; drawCash();
    if (el('co-to')) el('co-to').value = to;
    if (el('co-amt')) el('co-amt').value = amt;
  }

  /* ── Convert to USDC ──────────────────────────────────────────────────
     Everything but the reserve, in one tap, at a price the player sees first:
     about what arrives, the floor it cannot fall under, what stays behind for
     network fees. Nothing is signed until Convert is tapped on that price;
     an old price is replaced and shown again rather than used. */
  let cv = null;           // { q, err, busy, dir } while the sheet is open; dir 'usdcToSol' in SOL mode
  /* SOL mode: all the old USDC into SOL, in the same wallet. The same sheet, price and one Convert tap as the
     other way; only the words and the quote differ. Never opened by itself, only by this tap. */
  function convertUsdc() {
    if (!connected()) return login();
    if (!solMode() || !usdcOn()) return;
    if (!swapOn() || !window.duelWalletUsdcToSolQuote) return note('Your wallet is still starting. Try again in a moment.');
    cv = { dir: 'usdcToSol' };
    drawConvert();
    el('cvveil').classList.add('on');
    if (window.sheetFocus) window.sheetFocus.open('cvveil');
    return priceConvert(cv);
  }
  function convert() {
    if (!connected()) return login();
    if (solMode()) return;     // SOL is the money in SOL mode: there is nothing to convert it to
    if (!swapOn()) return note('Your wallet is still starting. Try again in a moment.');
    if (!convertible()) return note('There is no SOL to convert. ' +
      solTxt(Math.round(((w().swap && w().swap.solReserve) || 0) * 1e9)) + ' stays in your wallet for network fees.');
    cv = {};
    drawConvert();
    el('cvveil').classList.add('on');
    if (window.sheetFocus) window.sheetFocus.open('cvveil');
    return priceConvert(cv);
  }
  function priceConvert(c) {
    c.q = null; c.err = null; drawConvert();
    const ask = c.dir === 'usdcToSol' ? window.duelWalletUsdcToSolQuote() : window.duelWalletSwapQuote('toUsdc', convertible());
    return ask.then(q => {
      if (cv !== c) return;
      c.q = q; drawConvert();
    }, e => {
      if (cv !== c) return;
      c.err = e && e.message ? e.message : 'Could not get a price. Try again.'; drawConvert();
    });
  }
  function drawConvert() {
    const b = el('cv-body'); if (!b || !cv) return;
    const toSol = cv.dir === 'usdcToSol';
    const ttl = el('cv-title'); if (ttl) ttl.textContent = toSol ? 'Convert to SOL' : 'Convert to USDC';
    const dlg = el('cvveil'); if (dlg) dlg.setAttribute('aria-label', toSol ? 'Convert to SOL' : 'Convert to USDC');
    const reserve = Math.round(((w().swap && w().swap.solReserve) || 0) * 1e9);
    if (cv.err) {
      b.innerHTML = '<div class="cashout"><p class="note" data-state="bad" id="cv-msg">' + esc(cv.err) + '</p>' +
        '<div class="brow"><button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.convertAgain()">Try again</button>' +
        '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelConvert()">Cancel</button></div></div>';
      return;
    }
    const q = cv.q;
    if (toSol) {
      // "Convert $12.34 USDC to about 0.0821 SOL?" and the floor it cannot fall under.
      b.innerHTML = '<div class="cashout">' +
        '<div class="mfig ph-no-capture"><div class="k">Convert ' + (q ? usdTxt(q.inAmount) : money(usdcBal())) + ' USDC to about</div>' +
          '<div class="v num">' + (q ? (Number(q.outAmount) / 1e9).toFixed(4) : '…') + '<span class="cvu"> SOL?</span></div></div>' +
        '<ul class="cvfacts ph-no-capture">' +
          '<li><span>At least</span><b class="num">' + (q ? solFloor(q.minOut) : '…') + '</b></li>' +
        '</ul>' +
        '<p class="note" aria-live="polite">' + (q
          ? 'The price can move a little before it lands. If it would pay less than the at-least figure, nothing is converted.'
          : 'Getting a price…') + '</p>' +
        '<div class="brow">' +
          '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.confirmConvert()"' + (q && !cv.busy ? '' : ' disabled') + '>' +
            (cv.busy ? 'Converting…' : 'Convert') + '</button>' +
          '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelConvert()"' + (cv.busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div></div>';
      return;
    }
    /* The question itself, filled in (Owen, 2026-10-15): "Convert 0.1573 SOL to about $29.89
       USDC?", so the one tap is all that is left to do. */
    b.innerHTML = '<div class="cashout">' +
      '<div class="mfig ph-no-capture"><div class="k">Convert ' + (q ? solTxt(q.inAmount) : solTxt(convertible())) + ' to about</div>' +
        '<div class="v num">' + (q ? usdTxt(q.outAmount) : '…') + '<span class="cvu"> USDC?</span></div></div>' +
      '<ul class="cvfacts ph-no-capture">' +
        '<li><span>At least</span><b class="num">' + (q ? usdFloor(q.minOut) : '…') + '</b></li>' +
        '<li><span>Kept for network fees</span><b class="num">' + solTxt(reserve) + '</b></li>' +
      '</ul>' +
      '<p class="note" aria-live="polite">' + (q
        ? 'The price can move a little before it lands. If it would pay less than the at-least figure, nothing is converted.'
        : 'Getting a price…') + '</p>' +
      '<div class="brow">' +
        '<button type="button" class="ds-btn ds-btn-primary ds-btn-lg ds-btn-block" onclick="V2Wallet.confirmConvert()"' + (q && !cv.busy ? '' : ' disabled') + '>' +
          (cv.busy ? 'Converting…' : 'Convert') + '</button>' +
        '<button type="button" class="ds-btn ds-btn-quiet ds-btn-block" onclick="V2Wallet.cancelConvert()"' + (cv.busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div></div>';
  }
  function confirmConvert() {
    const c = cv;
    if (!c || !c.q || c.busy) return;
    if (!fresh(c.q)) return priceConvert(c);
    c.busy = true; drawConvert();
    // The dollars arriving are this card's news; the toast system's "Funds added" stays quiet for them.
    let unexpect = () => {};
    // The dollars arriving (USDC out, or in SOL mode the USDC going in, which is what the SOL is worth).
    try { if (window.DSToast && window.DSToast.expectRise) unexpect = window.DSToast.expectRise(Number(c.dir === 'usdcToSol' ? c.q.inAmount : c.q.outAmount) / 1e6); } catch (_) {}
    window.duelWalletSwapRun(c.q).then(r => {
      if (cv === c) closeConvert();
      if (c.dir === 'usdcToSol') {
        const inUsd = usdTxt((r && r.inAmount) || c.q.inAmount);
        const got = solTxt((r && r.outAmount) || c.q.outAmount);
        tell({ kind: 'money', title: 'Converted', amount: '+' + got, detail: 'from ' + inUsd + ' USDC' },
             'Converted ' + inUsd + ' USDC to ' + got + '.', true);
        if (onScreen()) { loadTx(); loadMoves(); }
        return;
      }
      const inSol = solTxt((r && r.inAmount) || c.q.inAmount);
      const got = usdTxt((r && r.outAmount) || c.q.outAmount);
      tell({ kind: 'money', title: 'Converted', amount: '+' + got + ' USDC', detail: 'from ' + inSol },
           'Converted ' + inSol + ' to ' + got + ' USDC.', true);
      seenConv = solLamports();
      /* The balance on screen is a beat behind the chain: until it catches up it still shows the
         SOL just converted, which must not open the sheet again for it. */
      if (connected()) setDeclined(w().address, convertible());
      if (onScreen()) { loadTx(); loadMoves(); }
    }, e => {
      try { unexpect(); } catch (_) {}
      if (cv !== c) return;
      c.busy = false; c.q = null;
      c.err = e && e.message ? e.message : 'The conversion did not go through. Check your balance before trying again.';
      drawConvert();
    });
  }
  function convertAgain() { if (cv) priceConvert(cv); }
  function closeConvert() {
    cv = null;
    const v = el('cvveil');
    if (!v || !v.classList.contains('on')) return;
    v.classList.remove('on');
    if (window.sheetFocus) window.sheetFocus.close();
  }
  /* Cancel, the close button, Escape, the backdrop: never while it is sending. A no is kept for
     this SOL: the sheet does not come back on its own until more arrives (offerConvert). */
  function cancelConvert() {
    if (cv && cv.busy) return;
    if (cv && cv.dir !== 'usdcToSol' && connected()) setDeclined(w().address, convertible());
    closeConvert();
  }

  /* SOL arrived, so the question comes to the player (Owen, 2026-10-15: no hunting for the
     button). When the wallet holds SOL it can convert, on load or as it lands, the Convert sheet
     opens by itself with a fresh price, and one tap converts it. Nothing is ever signed without
     that tap. Not over a running game, another sheet, Privy's own window or a hidden page: it
     waits for the next balance tick or the game's end. Once the player says no, not again for
     that SOL; more SOL arriving asks again. */
  const DECLINED = a => 'ds_cv_declined:' + a;
  function declinedAt(a) { try { return Number(localStorage.getItem(DECLINED(a))) || 0; } catch (_) { return 0; } }
  function setDeclined(a, n) { try { localStorage.setItem(DECLINED(a), String(Math.max(0, Math.round(n)))); } catch (_) {} }
  const inGame = () => ['game-frame', 'agar-frame'].some(id => { const f = el(id); return !!f && f.style.display === 'block'; });
  const busyScreen = () => !!document.querySelector('.howveil.on') || !!document.getElementById('privy-modal-content') ||
    document.visibilityState === 'hidden';
  function offerConvert() {
    if (cv || !connected() || !swapOn() || w().sol == null || solMode()) return;   // never in SOL mode
    const c = convertible();
    const a = w().address;
    let no = declinedAt(a);
    /* Spent since the no (converted, withdrawn, down to nothing): what is there now is the new
       line, so only SOL that arrives after it asks again. */
    if (no && c < no) { setDeclined(a, c); no = c; }
    if (!c) return;
    const step = Math.round((Number(w().swap.minConvertSol) || 0) * 1e9);
    if (no && c < no + step) return;
    if (inGame() || busyScreen()) return;
    convert();
  }

  /* The lobby's toast (toasts.js, DSToast) where it is loaded, else the plain one. */
  function tell(o, plain, good) {
    if (window.DSToast && typeof window.DSToast.show === 'function') return window.DSToast.show(o);
    note(plain, good);
  }
  /* SOL that arrives while the page is open (a card purchase landing, a send
     from an exchange) is pointed out once, with where to convert it. Not on
     page load: SOL already sitting there shows on the Wallet tab. */
  /* Watched as the raw SOL balance, not the convertible part: a first small top-up can sit under
     the fee reserve and still be money added. "Funds added", the toast system's own words for
     money arriving (Owen's card buy, 2026-10-15), with the amount that came in. */
  let seenConv = null;
  const SOL_ARRIVAL_MIN = 1e6;   // 0.001 SOL, the history's dust floor too
  function watchSol() {
    if (!connected() || w().sol == null || !w().swap) return;
    const now = solLamports();
    if (seenConv !== null && now - seenConv >= SOL_ARRIVAL_MIN) {
      // The Convert sheet opens by itself for it (offerConvert), so the card only says it came.
      // SOL mode: toasts.js says it, in dollars, so this one stays quiet; the history still refreshes.
      if (!solMode()) tell({ kind: 'money', title: 'Funds added', amount: '+' + solTxt(now - seenConv), detail: 'is in your wallet' },
           'Funds added: ' + solTxt(now - seenConv) + '.', true);
      if (onScreen()) loadMoves();
    }
    seenConv = now;
  }


  /* Copies the whole address, whatever the row shows. Says Copied only once
     the clipboard took it; where it refuses (an old browser, no permission)
     the button says so instead of claiming a copy that did not happen. */
  function copy(which) {
    const box = el(which || 'w-addr'); if (!box) return;
    const lbl = box.querySelector('.cp span');
    const a = w().address || '';
    const done = (ok) => {
      box.classList.toggle('done', ok);
      if (lbl) lbl.textContent = ok ? 'Copied' : 'Select';
      /* Refused (an old browser, a blocked clipboard): the row shows the whole
         address, selected, so a long-press or Ctrl+C still gets it. */
      if (!ok) {
        const code = box.querySelector('code');
        if (code) {
          code.textContent = a; code.style.whiteSpace = 'normal'; code.style.wordBreak = 'break-all';
          try { const r = document.createRange(); r.selectNodeContents(code);
                const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (_) {}
        }
        return;
      }
      clearTimeout(box._t);
      box._t = setTimeout(() => { box.classList.remove('done'); if (lbl) lbl.textContent = 'Copy'; }, 1400);
      copied(a);
    };
    try { navigator.clipboard.writeText(a).then(() => done(true), () => done(false)); }
    catch (_) { done(false); }
  }

  /* The lobby's own toast (play.js), not a browser alert box that stops the
     page and looks like a different product; the alert stays only as the
     fallback for a page where play.js never loaded. */
  function note(msg, good) {
    if (window.V2Play && window.V2Play.toast) return window.V2Play.toast(msg, !!good);
    if (window.DSDialog) window.DSDialog.alert({ line: msg });
    else alert(msg);
  }
  /* Any address copied here, the player's own or one in the history: the
     button says Copied where it was pressed, and the card says which. */
  function copied(a) {
    if (window.DSToast) window.DSToast.show({ kind: 'ok', title: 'Address copied', code: ownShort(a) });
  }

  /* Only the header follows a balance change while the form is open: a full
     re-render mid-typing would throw away the address being pasted into it. */
  /* Signed out mid cash-out: the half-filled form belongs to the wallet that
     just left, so it is dropped rather than shown to whoever signs in next. */
  /* Off the Wallet tab only the header follows: drawing the hidden screen
     asked the chain for this wallet's history on every page load, for people
     who never opened the tab. Opening it draws it in full (fillScreen). */
  const onScreen = () => {
    const s = el('wallet-screen');
    return !!s && getComputedStyle(s).display !== 'none';
  };
  window.addEventListener('duelwallet:change', () => {
    watchSol();
    if (!connected()) { cashing = false; pending = null; seenConv = null; if (cv && !cv.busy) closeConvert(); if (adding) cancelAdd(); }
    if (adding && !w().linked) cancelAdd();   // unlinked (or signed out) with the sheet open
    offerConvert();
    if (cashing) { refreshChip(); return renderHeader(); }
    if (!onScreen()) { drawnFor = null; return renderHeader(); }
    render(true);
  });
  /* Back in the lobby, or back on the page: a Convert that waited is asked now. A game
     closing says game:done from one of our game frames, on this origin, as every other
     listener here checks. */
  window.addEventListener('message', (e) => {
    if (!e || e.origin !== window.location.origin || e.data !== 'game:done') return;
    const f = ['game-frame', 'agar-frame'].map(el).find(x => !!x && !!x.contentWindow && x.contentWindow === e.source);
    if (!f || e.source !== f.contentWindow) return;
    setTimeout(offerConvert, 1200);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(offerConvert, 400); });
  window.V2Wallet = { render: render, login: login, fund: fund, copy: copy, view: view,
                      refresh: refresh, more: more, txScroll: txScroll, mvScroll: mvScroll,
                      copyPeer: copyPeer,
                      cashOut: cashOut, cancelCash: cancelCash, backCash: backCash,
                      max: max, submitCash: submitCash, confirmCash: confirmCash, setPayAs: setPayAs,
                      convert: convert, convertUsdc: convertUsdc, hint: hint, setUnit: setUnit,
                      // the Withdraw amount's dollar and lamport arithmetic, pure, for test/withdrawUsd.test.js
                      wdMath: { usdToLamports: usdToLamports, lamportsToCents: lamportsToCents, solText: solText,
                                MIN_SEND_LAMPORTS: MIN_SEND_LAMPORTS, PRICE_MAX_AGE_MS: PRICE_MAX_AGE_MS },
                      confirmConvert: confirmConvert, convertAgain: convertAgain,
                      cancelConvert: cancelConvert,
                      addrRow: addrRow, headerTap: headerTap,
                      unlink: unlink, toLinked: toLinked, addMax: addMax, addHint: addHint,
                      submitAdd: submitAdd, cancelAdd: cancelAdd, addFromWallet: addFromWallet };
})();
