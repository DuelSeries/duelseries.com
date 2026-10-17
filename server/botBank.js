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
//   log       the last 50 moves, for the console

const fs = require('fs');
const path = require('path');

const DEFAULT_CAP_MICRO = 5000000;
const LOG_MAX = 50;
const isMicro = (v) => Number.isSafeInteger(v) && v >= 0;

function createBotBank({ file, fsx = fs, now = Date.now, log = console } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('botBank: a file is required');
  let st = { balance: 0, capMicro: DEFAULT_CAP_MICRO, day: '', spent: 0, topups: [], log: [] };
  try {
    const raw = JSON.parse(fsx.readFileSync(file, 'utf8'));
    if (raw && isMicro(raw.balance) && isMicro(raw.capMicro) && isMicro(raw.spent)) {
      st = Object.assign(st, raw, { topups: Array.isArray(raw.topups) ? raw.topups.slice(-500) : [],
        log: Array.isArray(raw.log) ? raw.log.slice(-LOG_MAX) : [] });
    }
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) log.error('[BOTBANK] CRITICAL state unreadable, starting empty: ' + (e && e.message));
  }

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

  return {
    file,
    // -> null when a seed of `micro` can be taken now, else why not ('bank' or 'cap')
    whyNot(micro) {
      roll();
      if (!isMicro(micro) || micro < 1) return 'amount';
      if (st.balance < micro) return 'bank';
      if (st.spent + micro > st.capMicro) return 'cap';
      return null;
    },
    // One bot's seed out of the bank, saved first. -> true, or false (nothing taken)
    take(micro, label) {
      if (this.whyNot(micro) !== null) return false;
      st.balance -= micro;
      st.spent += micro;
      note('seed', micro, { room: String(label || '') });
      if (!save()) {
        st.balance += micro;
        st.spent -= micro;
        st.log.pop();
        return false;
      }
      return true;
    },
    // Unspent seed back (a bot removed or settled, a seed pellet nobody picked up). Today's spent goes down by it.
    giveBack(micro, why, label) {
      if (!isMicro(micro) || micro < 1) return false;
      roll();
      st.balance += micro;
      st.spent = st.spent > micro ? st.spent - micro : 0;
      note('back', micro, { why: String(why || ''), room: String(label || '') });
      if (!save()) log.error('[BOTBANK] CRITICAL ' + micro + ' micro returned but not saved; the file is ' + micro + ' short');
      return true;
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
    view() {
      roll();
      return { balance: st.balance / 1e6, spentToday: st.spent / 1e6, cap: st.capMicro / 1e6,
        log: st.log.slice(-10).map((x) => Object.assign({}, x, { micro: undefined, usd: x.micro / 1e6 })) };
    },
    balanceMicro: () => st.balance,
  };
}

module.exports = { createBotBank, DEFAULT_CAP_MICRO };
