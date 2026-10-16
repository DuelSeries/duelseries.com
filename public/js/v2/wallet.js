'use strict';
/* ─── Wallet ──────────────────────────────────────────────────────────────────
   This screen is a view over the Privy widget, not a second wallet. Every
   money action is delegated to the globals public/wallet/widget.js publishes,
   so there is exactly one implementation of funding and sending in the product
   and this lobby cannot drift from the live one:

     window.duelWallet          { ready, authenticated, address, balance, unit }
     'duelwallet:change'        fired on any of the above changing
     window.duelWalletLogin()   opens the Privy login
     window.duelWalletFund(n)   Privy funding flow, resolves or rejects
     window.duelWalletSend(a,t) send `a` to address `t`
     window.duelWalletRefresh() re-read the on-chain balance

   Nothing here signs, quotes or verifies anything. If a call is missing the
   widget has not mounted yet, and the screen says so rather than pretending
   the balance is zero — a real balance of 0 and "not connected" are very
   different things to show someone about their money. */

(function () {
  const el = id => document.getElementById(id);
  const w = () => window.duelWallet || {};
  /* Which step the cash-out panel is on. Module state rather than DOM state,
     because a balance refresh re-renders the panel and would otherwise throw
     away whatever was half-typed into it. */
  let cashing = false, pending = null;
  const connected = () => !!(w().authenticated && w().address);
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
  function addrRow(id, a) {
    return '<div class="waddr" id="' + id + '">' +
      '<code title="' + esc(a) + '">' + esc(ownShort(a)) + '</code>' +
      '<button type="button" class="cp" onclick="V2Wallet.copy(\'' + id + '\')" ' +
        'aria-label="Copy wallet address">' + COPY_ICON + '<span>Copy</span></button></div>';
  }

  function clearMoves() {
    mvGen++; clearTimeout(mvTimer);
    const mv = el('w-moves'); if (mv) mv.innerHTML = '';
  }

  /* The header readout. Signed out shows a dash, never $0.00. */
  function renderHeader() {
    const v = el('hdr-balance');
    if (!v) return;
    v.textContent = connected() ? balMoney(w().balance) : '—';
    /* Target the label span, not lastChild: the button's last node is the
       whitespace after the span, so writing to it appends a second label. */
    const label = document.querySelector('#wbtn span');
    /* Signed out (known, not merely not loaded yet): the header drops the
       empty balance box and says Sign in, on a phone too, where it was a lone
       dash beside an unlabelled icon. While the wallet is still starting it
       says Wallet, so a signed-in player never sees a Sign in flash by. */
    const out = !!w().ready && !connected();
    if (label) label.textContent = out ? 'Sign in' : 'Wallet';
    // A name for screen readers too: on a phone the label is hidden and only the icon shows.
    const btn = el('wbtn'); if (btn) btn.setAttribute('aria-label', out ? 'Sign in' : 'Wallet');
    document.body.classList.toggle('signedout', out);
  }
  /* The header button signs you in when you are signed out, instead of
     opening a Wallet tab whose only content is a second Sign in button. */
  function headerTap() {
    if (w().ready && !connected()) return login();
    if (window.go) window.go('wallet');
  }

  /* light: a balance tick from the widget. The screen is already drawn for
     this wallet, so only the number changes; rebuilding it would throw away
     every page of transactions already shown and fetch the first one again. */
  let drawnFor = null;
  function render(light) {
    renderHeader();
    const body = el('w-body');
    if (!body) return;

    if (!w().ready) {
      drawnFor = null;
      clearMoves();
      body.innerHTML = '<div class="panel"><p class="note">Starting your wallet…</p></div>';
      return;
    }
    if (!connected()) {
      drawnFor = null;
      const earn = el('w-earn'); if (earn) earn.hidden = true;
      clearMoves();
      body.innerHTML =
        '<div class="panel">' +
        '<div class="brow"><button class="btn pri" onclick="V2Wallet.login()">Sign in</button></div>' +
        '</div>';
      return;
    }
    if (light === true && drawnFor === w().address && el('w-bal')) {
      el('w-bal').textContent = balMoney(w().balance);
      return;
    }

    const addr = w().address;
    const bal = Number(w().balance) || 0;
    body.innerHTML =
      /* The balance leads, at the size of the thing it is. Add funds and
         Withdraw sit under it because they are what you came to do, and
         Refresh is beside them rather than hidden, because an on-chain
         balance can be a few seconds behind and the only honest answer to
         "is it there yet" is a button that asks again. */
      /* No "Available" over it and no "USDC on Solana" under it (Owen,
         2026-10-15): the big number on the Wallet tab is the balance, and the
         address panel right below already says what it is held in. */
      '<div class="wbal">' +
        '<div class="bnum num" id="w-bal">' + balMoney(bal) + '</div>' +
        /* The form lives in its own sheet now, so this row never swaps out. */
        ('<div class="wacts">' +
            '<button class="btn pri" onclick="V2Wallet.fund()">Add funds</button>' +
            '<button class="btn sec" onclick="V2Wallet.cashOut()">Withdraw</button>' +
            '<button class="btn sec wref" id="w-refresh" onclick="V2Wallet.refresh()" ' +
              'aria-label="Refresh balance" title="Refresh balance">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
                'stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
                '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>' +
            '</button>' +
          '</div>') +
      '</div>' +
      '<div class="panel wdep">' +
        /* "Add funds", not "Deposit", everywhere (Owen, 2026-10-15); this is the
           address the money is sent to, so it is named as what it is. */
        '<div class="plab">Your wallet address</div>' +
        addrRow('w-addr', addr) +
        /* The one sentence kept. The rest of the copy on this screen was
           explanation; this is the only line whose absence can cost somebody
           their money. */
        '<p class="note">USDC on Solana only. Anything else is unrecoverable.</p>' +
      '</div>' +
      '<div class="head"><div><h2>Transactions</h2></div></div>' +
      /* Five rows tall, the rest a scroll away inside the card, and the next
         page asked for as the scroll nears the end (Owen, 2026-10-15). A Show
         more button under a list that long was a page of buttons to tap. */
      '<div class="txcard"><div class="txl sc" id="w-tx" onscroll="V2Wallet.txScroll()">' +
        '<div class="none">Loading…</div></div></div>';
    drawnFor = addr;
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
  function txRow(t) {
    const inb = t.direction === 'in';
    /* The player's own money is named by the button that moves it (Owen,
       2026-10-15): Add funds and Withdraw, the same words as on the buttons. */
    const name = t.game ? (inb ? 'Game payout' : 'Game entry') : (inb ? 'Add funds' : 'Withdraw');
    /* A real minus sign, the arrow kept from screen readers, and the link
       says where it goes: each row opens the transaction on Solscan. */
    return '<a class="tx" href="https://solscan.io/tx/' + esc(t.signature) + '" ' +
      'target="_blank" rel="noopener noreferrer" title="View on Solscan">' +
      '<span class="txi ' + (inb ? 'in' : 'out') + '" aria-hidden="true">' + (inb ? '↓' : '↑') + '</span>' +
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
      box.innerHTML = '<div class="none">Could not load transactions. Tap refresh to try again.</div>';
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
        'onclick="V2Wallet.more()">Could not load more. Tap to try again.</button>');
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
  function moveRow(t) {
    const inb = t.direction === 'in';
    const peer = typeof t.peer === 'string' && SOL_ADDR.test(t.peer) ? t.peer : '';
    return '<div class="tx mv">' +
      '<a class="mvl" href="https://solscan.io/tx/' + esc(t.signature) + '" ' +
        'target="_blank" rel="noopener noreferrer" title="View on Solscan">' +
        '<span class="txi ' + (inb ? 'in' : 'out') + '" aria-hidden="true">' + (inb ? '↓' : '↑') + '</span>' +
        '<span class="txw"><span class="txn">' + (inb ? 'Add funds' : 'Withdraw') + '</span>' +
          '<span class="txd">' + whenAt(t.at) + '</span></span></a>' +
      '<span class="mvr">' +
        '<span class="txa num ' + (inb ? 'in' : 'out') + '">' + (inb ? '+' : '−') + money(t.usdc) + '</span>' +
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
      sec.innerHTML = '<div class="head"><div><h2>Add funds and Withdrawals</h2></div></div>' +
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
        '. Tap refresh to try again.</div>';
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
    if (pending) {
      /* No "Confirm" label over it: the sentence and its "Send it" say so. */
      return '<div class="cashout">' +
        /* The destination in FULL here, the one place it has to be checked:
           a look-alike address can share its first and last characters with
           the real one, which is exactly what a shortened form shows. */
        '<p class="note">Send <b>' + money(pending.amt) + '</b> to</p>' +
        '<code class="cofull">' + esc(pending.to) + '</code>' +
        '<p class="note">On-chain transfers cannot be reversed.</p>' +
        '<div class="brow">' +
          '<button class="btn pri" onclick="V2Wallet.confirmCash()">Send it</button>' +
          '<button class="btn sec" onclick="V2Wallet.backCash()">Back</button>' +
        '</div></div>';
    }
    /* The balance alone (the sheet is titled Withdraw), and the can't-be-
       reversed warning once, on the confirm step where it is read before
       sending, rather than on both steps (2026-10-15 audit). */
    return '<div class="cashout">' +
      '<div class="mfig">' +
        '<div class="v num">' + balMoney(bal) + '</div></div>' +
      /* Enter in either field does what the Withdraw button does. */
      '<input class="fld" id="co-to" placeholder="Solana address" autocomplete="off" ' +
        'spellcheck="false" aria-label="Destination Solana address" ' +
        'onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()">' +
      '<div class="amtrow">' +
        '<input class="fld num" id="co-amt" inputmode="decimal" placeholder="0.00" ' +
          'autocomplete="off" aria-label="Amount in USDC" ' +
          'onkeydown="if(event.key===\'Enter\')V2Wallet.submitCash()">' +
        '<button type="button" class="maxbtn" onclick="V2Wallet.max()">Max</button>' +
      '</div>' +
      /* Empty until there is something to say: the available figure is
         already the big number at the top of this sheet. */
      '<p class="note" id="co-msg"></p>' +
      '<div class="brow">' +
        /* Withdraw, like the button and the sheet: "Cash out" is what you do
           to leave a game with your winnings, a different thing. */
        '<button class="btn pri" onclick="V2Wallet.submitCash()">Withdraw</button>' +
        '<button class="btn sec" onclick="V2Wallet.cancelCash()">Cancel</button>' +
      '</div></div>';
  }

  function login() { if (window.duelWalletLogin) window.duelWalletLogin(); }

  function fund() {
    if (!connected()) return login();
    if (!window.duelWalletFund) return note('Your wallet is still starting. Try again in a moment.');
    /* The widget owns the funding flow; a rejection here is the user closing
       it or the provider refusing, not something to swallow silently. */
    /* Ten. Twenty was a number nobody chose, and it is the figure Privy prints
       at the top of its own screen, so it reads as a price rather than a
       starting point. */
    window.duelWalletFund(10).catch(e =>
      note('Add funds did not open: ' + (e && e.message ? e.message : 'try again.')));
  }

  /* Cash out sends from the player's own wallet to an address they give us.
     The amount and destination are theirs; this screen only collects them and
     hands both to the widget, which owns every part of the money. */
  /* Add funds opens the QR code and the card and exchange options straight
     away (fund, above). It used to open our own sheet first, which repeated
     the address and warning already on the Wallet tab (Owen, 2026-10-15). */

  function cashOut() {
    if (!connected()) return login();
    if (!window.duelWalletSend) return note('Your wallet is still starting. Try again in a moment.');
    if ((Number(w().balance) || 0) <= 0) return note('There is nothing to withdraw yet.');
    cashing = true; pending = null;
    drawCash();
    el('wdrveil').classList.add('on');
    /* No field is focused on open (Owen, 2026-10-15). Focusing the address
       field threw the phone keyboard over the sheet before anybody had read
       it; the keyboard comes up when they tap a field, which is when they want
       it. Focus goes to the close button instead (sheetFocus), which raises
       nothing. */
    if (window.sheetFocus) window.sheetFocus.open('wdrveil');
  }
  function drawCash() {
    const b = el('wdr-body'); if (b) b.innerHTML = cashForm(Number(w().balance) || 0);
  }
  function cancelCash() {
    cashing = false; pending = null;
    if (!el('wdrveil').classList.contains('on')) return;
    el('wdrveil').classList.remove('on');
    if (window.sheetFocus) window.sheetFocus.close();
  }
  function backCash() { pending = null; drawCash(); }
  function max() {
    const a = el('co-amt');
    // Filled, not focused: a tap on Max should not raise the keyboard either.
    if (a) a.value = cents(w().balance).toFixed(2);
  }
  // A refusal in the form reads as one: the error red, not the hint grey.
  function say(msg) {
    const m = el('co-msg');
    if (!m) return note(msg);
    m.textContent = msg; m.dataset.state = msg ? 'bad' : '';
  }

  /* Checked here as well as in the widget, so a bad amount is answered in the
     form instead of by a rejected transaction. The widget stays the authority
     on what actually sends; this only catches the obvious cases early: a
     destination that is not a Solana address at all, or is this wallet's own,
     and an amount in more than cents, which the confirm step could only show
     rounded. A comma is read as the decimal point. */
  const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function submitCash() {
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
    pending = { to: to, amt: amt };
    drawCash();
  }
  function confirmCash() {
    if (!pending) return;
    const p = pending;
    pending = null; cashing = false;
    el('wdrveil').classList.remove('on');
    render();
    window.duelWalletSend(p.amt, p.to)
      .then(() => { note('Sent.', true); if (window.duelWalletRefresh) window.duelWalletRefresh(); })
      .catch(e => note('Send failed: ' + (e && e.message ? e.message : 'try again.')));
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
    };
    try { navigator.clipboard.writeText(a).then(() => done(true), () => done(false)); }
    catch (_) { done(false); }
  }

  /* The lobby's own toast (play.js), not a browser alert box that stops the
     page and looks like a different product; the alert stays only as the
     fallback for a page where play.js never loaded. */
  function note(msg, good) {
    if (window.V2Play && window.V2Play.toast) return window.V2Play.toast(msg, !!good);
    alert(msg);
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
    if (!connected()) { cashing = false; pending = null; }
    if (cashing) return renderHeader();
    if (!onScreen()) { drawnFor = null; return renderHeader(); }
    render(true);
  });
  window.V2Wallet = { render: render, login: login, fund: fund, copy: copy,
                      refresh: refresh, more: more, txScroll: txScroll, mvScroll: mvScroll,
                      copyPeer: copyPeer,
                      cashOut: cashOut, cancelCash: cancelCash, backCash: backCash,
                      max: max, submitCash: submitCash, confirmCash: confirmCash,
                      addrRow: addrRow, headerTap: headerTap };
})();
