// CollusionMonitor — detects one account systematically funneling value to another.
//
// Value moves between accounts when a snake/cell dies and another player eats the
// dropped cash. In normal play those flows spread across many opponents; collusion
// (feed-a-loss laundering, or boosting a buddy's / alt account) concentrates them into
// a repeated, one-directional pair. We aggregate directed value flow per ordered
// (source -> dest) account pair over a rolling window and flag pairs that are ALL of:
//   - repeated        ( >= MIN_EVENTS transfers )
//   - sizable         ( >= MIN_NET_SOL moved net src -> dst )
//   - one-directional ( src->dst is >= ONEWAY of the two-way total — dst barely feeds back )
//   - concentrated    ( src is >= CONC of everything dst received this window )
// Flags are logged, persisted (db.recordCollusionFlag) and pushed to the owner, with a
// per-pair cooldown so a sustained pair isn't re-alerted every cycle.
//
// Bots carry no googleId, so bot<->player and bot<->bot flows are ignored automatically.
// Thresholds are env-tunable so they can be calibrated against real traffic.

const WINDOW_MS          = Number(process.env.COLLUSION_WINDOW_MS)   || 24 * 60 * 60 * 1000;
const MIN_EVENTS         = Number(process.env.COLLUSION_MIN_EVENTS)  || 5;
const MIN_NET_SOL        = Number(process.env.COLLUSION_MIN_SOL)     || 0.02;
const ONEWAY             = Number(process.env.COLLUSION_ONEWAY)      || 0.8;
const CONC               = Number(process.env.COLLUSION_CONC)        || 0.5;
const EVAL_MS            = Number(process.env.COLLUSION_EVAL_MS)     || 30 * 1000;
const REFLAG_COOLDOWN_MS = Number(process.env.COLLUSION_COOLDOWN_MS) || 60 * 60 * 1000;

const pairs       = new Map(); // "src|dst" -> { src, dst, sol, count, firstTs, lastTs, lobbyType }
const received    = new Map(); // dst -> total sol received in window (recomputed each eval)
const lastFlagged = new Map(); // "src|dst" -> ts of last flag (cooldown)
let _db = null, _onFlag = null, _timer = null;

function init({ db, onFlag } = {}) {
  _db = db || null;
  _onFlag = onFlag || null;
  if (_timer) clearInterval(_timer);
  _timer = setInterval(evaluate, EVAL_MS);
  if (_timer.unref) _timer.unref();
}

// Record that `amount` SOL of cash value moved from account `src` to account `dst`.
function record(src, dst, amount, ctx = {}) {
  if (!src || !dst || src === dst || !(amount > 0)) return; // need two distinct real accounts
  const now = Date.now();
  const key = src + '|' + dst;
  let p = pairs.get(key);
  if (!p) { p = { src, dst, sol: 0, count: 0, firstTs: now, lastTs: now, lobbyType: ctx.lobbyType || '?' }; pairs.set(key, p); }
  p.sol += amount;
  p.count++;
  p.lastTs = now;
  if (ctx.lobbyType) p.lobbyType = ctx.lobbyType;
}

function _prune(now) {
  for (const [k, p] of pairs) if (now - p.lastTs > WINDOW_MS) pairs.delete(k);
  received.clear();
  for (const p of pairs.values()) received.set(p.dst, (received.get(p.dst) || 0) + p.sol);
}

function _assess(p) {
  const rev    = pairs.get(p.dst + '|' + p.src);
  const revSol = rev ? rev.sol : 0;
  const net    = p.sol - revSol;
  const oneWay = p.sol / (p.sol + revSol);          // ~1 = purely src -> dst
  const intake = received.get(p.dst) || p.sol;       // everything dst received this window
  const conc   = p.sol / intake;                     // src's share of dst's intake
  const suspicious = p.count >= MIN_EVENTS && net >= MIN_NET_SOL && oneWay >= ONEWAY && conc >= CONC;
  return { net, oneWay, conc, suspicious };
}

function evaluate() {
  const now = Date.now();
  _prune(now);
  for (const [key, p] of pairs) {
    const a = _assess(p);
    if (!a.suspicious) continue;
    if (now - (lastFlagged.get(key) || 0) < REFLAG_COOLDOWN_MS) continue;
    lastFlagged.set(key, now);
    const flag = {
      src: p.src, dst: p.dst,
      netSol: +a.net.toFixed(6), totalSol: +p.sol.toFixed(6), count: p.count,
      oneWayRatio: +a.oneWay.toFixed(3), concentration: +a.conc.toFixed(3),
      lobbyType: p.lobbyType, windowMs: WINDOW_MS, ts: now,
    };
    console.warn(`[COLLUSION] ${p.src} -> ${p.dst}: net ${flag.netSol} SOL over ${p.count} feeds, oneway ${flag.oneWayRatio}, conc ${flag.concentration} (${p.lobbyType})`);
    if (_db && _db.recordCollusionFlag) _db.recordCollusionFlag(flag).catch(e => console.error('[COLLUSION] persist failed:', e.message));
    if (_onFlag) { try { _onFlag(flag); } catch (e) {} }
  }
}

// Live view for the owner admin endpoint: current top one-directional pairs.
function topPairs(limit = 25) {
  _prune(Date.now());
  const out = [];
  for (const p of pairs.values()) {
    const a = _assess(p);
    out.push({
      src: p.src, dst: p.dst, totalSol: +p.sol.toFixed(6), netSol: +a.net.toFixed(6),
      count: p.count, oneWayRatio: +a.oneWay.toFixed(3), concentration: +a.conc.toFixed(3),
      lobbyType: p.lobbyType, suspicious: a.suspicious, lastTs: p.lastTs,
    });
  }
  out.sort((x, y) => y.netSol - x.netSol);
  return out.slice(0, limit);
}

module.exports = {
  init, record, evaluate, topPairs,
  _config: { WINDOW_MS, MIN_EVENTS, MIN_NET_SOL, ONEWAY, CONC, REFLAG_COOLDOWN_MS },
  _state: { pairs, received, lastFlagged }, // exposed for tests
};
