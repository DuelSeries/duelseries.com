/* Buying and wearing paid skins, the lobby's side (docs/skin-purchases.md). The money logic is the server's
   (server/skinShop.js); this page only asks, has the wallet sign, and reports.

     DSSkins.owns(game, skin)           true when this wallet owns it (GET /api/skins/owned)
     DSSkins.refresh()                  reads what the wallet owns again
     DSSkins.buy(game, skin, onStatus)  intent -> the wallet signs (duelWalletSignSkin) -> /api/skins/buy -> settled.
                                        Resolves { ok:true, item } | { pending:true } | { owned:true };
                                        rejects with a plain-words Error (e.cancelled when the player said no)
     DSSkins.wear(game, skin|null)      the paid skin a game sends in its join (null: its free look)
     DSSkins.worn(game)                 the paid skin being worn in that game, if still owned, else null
     DSSkins.ensurePass(force)          the skin pass the games send (POST /api/skins/pass, a silent one-time
                                        signature over 'skins:pass'); refetched when it is near expiry or no
                                        longer lists everything owned

   What a game page reads (same origin): localStorage 'duel.shop.<game>' (the skin id) and 'duel.skinpass' (the
   pass). The game's SERVER decides: a pass that is not genuine or does not list the skin is the free look.

   A purchase on its way is saved under 'duel.skinbuy' BEFORE its payment is sent, so a reload asks the server
   where it stands (GET /api/skins/purchase/:ref) and finishes it: a payment that landed is always the skin. */
(function (root) {
  'use strict';
  const PASS_KEY = 'duel.skinpass';
  const PASS_WALLET = 'duel.skinpass.w';
  const BUY_KEY = 'duel.skinbuy';
  const shopKey = (g) => 'duel.shop.' + g;
  const HOUR = 3600 * 1000;

  function createSkinBuy(env) {
    const e = env || {};
    const fetch = e.fetch;
    const store = e.storage;
    const wallet = e.wallet;                 // () -> { address, balance } | null
    const now = e.now || (() => Date.now());
    const sleep = e.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const emit = e.emit || (() => {});
    const pollMs = e.pollMs != null ? e.pollMs : 3000;
    const pollFor = e.pollFor != null ? e.pollFor : 3 * 60 * 1000;
    let owned = new Set();
    let ownedFor = null;
    let busy = false;
    let passing = null;

    const get = (k) => { try { return store.getItem(k); } catch (_) { return null; } };
    const put = (k, v) => { try { if (v == null) store.removeItem(k); else store.setItem(k, v); } catch (_) {} };
    const addr = () => { const w = wallet && wallet(); return w && w.address ? w.address : null; };

    async function json(url, opts) {
      const r = await fetch(url, opts);
      let body = {};
      try { body = await r.json(); } catch (_) {}
      return { status: r.status, body: body || {} };
    }
    const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    function owns(game, skin) { return !!addr() && ownedFor === addr() && owned.has(game + ':' + skin); }

    async function refresh() {
      const w = addr();
      if (!w) { owned = new Set(); ownedFor = null; forgetPass(); emit(); return owned; }
      if (get(PASS_WALLET) && get(PASS_WALLET) !== w) forgetPass();   // another wallet's pass never rides along
      const r = await json('/api/skins/owned?wallet=' + encodeURIComponent(w));
      if (r.status === 200 && Array.isArray(r.body.items) && addr() === w) {
        owned = new Set(r.body.items.filter((i) => typeof i === 'string'));
        ownedFor = w;
        emit();
      }
      return owned;
    }

    function forgetPass() { put(PASS_KEY, null); put(PASS_WALLET, null); put(PASS_KEY + '.x', null); put(PASS_KEY + '.i', null); }

    // The pass the games send. Refetched when missing, another wallet's, under 6 h from expiry, or missing an item
    // the wallet owns. A wallet owning nothing needs none.
    async function ensurePass(force) {
      const w = addr();
      if (!w || !owned.size || ownedFor !== w) return null;
      const have = get(PASS_KEY);
      const exp = Number(get(PASS_KEY + '.x')) || 0;
      let listed = [];
      try { listed = JSON.parse(get(PASS_KEY + '.i') || '[]'); } catch (_) { listed = []; }
      const stale = !have || get(PASS_WALLET) !== w || exp - now() < 6 * HOUR || [...owned].some((i) => !listed.includes(i));
      if (!force && !stale) return have;
      if (passing) return passing;
      passing = (async () => {
        try {
          if (typeof e.signAction !== 'function') return null;
          const proof = await e.signAction('skins:pass', {});
          if (!proof || addr() !== w) return null;
          const r = await post('/api/skins/pass', { proof });
          if (r.status !== 200 || typeof r.body.pass !== 'string') return null;
          put(PASS_KEY, r.body.pass); put(PASS_WALLET, w);
          put(PASS_KEY + '.x', String(r.body.exp || 0));
          put(PASS_KEY + '.i', JSON.stringify(Array.isArray(r.body.items) ? r.body.items : []));
          return r.body.pass;
        } catch (_) {
          return null;
        } finally {
          passing = null;
        }
      })();
      return passing;
    }

    function wear(game, skin) {
      put(shopKey(game), skin ? String(skin) : null);
      if (skin) ensurePass(false);
    }
    function worn(game) {
      const s = get(shopKey(game));
      return s && owns(game, s) ? s : null;
    }

    // The saved purchase on its way, settled: polls the server until it is paid, failed or expired (3 minutes).
    async function settle(ref, onStatus) {
      const start = now();
      const end = start + pollFor;
      for (;;) {
        const r = await json('/api/skins/purchase/' + encodeURIComponent(ref));
        const st = r.body && r.body.state;
        if (st === 'paid') return finishPaid(r.body.item);
        if (st === 'failed' || st === 'expired' || st === 'review' || r.status === 404) {
          put(BUY_KEY, null);
          const err = new Error(r.body.error || 'That payment did not go through, so no money moved.');
          err.settled = st || 'gone';
          throw err;
        }
        // Still open: the signed payment never reached the server (or is reaching it right now, so not at once).
        if (st === 'open' && now() - start >= 20000) {
          put(BUY_KEY, null);
          const err = new Error('That payment was never sent. Nothing was charged.');
          err.cancelled = true;
          throw err;
        }
        if (now() >= end) return { pending: true, ref };
        if (onStatus) onStatus('Still confirming on the network…');
        await sleep(pollMs);
      }
    }

    async function finishPaid(item) {
      put(BUY_KEY, null);
      if (item) { owned.add(item); ownedFor = addr(); }
      emit();
      refresh().then(() => ensurePass(true)).catch(() => {});
      return { ok: true, item };
    }

    // expectUsd: the price the sheet showed. A quote at any other price is never signed (the server prices it; this
    // only makes sure the player pays what they read).
    async function buy(game, skin, onStatus, expectUsd) {
      const w = addr();
      if (!w) throw new Error('Log in to unlock skins.');
      if (busy) throw new Error('A purchase is already in progress.');
      busy = true;
      const say = (s) => { if (onStatus) try { onStatus(s); } catch (_) {} };
      try {
        say('Getting the price…');
        const q = await post('/api/skins/intent', { game, skin, wallet: w });
        if (q.status !== 200) throw new Error(q.body.error || 'Could not start the purchase. Try again.');
        if (q.body.owned) { await finishPaid(q.body.item); return { owned: true, item: q.body.item }; }
        if (q.body.pending) {
          put(BUY_KEY, JSON.stringify({ ref: q.body.ref, game, skin, wallet: w, at: now() }));
          say('Your earlier payment is still confirming…');
          return await settle(q.body.ref, say);
        }
        // SOL mode quotes amountUsd (the dollars), USDC mode amountUsdc
        const quotedUsd = Number(q.body.amountUsd != null ? q.body.amountUsd : q.body.amountUsdc);
        if (expectUsd != null && Math.abs(quotedUsd - Number(expectUsd)) > 1e-9) {
          const pc = new Error('The price is now $' + quotedUsd.toFixed(2) + '. Refresh the page to see it.');
          pc.cancelled = true;
          throw pc;
        }
        say('Confirm in your wallet…');
        let signed;
        try {
          signed = await e.signSkin(q.body);
        } catch (err) {
          const c = new Error('Cancelled. Nothing was charged.');
          c.cancelled = true;
          throw c;
        }
        if (!signed || addr() !== w) { const c = new Error('Cancelled. Nothing was charged.'); c.cancelled = true; throw c; }
        // Saved BEFORE it is sent: a reload from here on resumes this purchase.
        put(BUY_KEY, JSON.stringify({ ref: q.body.ref, game, skin, wallet: w, at: now() }));
        say('Unlocking…');
        let r;
        try {
          r = await post('/api/skins/buy', { ref: q.body.ref, signedTx: signed });
        } catch (_) {
          say('Still confirming on the network…');
          return await settle(q.body.ref, say);
        }
        if (r.status === 200 && r.body.state === 'paid') return finishPaid(r.body.item);
        if (r.status === 202 || (r.status === 409 && r.body.pending)) { say('Still confirming on the network…'); return await settle(q.body.ref, say); }
        if (r.body && r.body.owned) { put(BUY_KEY, null); await refresh(); return { owned: true }; }
        put(BUY_KEY, null);
        const err = new Error(r.body.error || 'The purchase did not go through. Nothing was charged.');
        if (/Not enough (USDC|in your wallet)|SOL for the network fee/.test(err.message)) err.funds = true;
        throw err;
      } finally {
        busy = false;
      }
    }

    // A purchase a reload interrupted: finished now. Resolves the same as buy, or null when there is none.
    async function resume(onStatus) {
      let saved = null;
      try { saved = JSON.parse(get(BUY_KEY) || 'null'); } catch (_) { saved = null; }
      if (!saved || typeof saved.ref !== 'string') return null;
      if (saved.wallet && saved.wallet !== addr()) return null;
      if (busy) return null;
      busy = true;
      try {
        return Object.assign({ game: saved.game, skin: saved.skin }, await settle(saved.ref, onStatus));
      } catch (err) {
        err.game = saved.game; err.skin = saved.skin;
        throw err;
      } finally {
        busy = false;
      }
    }

    return { owns, refresh, buy, resume, wear, worn, ensurePass, forgetPass, get busy() { return busy; },
             KEYS: { PASS_KEY, BUY_KEY, shopKey } };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createSkinBuy };
  if (root && root.document) {
    const api = createSkinBuy({
      fetch: (u, o) => root.fetch(u, o),
      storage: root.localStorage,
      wallet: () => root.duelWallet || null,
      signSkin: (q) => (typeof root.duelWalletSignSkin === 'function' ? root.duelWalletSignSkin(q) : Promise.reject(new Error('Wallet not ready'))),
      signAction: (a, args) => (typeof root.duelWalletSignAction === 'function' ? root.duelWalletSignAction(a, args) : Promise.resolve(null)),
      emit: () => { try { root.dispatchEvent(new root.CustomEvent('ds:skins')); } catch (_) {} },
    });
    root.DSSkins = api;
    const nameOf = (g, s) => {
      const S = root.V2Shop, sg = S && S.game(g), k = sg && sg.skins.find((x) => x.id === s);
      return { skin: k ? k.name : s, game: sg ? sg.name : g };
    };
    let seen = null;
    root.addEventListener('duelwallet:change', () => {
      const w = root.duelWallet && root.duelWallet.address ? root.duelWallet.address : null;
      if (w === seen) return;
      seen = w;
      api.refresh().then(() => api.ensurePass(false)).catch(() => {});
      // A purchase a reload cut off: finished, and said.
      api.resume().then((r) => {
        if (!r || !root.DSToast) return;
        const n = nameOf(r.game, r.skin);
        if (r.ok || r.owned) root.DSToast.show({ kind: 'ok', title: 'Unlocked ' + n.skin, detail: 'Yours in ' + n.game });
        else if (r.pending) root.DSToast.show({ kind: 'info', title: 'Still confirming', detail: n.skin + ' unlocks when the network confirms it' });
      }).catch((err) => {
        if (root.DSToast && err && !err.cancelled) root.DSToast.show({ kind: 'err', title: 'Skin not unlocked', detail: err.message });
      });
    });
  }
})(typeof window !== 'undefined' ? window : null);
