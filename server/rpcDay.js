'use strict';
/* ─── The day's cap on the public chain reads, when they share the money key ───
   (night review 2026-10-29, fourth pass: findings 1, 2 and 22, review problem 0)

   One day (server/rpcBudget.js createDayCap) for every provider call a visitor can
   cause: /api/sol-balance and the /api/rpc relay (index.js publicRpcBudget) and the
   Wallet tab's history (Usdc.js). It exists only while those reads go to the same
   key as stake verifies, submits and payouts: PUBLIC_RPC_URL unset, or set to
   RPC_URL. With a key of their own (PUBLIC_RPC_URL), a flood can only spend that
   key's credits, never the money key's, so there is no day and `day` is null.

   Sizing: RPC_READS_PER_DAY (10000 by default), refilling over 24 h, so a month of
   flood costs these reads about 31 x 10k = 310k calls at most (a full day more in
   its first day), about a third of Helius Free's 1M, where the rates alone allowed
   about 430k a day. A send's blockhash is the money lane and outside this day: one
   fetch per 5 s server-wide at most (index.js sharedBlockhash). What that leaves honest
   players: one signed-in tab in view costs two calls per 15 s for its address
   (about 480 an hour; a hidden tab about 120), a Wallet tab's history opening up to
   60, and the owner's own session nothing (never counted). Today's traffic, the
   owner and a few testers, is far under it. Each address has an eighth of the day
   and a quarter is kept for addresses inside theirs (dayShare), so one address
   flooding never empties it for everyone; eight or more can, and then balances
   answer from the last read (stale, up to 5 minutes) and then as unknown, history
   says busy and the relay 503s until it refills (the wallet SDK's own reads, so
   Privy's Add funds sheet may say busy too; the card, the address and Add from a
   linked wallet do not use it), while every stake, verify, payout, send and a
   send's blockhash goes on, because none of them takes from it.
   Real traffic will outgrow it: before paid ads bring players, set PUBLIC_RPC_URL
   (a second Helius key; this cap then goes away) or raise RPC_READS_PER_DAY with a
   bigger plan. Each server counts its own day (the EU server, while it runs on the
   same key, spends another).

   Kept across restarts in RPC_DAY_PATH (server/data/rpc-day.json by default:
   gitignored, kept by the deploy's reset), so no deploy refills it. Under node --test
   (NODE_TEST_CONTEXT, which production never sets) with no RPC_DAY_PATH it stays in
   memory, so a test run never reads or spends a checkout's day. */
const path = require('path');
const rpcBudget = require('./rpcBudget');

// The same two keys Wallet.js and Usdc.js read.
const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const RPC_URL = process.env.RPC_URL || (NETWORK === 'mainnet-beta'
  ? 'https://api.mainnet-beta.solana.com'
  : 'https://api.devnet.solana.com');
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || RPC_URL;
const SHARED_KEY = PUBLIC_RPC_URL === RPC_URL;
const RPC_READS_PER_DAY = rpcBudget.envNumber('RPC_READS_PER_DAY', 10000);
const FILE = process.env.RPC_DAY_PATH ||
  (process.env.NODE_TEST_CONTEXT ? null : path.join(__dirname, 'data', 'rpc-day.json'));

let day = null;
if (SHARED_KEY) {
  day = rpcBudget.createDayCap({ perDay: RPC_READS_PER_DAY, perKey: rpcBudget.dayShare(RPC_READS_PER_DAY),
                                 saved: FILE ? rpcBudget.readDayFile(FILE) : null });
  if (FILE) rpcBudget.persistDayCap(day, { file: FILE });
  console.log(`[RPC-DAY] public chain reads share the money key: ${Math.floor(day.left())} of ${RPC_READS_PER_DAY} ` +
    'left in their day (set PUBLIC_RPC_URL to give them a key of their own)');
}

module.exports = { day, SHARED_KEY, RPC_READS_PER_DAY, FILE };
