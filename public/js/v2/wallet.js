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
      body.innerHTML =
        '<div class="panel"><div class="plab">Not connected</div>' +
        '<p class="note">Sign in to see your balance, deposit USDC and cash out. ' +
        'Your wallet is your account here, so there is nothing else to create.</p>' +
        '<div class="brow"><button class="btn pri" onclick="V2Wallet.login()">Sign in</button></div>' +
        '</div>';
      return;
    }

    const addr = w().address;
    body.innerHTML =
      '<div class="wgrid">' +
        '<div class="panel">' +
          '<div class="bfig">' +
            '<div><div class="blab">Available</div>' +
              '<div class="bnum num">' + money(w().balance) + '</div></div>' +
          '</div>' +
          '<div class="brow">' +
            '<button class="btn pri" onclick="V2Wallet.fund()">Add funds</button>' +
            '<button class="btn sec" onclick="V2Wallet.cashOut()">Cash out</button>' +
          '</div>' +
          '<p class="note">The house takes <b>10%</b> of what you cash out of a game. ' +
          'Nothing is taken from a deposit, and nothing is taken if you leave with ' +
          'your buy-in.</p>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="plab">Your deposit address</div>' +
          '<div class="waddr" id="w-addr" onclick="V2Wallet.copy()">' +
            '<code>' + esc(addr) + '</code><span class="cp">Copy</span></div>' +
          '<p class="note">Send only <b>USDC on Solana</b>. Any other token, or the ' +
          'right token on the wrong network, cannot be recovered.</p>' +
        '</div>' +
      '</div>';
  }

  function login() { if (window.duelWalletLogin) window.duelWalletLogin(); }

  function fund() {
    if (!connected()) return login();
    if (!window.duelWalletFund) return note('Your wallet is still starting. Try again in a moment.');
    /* The widget owns the funding flow; a rejection here is the user closing
       it or the provider refusing, not something to swallow silently. */
    window.duelWalletFund(20).catch(e =>
      note('Add funds did not open: ' + (e && e.message ? e.message : 'try again.')));
  }

  /* Cash out sends from the player's own wallet to an address they give us.
     The amount and destination are theirs; this screen only collects them and
     hands both to the widget. */
  function cashOut() {
    if (!connected()) return login();
    if (!window.duelWalletSend) return note('Your wallet is still starting. Try again in a moment.');
    const bal = Number(w().balance) || 0;
    if (bal <= 0) return note('There is nothing to cash out yet.');
    const to = (prompt('Send USDC to which Solana address?') || '').trim();
    if (!to) return;
    const raw = (prompt('How much? You have ' + money(bal) + '.', bal.toFixed(2)) || '').trim();
    const amt = Number(raw);
    if (!isFinite(amt) || amt <= 0) return note('That is not an amount.');
    if (amt > bal) return note('That is more than you have.');
    if (!confirm('Send ' + money(amt) + ' to ' + shortAddr(to) + '?\n\n' +
                 'On-chain transfers cannot be reversed.')) return;
    window.duelWalletSend(amt, to)
      .then(() => { note('Sent.'); if (window.duelWalletRefresh) window.duelWalletRefresh(); })
      .catch(e => note('Send failed: ' + (e && e.message ? e.message : 'try again.')));
  }

  function copy() {
    const box = el('w-addr'); if (!box) return;
    const lbl = box.querySelector('.cp');
    try { navigator.clipboard.writeText(w().address || ''); } catch (_) {}
    box.classList.add('done'); lbl.textContent = 'Copied';
    setTimeout(() => { box.classList.remove('done'); lbl.textContent = 'Copy'; }, 1400);
  }

  function note(msg) { alert(msg); }

  window.addEventListener('duelwallet:change', render);
  window.V2Wallet = { render: render, login: login, fund: fund, cashOut: cashOut, copy: copy };
})();
