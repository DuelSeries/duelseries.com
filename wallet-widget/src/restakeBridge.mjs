// The in-game "Play again" bridge (STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 3).
//
// A game page in the lobby's frame asks the wallet to buy another round (duel:restake); the
// wallet stakes and posts the fresh entry token back (duel:restake:done). The stake can take a
// long time (the wallet's approval), and meanwhile the lobby may clear the frame (game:done sets
// it blank) or load another page into it. The old handler then posted the token into whatever
// the frame held: a stake with no seat. Here the answer goes only to the document that asked,
// on this origin, with its nonce; when that document is gone BEFORE the money moves, nothing is
// submitted; when it goes AFTER, the round that was paid for opens instead of being dropped.
//
// Plain ES module with no imports, so node tests load it as it ships (test/restakeBridge.test.js).

export function cancelledError() {
  const e = new Error('Stake cancelled: the game that asked for it was closed.');
  e.cancelled = true;
  return e;
}

// frames(game) -> the iframe element that game runs in (or null)
// origin       -> this lobby's origin; only same-origin frames may ask, answers go only there
// stake(req, { stillWanted }) -> Promise<{ entryToken, ... }>; must call stillWanted() right
//                before asking for the signature and again right before submitting, and throw
//                cancelledError() when it returns false (no money moves)
// relaunch(req, staked) -> true when it opened the paid round in a free frame
// log(message)
export function createRestakeBridge({ frames, origin, stake, relaunch, log }) {
  const loads = new WeakMap(); // frame -> how many documents it has loaded since we watched it
  let current = null;
  const say = typeof log === 'function' ? log : () => {};

  function watch(frame) {
    if (loads.has(frame)) return;
    loads.set(frame, 0);
    frame.addEventListener('load', () => loads.set(frame, (loads.get(frame) || 0) + 1));
  }

  // The document that asked is still the one in the frame, and the frame is on screen.
  function alive(req) {
    const f = req.frame;
    return !req.abandoned &&
      f.isConnected !== false &&
      !!f.style && f.style.display === 'block' &&
      f.contentWindow === req.source &&
      loads.get(f) === req.loads;
  }

  function answer(req, msg) {
    if (req.nonce !== undefined) msg.nonce = req.nonce;
    try { req.source.postMessage(msg, origin); } catch (_) { /* the frame went away */ }
  }

  async function onMessage(e) {
    const d = e && e.data;
    if (!d || typeof d !== 'object' || d.type !== 'duel:restake') return;
    if (!origin || e.origin !== origin) return;
    const frame = frames(d.game);
    if (!frame || !e.source || e.source !== frame.contentWindow) return;
    watch(frame);
    const stakeOk = d.stake !== undefined && d.stake !== null;
    const req = {
      game: typeof d.game === 'string' ? d.game : 'snake',
      sel: stakeOk ? { stake: Number(d.stake) } : { lobbyType: typeof d.lobbyType === 'string' ? d.lobbyType : '' },
      frame,
      source: e.source,
      loads: loads.get(frame),
      nonce: typeof d.nonce === 'string' ? d.nonce : undefined,
      abandoned: false
    };
    if (current) {
      answer(req, { type: 'duel:restake:error', message: 'A stake is already in progress.' });
      return;
    }
    current = req;
    try {
      const staked = await stake(req, { stillWanted: () => alive(req) });
      if (alive(req)) {
        answer(req, { type: 'duel:restake:done', entryToken: staked.entryToken });
      } else if (!relaunch(req, staked)) {
        say('a paid ' + req.game + ' round has no page to go to; the frame is busy');
      }
    } catch (err) {
      if (err && err.cancelled) say('cancelled before any money moved: ' + req.game + ' was closed');
      else if (alive(req)) answer(req, { type: 'duel:restake:error', message: (err && err.message) || 'Stake failed' });
    } finally {
      if (current === req) current = null;
    }
  }

  // The lobby cleared the frames (game:done): whatever was asked for is no longer wanted. The
  // slot frees at once, so a wallet prompt that never settles cannot block the next game's
  // Play again; the abandoned stake still stops before its submit, or relaunches after it.
  function onGameDone() {
    if (current) {
      current.abandoned = true;
      current = null;
    }
  }

  return { onMessage, onGameDone, alive, get pending() { return current; } };
}
