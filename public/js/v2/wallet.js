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
  const money = n => '$' + (Number(n) || 0).toFixed(2);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function shortAddr(a) {
    return !a ? '' : a.length <= 16 ? a : a.slice(0, 6) + '…' + a.slice(-6);
  }

  /* The header readout. Signed out shows a dash, never $0.00. */
  function renderHeader() {
    const v = el('hdr-balance');
    if (!v) return;
    v.textContent = connected() ? money(w().balance) : '—';
    /* Target the label span, not lastChild: the button's last node is the
       whitespace after the span, so writing to it appends a second label. */
    const label = document.querySelector('#wbtn span');
    if (label) label.textContent = connected() ? 'Wallet' : 'Sign in';
  }

  function render() {
    renderHeader();
    const body = el('w-body');
    if (!body) return;

    if (!w().ready) {
      body.innerHTML = '<div class="panel"><p class="note">Starting your wallet…</p></div>';
      return;
    }
    if (!connected()) {
      const earn = el('w-earn'); if (earn) earn.hidden = true;
      body.innerHTML =
        '<div class="panel"><div class="plab">Not connected</div>' +
        '<p class="note">Sign in to see your balance, deposit USDC and cash out. ' +
        'Your wallet is your account here, so there is nothing else to create.</p>' +
        '<div class="brow"><button class="btn pri" onclick="V2Wallet.login()">Sign in</button></div>' +
        '</div>';
      return;
    }

    const addr = w().address;
    const bal = Number(w().balance) || 0;
    body.innerHTML =
      /* The balance leads, at the size of the thing it is. Deposit and
         Withdraw sit under it because they are what you came to do, and
         Refresh is beside them rather than hidden, because an on-chain
         balance can be a few seconds behind and the only honest answer to
         "is it there yet" is a button that asks again. */
      '<div class="wbal">' +
        '<div class="blab">Available</div>' +
        '<div class="bnum num" id="w-bal">' + money(bal) + '</div>' +
        '<div class="wunit">USDC on Solana</div>' +
        /* The form lives in its own sheet now, so this row never swaps out. */
        ('<div class="wacts">' +
            '<button class="btn pri" onclick="V2Wallet.openDep()">Deposit</button>' +
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
        '<div class="plab">Your deposit address</div>' +
        '<div class="waddr" id="w-addr" onclick="V2Wallet.copy()">' +
          '<code>' + esc(addr) + '</code><span class="cp">Copy</span></div>' +
        /* The one sentence kept. The rest of the copy on this screen was
           explanation; this is the only line whose absence can cost somebody
           their money. */
        '<p class="note">USDC on Solana only. Anything else is unrecoverable.</p>' +
      '</div>' +
      '<div class="head"><div><h2>Recent transactions</h2>' +
        '<div class="sub">Money in and out of this wallet.</div></div></div>' +
      '<div class="txl" id="w-tx"><div class="none">Loading…</div></div>';
    loadTx();
    /* The earnings chart and the payout list, which used to be their own tab. */
    if (window.V2Stats) window.V2Stats.load();
  }

  /* Read off the chain, because that is the only place these exist: the
     transfers are self-custody and never touch our server, and the old
     deposits/withdrawals tables are vestigial from the custodial system. */
  let txFor = null;
  async function loadTx() {
    const a = w().address; if (!a) return;
    txFor = a;
    let rows = null;
    try {
      const r = await fetch('/api/my-transactions?wallet=' + encodeURIComponent(a));
      rows = (await r.json()).transactions;
    } catch (_) { rows = null; }
    const box = el('w-tx');
    if (!box || txFor !== a) return;          // screen changed under us
    if (!Array.isArray(rows)) {
      box.innerHTML = '<div class="none">Could not reach the chain. Try refresh.</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = '<div class="none">Nothing yet. Deposits and withdrawals show up here.</div>';
      return;
    }
    box.innerHTML = rows.map(t => {
      const inb = t.direction === 'in';
      return '<a class="tx" href="https://solscan.io/tx/' + esc(t.signature) + '" ' +
        'target="_blank" rel="noopener noreferrer">' +
        '<span class="txi ' + (inb ? 'in' : 'out') + '">' + (inb ? '↓' : '↑') + '</span>' +
        '<span class="txn">' + (inb ? 'Deposit' : 'Withdrawal') + '</span>' +
        '<span class="txd">' + when(t.at) + '</span>' +
        '<span class="txa num ' + (inb ? 'in' : 'out') + '">' +
          (inb ? '+' : '-') + money(t.usdc) + '</span></a>';
    }).join('');
  }
  const when = ms => {
    if (!ms) return '';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  /* Asks the chain again for both numbers, and says it is doing it. */
  async function refresh() {
    const b = el('w-refresh'); if (b) b.classList.add('spin');
    try { if (window.duelWalletRefresh) await window.duelWalletRefresh(); } catch (_) {}
    await loadTx();
    if (b) setTimeout(() => b.classList.remove('spin'), 300);
  }

  /* Two steps in one panel, replacing three stacked browser dialogs: a prompt
     for the address, a prompt for the amount, then a confirm. Those cannot be
     styled, cannot show the balance while you type an amount against it, and
     on a phone each one covers the whole screen. */
  function cashForm(bal) {
    if (pending) {
      return '<div class="cashout">' +
        '<div class="plab">Confirm</div>' +
        '<p class="note">Send <b>' + money(pending.amt) + '</b> to <code>' +
          esc(shortAddr(pending.to)) + '</code>. On-chain transfers cannot be reversed.</p>' +
        '<div class="brow">' +
          '<button class="btn pri" onclick="V2Wallet.confirmCash()">Send it</button>' +
          '<button class="btn sec" onclick="V2Wallet.backCash()">Back</button>' +
        '</div></div>';
    }
    return '<div class="cashout">' +
      '<div class="mfig"><div class="k">Available to withdraw</div>' +
        '<div class="v num">' + money(bal) + '</div></div>' +
      '<p class="msub">Paste the Solana address you want the USDC sent to, ' +
        'choose an amount, and confirm. It goes on-chain and cannot be reversed, ' +
        'so check the address before you send.</p>' +
      '<input class="fld" id="co-to" placeholder="Solana address" autocomplete="off" ' +
        'spellcheck="false" aria-label="Destination Solana address">' +
      '<div class="amtrow">' +
        '<input class="fld num" id="co-amt" inputmode="decimal" placeholder="0.00" ' +
          'autocomplete="off" aria-label="Amount in USDC">' +
        '<button type="button" class="maxbtn" onclick="V2Wallet.max()">Max</button>' +
      '</div>' +
      '<p class="note" id="co-msg">Available ' + money(bal) + ' USDC.</p>' +
      '<div class="brow">' +
        '<button class="btn pri" onclick="V2Wallet.submitCash()">Cash out</button>' +
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
  /* Deposit is our screen, not Privy's. Privy's own funding modal is headed
     "Receive 20 USDC", which says nothing about where the money is going; this
     one says whose wallet it is, shows the address, and keeps the one warning
     that matters. Privy is still one button away for the QR and the card and
     exchange options, which are its to render. */
  function openDep() {
    if (!connected()) return login();
    const a = w().address || '';
    const code = el('dep-addr-code'); if (code) code.textContent = a;
    el('depveil').classList.add('on');
  }
  function closeDep() { el('depveil').classList.remove('on'); }

  function cashOut() {
    if (!connected()) return login();
    if (!window.duelWalletSend) return note('Your wallet is still starting. Try again in a moment.');
    if ((Number(w().balance) || 0) <= 0) return note('There is nothing to withdraw yet.');
    cashing = true; pending = null;
    drawCash();
    el('wdrveil').classList.add('on');
    const f = el('co-to'); if (f) f.focus();
  }
  function drawCash() {
    const b = el('wdr-body'); if (b) b.innerHTML = cashForm(Number(w().balance) || 0);
  }
  function cancelCash() {
    cashing = false; pending = null;
    el('wdrveil').classList.remove('on');
  }
  function backCash() { pending = null; drawCash(); }
  function max() {
    const a = el('co-amt');
    if (a) { a.value = (Number(w().balance) || 0).toFixed(2); a.focus(); }
  }
  function say(msg) { const m = el('co-msg'); if (m) m.textContent = msg; else note(msg); }

  /* Checked here as well as in the widget, so a bad amount is answered in the
     form instead of by a rejected transaction. The widget stays the authority
     on what actually sends; this only catches the obvious cases early. */
  function submitCash() {
    const bal = Number(w().balance) || 0;
    const to = ((el('co-to') || {}).value || '').trim();
    const amt = Number(((el('co-amt') || {}).value || '').trim());
    if (!to) return say('Paste the Solana address to send to.');
    if (!isFinite(amt) || amt <= 0) return say('Enter an amount to cash out.');
    if (amt > bal) return say('That is more than the ' + money(bal) + ' you have.');
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
      .then(() => { note('Sent.'); if (window.duelWalletRefresh) window.duelWalletRefresh(); })
      .catch(e => note('Send failed: ' + (e && e.message ? e.message : 'try again.')));
  }


  function copy(which) {
    const box = el(which || 'w-addr'); if (!box) return;
    const lbl = box.querySelector('.cp');
    try { navigator.clipboard.writeText(w().address || ''); } catch (_) {}
    box.classList.add('done'); lbl.textContent = 'Copied';
    setTimeout(() => { box.classList.remove('done'); lbl.textContent = 'Copy'; }, 1400);
  }

  function note(msg) { alert(msg); }

  /* Only the header follows a balance change while the form is open: a full
     re-render mid-typing would throw away the address being pasted into it. */
  window.addEventListener('duelwallet:change', () => { cashing ? renderHeader() : render(); });
  window.V2Wallet = { render: render, login: login, fund: fund, copy: copy,
                      refresh: refresh, openDep: openDep, closeDep: closeDep,
                      cashOut: cashOut, cancelCash: cancelCash, backCash: backCash,
                      max: max, submitCash: submitCash, confirmCash: confirmCash };
})();
