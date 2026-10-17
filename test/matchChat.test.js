'use strict';
/* Knockout and Battleship chat: room.chat() is what index.js's ko:chat / bs:chat handlers call. Only a seated player may
   speak, chatGuard decides what goes out (the cleaned text, never the raw one), a refusal is a note for the sender alone,
   and watchers hear it by seat with no socket id anywhere in it. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutLobby, BOT_AFTER_MS: KO_BOT } = require('../server/KnockoutLobby');
const { BattleshipLobby, BOT_AFTER_MS: BS_BOT } = require('../server/BattleshipLobby');
const { createChatGuard } = require('../server/chatGuard');

function rig(Lobby) {
  const roomSent = [];
  const io = { to: (room) => ({ emit: (ev, p) => roomSent.push({ room, ev, p }) }) };
  return { lob: new Lobby(io), roomSent };
}
function sock(id) {
  const sent = [], rooms = new Set();
  return {
    id, sent, rooms,
    join(r) { rooms.add(r); }, leave(r) { rooms.delete(r); },
    emit(ev, p) { sent.push({ ev, p }); },
    all(ev) { return sent.filter(m => m.ev === ev).map(m => m.p); },
  };
}

for (const g of [
  { name: 'Knockout', Lobby: KnockoutLobby, ev: 'ko:chat', botAfter: KO_BOT },
  { name: 'Battleship', Lobby: BattleshipLobby, ev: 'bs:chat', botAfter: BS_BOT },
]) {
  // Where the line lands: the players' own sockets or their room (Knockout broadcasts, Battleship writes to each seat),
  // plus the watchers' room. Both are collected so the tests do not care which way a game reaches its players.
  const heard = (r, sockets) => sockets.flatMap(s => s.all(g.ev))
    .concat(r.roomSent.filter(m => m.ev === g.ev && !/^(kow|bsw)_/.test(m.room)).map(m => m.p));
  const heardByWatchers = (r) => r.roomSent.filter(m => m.ev === g.ev && /^(kow|bsw)_/.test(m.room)).map(m => m.p);

  test(g.name + ': a seated player\'s line reaches both seats and the watchers, by seat, cleaned', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1');
    r.lob.enqueue(A, 'Owen', null, 0, 0);
    r.lob.enqueue(B, 'Nia', null, 0, 0);
    const room = r.lob.roomOf(A.id);
    assert.ok(room, 'a match is running');
    assert.strictEqual(r.lob.watch(W, {}).ok, true);

    const out = room.chat(B.id, '  gg   <b>ez</b> ', guard, 1000);
    assert.deepStrictEqual(out, { ok: true });
    const to = heard(r, [A, B]);
    // Knockout's one room emit is a single line for both seats; Battleship's is one per seat.
    assert.ok(to.length >= 1);
    for (const m of to) assert.deepStrictEqual(m, { name: 'Nia', side: 1, text: 'gg ez' });
    const w = heardByWatchers(r);
    assert.deepStrictEqual(w, [{ name: 'Nia', side: 1, text: 'gg ez' }]);
    const wire = JSON.stringify(w) + JSON.stringify(to);
    assert.ok(!wire.includes(A.id) && !wire.includes(B.id), 'no socket id on the wire');
  });

  test(g.name + ': a watcher, a stranger and a socket with no seat cannot chat', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1');
    r.lob.enqueue(A, 'Owen', null, 0, 0);
    r.lob.enqueue(B, 'Nia', null, 0, 0);
    const room = r.lob.roomOf(A.id);
    r.lob.watch(W, {});
    const before = r.roomSent.length;
    assert.deepStrictEqual(room.chat(W.id, 'hi from the stands', guard, 1000), { ok: false, note: null });
    assert.deepStrictEqual(room.chat('nobody', 'hi', guard, 1000), { ok: false, note: null });
    assert.strictEqual(r.roomSent.length, before, 'nothing was sent');
    assert.strictEqual(W.all(g.ev).length + A.all(g.ev).length + B.all(g.ev).length, 0);
    assert.strictEqual(r.lob.roomOf(W.id), null, 'and the lobby has no room for a watcher, so the handler stops there too');
  });

  test(g.name + ': a link is refused with a note for the sender and is sent to nobody', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1');
    r.lob.enqueue(A, 'Owen', null, 0, 0);
    r.lob.enqueue(B, 'Nia', null, 0, 0);
    const room = r.lob.roomOf(A.id);
    r.lob.watch(W, {});
    const out = room.chat(A.id, 'free sol at https://evil.example', guard, 1000);
    assert.strictEqual(out.ok, false);
    assert.ok(out.note && typeof out.note === 'string', 'the sender gets a note to show');
    assert.strictEqual(heard(r, [A, B]).length, 0);
    assert.strictEqual(heardByWatchers(r).length, 0);
  });

  test(g.name + ': a flood is rate limited by the guard and the extra lines never go out', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c'), B = sock('sockB-91de');
    r.lob.enqueue(A, 'Owen', null, 0, 0);
    r.lob.enqueue(B, 'Nia', null, 0, 0);
    const room = r.lob.roomOf(A.id);
    assert.strictEqual(room.chat(A.id, 'one', guard, 1000).ok, true);
    assert.strictEqual(room.chat(A.id, 'two', guard, 1050).ok, false);
    assert.deepStrictEqual(heard(r, [A, B]).map(m => m.text).filter((t, i, a) => a.indexOf(t) === i), ['one']);
  });

  test(g.name + ': a long name is cut to 24 characters', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c'), B = sock('sockB-91de');
    r.lob.enqueue(A, 'N'.repeat(40), null, 0, 0);
    r.lob.enqueue(B, 'Nia', null, 0, 0);
    r.lob.roomOf(A.id).chat(A.id, 'hello', guard, 1000);
    assert.strictEqual(heard(r, [A, B])[0].name.length, 24);
  });

  test(g.name + ': against a bot the human still hears their own line, and the bot never speaks', () => {
    const r = rig(g.Lobby), guard = createChatGuard();
    const A = sock('sockA-7f3c');
    r.lob.enqueue(A, 'Owen', null, 0, 0);
    r.lob.tick(Date.now() + g.botAfter + 1);
    const room = r.lob.roomOf(A.id);
    assert.ok(room && room.bot, 'matched with a bot');
    assert.deepStrictEqual(room.chat(A.id, 'gg', guard, 1000), { ok: true });
    const got = heard(r, [A]);
    assert.ok(got.length >= 1);
    assert.deepStrictEqual(got[0], { name: 'Owen', side: 0, text: 'gg' });
    // The bot's id is not a socket anybody can send as: index.js finds a room by the real socket's id.
    assert.strictEqual(r.lob.roomOf(room.bot.id), null);
  });
}
