'use strict';
/* "Add funds and Withdrawals" with SOL in it (Owen's first card buy, 2026-10-15: MoonPay's SOL
   landed but the card showed only old USDC rows). Usdc.historyRowOf reads one transaction as one
   row, and usdcTransfers walks the wallet's own address as well as its USDC account:
   - a MoonPay top-up (a plain SOL transfer, paid for by the sender) is Add funds +SOL, from it;
   - a Convert to USDC is one row, not a SOL out and a USDC in; Withdraw as SOL names the address
     that got the SOL and how much; a gasless one never names Jupiter's fee payer;
   - a stake is still a game and stays out; SOL dust (address poisoning) and rent are never rows;
   - SOL sent in an inner instruction (an exchange's program) counts too;
   - a transaction both lists hold is read once and is one row; a SOL row gets its dollar value;
   - the Transactions list stays the USDC that moved. Shapes are copied from Owen's real
     transactions (MoonPay deposit 4mpf5V26h52c, Convert 3m68BzDQz1du). */
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, PublicKey } = require('@solana/web3.js');
const _bs58 = require('bs58');
const bs58 = _bs58.default || _bs58;

const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
const Usdc = require('../server/Usdc');

const key = () => Keypair.generate().publicKey.toBase58();
const OWNER = key(), MOONPAY = key(), FRIEND = key(), POISON = key(), RECEIVER = key(), JUP_PAYER = key();
const SYS = '11111111111111111111111111111111';
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ESCROW = escrow.publicKey.toBase58();
const bal = (owner, amount) => ({ owner, mint: MINT, uiTokenAmount: { amount: String(amount) } });

function transferData(lamports) {
  const d = Buffer.alloc(12); d.writeUInt32LE(2, 0); d.writeBigUInt64LE(BigInt(lamports), 4); return d;
}
/* A confirmed transaction as getTransaction returns it. deltas: { address: lamports change };
   every key not named is unchanged. */
function tx({ keys, deltas = {}, fee = 5000, ixs = [], inner = [], tokPre = [], tokPost = [] }) {
  const pre = keys.map(() => 1_000_000_000);
  const post = keys.map((k, i) => pre[i] + (deltas[k] || 0));
  return {
    blockTime: 1_800_000_000,
    meta: { err: null, fee, preBalances: pre, postBalances: post, preTokenBalances: tokPre, postTokenBalances: tokPost,
            innerInstructions: inner, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { message: { staticAccountKeys: keys.map((k) => new PublicKey(k)),
      compiledInstructions: ixs.map(([program, accts, data]) => ({ programIdIndex: keys.indexOf(program),
        accountKeyIndexes: accts.map((a) => keys.indexOf(a)), data: data || Buffer.alloc(0) })) } },
  };
}
const sig = (s) => ({ signature: s, blockTime: 1_800_000_000 });
const row = (t, s) => Usdc.historyRowOf(t, OWNER, ESCROW, sig(s || 'x'));

const moonpay = tx({ keys: [MOONPAY, OWNER, SYS, MEMO], fee: 5582,
  deltas: { [MOONPAY]: -157_337_528 - 5582, [OWNER]: 157_337_528 },
  ixs: [[SYS, [MOONPAY, OWNER], transferData(157_337_528)], [MEMO, [], Buffer.from('moonpay')]] });
const convert = tx({ keys: [OWNER, key(), SYS, JUP6], fee: 5879,
  deltas: { [OWNER]: -198_880_514 },
  ixs: [[SYS, [OWNER, key()], transferData(198_874_635)], [JUP6, [OWNER], Buffer.alloc(40)]],
  tokPre: [bal(OWNER, 1_320_744)], tokPost: [bal(OWNER, 22_230_470)] });
// The wSOL leg above names an account outside keys on purpose: unknown accounts never matter.
convert.transaction.message.compiledInstructions[0].accountKeyIndexes = [0, 1];
const withdrawSol = tx({ keys: [OWNER, RECEIVER, key(), JUP6],
  deltas: { [OWNER]: -5000, [RECEIVER]: 47_400_000 },
  ixs: [[JUP6, [OWNER], Buffer.alloc(41)]],
  tokPre: [bal(OWNER, 10_000_000)], tokPost: [bal(OWNER, 5_000_000)] });
const gaslessWithdraw = tx({ keys: [JUP_PAYER, OWNER, RECEIVER, JUP6],
  deltas: { [JUP_PAYER]: 90_000_000, [RECEIVER]: 47_400_000 },
  ixs: [[JUP6, [OWNER], Buffer.alloc(41)]],
  tokPre: [bal(OWNER, 10_000_000)], tokPost: [bal(OWNER, 5_000_000)] });
const stake = tx({ keys: [OWNER, key()], deltas: { [OWNER]: -5000 },
  tokPre: [bal(OWNER, 1_000_000), bal(ESCROW, 0)], tokPost: [bal(OWNER, 500_000), bal(ESCROW, 500_000)] });
const dust = tx({ keys: [POISON, OWNER, SYS], deltas: { [POISON]: -5500, [OWNER]: 500 },
  ixs: [[SYS, [POISON, OWNER], transferData(500)]] });
const solOut = tx({ keys: [OWNER, FRIEND, SYS], deltas: { [OWNER]: -50_005_000, [FRIEND]: 50_000_000 },
  ixs: [[SYS, [OWNER, FRIEND], transferData(50_000_000)]] });
const rentOnly = tx({ keys: [OWNER, key(), SYS], deltas: { [OWNER]: -2_044_280 } });   // made its own USDC account
const innerIn = (() => {
  const keys = [FRIEND, OWNER, SYS, key()];
  const t = tx({ keys, deltas: { [FRIEND]: -30_005_000, [OWNER]: 30_000_000 }, ixs: [[keys[3], [FRIEND, OWNER]]] });
  t.meta.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(transferData(30_000_000)) }] }];
  return t;
})();

test('a MoonPay top-up is Add funds +SOL, from the sender who paid for it', () => {
  assert.deepStrictEqual(row(moonpay, 'mp'), { signature: 'mp', at: 1_800_000_000_000, kind: 'sol', usdc: 0,
    sol: 0.157337528, direction: 'in', game: false, peer: MOONPAY });
});

test('a Convert to USDC is one row: the dollars in, the SOL it came from, the fee left out', () => {
  const r = row(convert);
  assert.strictEqual(r.kind, 'convert');
  assert.strictEqual(r.usdc, 20.909726);
  assert.strictEqual(r.sol, 0.198874635);
  assert.strictEqual(r.direction, 'in');
  assert.strictEqual(r.peer, null);
  assert.strictEqual(r.game, false);
});

test('Withdraw as SOL names the address that got the SOL; a gasless one never names Jupiter\'s payer', () => {
  for (const t of [withdrawSol, gaslessWithdraw]) {
    const r = row(t);
    assert.strictEqual(r.kind, 'withdrawSol');
    assert.strictEqual(r.usdc, 5);
    assert.strictEqual(r.sol, 0.0474);
    assert.strictEqual(r.peer, RECEIVER);
    assert.strictEqual(r.direction, 'out');
  }
});

test('a stake stays a game; dust and rent are never rows; a plain SOL send and an inner one are', () => {
  const s = row(stake);
  assert.strictEqual(s.kind, 'usdc');
  assert.strictEqual(s.game, true);
  assert.strictEqual(row(dust), null, 'under 0.001 SOL: the address-poisoning case');
  assert.strictEqual(row(rentOnly), null, 'rent for its own account is not a withdrawal');
  assert.deepStrictEqual([row(solOut).kind, row(solOut).direction, row(solOut).sol, row(solOut).peer], ['sol', 'out', 0.05, FRIEND]);
  assert.deepStrictEqual([row(innerIn).kind, row(innerIn).direction, row(innerIn).sol, row(innerIn).peer], ['sol', 'in', 0.03, FRIEND]);
});

test('a skin bought is a skin row, not a game entry (Owen 2026-10-16: his Candy Cane read as "Game entry")', () => {
  // Owen's real shape: his USDC down 1, the revenue wallet (a house address) up 1, a memo naming the purchase.
  const REVENUE = key();
  Usdc.markHouseAddress(REVENUE);
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const skin = tx({ keys: [OWNER, key(), key(), TOKEN, MEMO],
    ixs: [[TOKEN, [OWNER], Buffer.from([12])], [MEMO, [], Buffer.from('ds-skin:85yxdBPrERgrUm6kw7tvi5')]],
    tokPre: [bal(OWNER, 22_080_000), bal(REVENUE, 7_000_000)], tokPost: [bal(OWNER, 21_080_000), bal(REVENUE, 8_000_000)] });
  const r = row(skin);
  assert.deepStrictEqual([r.kind, r.direction, r.usdc, r.game, r.skinRef, r.peer], ['skin', 'out', 1, false, '85yxdBPrERgrUm6kw7tvi5', REVENUE]);
  // The same payment to the house without that memo is still read as before (a game).
  const plain = tx({ keys: [OWNER, key(), key(), TOKEN], ixs: [[TOKEN, [OWNER], Buffer.from([12])]],
    tokPre: [bal(OWNER, 2_000_000), bal(REVENUE, 0)], tokPost: [bal(OWNER, 1_000_000), bal(REVENUE, 1_000_000)] });
  assert.strictEqual(row(plain).game, true);
  // A memo that only looks like one is not a skin.
  const odd = tx({ keys: [OWNER, key(), key(), TOKEN, MEMO],
    ixs: [[TOKEN, [OWNER], Buffer.from([12])], [MEMO, [], Buffer.from('ds-skin:../../x')]],
    tokPre: [bal(OWNER, 2_000_000), bal(REVENUE, 0)], tokPost: [bal(OWNER, 1_000_000), bal(REVENUE, 1_000_000)] });
  assert.notStrictEqual(row(odd).kind, 'skin');
  // The page names it from the item the route adds, and never as a game entry.
  const w = require('fs').readFileSync(require('path').join(__dirname, '../public/js/v2/wallet.js'), 'utf8');
  assert.ok(w.includes("const name = t.kind === 'skin' ? skinName(t.skinItem)"), 'Skin: <name> first');
});

test('the list walks both addresses: one row per transaction, newest first, games out, SOL priced', async () => {
  const ata = Usdc.ataFor(OWNER);
  const at = (s, slot) => ({ signature: s, slot, blockTime: 1_800_000_000 + slot, err: null });
  const lists = {
    [OWNER]: [at('conv', 50), at('mp', 40), at('dust', 30), at('out', 20)],
    [ata]: [at('conv', 50), at('stake', 45), at('wsol', 10)],
  };
  const txs = { conv: convert, mp: moonpay, dust, out: solOut, stake, wsol: withdrawSol };
  const reads = [];
  Usdc.connection.getSignaturesForAddress = async (addr) => (lists[addr.toString()] || []).slice();
  Usdc.connection.getTransaction = async (s) => { reads.push(s); return txs[s]; };
  const priced = [];
  const page = await Usdc.usdcTransfers(OWNER, { priceOn: async (ms) => { priced.push(ms); return 200; } });
  assert.strictEqual(page.complete, true);
  assert.deepStrictEqual(page.rows.map((r) => [r.signature, r.kind, r.direction]),
    [['conv', 'convert', 'in'], ['mp', 'sol', 'in'], ['out', 'sol', 'out'], ['wsol', 'withdrawSol', 'out']]);
  assert.strictEqual(reads.filter((s) => s === 'conv').length, 1, 'held by both lists, read once');
  const mp = page.rows.find((r) => r.signature === 'mp');
  assert.strictEqual(mp.usd, 31.47, '0.157337528 SOL at $200');
  assert.strictEqual(page.rows.find((r) => r.signature === 'conv').usd, null, 'a conversion has its dollars already');
  assert.strictEqual(priced.length, 2, 'only the SOL rows ask for a price');
  // Asked again, the price is kept on the row: no new lookups.
  await Usdc.usdcTransfers(OWNER, { priceOn: async () => { priced.push('again'); return 999; } });
  assert.ok(!priced.includes('again'));
  // The Transactions list stays the USDC that moved: no SOL-only rows there.
  Usdc.connection.getSignaturesForAddress = async (addr) => (addr.toString() === ata ? lists[ata].slice() : []);
  const hist = await Usdc.usdcHistory(OWNER, { limit: 20 });
  assert.deepStrictEqual(hist.rows.map((r) => r.signature), ['conv', 'stake', 'wsol']);
});
