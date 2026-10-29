'use strict';
// Who counts as a different PERSON for the battle royale's house prize (night review 2026-10-29).
//
// The rule is Owen's and unchanged: a match pays its $20 automatically only when at least two different people were
// in it when the doors shut; anything less is held for him to settle by hand. What changed is what "a person" means,
// because a proven wallet costs nothing: any keypair made offline signs the play:identify proof, so two of them (or
// thirty, one per /sl socket of one address) made one person "two people" and the house paid $20 to a fresh key.
//
//   countPeople(seats)   seats [{ wallet, net }] (the proven seats, net = clientAddr.addressGroup of the seat's address):
//                        min(distinct wallets, distinct networks). A seat with no known network shares one '' bucket,
//                        so it never adds a person. brMatch's prizeHeld counts with this as the doors shut.
//   stakedPeople({ seats, winner, lookup })   the same count over the seats whose wallet has really played paid
//                        (lookup(wallets) -> Set of those with a stakes_history row: written only by recordEntry, for a
//                        real on-chain stake that was seated). ok when the winner is one of them and they are at least
//                        two people. A lookup that throws or answers nonsense is not ok: the prize is held, never paid
//                        on a guess.
//
//   recentPrize({ prizes, wallet, net, matchId, now, days })   (second pass) the journal entry (brJournal.prizes()) of
//                        an AUTOMATIC prize to this wallet, or to a winner from this network, in the last `days` days,
//                        else null. Every state but 'held' counts ('checking' may still become a send; 'failed' and
//                        'unknown' may have landed or been settled by hand). An entry whose time cannot be read counts.
//                        days 0 or less: never.
//   netOf(seats, wallet) the network that wallet's seat joined from ('' when unknown or not there).
//
// The trade-off, written down: two real people on one network (one home's wifi, one campus or carrier NAT address)
// count as one, and a first-time winner who never played a paid game is not paid automatically. Both go to the
// existing "prize held, Owen settles" push, so an honest winner waits for Owen rather than losing the prize; a farmer
// can no longer pull $20 to a throwaway key.
//
// Second pass (night review 2026-10-29): stakedPeople alone still let a farm meet the rule cheaply and then repeat it,
// two wallets that each played ONE $0.50 game (about $0.10 net, once, and the rows stay forever) plus a second
// network (a hotspot), $20 a slot, four slots a day, with nothing per wallet. So an automatic prize is also held when
// the winner's wallet, or the network the winner played from, had one in the last COOLDOWN_DAYS: a farm needs a
// fresh staked wallet AND a fresh network for every $20 it takes. An honest repeat winner inside the week is held for
// Owen like every other case here, never lost.

const COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Every journal state but 'held' (brJournal PRIZE_STATES): a send was, may have been, or may yet be under way.
const AUTO_STATES = new Set(['checking', 'paying', 'paid', 'failed', 'unknown']);

function countPeople(seats) {
  const wallets = new Set();
  const nets = new Set();
  for (const s of Array.isArray(seats) ? seats : []) {
    if (!s || typeof s.wallet !== 'string' || !s.wallet) continue;
    wallets.add(s.wallet);
    nets.add(typeof s.net === 'string' ? s.net : '');
  }
  return Math.min(wallets.size, nets.size);
}

// -> { ok, people (staked people, or null when the lookup failed), winnerStaked }
async function stakedPeople({ seats, winner, lookup } = {}) {
  const list = Array.isArray(seats) ? seats.filter((s) => s && typeof s.wallet === 'string' && s.wallet) : [];
  if (typeof winner !== 'string' || !winner || !list.length || typeof lookup !== 'function') {
    return { ok: false, people: 0, winnerStaked: false };
  }
  let real;
  try {
    real = await lookup([...new Set(list.map((s) => s.wallet))]);
  } catch (_) {
    return { ok: false, people: null, winnerStaked: false };
  }
  if (!(real instanceof Set)) return { ok: false, people: null, winnerStaked: false };
  const people = countPeople(list.filter((s) => real.has(s.wallet)));
  const winnerStaked = real.has(winner) && list.some((s) => s.wallet === winner);
  return { ok: winnerStaked && people >= 2, people, winnerStaked };
}

function recentPrize({ prizes, wallet, net, matchId, now, days } = {}) {
  if (!(days > 0) || !Number.isFinite(now)) return null;
  const since = now - days * DAY_MS;
  const w = typeof wallet === 'string' && wallet ? wallet : null;
  const n = typeof net === 'string' && net ? net : null;
  for (const p of Array.isArray(prizes) ? prizes : []) {
    if (!p || (matchId && p.matchId === matchId) || !AUTO_STATES.has(p.state)) continue;
    if (!((w && p.wallet === w) || (n && p.net === n))) continue;
    const at = typeof p.at === 'string' ? Date.parse(p.at) : NaN;
    if (!Number.isFinite(at) || at >= since) return p;
  }
  return null;
}

function netOf(seats, wallet) {
  if (typeof wallet !== 'string' || !wallet) return '';
  const s = (Array.isArray(seats) ? seats : []).find((x) => x && x.wallet === wallet);
  return s && typeof s.net === 'string' ? s.net : '';
}

module.exports = { countPeople, stakedPeople, recentPrize, netOf, COOLDOWN_DAYS };
