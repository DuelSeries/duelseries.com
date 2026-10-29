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
// The trade-off, written down: two real people on one network (one home's wifi, one campus or carrier NAT address)
// count as one, and a first-time winner who never played a paid game is not paid automatically. Both go to the
// existing "prize held, Owen settles" push, so an honest winner waits for Owen rather than losing the prize; a farmer
// can no longer pull $20 to a throwaway key.

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

module.exports = { countPeople, stakedPeople };
