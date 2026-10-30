'use strict';
/* SOL and USDC in the player's OWN wallet (Owen, 2026-10-15: "Accept both, play in USDC").

   Card top-ups arrive as SOL (MoonPay sells SOL to Canada, not USDC on Solana), players can send
   SOL from an exchange too, and every game, stake and payout stays in USDC. Two conversions:

     toUsdc  the wallet's SOL into USDC in the same wallet (the one-tap Convert to USDC)
     toSol   the wallet's USDC into SOL, paid straight to an outside address (Withdraw as SOL)

   Nothing here touches the escrow, a stake, a payout or the house. Jupiter builds the
   transaction for the player's wallet, the player signs it, and it moves only the player's money.

   Jupiter is a third party, so what it hands back is checked before the player is ever asked to
   sign it:
     1. the order is for exactly what was asked (mints, amount, taker, receiver), with a slippage
        floor no worse than MAX_SLIPPAGE_BPS under the quote, a fee of at most MAX_FEE_BPS and a
        small price impact (checkOrder);
     1b. every instruction is one Jupiter's own orders use (checkShape): Jupiter's router with its
        on-chain floor decoded and no lower than the quoted one, or its RFQ fill; no approvals, no
        authority changes, no durable nonce, a capped priority fee. A price more than 3% worse
        than our own price feed's is refused (checkPrice);
     2. the transaction is SIMULATED on the chain and the wallet's accounts are compared before
        and after (checkEffects): the wallet stays a plain wallet, none of its token accounts loses
        tokens it should not, changes hands, or gains a delegate or a close authority, the SOL
        that leaves is at most what was asked plus a small fee allowance, and what arrives is at
        least the slippage floor;
     3. the exact message that passed is remembered under the order's requestId for QUOTE_TTL_MS,
        and execute sends only bytes carrying that message, signed by the player's wallet, once.
   When it lands, Jupiter's program refuses any fill under the floor, so the price moving between
   the check and the landing can cost at most the slippage cap, never more.

   SOL is never converted down to nothing: RESERVE_LAMPORTS stays in the wallet, because the
   player's own transfers (a stake, a withdrawal, a new token account) are paid for in SOL. */
const crypto = require('crypto');
const { PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

const RULES = Object.freeze({
  RESERVE_LAMPORTS: 5_000_000,        // 0.005 SOL always left for network fees
  MIN_SOL_IN: 1_000_000,              // 0.001 SOL, the smallest Convert
  MIN_USDC_IN: 1_000_000,             // $1, the smallest Withdraw as SOL
  MIN_USDC_CONVERT: 100_000,          // $0.10, the smallest Convert of old USDC to SOL (SOL mode)
  CONVERT_SOL_FEE_LAMPORTS: 1_010_000, // what a USDC -> SOL convert may cost the wallet: base fee + the priority cap
  MAX_USDC_IN: 100_000_000_000,       // $100,000, a sanity bound on one withdrawal
  MAX_SLIPPAGE_BPS: 100,              // the floor is at most 1% under the quote
  RETRY_SLIPPAGE_BPS: 50,             // what a second order asks for, well inside the cap
  MAX_FEE_BPS: 50,                    // Jupiter's fee for SOL-USDC is 2 bps; refuse anything over 0.5%
  MAX_PRICE_IMPACT_PCT: 1,            // percentage points
  FEE_ALLOWANCE_LAMPORTS: 4_000_000,  // network + priority fee + one new token account's rent
  QUOTE_TTL_MS: 40_000,
  MAX_TOKEN_ACCOUNTS: 40,
  QUOTES_PER_WALLET_MIN: 8,
  MAX_TX_BYTES: 1232,
  MAX_PENDING: 500,
});

/* An error whose message is safe to show the player. Anything else is answered with a plain
   "try again" and logged, so a provider's or the RPC's internals never reach the page. */
class SwapError extends Error {
  constructor(message, extra) {
    super(message);
    this.publicMessage = message;
    if (extra) Object.assign(this, extra);
  }
}
const fail = (m, extra) => { throw new SwapError(m, extra); };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isKey(s) {
  if (typeof s !== 'string' || !B58.test(s)) return false;
  try { return new PublicKey(s).toBase58() === s; } catch (_) { return false; }
}
const UINT = /^\d{1,20}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
function big(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !UINT.test(s)) return null;
  return BigInt(s);
}

/* The base layout of an SPL token account (Token and Token-2022 share its first 165 bytes). */
function readTokenAccount(data) {
  if (!data || data.length < 165) return null;
  return {
    mint: bs58.encode(data.subarray(0, 32)),
    owner: bs58.encode(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
    delegate: data.readUInt32LE(72) ? bs58.encode(data.subarray(76, 108)) : null,
    closeAuthority: data.readUInt32LE(129) ? bs58.encode(data.subarray(133, 165)) : null,
  };
}
const tokenOf = (a) => (a && TOKEN_PROGRAMS.includes(a.owner) ? readTokenAccount(a.data) : null);

/* Jupiter's order, checked against what was asked for. want: { inputMint, outputMint, amount
   (BigInt), wallet, receiver }. Returns the numbers the player is shown. */
const ORDER_ERRORS = {
  1: 'There is not enough in your wallet for that amount.',
  2: 'There is not enough SOL in your wallet for the network fee.',
  3: 'That amount is too small to convert.',
};
function checkOrder(order, want, rules) {
  const R = rules || RULES;
  if (!order || typeof order !== 'object') fail('No price came back. Try again.');
  if (order.inputMint !== want.inputMint || order.outputMint !== want.outputMint) fail('The price was for a different swap. Try again.');
  if (big(order.inAmount) !== want.amount) fail('The price was for a different amount. Try again.');
  if (order.taker != null && order.taker !== want.wallet) fail('The price was for a different wallet. Try again.');
  if (order.swapMode != null && order.swapMode !== 'ExactIn') fail('The price was for a different swap. Try again.');
  if (typeof order.transaction !== 'string' || !order.transaction) {
    fail((Number.isInteger(order.errorCode) && Object.prototype.hasOwnProperty.call(ORDER_ERRORS, order.errorCode) && ORDER_ERRORS[order.errorCode])
      || 'There is no price for that amount right now. Try again in a moment.');
  }
  if (typeof order.requestId !== 'string' || !/^[\w-]{1,100}$/.test(order.requestId)) fail('No price came back. Try again.');
  const out = big(order.outAmount), min = big(order.otherAmountThreshold);
  if (out === null || min === null || out <= 0n || min <= 0n || min > out) fail('No price came back. Try again.');
  // One unit of rounding allowed: a floor of exactly the cap rounds down by up to a unit.
  if ((min + 1n) * 10000n < out * BigInt(10000 - R.MAX_SLIPPAGE_BPS)) fail('The price is moving too much right now.', { slippage: true });
  const fee = Number(order.feeBps);
  if (!Number.isFinite(fee) || fee < 0 || fee > R.MAX_FEE_BPS) fail('The fee for that swap is too high right now. Try again later.');
  const rawImpact = order.priceImpact != null ? Number(order.priceImpact) : Number(order.priceImpactPct) * 100;
  const impact = Math.abs(rawImpact);
  if (!Number.isFinite(impact) || impact > R.MAX_PRICE_IMPACT_PCT) fail('That amount would move the price too much. Try a smaller amount.');
  return { requestId: order.requestId, inAmount: want.amount, outAmount: out, minOut: min, feeBps: fee,
           priceImpact: impact, router: typeof order.router === 'string' ? order.router : '' };
}

/* What a transaction says about itself: the exact signed message (the bytes after the signature
   section), its hash, and where the wallet signs. The wallet must be one of the required signers;
   for a gasless order the fee payer is Jupiter's and the wallet signs second. */
function txFacts(b64, wallet, rules) {
  const R = rules || RULES;
  if (typeof b64 !== 'string' || !b64 || b64.length > 4 * R.MAX_TX_BYTES) fail('That is not a conversion transaction.');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > R.MAX_TX_BYTES) fail('That is not a conversion transaction.');
  let tx;
  try { tx = VersionedTransaction.deserialize(bytes); } catch (_) { fail('That is not a conversion transaction.'); }
  const n = tx.signatures.length;
  const message = bytes.subarray((n < 0x80 ? 1 : n < 0x4000 ? 2 : 3) + 64 * n);
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const signers = keys.slice(0, tx.message.header.numRequiredSignatures);
  const signerIdx = signers.indexOf(wallet);
  if (signerIdx < 0) fail('That transaction is not for your wallet.');
  return { tx, bytes, keys, message, hash: crypto.createHash('sha256').update(message).digest('hex'), signerIdx };
}

/* What the transaction is allowed to run (security review 2026-10-15, findings 2 and 3). A
   simulation shows what a transaction does NOW; a program that behaves differently when it lands
   could pass one. So every top-level instruction must be one of the programs Jupiter's own orders
   use, read off real orders on 2026-10-15: the compute budget (its priority fee capped), a plain
   SOL transfer (wrapping SOL), creating a token account, the token program's transfer, close and
   sync, Jupiter's router with its floor decoded and checked against the quote, and Jupiter's RFQ
   fill (a market maker's fixed price, all or nothing). Anything else, a durable nonce, an
   approval, a change of authority, another router, is refused, and the order is asked for again
   on Jupiter's own router only. */
const PROGRAMS = Object.freeze({
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  JUPITER: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  JUPITERZ: '61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH',
});
/* Jupiter v6 route instructions seen in real orders, by discriminator: where the input amount,
   the quoted output and the slippage sit. The floor the program enforces on landing is
   quoted * (10000 - slippage) / 10000, which matched every order's otherAmountThreshold. */
const JUP_ROUTES = Object.freeze({
  bb64facc31c4af14: { inAt: 8, quotedAt: 16, slipAt: 24 },
  d19853937cfed8e9: { inAt: 9, quotedAt: 18, slipAt: 26 },
});
const TOKEN_IXS = new Set([3, 9, 12, 17]);   // Transfer, CloseAccount, TransferChecked, SyncNative
const MAX_PRIORITY_LAMPORTS = 1_000_000n;    // 0.001 SOL of priority fee at most
function checkShape(facts, want, minOut, rules) {
  const R = rules || RULES;
  const refuse = () => fail('That conversion is not in a form this wallet can check. Try again.', { shape: true });
  let routes = 0, cuLimit = null, cuPrice = 0n, others = 0;
  for (const ix of facts.tx.message.compiledInstructions) {
    if (ix.programIdIndex >= facts.keys.length) refuse();
    const pid = facts.keys[ix.programIdIndex];
    const d = Buffer.from(ix.data);
    if (pid === PROGRAMS.COMPUTE_BUDGET) {
      if (d[0] === 2 && d.length >= 5) cuLimit = BigInt(d.readUInt32LE(1));
      else if (d[0] === 3 && d.length >= 9) cuPrice = d.readBigUInt64LE(1);
      else refuse();
      continue;
    }
    others++;
    if (pid === SYSTEM_PROGRAM) { if (d.length !== 12 || d.readUInt32LE(0) !== 2) refuse(); continue; }
    if (pid === PROGRAMS.ATA) { if (!(d.length === 0 || (d.length === 1 && (d[0] === 0 || d[0] === 1)))) refuse(); continue; }
    if (pid === TOKEN_PROGRAMS[0]) { if (!d.length || !TOKEN_IXS.has(d[0])) refuse(); continue; }
    if (pid === PROGRAMS.JUPITERZ) { routes++; continue; }
    if (pid === PROGRAMS.JUPITER) {
      const L = JUP_ROUTES[d.subarray(0, 8).toString('hex')];
      if (!L || d.length < L.slipAt + 2) refuse();
      const inAmount = d.readBigUInt64LE(L.inAt), quoted = d.readBigUInt64LE(L.quotedAt), slip = d.readUInt16LE(L.slipAt);
      if (inAmount !== want.amount || slip > R.MAX_SLIPPAGE_BPS) refuse();
      if (quoted * BigInt(10000 - slip) / 10000n + 1n < minOut) refuse();
      routes++;
      continue;
    }
    refuse();
  }
  if (routes !== 1) refuse();
  const limit = cuLimit !== null ? cuLimit : BigInt(Math.min(1_400_000, 200_000 * others));
  if (limit * cuPrice / 1_000_000n > MAX_PRIORITY_LAMPORTS) refuse();
}

/* The simulation, read as balances. pre and post map address -> { lamports (BigInt), owner
   (program, base58), data (Buffer) } or null. o: { dir, wallet, usdcMint, usdcAta, receiver,
   inAmount, minOut }. Throws a SwapError naming the first thing that is wrong. */
function checkEffects(o, pre, post, rules) {
  const R = rules || RULES;
  const allow = BigInt(R.FEE_ALLOWANCE_LAMPORTS);
  const pw = pre.get(o.wallet), qw = post.get(o.wallet);
  if (!pw || !qw) fail('Could not check that conversion. Try again.');
  if (qw.owner !== SYSTEM_PROGRAM || qw.data.length !== 0) fail('That conversion would change your wallet. It was stopped.');
  for (const [addr, p] of pre) {
    if (addr === o.wallet || addr === o.receiver) continue;
    const q = post.get(addr);
    const pt = tokenOf(p);
    if (!pt) continue;                       // not a token account before: nothing of the player's to lose
    if (!q) fail('That conversion would close one of your token accounts. It was stopped.');
    const qt = tokenOf(q);
    if (!qt || qt.mint !== pt.mint) fail('That conversion would change one of your token accounts. It was stopped.');
    if (qt.owner !== o.wallet) fail('That conversion would hand one of your token accounts to someone else. It was stopped.');
    if (qt.delegate && qt.delegate !== pt.delegate) fail('That conversion would let someone else spend your tokens. It was stopped.');
    if (qt.closeAuthority && qt.closeAuthority !== pt.closeAuthority) fail('That conversion would let someone else close your token account. It was stopped.');
    if (addr !== o.usdcAta && qt.amount < pt.amount) fail('That conversion would take tokens it should not. It was stopped.');
  }
  const pu = tokenOf(pre.get(o.usdcAta)), qu = tokenOf(post.get(o.usdcAta));
  const before = pu ? pu.amount : 0n;
  if (qu && (qu.owner !== o.wallet || qu.mint !== o.usdcMint)) fail('That conversion would change your USDC account. It was stopped.');
  /* A USDC account the transaction creates (a first Convert after a card top-up) was skipped by
     the loop above, having no before. It must come out with no one else able to spend or close
     it: every later deposit and winning lands there (security review 2026-10-15, finding 1). */
  if (qu && !pu && (qu.delegate || qu.closeAuthority)) fail('That conversion would let someone else control your USDC account. It was stopped.');
  const spent = pw.lamports - qw.lamports;   // SOL that left the wallet (negative: it gained)
  if (o.dir === 'toUsdc') {
    if (!qu || qu.amount - before < o.minOut) fail('That conversion would pay less USDC than quoted. It was stopped.');
    if (spent > o.inAmount + allow) fail('That conversion would take more SOL than you asked. It was stopped.');
  } else if (o.dir === 'usdcToSol') {
    const after = qu ? qu.amount : 0n;
    if (before - after > o.inAmount) fail('That conversion would take more USDC than you asked. It was stopped.');
    // the wallet both pays the fee and receives the SOL: its net gain must be the floor less at most the fee
    if (-spent + BigInt(R.CONVERT_SOL_FEE_LAMPORTS) < o.minOut) fail('That conversion would pay less SOL than quoted. It was stopped.');
  } else {
    const after = qu ? qu.amount : 0n;
    if (before - after > o.inAmount) fail('That conversion would take more USDC than you asked. It was stopped.');
    const pr = pre.get(o.receiver), qr = post.get(o.receiver);
    const got = (qr ? qr.lamports : 0n) - (pr ? pr.lamports : 0n);
    if (got < o.minOut) fail('That withdrawal would send less SOL than quoted. It was stopped.');
    if (spent > allow) fail('That withdrawal would take more SOL than the network fee. It was stopped.');
  }
}

/* The signed transaction sent to execute must carry the very message that passed the checks,
   with the wallet's own valid signature on it. */
function checkSigned(b64, entry, rules) {
  const f = txFacts(b64, entry.wallet, rules);
  if (f.hash !== entry.hash || f.signerIdx !== entry.signerIdx) fail('That is not the conversion you were shown. Get a new price.');
  const sig = f.tx.signatures[f.signerIdx];
  let ok = false;
  try { ok = !!sig && sig.length === 64 && sig.some((b) => b !== 0) && ed25519.verify(sig, f.message, new PublicKey(entry.wallet).toBytes(), { zip215: false }); } catch (_) { ok = false; }
  if (!ok) fail('That conversion is not signed by your wallet.');
  return f;
}

const EXECUTE_ERRORS = {
  '-1': 'That price expired. Nothing was converted. Get a new one.',
  '-1005': 'That price expired before it went through. Nothing was converted. Get a new one.',
  '-2003': 'That price expired. Nothing was converted. Get a new one.',
  /* "Failed to land" may still land while its blockhash lives, so it does not say nothing moved
     (security review 2026-10-15, finding 7). */
  '-1000': 'It has not gone through. Check your balance in a minute before trying again.',
  '-2000': 'It has not gone through. Check your balance in a minute before trying again.',
  '-2004': 'The price changed. Nothing was converted. Try again.',
};
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* An independent price beside Jupiter's own (security review 2026-10-15, finding 6): a quote
   more than PRICE_TOLERANCE worse for the player than the market price is refused. refSolUsd()
   returns the dollars per SOL from our own price feed, or null when it has none recent, and then
   only Jupiter's checks apply. */
const PRICE_TOLERANCE = 0.03;
function checkPrice(dir, inAmount, outAmount, ref) {
  if (!(ref > 0)) return;
  const usdPerSol = dir === 'toUsdc'
    ? (Number(outAmount) / 1e6) / (Number(inAmount) / 1e9)    // dollars received per SOL given
    : (Number(inAmount) / 1e6) / (Number(outAmount) / 1e9);   // dollars given per SOL received
  const worse = dir === 'toUsdc' ? usdPerSol < ref * (1 - PRICE_TOLERANCE) : usdPerSol > ref * (1 + PRICE_TOLERANCE);
  if (!Number.isFinite(usdPerSol) || worse) fail('That price is too far from the market price right now. Try again in a moment.');
}

/* chain:   { getAccounts(addrs) -> [acct|null], getTokenAccounts(owner) -> [{ address, account }],
              simulate(tx, addrs) -> { err, accounts: [acct|null] } }
   jupiter: { order(params) -> order JSON, execute({ signedTransaction, requestId }) -> result JSON,
              wouldWait() -> ms an order would queue }
   usdcMint: () -> the USDC mint (base58). refSolUsd: () -> dollars per SOL, or null. */
function createSwap({ chain, jupiter, usdcMint, refSolUsd = () => null, now = Date.now, rules = RULES, log = () => {}, onDone = () => {} }) {
  const R = rules;
  const pending = new Map();
  function prune() {
    const t = now();
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k);
  }
  /* Quotes per wallet: a wallet's prices cannot be asked for faster than a person would, from any
     number of addresses (security review 2026-10-15, finding 5). */
  const perWallet = new Map();
  function spendQuote(wallet) {
    const t = now();
    const recent = (perWallet.get(wallet) || []).filter((x) => t - x < 60_000);
    if (recent.length >= R.QUOTES_PER_WALLET_MIN) fail('Too many prices asked for this wallet. Wait a minute and try again.');
    recent.push(t);
    perWallet.set(wallet, recent);
    if (perWallet.size > 5000) for (const [k, v] of perWallet) if (!v.some((x) => t - x < 60_000)) perWallet.delete(k);
  }

  async function quote(req) {
    const wallet = req && req.wallet, dir = req && req.dir;
    const receiver = req && req.receiver ? req.receiver : null;
    if (!isKey(wallet)) fail('That wallet address is not valid.');
    /* usdcToSol (SOL mode, Owen 2026-10-17): a player's old USDC becomes SOL in the same wallet. Like toSol with
       the wallet itself as receiver, so Jupiter is asked with no receiver and the effects check reads the
       wallet's own SOL gain. */
    if (dir !== 'toUsdc' && dir !== 'toSol' && dir !== 'usdcToSol') fail('Unknown conversion.');
    const amount = big(req.amount);
    if (amount === null) fail('Enter an amount.');
    const mint = usdcMint();
    if (!isKey(mint)) fail('Converting is not available right now.');
    if (dir === 'toUsdc') {
      if (receiver) fail('Converted USDC stays in your own wallet.');
      if (amount < BigInt(R.MIN_SOL_IN)) fail('That is less than the smallest conversion, ' + (R.MIN_SOL_IN / 1e9) + ' SOL.');
    } else if (dir === 'usdcToSol') {
      if (receiver) fail('Converted SOL stays in your own wallet.');
      if (amount < BigInt(R.MIN_USDC_CONVERT)) fail('The smallest conversion is $' + (R.MIN_USDC_CONVERT / 1e6).toFixed(2) + '.');
      if (amount > BigInt(R.MAX_USDC_IN)) fail('That is more than one conversion can take.');
    } else {
      if (!isKey(receiver)) fail('That is not a Solana address.');
      if (receiver === wallet) fail('That is this wallet\'s own address.');
      if (receiver === mint || receiver === SYSTEM_PROGRAM || TOKEN_PROGRAMS.includes(receiver)) fail('That is not a wallet address.');
      // A wallet is a key on the curve; a token account's or a program's address usually is not.
      if (!PublicKey.isOnCurve(new PublicKey(receiver).toBytes())) fail('That address is not a wallet. SOL can only be sent to a wallet address.');
      if (amount < BigInt(R.MIN_USDC_IN)) fail('The smallest withdrawal as SOL is $' + (R.MIN_USDC_IN / 1e6).toFixed(2) + '.');
      if (amount > BigInt(R.MAX_USDC_IN)) fail('That is more than one withdrawal can send.');
    }
    const usdcAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet)).toBase58();
    spendQuote(wallet);
    // Refused before any chain read when Jupiter's queue is already full.
    if (typeof jupiter.wouldWait === 'function' && jupiter.wouldWait() > 12_000) fail('Conversions are busy right now. Try again in a few seconds.');

    const base = [wallet, usdcAta].concat(receiver ? [receiver] : []);
    const [accts, tokens] = await Promise.all([chain.getAccounts(base), chain.getTokenAccounts(wallet)]);
    if (!Array.isArray(accts) || accts.length !== base.length || !Array.isArray(tokens)) fail('Could not read your wallet. Try again.');
    const pre = new Map();
    base.forEach((a, i) => pre.set(a, accts[i] || null));
    /* Only token accounts with something to lose are checked: a balance, a delegate or a close
       authority. Empty ones anybody can create for this wallet (dust spam) are left out, so they
       cannot push it over the cap and switch conversions off for it (finding 9). */
    const worth = tokens.filter((t) => {
      if (!t || !isKey(t.address) || t.address === usdcAta) return false;
      const a = tokenOf(t.account);
      return !!a && (a.amount > 0n || !!a.delegate || !!a.closeAuthority);
    });
    if (worth.length > R.MAX_TOKEN_ACCOUNTS) fail('This wallet holds too many token accounts to check a conversion safely.');
    for (const t of worth) pre.set(t.address, t.account);
    const usdcListed = tokens.find((t) => t && t.address === usdcAta);
    if (usdcListed && !pre.get(usdcAta)) pre.set(usdcAta, usdcListed.account || null);
    if (receiver) {
      // SOL goes only to a plain wallet: nothing there yet, or an account no program owns.
      const r = pre.get(receiver);
      if (r && (r.owner !== SYSTEM_PROGRAM || r.data.length !== 0)) fail('That address is not a wallet. SOL can only be sent to a wallet address.');
    }
    const w = pre.get(wallet);
    const lamports = w ? w.lamports : 0n;
    if (dir === 'toUsdc') {
      const most = lamports - BigInt(R.RESERVE_LAMPORTS);
      if (amount > most) {
        fail(most >= BigInt(R.MIN_SOL_IN)
          ? 'Keep ' + (R.RESERVE_LAMPORTS / 1e9) + ' SOL for network fees. The most you can convert is ' + (Number(most) / 1e9).toFixed(4) + ' SOL.'
          : 'There is no SOL to convert. ' + (R.RESERVE_LAMPORTS / 1e9) + ' SOL stays in your wallet for network fees.');
      }
    } else {
      const u = tokenOf(pre.get(usdcAta));
      if (!u || amount > u.amount) fail('That is more USDC than you have.');
    }

    const want = dir === 'toUsdc'
      ? { inputMint: SOL_MINT, outputMint: mint, amount, wallet, receiver: null }
      : { inputMint: mint, outputMint: SOL_MINT, amount, wallet, receiver };
    /* Jupiter's own router (Metis) and its RFQ market makers (JupiterZ) only: the two whose
       transactions checkShape can read. Dflow and OKX build theirs with their own programs. */
    const params = { inputMint: want.inputMint, outputMint: want.outputMint, amount: String(amount), taker: wallet,
                     excludeRouters: 'dflow,okx' };
    if (receiver) params.receiver = receiver;

    /* One order with Jupiter's own slippage estimate. If its floor is under our cap, its shape is
       one we cannot read, or the simulation refuses it (an RFQ maker's last look), ask once more
       on Jupiter's own router only, with our cap set. */
    let order = await jupiter.order(params), checked, facts, sim;
    const addrs = Array.from(pre.keys());
    for (let attempt = 0; ; attempt++) {
      try {
        checked = checkOrder(order, want, R);
        facts = txFacts(order.transaction, wallet, R);
        checkShape(facts, want, checked.minOut, R);
        checkPrice(dir, amount, checked.outAmount, refSolUsd());
        sim = await chain.simulate(facts.tx, addrs);
        if (!sim || sim.err || !Array.isArray(sim.accounts) || sim.accounts.length !== addrs.length) {
          fail('This conversion would not go through right now. Try again in a moment.', { simFailed: true });
        }
        break;
      } catch (e) {
        if (attempt > 0 || !(e && (e.slippage || e.simFailed || e.shape))) throw e;
        order = await jupiter.order(Object.assign({}, params,
          { slippageBps: String(R.RETRY_SLIPPAGE_BPS), excludeRouters: 'jupiterz,dflow,okx' }));
      }
    }
    const post = new Map();
    addrs.forEach((a, i) => post.set(a, sim.accounts[i] || null));
    checkEffects({ dir, wallet, usdcMint: mint, usdcAta, receiver, inAmount: amount, minOut: checked.minOut }, pre, post, R);

    prune();
    if (pending.size >= R.MAX_PENDING) fail('Conversions are busy right now. Try again in a moment.');
    const expiresAt = now() + R.QUOTE_TTL_MS;
    pending.set(checked.requestId, { wallet, dir, receiver, hash: facts.hash, signerIdx: facts.signerIdx,
                                     inAmount: amount, minOut: checked.minOut, expiresAt });
    return {
      requestId: checked.requestId, transaction: order.transaction, dir,
      inAmount: String(amount), outAmount: String(checked.outAmount), minOut: String(checked.minOut),
      feeBps: checked.feeBps, priceImpact: checked.priceImpact, router: checked.router,
      receiver, expiresAt,
    };
  }

  async function execute(req) {
    const requestId = req && req.requestId, signed = req && req.signedTransaction;
    if (typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) fail('That price is not valid. Get a new one.');
    prune();
    const entry = pending.get(requestId);
    if (!entry) fail('That price expired. Nothing was converted. Get a new one.');
    const f = checkSigned(signed, entry, R);
    pending.delete(requestId);               // one send per approved price, whatever happens next
    // The bytes that were checked, encoded again, not the client's own text (finding 8).
    const r = await jupiter.execute({ signedTransaction: Buffer.from(f.bytes).toString('base64'), requestId });
    const sig = r && typeof r.signature === 'string' && SIG.test(r.signature) ? r.signature : null;
    if (r && r.status === 'Success') {
      log(entry.dir + ' ' + entry.wallet.slice(0, 6) + ' in=' + (r.totalInputAmount || entry.inAmount) +
          ' out=' + (r.totalOutputAmount || '?') + (entry.receiver ? ' to=' + entry.receiver.slice(0, 6) : '') + ' sig=' + sig);
      const done = { ok: true, signature: sig, dir: entry.dir,
               inAmount: big(r.totalInputAmount) !== null ? r.totalInputAmount : String(entry.inAmount),
               outAmount: big(r.totalOutputAmount) !== null ? r.totalOutputAmount : null };
      // analytics (index.js: Withdraw as SOL is a withdraw); told after the send, never able to change the answer
      try { onDone({ dir: entry.dir, wallet: entry.wallet, inAmount: done.inAmount, outAmount: done.outAmount }); } catch (_) { /* none */ }
      return done;
    }
    const code = r && r.code != null ? String(r.code) : '';
    log('failed ' + entry.dir + ' ' + entry.wallet.slice(0, 6) + ' code=' + code + ' sig=' + sig);
    fail((own(EXECUTE_ERRORS, code) && EXECUTE_ERRORS[code]) || 'The conversion did not go through. Check your balance before trying again.', { signature: sig });
  }

  return { quote, execute, _pending: pending };
}

/* Jupiter's Swap API v2 (developers.jup.ag/docs/swap/order-and-execute). Keyless works at
   0.5 requests a second for the whole server, a free key (JUP_API_KEY) at 1; /execute has its
   own, larger bucket. Orders are spaced to the limit here, and one that would wait too long is
   refused instead of queued. */
function createJupiter({ fetchImpl = globalThis.fetch, apiKey = '', base = 'https://api.jup.ag/swap/v2',
                         now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = apiKey ? 1100 : 2100;
  let nextAt = 0;
  async function slot() {
    const t = now();
    const at = Math.max(t, nextAt);
    if (at - t > 12_000) fail('Conversions are busy right now. Try again in a few seconds.');
    nextAt = at + gap;
    if (at > t) await sleep(at - t);
  }
  async function call(path, init, timeoutMs, unreachable) {
    const headers = Object.assign({ Accept: 'application/json' }, init.headers || {});
    if (apiKey) headers['x-api-key'] = apiKey;
    let r;
    try {
      r = await fetchImpl(base + path, Object.assign({}, init, { headers, signal: AbortSignal.timeout(timeoutMs) }));
    } catch (_) {
      fail(unreachable || 'Could not reach the exchange. Try again.', { unreachable: true });
    }
    const declared = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
    if (Number.isFinite(declared) && declared > 256 * 1024) fail('Could not reach the exchange. Try again.');
    const text = await r.text();
    if (text.length > 256 * 1024) fail('Could not reach the exchange. Try again.');
    let j = null;
    try { j = JSON.parse(text); } catch (_) { j = null; }
    if (r.status === 429) fail('Conversions are busy right now. Try again in a few seconds.');
    if (!j || typeof j !== 'object') fail('Could not reach the exchange. Try again.');
    if (!r.ok && j.status === undefined) fail('There is no price for that right now. Try again in a moment.');
    return j;
  }
  return {
    wouldWait() { return Math.max(0, nextAt - now()); },
    async order(params) {
      await slot();
      return call('/order?' + new URLSearchParams(params).toString(), { method: 'GET' }, 10_000);
    },
    async execute(body) {
      return call('/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 65_000,
        'This is still confirming. Check your balance in a minute before trying again.');
    },
  };
}

/* The chain reads the checks need, over the server's own RPC connection (one request per call,
   never a batch: server/Wallet.js). One retry on a rate-limited read. */
function chainFromConnection(connection) {
  const norm = (a) => (a ? { lamports: BigInt(a.lamports), owner: a.owner.toBase58 ? a.owner.toBase58() : String(a.owner),
                              data: Buffer.from(a.data || []) } : null);
  const retry = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!/429|Too Many/i.test(String(e && e.message))) throw e;
      await new Promise((r) => setTimeout(r, 700));
      return fn();
    }
  };
  return {
    async getAccounts(addrs) {
      const list = await retry(() => connection.getMultipleAccountsInfo(addrs.map((a) => new PublicKey(a)), 'confirmed'));
      return list.map(norm);
    },
    async getTokenAccounts(owner) {
      const out = [];
      for (const pid of TOKEN_PROGRAMS) {
        const r = await retry(() => connection.getTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(pid) }, 'confirmed'));
        for (const { pubkey, account } of r.value) out.push({ address: pubkey.toBase58(), account: norm(account) });
      }
      return out;
    },
    async simulate(tx, addrs) {
      const r = await retry(() => connection.simulateTransaction(tx, {
        sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: addrs },
      }));
      const v = r && r.value;
      if (!v) return null;
      return {
        err: v.err || null,
        accounts: (v.accounts || []).map((a) => (a ? { lamports: BigInt(a.lamports), owner: String(a.owner),
                                                        data: Buffer.from((a.data && a.data[0]) || '', 'base64') } : null)),
      };
    },
  };
}

module.exports = { RULES, SOL_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAMS, SwapError, createSwap, createJupiter, chainFromConnection,
                   checkOrder, checkEffects, checkSigned, checkShape, checkPrice, txFacts, readTokenAccount, isKey,
                   PROGRAMS, JUP_ROUTES };
