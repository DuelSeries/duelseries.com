'use strict';
// Night review 2026-10-29 (findings 26 and 35): player names lose invisible, bidi and control characters, staff and
// brand names are reserved, the server's shared sanitizeName uses both, payouts never claim a taken name, and the
// public boards strip the same characters from names already stored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const playerName = require('../server/playerName');
const { cleanName, nameKey, isReservedName } = playerName;

const ROOT = path.join(__dirname, '..');
const ch = (n) => String.fromCharCode(n);

// The server's own sanitizeName, lifted out of server/index.js (index.js boots a server when required).
function serverSanitizeName() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const m = /function sanitizeName\(name\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'server/index.js sanitizeName found');
  return new Function('playerName', m[0] + '\nreturn sanitizeName;')(playerName);
}

test('cleanName: zero-width, bidi, invisible and control characters go; letters an honest player chose stay', () => {
  assert.strictEqual(cleanName('Owen' + ch(0x200b)), 'Owen');
  assert.strictEqual(cleanName(ch(0x202e) + 'esreveR'), 'esreveR');
  assert.strictEqual(cleanName('Duel' + ch(0x2063) + 'Series'), 'DuelSeries');
  assert.strictEqual(cleanName('a' + ch(0) + 'b' + ch(7) + 'c'), 'a b c');
  assert.strictEqual(cleanName(ch(0x200b).repeat(3)), '');
  assert.strictEqual(cleanName('  two   spaces  '), 'two spaces');
  assert.strictEqual(cleanName('<b>x</b>'), 'bx/b');
  for (const s of ['Zoë', 'José', 'Ｂｏｂ', '𝓢𝓷𝓪𝓴𝓮', '小龙', 'Влад', 'x_X-99']) assert.strictEqual(cleanName(s), s, s);
  assert.strictEqual(cleanName(5), '');
  assert.strictEqual(cleanName({ toString: 1 }), '');
});

test('reserved: the site and staff names in any spelling; ordinary names, bots included, are free', () => {
  for (const s of ['DuelSeries', 'DuelSeries Support', 'Duel Series', 'D u e l S e r i e s', 'DueISeries', 'duel_series',
    'Duel5eries', 'Admin', 'adm1n', 'DS Admin', 'TheOwner', 'Owner', '0wner', 'M0D', 'mod', 'Mods', 'Staff', 'DS staff',
    'Official', 'Support', 'Supp0rt', 'Help Support', 'Moderator', 'аdmin', 'Ad' + ch(0x200b) + 'min']) {
    assert.strictEqual(isReservedName(s), true, s);
  }
  for (const s of ['Owen', 'Bob', 'Player', 'Downer', 'Badminton', 'Modern', 'Moderna', 'Teamwork', 'Ownage', 'Stafford',
    'Admiral', 'Bigstaff', 'snake', 'gg', 'Zoë', '', 'Dev', 'Team Liquid']) {
    assert.strictEqual(isReservedName(s), false, s);
  }
  const { BASE_NAMES, makeName } = require('../server/botNames');
  for (const n of BASE_NAMES) assert.strictEqual(isReservedName(n), false, 'bot name ' + n);
  for (let i = 0; i < 2000; i++) {
    const n = makeName(i / 2000);
    assert.strictEqual(isReservedName(n), false, 'bot name ' + n);
  }
  assert.strictEqual(nameKey('0wen'), nameKey('Owen'), 'look-alikes share a key');
  assert.strictEqual(nameKey('O.w.e.n'), nameKey('owen'));
  assert.strictEqual(nameKey('Оwen'), nameKey('Owen'), 'a Cyrillic O');
  assert.notStrictEqual(nameKey('Owen'), nameKey('Owens'));
});

test('the server sanitizeName: invisible characters stripped, staff and brand names become Player, the rest unchanged', () => {
  const sanitizeName = serverSanitizeName();
  assert.strictEqual(sanitizeName('Owen' + ch(0x200b)), 'Owen');
  assert.strictEqual(sanitizeName(ch(0x202e) + 'abc'), 'abc');
  assert.strictEqual(sanitizeName(ch(0x200b).repeat(3)), 'Player');
  assert.strictEqual(sanitizeName('DuelSeries Support'), 'Player');
  assert.strictEqual(sanitizeName('Admin'), 'Player');
  assert.strictEqual(sanitizeName('<script>'), 'script');
  assert.strictEqual(sanitizeName('x'.repeat(30)), 'x'.repeat(20));
  assert.strictEqual(sanitizeName(42), '42');
  assert.strictEqual(sanitizeName({ toString: 1 }), 'Player');
  assert.strictEqual(sanitizeName(undefined), 'Player');
  for (const s of ['Bob', 'Zoë', 'snake king', 'Player']) assert.strictEqual(sanitizeName(s), s, s);
});

test('agar asks the helper about the whole name too, so a reserved name split across pieces is still Player', () => {
  const { cleanName: agClean } = require('../server/ag/agSockets');
  const sanitizeName = serverSanitizeName();
  const clean = (n) => agClean(n, 15, sanitizeName);
  assert.strictEqual(clean('DuelSeries'), 'Player');
  assert.strictEqual(clean('DuelSeri' + 'es Support'), 'Player');
  assert.strictEqual(clean('Owner of all'), 'Player');
  assert.strictEqual(clean('Bob the snake'), 'Bob the snake');
  assert.strictEqual(clean('Player'), 'Player');
  assert.strictEqual(clean('Zo' + ch(0x200b) + 'ë'), 'Zoë');
});

// ---- recordEarnings (finding 35) ------------------------------------------------------------------------------------

function withPool(db, answer, fn) {
  const sent = [];
  const real = db.pool.query;
  db.pool.query = async (sql, params) => {
    sent.push({ sql: sql.replace(/\s+/g, ' '), params });
    return answer(sql, params, sent.length);
  };
  return Promise.resolve().then(() => fn(sent)).finally(() => { db.pool.query = real; });
}

test('recordEarnings: a payout names an account only with a free, real name; the landed row is always written', async () => {
  const db = require('../server/db');
  const ok = async () => ({ rows: [], rowCount: 1 });
  // 'Player', a blank, a staff name: no name at all (NULL shows as the short wallet), never 'Player'
  for (const n of ['Player', 'player', '', null, undefined, 'DuelSeries Support', ch(0x200b)]) {
    await withPool(db, ok, async (sent) => {
      await db.recordEarnings('W1', n, 1.5, 2);
      assert.strictEqual(sent.length, 2, String(n));
      assert.deepStrictEqual(sent[0].params, ['W1', null, 1.5], String(n));
      assert.match(sent[1].sql, /INSERT INTO earnings_history/);
      assert.deepStrictEqual(sent[1].params, ['W1', 1.5, 2]);
    });
  }
  // a real name goes in cleaned, and the statement itself refuses one another account holds
  await withPool(db, ok, async (sent) => {
    await db.recordEarnings('W1', 'Bob' + ch(0x200b), 1, 0);
    assert.deepStrictEqual(sent[0].params, ['W1', 'Bob', 1]);
    const up = sent[0].sql;
    assert.match(up, /CASE WHEN \$2::text IS NOT NULL AND NOT EXISTS \( SELECT 1 FROM accounts b WHERE LOWER\(b\.name\) = LOWER\(\$2::text\) AND b\.google_id <> \$1\) THEN \$2::text END/);
    assert.match(up, /ON CONFLICT \(google_id\) DO UPDATE SET total_earnings = COALESCE\(accounts\.total_earnings, 0\) \+ \$3,/);
    assert.match(up, /name = CASE WHEN \(accounts\.name IS NULL OR accounts\.name = '' OR LOWER\(accounts\.name\) = 'player'\) AND EXCLUDED\.name IS NOT NULL THEN EXCLUDED\.name ELSE accounts\.name END/);
  });
  // two payouts racing for one free name: the loser's statement wrote nothing, so it goes again nameless, once
  const dup = () => { const e = new Error('duplicate key'); e.code = '23505'; return e; };
  await withPool(db, async (sql, p, i) => { if (i === 1) throw dup(); return { rows: [] }; }, async (sent) => {
    await db.recordEarnings('W2', 'Bob', 1, 0);
    assert.deepStrictEqual(sent.map((s) => s.params), [['W2', 'Bob', 1], ['W2', null, 1], ['W2', 1, 0]]);
  });
  // any other failure is still the caller's (nothing retried, nothing double counted)
  await withPool(db, async (sql, p, i) => { if (i === 1) throw new Error('down'); return { rows: [] }; }, async (sent) => {
    await assert.rejects(db.recordEarnings('W3', 'Bob', 1, 0), /down/);
    assert.strictEqual(sent.length, 1);
  });
  await withPool(db, async () => { throw dup(); }, async (sent) => {
    await assert.rejects(db.recordEarnings('W4', 'Player', 1, 0), /duplicate/);
    assert.strictEqual(sent.length, 1, 'a nameless upsert is never retried');
  });
});

test('getProfile: a name two accounts share opens the older one', async () => {
  const db = require('../server/db');
  await withPool(db, async () => ({ rows: [] }), async (sent) => {
    assert.strictEqual(await db.getProfile('Bob'), null);
    assert.match(sent[0].sql, /WHERE LOWER\(name\) = LOWER\(\$1\) ORDER BY created_at ASC NULLS LAST, google_id LIMIT 1/);
  });
});

test('getMyProfile: no nameHistory; getAccountName reads one name', async () => {
  const db = require('../server/db');
  await withPool(db, async (sql) => (/FROM accounts/.test(sql)
    ? { rows: [{ name: 'Bob', total_earnings: '1', games_played: 2, play_time_seconds: 3, created_at: 't' }] }
    : { rows: [] }), async (sent) => {
    const p = await db.getMyProfile('W');
    assert.strictEqual(p.name, 'Bob');
    assert.ok(!('nameHistory' in p));
    assert.doesNotMatch(sent[0].sql, /name_history/);
    assert.strictEqual(await db.getAccountName('W'), 'Bob');
  });
});

test('the boards strip zero-width and bidi characters from names already stored', () => {
  const { displayName } = require('../server/earnings');
  const A = 'AAAAbbbbccccddddeeeeffffgggghhhhZZ11';
  assert.strictEqual(displayName('Owen' + ch(0x200b), A), 'Owen');
  assert.strictEqual(displayName(ch(0x202e) + 'xyz', A), 'xyz');
  assert.strictEqual(displayName(ch(0x200b) + ch(0x2063), A), 'AAAA…ZZ11');
});
