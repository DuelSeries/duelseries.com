'use strict';
// The owner's bot bank (Owen 2026-10-17): the money that funds paid bounty bots. A paid bot spawns carrying its
// room's stake (its seed), taken from here; a player who kills it wins that money like any player's gold. Unspent
// seed comes back here (a bot removed, Control set lower, a restart, a seed pellet nobody picked up). Never the house.
//
// Where the money really is: Owen sends USDC from his revenue wallet to the ESCROW address (the wallet that pays every
// cash-out), then gives Control that transaction's signature. The server reads the confirmed transaction (the escrow's
// USDC balance went up by the amount, the revenue wallet signed it), claims the signature once (db.markStakeSig, the
// same one-time table stakes use), and only then adds the amount here. So every micro in this bank is already in
// escrow, and a seed handed to a bot is backed by escrow like a player's stake.
//
// State (one small JSON file beside the money journal, atomic write: temp file then rename; written BEFORE a seed
// leaves, so a crash can lose track of at most a seed in flight, never invent one):
//   balance   micro available to fund bots
//   capMicro  the daily limit of seed handed out (default $5), editable in Control
//   day       the UTC day 'YYYY-MM-DD' spent counts for; spent: seed handed out today minus seed returned today
//   topups    signatures already credited (a second credit of one is refused even without the database)
//   inflight  seed now held by live bots. A bot's death moves its seed into play (spent(), the players can win it);
//             a bot leaving any other way gives it back (giveBack live). A hard kill (no settle) leaves inflight > 0:
//             those bots died with the process, their seed still in escrow, so the next load gives it back first.
//   log       the last 50 moves, for the console
//
// Since 2026-10-17 the bank has its OWN WALLET (server/botWallet.js, `chain`): the bank's money is that wallet's
// on-chain USDC, and anything sent to its address is bot money. `balance` above is now the bank's FLOAT: bot money
// already in escrow, ready for a seed. A seed the float cannot cover starts an on-chain transfer bot wallet -> escrow
// (fund); the bot spawns only once that lands (whyNot answers 'funding' until then, and the games re-run their bot
// targets on onReady). Seed coming back (giveBack, a hard stop) lands in the float, and once nothing has been taken
// for a while the float is sent escrow -> bot wallet (sweep). Each transfer is signed, then SAVED here (fund / sweep,
// with its signature and bytes), then sent, then settled from the chain: a crash anywhere re-reads it on the next
// load. A sweep that fails puts its amount back in the float (the owed-to-bank record), and is retried; never lost.
//   fund      { micro, sig, raw, lvbh, at } a transfer into escrow not yet landed (not in the float until it lands)
//   sweep     { micro, sig, raw, lvbh, at } a transfer back to the wallet not yet landed (still owed to the bank)
//   flags     one-time steps done (the move to the wallet, the deposit credited in it)

const fs = require('fs');
const path = require('path');

const DEFAULT_CAP_MICRO = 5000000;
const SWEEP_IDLE_MS = 120000;   // no seed taken this long: the float goes home
const RETRY_MS = 60000;         // after a failed transfer, wait this long before the next one
const EXPIRED_READS = 5;        // past its block height and not found this many reads in a row: it never landed
const FUND_BOTS = 5;            // one fund covers this many seeds at most (fewer transactions when many bots start)
const LOG_MAX = 50;
const isMicro = (v) => Number.isSafeInteger(v) && v >= 0;

function createBotBank({ file, fsx = fs, now = Date.now, log = console, chain = null, tickMs = 4000 } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('botBank: a file is required');
  let st = { balance: 0, capMicro: DEFAULT_CAP_MICRO, day: '', spent: 0, inflight: 0, topups: [], log: [],
    fund: null, sweep: null, flags: {} };
  try {
    const raw = JSON.parse(fsx.readFileSync(file, 'utf8'));
    if (raw && isMicro(raw.balance) && isMicro(raw.capMicro) && isMicro(raw.spent)) {
      st = Object.assign(st, raw, { topups: Array.isArray(raw.topups) ? raw.topups.slice(-500) : [],
        log: Array.isArray(raw.log) ? raw.log.slice(-LOG_MAX) : [] });
    }
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) log.error('[BOTBANK] CRITICAL state unreadable, starting empty: ' + (e && e.message));
  }

  if (!isMicro(st.inflight)) st.inflight = 0;
  const isRec = (r) => !!r && isMicro(r.micro) && r.micro > 0 && typeof r.sig === 'string' && typeof r.raw === 'string';
  if (!isRec(st.fund)) st.fund = null;
  if (!isRec(st.sweep)) st.sweep = null;
  if (!st.flags || typeof st.flags !== 'object') st.flags = {};
  let funding = false;   // a fund being built (not saved yet), so no second one starts
  let sweeping = false;
  let lastTake = now();
  let retryAt = 0;
  const ready = [];
  const today = () => new Date(now()).toISOString().slice(0, 10);
  function roll() {
    const d = today();
    if (st.day !== d) {
      st.day = d;
      st.spent = 0;
    }
  }
  function save() {
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify(st) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.error('[BOTBANK] CRITICAL not saved (' + file + '): ' + (e && e.message));
      return false;
    }
  }
  function note(kind, micro, extra) {
    st.log.push(Object.assign({ at: now(), kind, micro, balance: st.balance }, extra || {}));
    if (st.log.length > LOG_MAX) st.log.splice(0, st.log.length - LOG_MAX);
  }

  // seed live bots held when the process died without settling: back to the balance, once, saved
  if (st.inflight > 0) {
    const m = st.inflight;
    st.balance += m;
    st.inflight = 0;
    // seed handed out today and now back does not count against today's limit (the restored bots take it again)
    if (st.day === new Date(now()).toISOString().slice(0, 10)) st.spent = st.spent > m ? st.spent - m : 0;
    st.log.push({ at: now(), kind: 'back', micro: m, balance: st.balance, why: 'hard-stop' });
    log.error('[BOTBANK] ' + m + ' micro of seed held by bots at a hard stop given back to the bank');
    save();
  }

  // ---- the wallet side (only with a chain) ----
  function startFund(micro) {
    if (!chain || funding || st.fund || now() < retryAt) return;
    funding = true;
    (async () => {
      const b = await chain.build('in', micro);
      st.fund = { micro, sig: b.sig, raw: b.raw, lvbh: b.lvbh, at: now() };
      if (!save()) { st.fund = null; throw new Error('not saved, not sent'); }
      note('fund-sent', micro, { sig: b.sig.slice(0, 16) });
      await chain.broadcast(b.raw);
    })().catch((e) => {
      retryAt = now() + RETRY_MS;
      log.warn('[BOTBANK] fund of ' + micro + ' micro not sent: ' + (e && e.message));
    }).finally(() => { funding = false; });
  }
  function startSweep() {
    if (!chain || sweeping || st.sweep || st.fund || funding || st.balance < 1 || now() < retryAt) return;
    const micro = st.balance;
    sweeping = true;
    (async () => {
      const b = await chain.build('out', micro);
      if (st.balance < micro || st.sweep) return; // a seed took some meanwhile: drop this one unsent, next tick
      st.balance -= micro;
      st.sweep = { micro, sig: b.sig, raw: b.raw, lvbh: b.lvbh, at: now() };
      if (!save()) { st.balance += micro; st.sweep = null; throw new Error('not saved, not sent'); }
      note('sweep-sent', micro, { sig: b.sig.slice(0, 16) });
      await chain.broadcast(b.raw);
    })().catch((e) => {
      retryAt = now() + RETRY_MS;
      log.warn('[BOTBANK] sweep of ' + micro + ' micro not sent: ' + (e && e.message));
    }).finally(() => { sweeping = false; });
  }
  async function settle(kind) {
    const r = st[kind];
    const s = await chain.status(r.sig, r.lvbh);
    if (st[kind] !== r) return;
    if (s === 'pending') { r.miss = 0; await chain.broadcast(r.raw); return; }
    // one 'not found' read can be a lagging node: a transfer that may have landed is never called failed on one read
    if (s === 'expired' && (r.miss = (r.miss || 0) + 1) < EXPIRED_READS) return;
    st[kind] = null;
    if (kind === 'fund' && s === 'landed') { st.balance += r.micro; note('funded', r.micro, { sig: r.sig.slice(0, 16) }); }
    if (kind === 'sweep' && s === 'landed') note('swept', r.micro, { sig: r.sig.slice(0, 16) });
    if (kind === 'sweep' && s !== 'landed') { st.balance += r.micro; note('sweep-failed', r.micro, { sig: r.sig.slice(0, 16) }); }
    if (kind === 'fund' && s !== 'landed') note('fund-failed', r.micro, { sig: r.sig.slice(0, 16) });
    if (s !== 'landed') retryAt = now() + RETRY_MS;
    if (!save()) log.error('[BOTBANK] CRITICAL ' + kind + ' settled (' + s + ') but not saved');
    if (chain.refresh) chain.refresh();
    if (kind === 'fund' && s === 'landed') for (const f of ready) { try { f(); } catch (e) { log.error('[BOTBANK] onReady: ' + (e && e.message)); } }
  }
  let ticking = false;
  async function tick() {
    if (!chain || ticking) return;
    ticking = true;
    try {
      // the wait after a failed transfer is over: the games ask again (a fresh fund starts if bots still wait)
      if (retryAt && now() >= retryAt && !st.fund && !funding) {
        retryAt = 0;
        for (const f of ready) { try { f(); } catch (e) { log.error('[BOTBANK] onReady: ' + (e && e.message)); } }
      }
      if (st.fund) await settle('fund');
      if (st.sweep) await settle('sweep');
      if (now() - lastTake >= SWEEP_IDLE_MS) startSweep();
    } catch (e) {
      log.warn('[BOTBANK] tick: ' + (e && e.message));
    } finally {
      ticking = false;
    }
  }
  let timer = null;
  if (chain && tickMs > 0) {
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
  }

  return {
    file,
    tick,
    stop() { if (timer) clearInterval(timer); timer = null; },
    // fn() runs when a fund lands, so the games can spawn the bots that were waiting for it
    onReady(fn) { if (typeof fn === 'function') ready.push(fn); },
    // -> null when a seed of `micro` can be taken now, else why not ('bank' or 'cap')
    whyNot(micro) {
      roll();
      if (!isMicro(micro) || micro < 1) return 'amount';
      if (st.spent + micro > st.capMicro) return 'cap';
      if (st.balance >= micro) return null;
      if (!chain) return 'bank';
      if (funding || st.fund) return 'funding';
      const w = chain.usdcMicro();
      const need = micro - st.balance;
      if (!Number.isSafeInteger(w) || w < need) return 'bank';
      if (now() < retryAt) return 'funding'; // a transfer just failed: the next try starts when the wait is over
      // up to FUND_BOTS seeds in one transfer, never past the wallet or what is left of today's limit
      const room = st.capMicro - st.spent - st.balance;
      startFund(Math.max(need, Math.min(w, room, need + (FUND_BOTS - 1) * micro)));
      return 'funding';
    },
    // One bot's seed out of the bank, saved first. -> true, or false (nothing taken)
    take(micro, label) {
      if (this.whyNot(micro) !== null) return false;
      st.balance -= micro;
      st.spent += micro;
      st.inflight += micro;
      lastTake = now();
      note('seed', micro, { room: String(label || '') });
      if (!save()) {
        st.balance += micro;
        st.spent -= micro;
        st.inflight -= micro;
        st.log.pop();
        return false;
      }
      return true;
    },
    // Unspent seed back (a bot removed or settled, a seed pellet nobody picked up). Today's spent goes down by it.
    // live: the seed of a bot still alive (it was in flight); false for seed pellets of a bot already dead (spent).
    giveBack(micro, why, label, live) {
      if (!isMicro(micro) || micro < 1) return false;
      roll();
      if (live === true) st.inflight = st.inflight > micro ? st.inflight - micro : 0;
      st.balance += micro;
      st.spent = st.spent > micro ? st.spent - micro : 0;
      note('back', micro, { why: String(why || ''), room: String(label || '') });
      if (!save()) log.error('[BOTBANK] CRITICAL ' + micro + ' micro returned but not saved; the file is ' + micro + ' short');
      return true;
    },
    // A bot died: its seed is in play now (pellets anyone can win), no longer held by a live bot.
    spent(micro) {
      if (!isMicro(micro) || micro < 1) return;
      st.inflight = st.inflight > micro ? st.inflight - micro : 0;
      save();
    },
    // A verified, claimed top-up (the server checked the chain and db.markStakeSig first).
    credit(micro, sig) {
      if (!isMicro(micro) || micro < 1) return { ok: false, why: 'amount' };
      if (typeof sig !== 'string' || !sig) return { ok: false, why: 'signature' };
      if (st.topups.includes(sig)) return { ok: false, why: 'already credited' };
      st.balance += micro;
      st.topups.push(sig);
      if (st.topups.length > 500) st.topups.splice(0, st.topups.length - 500);
      note('topup', micro, { sig: sig.slice(0, 16) });
      return { ok: save(), balance: st.balance };
    },
    setCap(micro) {
      if (!isMicro(micro) || micro > 1000000000) return { ok: false, why: 'cap' };
      st.capMicro = micro;
      return { ok: save(), capMicro: micro };
    },
    hasTopup(sig) {
      return st.topups.includes(sig);
    },
    // one-time steps (the migration): setFlag(name) once, then flag(name) answers true
    flag: (name) => st.flags[name] === true,
    setFlag(name, why) {
      st.flags[name] = true;
      note('step', 0, { why: String(name) + (why ? ': ' + String(why).slice(0, 60) : '') });
      return save();
    },
    view() {
      roll();
      const w = chain ? chain.usdcMicro() : null, lam = chain ? chain.solLamports() : null;
      const away = st.balance + (st.sweep ? st.sweep.micro : 0);
      return { float: away / 1e6, wallet: Number.isSafeInteger(w) ? w / 1e6 : null,
        balance: ((Number.isSafeInteger(w) ? w : 0) + away) / 1e6,
        sol: Number.isSafeInteger(lam) ? lam / 1e9 : null, address: chain ? chain.address : null,
        funding: !!(st.fund || funding), sweeping: !!st.sweep,
        spentToday: st.spent / 1e6, cap: st.capMicro / 1e6,
        log: st.log.slice(-10).map((x) => Object.assign({}, x, { micro: undefined, usd: x.micro / 1e6 })) };
    },
    // bot money escrow holds for the bank (the float, plus a sweep not yet landed): owed like a stake
    balanceMicro: () => st.balance + (st.sweep ? st.sweep.micro : 0),
  };
}

module.exports = { createBotBank, DEFAULT_CAP_MICRO };
