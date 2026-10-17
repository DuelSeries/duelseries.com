'use strict';
// server/chatGuard.js: the one gate every game's chat line goes through (cleaning, rate, scams, abuse).
const test = require('node:test');
const assert = require('node:assert');
const { createChatGuard, clean, contentProblem, maskSwears, MAX_LEN } = require('../server/chatGuard');

const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 97 + 13) % 26 + 97));
const ch = (n) => String.fromCharCode(n);

test('clean: tags and angle brackets gone, hidden characters gone, spaces collapsed, capped', () => {
  assert.strictEqual(clean('  <b>hi</b>   there  '), 'hi there');
  assert.strictEqual(clean('<img src=x onerror=alert(1)>gg'), 'gg');
  assert.strictEqual(clean('a<>b'), 'a b');
  assert.strictEqual(clean('g' + ch(0x200b) + 'g' + ch(0x202e) + ' ez'), 'gg ez');
  assert.strictEqual(clean('line' + ch(10) + 'break' + ch(0)), 'line break');
  assert.strictEqual(clean('noooooooooooo'), 'nooooo');
  assert.strictEqual(clean('x'.repeat(300).split('').join(' ')).length, MAX_LEN - 1);
  assert.strictEqual(clean(ch(0xff48) + ch(0xff49)), 'hi', 'full-width letters folded');
  assert.strictEqual(clean(5), null);
  assert.strictEqual(clean('x'.repeat(5000)), null);
  assert.strictEqual(clean('   '), '');
});

test('links, invites, IPs and wallet addresses are refused; ordinary chat is not', () => {
  for (const s of ['go to https://evil.example', 'www.free-sol', 'claim at solgift.xyz', 'freesol dot com',
    'freesol (dot) com', 'discord.gg/abc', 'join t.me/scam', 'bit.ly/x', 'ping 192.168.0.1', 'owen.sol']) {
    assert.strictEqual(contentProblem(clean(s)), 'link', s);
  }
  for (const s of ['send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '0x52908400098527886E0F7030069857D2E4169EE7',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '7xKX tg2C W87d 97TX JSDp bD5j Bkhe TqA8 3TZR uJos gAsU']) {
    assert.strictEqual(contentProblem(clean(s)), 'addr', s);
  }
  assert.strictEqual(contentProblem('whats your seed phrase'), 'secret');
  assert.strictEqual(contentProblem('dm me your private key'), 'secret');
  for (const s of ['gg ez', 'ok.so what now', 'nice. lol', 'i have 1.5 mass', 'e.g. go left', 'gg.lol',
    'come to the middle, food everywhere', 'cash out before the edge', 'Dani gg anyone?', 'mini gg all',
    'Nigeria', 'class act', 'assassin snake', 'top 3 here we go']) {
    assert.strictEqual(contentProblem(clean(s)), null, s);
  }
});

test('slurs are refused however they are spelt; swear words are masked', () => {
  const slur = rot13('avttre');
  for (const s of [slur, 'you ' + slur, slur.toUpperCase(), 'n1gg3r', slur.split('').join(' '), slur.split('').join('.'),
    rot13('snttbg'), rot13('xlf'), 'just ' + rot13('xvyy lbhefrys'), rot13('xvyy hefrys')]) {
    assert.strictEqual(contentProblem(clean(s)), 'abuse', s);
  }
  assert.strictEqual(maskSwears(rot13('shpxvat uryy')), 'f****** hell');
  assert.strictEqual(maskSwears(rot13('lbh ovgpu')), 'you b****');
  assert.strictEqual(maskSwears('pass the class, assassin'), 'pass the class, assassin');
});

test('rate: a burst, then one per refill; never two inside the gap; the same line twice is dropped', () => {
  const g = createChatGuard();
  let t = 1000;
  assert.deepStrictEqual(g.check('a', 'one', t), { ok: true, text: 'one' });
  const fast = g.check('a', 'two', t + 100);
  assert.strictEqual(fast.ok, false);
  assert.strictEqual(fast.why, 'rate');
  assert.ok(fast.note);
  for (const w of ['two', 'three', 'four']) assert.strictEqual(g.check('a', w, (t += 400)).ok, true, w);
  assert.strictEqual(g.check('a', 'five', (t += 400)).why, 'rate', 'bucket empty');
  assert.strictEqual(g.check('a', 'five', (t += 4000)).ok, true);
  assert.strictEqual(g.check('a', 'Five', (t += 3000)).why, 'dup');
  assert.strictEqual(g.check('b', 'one', t).ok, true, 'buckets are per sender');
  const again = g.check('a', 'x', t + 3000);
  assert.strictEqual(again.ok, true);
});

test('three refused lines pause the sender; notes are throttled; nothing but text ever comes back', () => {
  const g = createChatGuard();
  let t = 0;
  const r1 = g.check('s', 'free sol at scam.xyz', (t += 3000));
  assert.deepStrictEqual([r1.ok, r1.why, typeof r1.note], [false, 'link', 'string']);
  assert.strictEqual(g.check('s', 'scam dot com', (t += 3000)).why, 'link');
  const r3 = g.check('s', 'scam (dot) xyz', (t += 3000));
  assert.strictEqual(r3.why, 'muted');
  assert.ok(r3.note);
  const r4 = g.check('s', 'hello', (t += 1000));
  assert.deepStrictEqual([r4.why, r4.note], ['muted', null], 'the next note waits');
  assert.strictEqual(g.check('s', 'hello', (t += 120000)).ok, true, 'the pause ends');
  assert.strictEqual(g.check('s', '', t).why, 'empty');
  assert.strictEqual(g.check('s', { text: 'x' }, t).why, 'bad');
});
