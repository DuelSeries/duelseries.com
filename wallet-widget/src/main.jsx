import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin, useUser, useIdentityToken, useLoginWithSiws, useLinkWithSiws } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets, useCreateWallet as useCreateSolanaWallet, useSignTransaction, useSignMessage, useFundWallet,
         useSolanaFundingPlugin, toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import { getWallets } from '@wallet-standard/app';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import bs58 from 'bs58';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { SERVER_URLS, stakeRoute } from './stakeRoute.mjs';
import { createRestakeBridge, cancelledError } from './restakeBridge.mjs';
import { holdBackCoinbase } from './holdCoinbase.mjs';
import { buildSkinPayment } from './skinPay.mjs';
import { makeWalletSetup } from './walletSetup.mjs';
import { SEND_FEE_LAMPORTS, leavesReserve } from './solReserve.mjs';
import { WALLETS, detectedWallets, walletFor, accountFor, signTransactionWith, signMessageWith, isRefusal } from './browserWallets.mjs';
import { DEVICE_ACTIONS, loadDeviceKey, createDeviceKey, forgetDeviceKey, signWithDeviceKey } from './deviceKey.mjs';
import { linkedOf, linkWith, addProblem, maxAddLamports, buildAdd } from './linkedWallet.mjs';
// The shared gold popup card (public/js/shared/dsDialog.js), bundled so the lobby needs no extra tag.
import '../../public/js/shared/dsDialog.js';

// Active money mode (sol|usdc) reported by the server. In BOTH modes the games count in dollars; the mode
// decides what a send is made of (a SOL transfer or a USDC token transfer) and what a balance is read from.
// Cached after the first good answer. An unreadable answer is never cached and never guessed: it comes back
// as mode null, and a send refuses it rather than moving the wrong asset.
let _moneyCfg = null;
async function moneyConfig() {
  if (_moneyCfg) return _moneyCfg;
  try {
    const j = await (await fetch('/api/money-config')).json();
    if (j && (j.mode === 'usdc' || j.mode === 'sol')) _moneyCfg = j;
  } catch {}
  return _moneyCfg || { mode: null, unit: null, usdcMint: null, decimals: 6 };
}

// Phase 1 — self-custody stake-on-join. Connect (Phase 0) + a "Stake & Play" button that
// moves the entry fee from the player's embedded wallet into the escrow (one-tap Confirm),
// the server verifies it on-chain and issues the entry token the game already consumes.
// See docs/self-custody-migration.md.
const APP_ID = 'cmpnepg0100f20cl10wdig1fr';
// RPC goes through our own backend proxy so the browser doesn't hit a public RPC that
// 403s browser origins. (WSS is confirmation-only; the stake is verified server-side too.)
const RPC_HTTP = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/rpc';
const RPC_WSS = 'wss://api.mainnet-beta.solana.com';

/* What the wallet holds, as the server reads it.
     USDC mode: balance is the USDC (dollars); sol is the wallet's SOL beside it (card top-ups and exchange
                sends arrive as SOL, and the Wallet tab shows it with Convert to USDC).
     SOL mode:  balance is the dollar VALUE of the wallet's SOL (null while the server has no price), sol is
                the SOL itself, usdc is any old USDC left in the wallet (the Convert to SOL line), solUsd the
                display rate. The server's figures are used as given; nothing here prices anything.
   Night review 2026-10-29 (third pass): the server shares one read of an address for 10 s; opts.fresh asks for one
   under 1 s old (a check before money moves, and the read right after it moves). stale is true when the server could
   not read the chain just now and answered with its last read of the address (up to 5 minutes old): shown like any
   balance, never used to refuse a send (freshSol). */
const finite = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
async function fetchBalances(address, opts) {
  try {
    const r = await fetch('/api/sol-balance?address=' + encodeURIComponent(address) + (opts && opts.fresh ? '&fresh=1' : ''));
    const j = await r.json();
    return { balance: typeof j.sol === 'number' ? j.sol : null,
             sol: typeof j.solNative === 'number' ? j.solNative : null,
             usdc: finite(j.usdc), solUsd: finite(j.solUsd), stale: j.stale === true };
  } catch { return { balance: null, sol: null, usdc: null, solUsd: null, stale: false }; }
}
/* A wallet's SOL right now, for the check before a stake, a send, a skin or an add: null when it cannot be read fresh
   (a busy moment, or a flood holding the server's read budget). A check that gets null lets the money go ahead
   unchecked, and the chain refuses whatever the wallet cannot cover, so a balance read is never what stops a player
   moving their own money (night review 2026-10-29, third pass; before, Withdraw, a skin buy and an add from a linked
   wallet said "Could not read your balance" and stopped). */
async function freshSol(address) {
  const b = await fetchBalances(address, { fresh: true });
  return b.stale ? null : b.sol;
}

/* SOL <-> USDC in this wallet (server/swap.js; Owen 2026-10-15, "Accept both, play in USDC").
   The server asks Jupiter for the transaction and checks it, the order and a simulation read as
   balances, before it is handed here; the player sees the price and taps to confirm; then this
   wallet signs exactly those bytes and the server sends them once. Nothing is signed without that
   tap, and the server refuses any bytes that are not the ones it checked. */
/* The prices this widget fetched, by requestId. The lobby gets a copy to show and names one back
   to run it; the bytes signed are always this widget's own copy, never one handed in. */
const _quotes = new Map();
async function swapQuote(address, dir, amount, receiver) {
  const qs = new URLSearchParams({ wallet: address, dir, amount: String(amount) });
  if (receiver) qs.set('receiver', receiver);
  const r = await fetch('/api/swap/quote?' + qs.toString());
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j || j.error || !j.requestId) throw new Error((j && j.error) || 'Could not get a price. Try again.');
  const t = Date.now();
  for (const [k, v] of _quotes) if (!(Number(v.expiresAt) > t)) _quotes.delete(k);
  _quotes.set(j.requestId, j);
  return Object.assign({}, j);
}
async function swapRun(requestId, wallet, signTransaction) {
  const q = _quotes.get(requestId);
  if (!q || typeof q.transaction !== 'string') throw new Error('That price is not valid. Get a new one.');
  _quotes.delete(requestId);
  if (Date.now() > Number(q.expiresAt || 0)) throw new Error('That price expired. Nothing was converted. Get a new one.');
  const bytes = Uint8Array.from(atob(q.transaction), (c) => c.charCodeAt(0));
  // The wallet must be one of the transaction's signers (the server checked this too).
  const vtx = VersionedTransaction.deserialize(bytes);
  const signers = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (!signers.includes(wallet.address)) throw new Error('That conversion is not for your wallet.');
  // The player already confirmed this exact price on our sheet; a second Privy screen would repeat it.
  const { signedTransaction } = await signTransaction({ transaction: bytes, wallet, options: { uiOptions: { showWalletUIs: false } } });
  const r = await fetch('/api/swap/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: q.requestId, signedTransaction: Buffer.from(signedTransaction).toString('base64') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'The conversion did not go through. Check your balance before trying again.');
  return j;
}

const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');

/* p, or a plain failure after ms: a wallet or Privy request that never answers must not hold a card up forever. */
function inTime(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error(msg)), ms); })])
    .finally(() => clearTimeout(t));
}

/* Privy's own (email and Google) wallet, as Privy names it: 'privy' today, 'privy-v2' in its types, connector
   'embedded'. Anything else is a browser wallet the player signed in with. */
const isPrivyWallet = (a) => !!a && (/^privy/.test(String(a.walletClientType || '')) || /^embedded/.test(String(a.connectorType || '')));

function solanaAddress(user) {
  if (!user) return null;
  const accts = user.linkedAccounts || [];
  const isSol = (a) => a && a.type === 'wallet' && a.chainType === 'solana';
  const w = accts.find((a) => isSol(a) && isPrivyWallet(a)) || accts.find(isSol);
  if (w?.address) return w.address;
  if (user.wallet?.chainType === 'solana') return user.wallet.address;
  return null;
}

/* The linked account behind that address: its walletClientType is 'privy' for the email and Google wallet, the
   browser wallet's name for Connect wallet ('phantom', 'solflare', ...). */
function linkedSolana(user, address) {
  if (!user || !address) return null;
  return (user.linkedAccounts || []).find((a) => a && a.type === 'wallet' && a.chainType === 'solana' && a.address === address)
    || (user.wallet && user.wallet.address === address ? user.wallet : null);
}

/* Connect wallet (browserWallets.mjs). The Wallet Standard registry every Solana extension joins; Privy's
   connectors read the same one. */
const registry = typeof window !== 'undefined' ? getWallets() : null;
const labelOfClient = (c) => ((WALLETS.find((k) => k.client === c) || {}).label) || 'your wallet';

/* The Privy app's public config (the same GET Privy's own client makes), once a page; unreadable counts as off and
   is asked again a minute later. 4 s at most, so a slow or hung answer never holds anything up. */
let _privyCfg = null;
function privyConfig() {
  if (!_privyCfg) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 4000);
    _privyCfg = Promise.race([
      fetch('https://auth.privy.io/api/v1/apps/' + APP_ID, { headers: { 'privy-app-id': APP_ID }, signal: ctl ? ctl.signal : undefined })
        .then((r) => (r.ok ? r.json() : null)),
      new Promise((resolve) => setTimeout(() => resolve(null), 4500)),
    ]).catch(() => null).finally(() => clearTimeout(timer));
    _privyCfg.then((j) => { if (!j) setTimeout(() => { _privyCfg = null; }, 60000); });
  }
  return _privyCfg;
}
/* Privy's Add funds sheet lists "Transfer from wallet" (Phantom, Solflare, Backpack) once the dashboard's funding
   methods include it; until then the lobby offers its own "Add from Phantom" beside Add funds (wallet.js). Null while
   the config is unreadable, so the caller asks again. */
const walletFundingOn = () => privyConfig().then((j) => (j ? !!(j.funding_config &&
  (j.funding_config.options || []).some((o) => o && o.method === 'wallets')) : null));

// Stake the entry fee (paid lobbies) from the embedded wallet into the escrow, verify it
// server-side, then launch the game. Free lobbies skip the stake entirely.
// Stake the entry fee for a paid lobby and return the verified entry token (no launch). Used
// by both stakeAndPlay and the in-game "Play Again" re-stake. Free lobbies stake nothing.
// The lobby is served from the NA origin, but a paid stake must hit the SAME server the game
// will connect to: the one-time entry token is minted in that server's memory and consumed
// there on join. Which server that is depends on the game (stakeRoute.mjs): snake follows the
// lobby's region, Paper, Knockout, Battleship, agar.io and paid snake on the new engine (/sl)
// play on this origin.
function lobbyRegion() { try { return localStorage.getItem('duelseries_region') || 'na'; } catch (_) { return 'na'; } }
// The region the running game page was launched with (same-origin frames share this tab's
// sessionStorage), so a Play again stakes where that page is connected, not where the lobby
// points now.
function pageRegion() { try { return sessionStorage.getItem('region') || lobbyRegion(); } catch (_) { return lobbyRegion(); } }

/* `sel` selects the room to buy into, in one of two forms:
     'dollar' | { lobbyType: 'dollar' }   the original fixed tiers
     { stake: 0.5 }                   a rung of the stake ladder
   Both are supported while the two lobbies run side by side: index.html sends
   a tier, /v2 sends a rung. The request differs only in which parameter names
   the room; everything about building, signing and submitting the transfer is
   the same code either way, so there is one staking path and not two. */
const STAKE_CU_LIMIT = 80_000;
const STAKE_CU_PRICE = 100_000;   // micro-lamports per compute unit
// A stake's most: the base fee plus its priority fee (STAKE_CU_LIMIT * STAKE_CU_PRICE / 1e6 = 8000).
const STAKE_FEE_LAMPORTS = SEND_FEE_LAMPORTS + Math.ceil(STAKE_CU_LIMIT * STAKE_CU_PRICE / 1e6);
// Plain words for a SOL stake the wallet cannot carry. Keep "rent" out of it: doStake rewrites such messages.
const SOL_LOW_MSG = 'Add a little SOL. Your wallet needs the entry plus 0.001 SOL left over for network fees.';
const SOL_SEND_LOW = 'Leave at least 0.001 SOL in your wallet for network fees. Send a little less, or use Max.';

function stakeSpec(sel) {
  if (typeof sel === 'string') return { lobbyType: sel };
  return sel || {};
}
/* base: the server to stake on (stakeRoute), '' for this origin. hooks.stillWanted, when given,
   is asked right before the wallet prompt and right before the submit: false means the game
   that asked is gone, so the stake stops there with nothing sent (the signed transfer is
   never broadcast, so no money moves). */
async function stakeOnly(sel, wallet, signTransaction, onStatus, base, hooks) {
  const spec = stakeSpec(sel);
  const wanted = () => !(hooks && typeof hooks.stillWanted === 'function') || hooks.stillWanted();
  const byStake = spec.stake !== undefined && spec.stake !== null;
  // Free costs nothing and needs no token, whichever way it was named.
  if (byStake ? Number(spec.stake) === 0 : spec.lobbyType === 'free') {
    return { entryToken: '', worth: 0 };
  }
  // A room nobody named is never staked into (no default room, BACKLOG 2.1).
  if (!byStake && (typeof spec.lobbyType !== 'string' || !spec.lobbyType)) {
    throw new Error('That lobby is not available right now. Refresh and try again.');
  }
  if (typeof base !== 'string') throw new Error('No server chosen for this stake');
  onStatus('Getting quote…');
  const query = byStake
    ? '/api/stake-quote?stake=' + encodeURIComponent(spec.stake)
    : '/api/stake-quote?lobbyType=' + encodeURIComponent(spec.lobbyType);
  const quote = await (await fetch(base + query)).json();
  if (quote.error) throw new Error(quote.error);

  /* The PRICE decides, not the name. The check above catches the lobby actually
     called 'free'; this catches every other lobby that costs nothing — the
     battle royale is the first, entered for free with the prize paid by the
     house. Without it that quote came back priced at zero with no escrow to pay
     (correctly, there is nothing to pay) and this threw 'No escrow configured
     for this lobby' at a player trying to enter a free event.

     Both money modes: SOL prices in lamports, USDC in units. A quote with
     nothing to transfer needs no transfer. */
  const owes = quote.mode === 'usdc'
    ? Number(quote.units || 0)
    : Number(quote.lamports || 0);
  if (!owes) return { entryToken: '', worth: 0 };

  /* SOL mode: the stake, its fee and a little SOL must all fit in the wallet. A wallet left holding less
     than 0.001 SOL cannot pay for its next move (and under about 0.00089 SOL the network refuses the
     account outright), so the player is told to add a little SOL BEFORE anything is signed. A balance
     that cannot be read does not block play; the network still refuses a stake the wallet cannot cover. */
  if (quote.mode === 'sol') {
    const have = await freshSol(wallet.address);
    if (have != null && !leavesReserve(Math.round(have * 1e9), owes, STAKE_FEE_LAMPORTS)) {
      throw new Error(SOL_LOW_MSG);
    }
  }

  onStatus('Building stake…');
  const from = new PublicKey(wallet.address);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = quote.blockhash; // real blockhash — our backend submits the signed tx
  /* A priority fee, so the network does not drop the entry. Without one about a third of
     stakes were accepted by the RPC and never landed (2026-10-17: 6 of Owen's 16, each a
     "Stake not confirmed in time" and a Play again that did nothing). The limit covers the
     escrow account create (when it is missing) plus the transfer with room to spare; the
     fee is at most STAKE_CU_LIMIT * STAKE_CU_PRICE / 1e6 lamports (8000, under $0.01 of SOL).
     The server checks the escrow's balance change only, so extra instructions change nothing
     it verifies. */
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: STAKE_CU_LIMIT }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: STAKE_CU_PRICE }));
  if (quote.mode === 'usdc') {
    // USDC stake: SPL transfer from the player's USDC token account into the escrow's.
    const mint = new PublicKey(quote.usdcMint);
    const fromAta = getAssociatedTokenAddressSync(mint, from);
    const escrowAta = new PublicKey(quote.escrowAta);
    // Make sure the escrow's USDC account exists before transferring into it. Idempotent: only the
    // very first staker ever pays the ~0.002 SOL rent (a no-op once it exists). Without this, the
    // first USDC stake fails — you can't transferChecked into a token account that isn't created.
    if (quote.escrowOwner) tx.add(createAssociatedTokenAccountIdempotentInstruction(from, escrowAta, new PublicKey(quote.escrowOwner), mint));
    tx.add(createTransferCheckedInstruction(fromAta, mint, escrowAta, from, BigInt(quote.units), quote.decimals));
  } else {
    if (!quote.escrowAddress) throw new Error('No escrow configured for this lobby');
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(quote.escrowAddress), lamports: quote.lamports }));
  }
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  if (!wanted()) throw cancelledError();
  onStatus('Confirm in your wallet…');
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet }); // sign only — no browser WSS
  const signedTx = Buffer.from(signedTransaction).toString('base64');
  if (!wanted()) throw cancelledError(); // signed but never sent: nothing moved

  onStatus('Submitting stake…');
  const verify = await (await fetch(base + '/api/submit-stake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(byStake
      ? { stake: spec.stake, signedTx, walletAddress: wallet.address }
      : { lobbyType: spec.lobbyType, signedTx, walletAddress: wallet.address }),
  })).json();
  if (!verify.ok) throw new Error(verify.error || 'Stake failed');
  /* worth is the server's figure, never ours. On the ladder it is the rung the
     payment resolved to, which can be lower than what was asked for if the
     amount fell short, so the caller must use this and not spec.stake. */
  return { entryToken: verify.entryToken,
           worth: (verify.worth != null ? verify.worth : verify.worthSol),
           stake: verify.stake };
}

/* A skin's payment, signed (docs/skin-purchases.md): the quote from POST /api/skins/intent becomes exactly the
   transfer and memo the server accepts (skinPay.mjs), and the player's own wallet signs it, sign only, the same way
   a stake is signed. The lobby (public/js/v2/skinBuy.js) sends it to /api/skins/buy; nothing is broadcast here. */
const USDC_ACCOUNT_RENT = 2_039_280;   // what a USDC send costs the sender when the receiver has no USDC account
async function signSkinPayment(quote, wallet, signTransaction) {
  // SOL skins: only to the server's revenue wallet, and never more than $25 of SOL (skins cost $1 to $5)
  const cfg = await moneyConfig();
  if (quote && quote.asset === 'sol') {
    // the wallet keeps its 0.001 SOL after the skin and the fee, like a stake or a send; unreadable just now, the
    // payment goes ahead and the chain refuses one the wallet cannot cover (freshSol)
    const have = await freshSol(wallet.address);
    if (have != null && !leavesReserve(Math.round(have * 1e9), Number(quote.units), SEND_FEE_LAMPORTS)) {
      throw new Error('Not enough in your wallet. Keep 0.001 SOL for network fees.');
    }
  }
  const maxLamports = Number(cfg.solUsd) > 0 ? Math.ceil((25 / Number(cfg.solUsd)) * 1e9) : 250_000_000;
  const serialized = buildSkinPayment(quote, wallet.address, { payTo: cfg.skinPayTo, maxLamports });
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
  return Buffer.from(signedTransaction).toString('base64');
}

/* agar.io's rooms are rungs (Free, $0.50, $1.00; PAID-AGAR-DESIGN.md 7), staked by amount like
   Paper's. It has no tier rooms, so a paid tier name (dollar) names a room that does not
   exist: quoting it would take a stake no agar door could seat. Refused before any quote or wallet
   prompt, for the lobby's launch and for an in-game Play again alike. */
function refuseAgarTier(game, sel) {
  if (game !== 'agar') return;
  const spec = stakeSpec(sel);
  const byStake = spec.stake !== undefined && spec.stake !== null;
  if (!byStake && spec.lobbyType !== 'free') throw new Error('That agar.io table does not exist. Pick a buy-in on the card.');
}

/* Paid snake runs on two engines while the swap is live (PAID-SL-DESIGN.md 2). The lobby names the new one with
   engine: 'sl' when the board's open row at that stake is an 'sl:' row; the stake then goes to this origin, where the
   new engine's paid door is, and the round opens /sl. Honoured only for a paid snake rung: any other game, a tier,
   Free, or any other value is the old path exactly (/game.html on the region's server). */
function engineOf(game, sel) {
  const spec = stakeSpec(sel);
  const byStake = spec.stake !== undefined && spec.stake !== null;
  return game === 'snake' && spec.engine === 'sl' && byStake && Number(spec.stake) > 0 ? 'sl' : null;
}

/* The one-shot mark of a paid /sl launch (slPaidLaunch). public/js/slx/slxPaid.js reads the hand-off as money only
   when it is there, and removes it with the token at boot, so a token left behind by an old-engine launch (or a
   launch whose page never loaded) is never spent by a later /sl page. A marker, not a secret. */
function launchNonce() {
  const b = new Uint8Array(12);
  try { crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function stakeAndPlay(game, sel, wallet, signTransaction, onStatus, onLaunch) {
  refuseAgarTier(game, sel);
  // One read of the lobby's region: the stake and the page's connection use the same answer.
  const route = stakeRoute(game, lobbyRegion(), engineOf(game, sel));
  const staked = await stakeOnly(stakeSpec(sel), wallet, signTransaction, onStatus, route.base);
  onStatus('Joining…');
  launchStaked(game, sel, Object.assign({}, staked, { region: route.region }), wallet, onLaunch);
}

/* Opens a round that is already paid for (or free): the hand-off the page reads, then the page
   in the lobby's frame. staked = { entryToken, worth, stake, region } from stakeOnly plus the
   route; region is null for a game that plays on this origin. Also used when a Play again was
   paid for after its page had gone (restakeBridge.mjs), so the stake still gets its seat. */
function launchStaked(game, sel, staked, wallet, onLaunch) {
  const spec = stakeSpec(sel);
  const byStake = spec.stake !== undefined && spec.stake !== null;
  const { entryToken, worth, stake } = staked;

  sessionStorage.setItem('playerName', localStorage.getItem('duelseries_playername') || short(wallet.address));
  sessionStorage.setItem('googleId', wallet.address);       // self-custody identity = wallet
  sessionStorage.setItem('walletAddress', wallet.address);
  /* The game echoes these back when it joins, and the server decides the room
     from whichever it receives. On the ladder the stake is the SERVER's rung,
     not what was asked for, so a payment that resolved down lands in the room
     it actually bought. lobbyType stays set for the tier path and is cleared
     on the ladder path so the two can never both be honoured. */
  if (byStake) {
    sessionStorage.setItem('stake', String(stake != null ? stake : worth));
    sessionStorage.removeItem('lobbyType');
  } else {
    sessionStorage.setItem('lobbyType', spec.lobbyType);
    sessionStorage.removeItem('stake');
  }
  sessionStorage.setItem('entryToken', entryToken);
  sessionStorage.setItem('entrySol', String(worth));
  // Written fresh for an /sl round, before the page loads; cleared for every other launch, so no
  // mark ever sits beside a token the new engine was not bought for.
  const sl = engineOf(game, sel) === 'sl';
  if (sl) sessionStorage.setItem('slPaidLaunch', launchNonce());
  else sessionStorage.removeItem('slPaidLaunch');
  // Chomp's own one-shot mark (public/js/chomp/chompPaid.js): its page spends a token only beside it.
  if (game === 'chomp' && byStake && Number(stake != null ? stake : worth) > 0) sessionStorage.setItem('chompPaidLaunch', launchNonce());
  else sessionStorage.removeItem('chompPaidLaunch');
  // The region the stake went to, for pages that follow it (snake); a game that plays on this
  // origin (Paper, Knockout, Battleship, agar.io, /sl) still gets the lobby's pick, which it does
  // not use to connect.
  sessionStorage.setItem('region', staked.region || lobbyRegion());
  sessionStorage.setItem('snakeColor', localStorage.getItem('duelseries_skin_color') || '#14F195');
  sessionStorage.setItem('hatId', localStorage.getItem('duelseries_hat_id') || 'none');
  sessionStorage.setItem('boostId', localStorage.getItem('duelseries_boost_id') || 'default');
  // gameMode was the old agar.io page's flag and nothing read it; cleared so a stale one goes.
  sessionStorage.removeItem('gameMode');
  sessionStorage.removeItem('spectateOnly');
  // Launch in the lobby's iframe (snake → game-frame/game.html, agar → agar-frame and /ag);
  // the in-game Lobby button returns cleanly via the lobby's game:done handler.
  /* Which page this buy-in opens. Knockout is the first game here that has
     its own page AND takes money, so the map is by game rather than by a
     single isAgar flag. Its free seats never reach this function at all -
     the lobby opens those directly, because there is nothing to stake.
     Paper and agar.io are different: all three of their rungs come through
     here, Free included (stake 0 short-circuits to an empty token above), so
     every launch writes a fresh hand-off. Without its entry a paid Paper token
     would fall through to /game.html and the snake client would spend it.
     A paid snake round on the new engine opens /sl in the snake frame (engineOf above). */
  const isAgar = game === 'agar';
  const PAGES = { agar: '/ag', knockout: '/knockout', battleship: '/battleship', snake: '/game.html',
                  paper: '/paper-arena', chomp: '/chomp', swim: '/swim', headsoccer: '/headsoccer', pool8: '/pool8',
                  rooftop: '/rooftop', crossy: '/crossy', airhockey: '/airhockey' };
  const frame = document.getElementById(isAgar ? 'agar-frame' : 'game-frame');
  const html = sl ? '/sl' : (PAGES[game] || '/game.html');
  if (frame) {
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    onLaunch();
    // Focus the game iframe once it loads so keyboard (boost / cash-out) works immediately.
    // The Privy approval modal had focus, so without this the player has to click in first.
    frame.addEventListener('load', () => {
      const focusGame = () => { try { frame.contentWindow.focus(); } catch (_) {} };
      focusGame(); setTimeout(focusGame, 150); // again after the modal finishes returning focus
    }, { once: true });
    frame.src = html;
    frame.style.display = 'block';
  } else {
    window.location.href = html;
  }
}

// Self-custody Cash Out: send SOL from the embedded wallet to any external address. Privy
// signs; our backend relays + confirms (the browser can't reach a public RPC directly).
async function sendSol(toAddress, amountSol, wallet, signTransaction) {
  let toPub;
  try { toPub = new PublicKey(toAddress); } catch (_) { throw new Error("That doesn't look like a valid Solana address."); }
  const { blockhash } = await (await fetch('/api/blockhash')).json();
  if (!blockhash) throw new Error('Network busy — try again.');
  const from = new PublicKey(wallet.address);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: toPub, lamports: Math.round(amountSol * 1e9) }));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
  const signedTx = Buffer.from(signedTransaction).toString('base64');
  const r = await (await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTx, kind: 'withdraw' }) })).json();
  if (!r.ok) throw new Error(r.error || 'Send failed');
  return r.sig;
}

// USDC cash-out: send USDC from the embedded wallet to any external address. Creates the
// recipient's USDC token account if they don't have one (idempotent — no-op if it exists).
async function sendUsdc(toAddress, amountUsdc, mint, decimals, wallet, signTransaction) {
  let toPub;
  try { toPub = new PublicKey(toAddress); } catch (_) { throw new Error("That doesn't look like a valid Solana address."); }
  const mintPub = new PublicKey(mint);
  const from = new PublicKey(wallet.address);
  const fromAta = getAssociatedTokenAddressSync(mintPub, from);
  const toAta = getAssociatedTokenAddressSync(mintPub, toPub);
  const { blockhash } = await (await fetch('/api/blockhash')).json();
  if (!blockhash) throw new Error('Network busy — try again.');
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, toAta, toPub, mintPub));
  tx.add(createTransferCheckedInstruction(fromAta, mintPub, toAta, from, BigInt(Math.round(amountUsdc * Math.pow(10, decimals))), decimals));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
  const signedTx = Buffer.from(signedTransaction).toString('base64');
  const r = await (await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTx, kind: 'withdraw' }) })).json();
  if (!r.ok) throw new Error(r.error || 'Send failed');
  return r.sig;
}

/* Privy's wallet frame (auth.privy.io) says privy:iframe:ready once it can work. If a wallet setup
   fails and it never said so, a browser blocker stopped it, and the card says how to allow it. */
let privyFrameReady = false;
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.origin === 'https://auth.privy.io' && e.data && e.data.event === 'privy:iframe:ready') privyFrameReady = true;
  });
}

/* Product tracking: the sign-in funnel (shared/trackPlan.js), sent through the lobby's helper
   (public/js/shared/dsTrack.js, window.DSTrack), which identifies the player by wallet on its own once the wallet is
   published. Never a wallet, an email or a token: an error is Privy's code, or its words with anything shaped like an
   address or an email taken out (a status code stays: no money figure is ever in these). Nothing here can stand in the
   way of signing in. */
const SIGNIN_METHOD = { siws: 'wallet', siwe: 'wallet', sms: 'phone' };
const errWords = (m) => String(m || '').replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '…').replace(/\S+@\S+/g, '…').slice(0, 100);
function signinOpened(where) {
  try { if (window.DSTrack) window.DSTrack.event('signin_opened', { where: typeof where === 'string' ? where : undefined }); } catch (_) {}
}
/* One signed_in per sign-in, from Privy's onComplete (a wallet sign-in included: it used to be a second event of its
   own, sent later from the device key step). */
function signedInEvent(loginMethod, isNewUser, account) {
  try {
    if (!window.DSTrack) return;
    const m = String(loginMethod || '');
    const c = (m === 'siws' || m === 'siwe') && account ? String(account.walletClientType || '') : '';
    const k = c ? WALLETS.find((x) => x.client === c) : null;
    window.DSTrack.event('signed_in', { method: SIGNIN_METHOD[m] || m || undefined,
      new_user: typeof isNewUser === 'boolean' ? isNewUser : undefined, wallet_app: k ? k.label : c || undefined });
  } catch (_) {}
}
/* Privy's useLogin onError: the window closed without signing in is a give-up, anything else went wrong. */
function signinErrorEvent(code) {
  try {
    if (!window.DSTrack) return;
    const c = String(code || 'unknown_auth_error');
    if (c === 'exited_auth_flow') window.DSTrack.event('signin_abandoned', { step: 'privy' });
    else if (c === 'oauth_user_denied') window.DSTrack.event('signin_abandoned', { step: 'oauth' });
    else window.DSTrack.event('signin_failed', { step: 'privy', error: errWords(c) });
  } catch (_) {}
}

function WalletPanel() {
  const { ready, authenticated, user, logout, getAccessToken, unlinkWallet } = usePrivy();
  /* A browser wallet signed in through Privy's modal: noted here, finished below (the device key). */
  /* State, not a ref: Privy can call onComplete after the signed-in render, and the effect must run again then. */
  const [walletSignedIn, setWalletSignedIn] = useState(null);
  const { login } = useLogin({
    onComplete: ({ isNewUser, loginMethod, loginAccount, wasAlreadyAuthenticated }) => {
      if (!wasAlreadyAuthenticated) signedInEvent(loginMethod, isNewUser, loginAccount);
      if (wasAlreadyAuthenticated || loginMethod !== 'siws' || !loginAccount) return;
      setWalletSignedIn({ address: loginAccount.address, at: Date.now() });
    },
    onError: (code) => signinErrorEvent(code),
  });
  // Carries the linked accounts with it, so the server can resolve the wallet in one
  // call that Privy does not rate limit. Null unless identity tokens are switched on
  // for the app, which is why nothing depends on it alone.
  const { identityToken } = useIdentityToken();
  const { wallets: solWallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  /* Which way the player paid in Privy's Add funds sheet, for the lobby's funding count (dsTrack.js): MoonPay or
     Coinbase is a card, Transfer from wallet or Receive funds is crypto. Analytics only, never money. */
  const { fundWallet } = useFundWallet({
    onUserExited: ({ fundingMethod }) => {
      try {
        const m = fundingMethod === 'moonpay' || fundingMethod === 'coinbase-onramp' ? 'card'
          : fundingMethod === 'external' || fundingMethod === 'manual' ? 'crypto' : null;
        if (m && window.DSTrack && window.DSTrack.fundMethod) window.DSTrack.fundMethod(m);
      } catch (_) {}
    },
  });
  useSolanaFundingPlugin();   // Privy's Transfer from wallet builds its Solana send with this
  const { createWallet } = useCreateSolanaWallet();
  const { refreshUser } = useUser();
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();
  const linkSiws = useLinkWithSiws();
  const linkRef = useRef(null);
  linkRef.current = linkSiws;   // a new object every render; the window functions read the latest
  const [balance, setBalance] = useState(null);  // USDC mode: the USDC. SOL mode: the dollar value of the SOL.
  const [sol, setSol] = useState(null);    // the wallet's SOL (beside a USDC balance, or the money itself in SOL mode)
  const [usdc, setUsdc] = useState(null);  // SOL mode: old USDC still in the wallet (null: none, or not read)
  const [solUsd, setSolUsd] = useState(null); // SOL mode: the server's display rate, dollars per SOL
  // The figures above are the server's last read of the address (up to 5 minutes old), not a read now (night review
  // 2026-10-29, fourth pass): the lobby shows them as they are and treats them as unread for its own checks.
  const [stale, setStale] = useState(false);
  const [mode, setMode] = useState(null);  // 'usdc' | 'sol', from /api/money-config (null until it answers)
  const [unit, setUnit] = useState('');    // what the games count in: USDC, or USD in SOL mode (/api/money-config)
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [what, setWhat] = useState(null);  // { game, stake } of the buy-in in flight, for the popup's words
  const [playing, setPlaying] = useState(false);
  const dialogOwned = useRef(false);       // whether the popup up now is this widget's
  const [tier, setTier] = useState(() => { try { return localStorage.getItem('duelseries_lobbytype') || 'free'; } catch { return 'free'; } });
  const stakeRef = useRef(null);
  const busyRef = useRef(false); // synchronous guard: no double-staking on rapid Play clicks

  /* The installed browser wallets, kept current as extensions register (an extension can load after the page). */
  const [detected, setDetected] = useState(() => detectedWallets(registry));
  useEffect(() => {
    if (!registry) return undefined;
    const sync = () => setDetected(detectedWallets(registry));
    const offs = [registry.on('register', sync), registry.on('unregister', sync)];
    sync();
    return () => offs.forEach((off) => { try { off(); } catch (_) {} });
  }, []);

  /* The player's wallet is the signed-in account's, and only that: a browser wallet that is merely connected
     never stands in for it. Email and Google: Privy's own wallet object. Connect wallet: { address, external,
     clientType, std, name }, signed through the browser wallet itself (browserWallets.mjs). */
  const address = authenticated ? solanaAddress(user) : null;
  const gameAcct = linkedSolana(user, address);
  const clientType = gameAcct && gameAcct.walletClientType;
  const isExternal = !!(address && gameAcct && !isPrivyWallet(gameAcct));
  const extStd = isExternal ? walletFor(detected, address, clientType) : null;
  const extWallet = useMemo(() => (isExternal
    ? { address, external: true, clientType, std: extStd, name: (extStd && extStd.name) || labelOfClient(clientType) }
    : null), [isExternal, address, clientType, extStd]);
  const wallet = extWallet || (address ? (solWallets || []).find((w) => w.address === address) || null : null);

  /* A Google or email player's linked browser wallet (linkedWallet.mjs): a way to move money in and out, never the
     game wallet. linkable: the installed wallets of the three that could be linked. Neither exists for a player who
     signed in with a browser wallet: that wallet already is the game wallet. */
  const linked = !isExternal && address ? linkedOf(user, address) : null;
  const linkedStd = linked ? walletFor(detected, linked.address, linked.clientType) : null;
  const linkable = !isExternal && address
    ? WALLETS.map((k) => ({ k, w: detected.find((d) => k.names.includes(String(d.name || '').trim().toLowerCase())) }))
        .filter((x) => x.w).map((x) => ({ id: x.k.id, label: x.k.label, icon: x.w.icon || x.k.icon }))
    : [];
  const linkedKey = linked ? linked.address + '|' + linked.name + '|' + (linkedStd ? 1 : 0) : '';
  const linkableKey = linkable.map((x) => x.id).join(',');

  /* One signer for both kinds of wallet, the shape Privy's hooks take ({ transaction, wallet }, { message, wallet }).
     A browser wallet signs with the account the player signed in with, or says plainly why it cannot. */
  const signTx = useCallback(async (args) => {
    const w = args && args.wallet;
    if (w && w.external) {
      if (!w.std) throw new Error(w.name + ' is not in this browser. Open DuelSeries where ' + w.name + ' is installed, or sign out and sign in again.');
      return signTransactionWith(w.std, w.address, args.transaction);
    }
    return signTransaction(args);
  }, [signTransaction]);
  const signMsg = useCallback(async (args) => {
    const w = args && args.wallet;
    if (w && w.external) {
      if (!w.std) throw new Error(w.name + ' is not in this browser. Open DuelSeries where ' + w.name + ' is installed, or sign out and sign in again.');
      return signMessageWith(w.std, w.address, args.message);
    }
    return signMessage(args);
  }, [signMessage]);

  /* A browser wallet that already trusts this site is connected quietly on load, so a stake later needs its one
     approval and no connect popup first. */
  useEffect(() => {
    if (extStd && address) accountFor(extStd, address, { silent: true }).catch(() => {});
  }, [extStd, address]);

  /* Signed in with no wallet (walletSetup.mjs: Privy's on-login create can stall for good, and
     its login() does nothing for a session already signed in). The wallet is made here: right
     after login, on the next visit of anyone already stuck, and on every Sign in press. The gold
     card says what is happening, and a failure offers Try again instead of a spinner forever. */
  const privyRef = useRef(null);
  privyRef.current = { ready, authenticated, user, login, createWallet, refreshUser, generateSiwsMessage, loginWithSiws };
  const setupRef = useRef(null);
  if (!setupRef.current) {
    setupRef.current = makeWalletSetup({
      createWallet: () => privyRef.current.createWallet(),
      hasWallet: () => !!solanaAddress(privyRef.current.user),
      refreshUser: () => privyRef.current.refreshUser(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
  }
  const setupUi = useRef(null); // the card flow on screen now, so two callers share one
  const setUpWallet = () => {
    if (setupUi.current) return setupUi.current;
    const run = async () => {
      for (;;) {
        const D = window.DSDialog;
        if (D) D.busy({ title: 'Setting up your wallet', line: 'This takes a few seconds' });
        const r = await setupRef.current.ensure();
        if (r.ok) { if (D) D.close(); return true; }
        console.warn('[wallet-widget] wallet setup failed:', (r.error && r.error.message) || r.error);
        try { if (window.DSTrack) window.DSTrack.event('wallet_setup_failed', { error: errWords((r.error && r.error.message) || r.error) }); } catch (_) {}
        if (!D) return false;
        const again = await D.confirm(privyFrameReady
          ? { title: "Your wallet didn't load", line: 'Check your connection and try again. Your account is safe.', ok: 'Try again', cancel: 'Not now' }
          : { title: 'Your browser is blocking your wallet', line: /Edg\//.test(navigator.userAgent)
              ? 'Click the lock icon in the address bar, set Tracking prevention to Off for this site, then try again. Your account is safe.'
              : 'Turn off tracking protection or ad blockers for this site, then try again. Your account is safe.', ok: 'Try again', cancel: 'Not now' });
        if (!again) {
          try { if (window.DSTrack) window.DSTrack.event('signin_abandoned', { step: 'wallet_setup' }); } catch (_) {}
          return false;
        }
      }
    };
    const p = run().finally(() => { setupUi.current = null; });
    setupUi.current = p;
    return p;
  };
  const hasSolWallet = !!solanaAddress(user);
  useEffect(() => {
    if (ready && authenticated && user && !hasSolWallet) setUpWallet();
  }, [ready, authenticated, user && user.id, hasSolWallet]);

  /* Sign in always does something: signed in without a wallet makes the wallet; Privy still
     starting is waited for (up to 10 s) with the card up, then login, or a plain message.
     where: which button asked (the lobby passes 'header', 'play', 'skin_buy', ...), for the sign-in funnel only. */
  const signIn = async (where) => {
    let p = privyRef.current;
    if (!p.ready) {
      const D = window.DSDialog;
      if (D) D.busy({ title: 'Signing in', line: 'Getting ready' });
      const end = Date.now() + 10000;
      while (!privyRef.current.ready && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      p = privyRef.current;
      if (D) D.close();
      if (!p.ready) {
        signinOpened(where);
        try { if (window.DSTrack) window.DSTrack.event('signin_failed', { step: 'loading', error: 'privy_not_ready' }); } catch (_) {}
        if (D) D.alert({ title: "Sign in didn't load", line: 'Check your connection, or turn off blockers for this site, then try again.' });
        return;
      }
    }
    if (!p.authenticated) signinOpened(where);
    if (p.authenticated) { if (!solanaAddress(p.user)) setUpWallet(); return; }
    p.login();
  };

  const signingIn = useRef(false);

  /* The device key: one approval in the browser wallet, good for 30 days. Refused or failed, the player still plays
     and paid rounds still count (the entry proves the wallet); a free round's stats and an event prize need it, so a
     game join asks again (duelWalletSignAction) and the lobby offers it (below). One ask at a time. */
  const keyAsk = useRef(null);
  const deviceKeyFor = (std, addr, D) => {
    if (loadDeviceKey(localStorage, addr)) return Promise.resolve(true);
    if (keyAsk.current) return keyAsk.current;
    if (D) D.busy({ title: 'One more approval', line: 'Approve in ' + std.name + ' so games know it is you without asking again. It can never move money.' });
    const p = inTime(createDeviceKey(localStorage, addr, (bytes) => signMessageWith(std, addr, bytes).then((r) => r.signature)),
      120000, std.name + " didn't answer.")
      .then(() => {
        // the skin pass asked at sign-in, before there was a key, got nothing: ask again now (skinBuy.js)
        try { if (window.DSSkins) window.DSSkins.ensurePass(true).catch(() => {}); } catch (_) {}
        return true;
      }, () => {
        const t = String(Date.now());
        try { localStorage.setItem('duel.devkey.ask.' + addr, t); localStorage.setItem('duel.devkey.no.' + addr, t); } catch (_) {}
        return false;
      })
      .finally(() => { keyAsk.current = null; });
    keyAsk.current = p;
    return p;
  };

  /* Signed in with a browser wallet in Privy's modal: one more approval for the device key (deviceKey.mjs) so games
     know it is them without a popup on every join, then the toast. A wallet linked to a Google or email account signs
     in to THAT account (not external): nothing to ask then. */
  useEffect(() => {
    const w = walletSignedIn;
    if (!w || !authenticated || !address) return;
    if (Date.now() - w.at > 60000) { setWalletSignedIn(null); return; }
    if (!isExternal) { if (gameAcct) setWalletSignedIn(null); return; }
    if (!extStd || address !== w.address) return;
    setWalletSignedIn(null);
    const D = window.DSDialog;
    const name = extStd.name;
    signingIn.current = true;
    const asked = !loadDeviceKey(localStorage, address);   // a key already here: no card was opened, none to close
    deviceKeyFor(extStd, address, D).finally(() => {
      signingIn.current = false;
      if (asked && D) D.close();
      if (window.DSToast) window.DSToast.show({ kind: 'ok', title: 'Signed in with ' + name, code: short(address) });
    });
  }, [walletSignedIn, authenticated, address, isExternal, extStd]);

  /* No device key yet for a signed-in browser wallet (refused at sign-in, past its 30 days, or a fresh browser):
     a toast to tap, at most once a day, never a popup on its own. */
  useEffect(() => {
    if (!isExternal || !extStd || !address || signingIn.current) return undefined;
    if (loadDeviceKey(localStorage, address)) return undefined;
    let last = 0;
    try { last = Number(localStorage.getItem('duel.devkey.ask.' + address)) || 0; } catch (_) {}
    if (Date.now() - last < 24 * 60 * 60 * 1000) return undefined;
    const t = setTimeout(() => {
      if (!window.DSToast || loadDeviceKey(localStorage, address) || signingIn.current) return;
      try { localStorage.setItem('duel.devkey.ask.' + address, String(Date.now())); } catch (_) {}
      window.DSToast.show({ kind: 'info', title: 'One approval left', detail: 'Tap so your games count for stats and event prizes', ms: 9000,
        onTap: () => { deviceKeyFor(extStd, address, window.DSDialog).finally(() => window.DSDialog && window.DSDialog.close()); } });
    }, 2500);
    return () => clearTimeout(t);
  }, [isExternal, extStd, address]);

  /* Opened inside a wallet app from the sheet on a phone (signin=wallet): the sheet opens itself, once. */
  useEffect(() => {
    if (!ready) return;
    let want = false;
    try { const u = new URL(window.location.href); want = u.searchParams.get('signin') === 'wallet';
      if (want) { u.searchParams.delete('signin'); window.history.replaceState(null, '', u.toString()); } } catch (_) {}
    if (want && !authenticated) signIn('wallet_app');
  }, [ready]);

  const applyBalances = (b) => { setBalance(b.balance); setSol(b.sol); setUsdc(b.usdc); setSolUsd(b.solUsd); setStale(b.stale === true); };
  useEffect(() => {
    if (!address) { setBalance(null); setSol(null); setUsdc(null); setSolUsd(null); setStale(false); return; }
    /* Every 15 s while the page is in view; while it is hidden (another tab, a locked phone) once a minute, and at
       once on coming back (night review 2026-10-29, third pass: a tab left open all day was most of what balances
       cost the server's read budget). */
    let live = true, last = 0;
    const tick = (now) => {
      if (!now && document.hidden && Date.now() - last < 60000) return;
      last = Date.now();
      fetchBalances(address).then((b) => { if (live) applyBalances(b); });
    };
    tick(true);
    const id = setInterval(() => tick(false), 15000);
    const onShow = () => { if (!document.hidden && Date.now() - last > 5000) tick(true); };
    document.addEventListener('visibilitychange', onShow);
    return () => { live = false; clearInterval(id); document.removeEventListener('visibilitychange', onShow); };
  }, [address]);

  const [swapCfg, setSwapCfg] = useState(null);
  const [walletFunding, setWalletFunding] = useState(false);
  useEffect(() => {
    let live = true, timer = null;
    const ask = () => walletFundingOn().then((on) => {
      if (!live) return;
      if (on === null) timer = setTimeout(ask, 61000);   // unreadable: privyConfig() asks again after a minute
      else setWalletFunding(on);
    });
    ask();
    return () => { live = false; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    let live = true, timer = null;
    const load = () => moneyConfig().then((c) => {
      if (!live) return;
      if (!c.mode) { timer = setTimeout(load, 5000); return; }   // unreadable: ask again, never guess
      setMode(c.mode);
      setUnit(c.unit || '');
      if (c.swap) setSwapCfg({ solReserve: c.solReserve, minConvertSol: c.minConvertSol, minWithdrawSolUsd: c.minWithdrawSolUsd });
    }).catch(() => {});
    load();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    // external: signed in with a browser wallet (walletName 'Phantom', ...), not the email and Google wallet
    window.duelWallet = { ready, authenticated, address, balance, unit, sol, swap: swapCfg, mode, usdc, solUsd, stale,
                          external: isExternal, walletName: extWallet ? extWallet.name : null,
                          // a Google/email player's linked browser wallet ({ address, name, here }), and what could be linked
                          linked: linked ? { address: linked.address, name: linked.name, here: !!linkedStd,
                                             icon: (linkedStd && linkedStd.icon) || ((WALLETS.find((k) => k.client === linked.clientType) || {}).icon) || '' } : null,
                          linkable,
                          // Privy's Add funds sheet has Transfer from wallet (the dashboard's funding methods)
                          walletFunding };
    window.dispatchEvent(new CustomEvent('duelwallet:change', { detail: window.duelWallet }));
  }, [ready, authenticated, address, balance, unit, sol, swapCfg, mode, usdc, solUsd, stale, isExternal, extWallet, linkedKey, linkableKey, walletFunding]);

  // Hide the widget while the game iframe covers the screen; re-show on return to lobby.
  useEffect(() => {
    const onMsg = (e) => {
      if (e && e.data === 'game:done') {
        if (restakeRef.current) restakeRef.current.onGameDone(); // the lobby clears the frames now
        setPlaying(false); setBusy(false); setStatus('');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Follow the lobby's selected tier.
  useEffect(() => {
    const onChange = (e) => setTier((e && e.detail) || 'free');
    window.addEventListener('duel:lobbychange', onChange);
    return () => window.removeEventListener('duel:lobbychange', onChange);
  }, []);

  // Phase 4a: the lobby's main Play button routes paid self-custody play here.
  useEffect(() => {
    const onPlay = (e) => {
      const d = (e && e.detail) || {};
      const game = (d && typeof d === 'object') ? (d.game || 'snake') : 'snake';
      /* A stake on the event wins. With no stake, the room is the lobbyType the
         event names, and nothing else: there is no default room any more. This
         used to fall back to the old ten cent tier, so an event naming no room
         quoted and minted a real $0.10 entry for a room the player did not pick
         (BACKLOG 2.1 retired that tier). An unnamed room now reaches stakeOnly
         with no lobbyType and is refused there, before any quote or wallet
         prompt. */
      const sel = (d && typeof d === 'object' && d.stake !== undefined && d.stake !== null)
        ? { stake: d.stake }
        : { lobbyType: (d && typeof d === 'object') ? d.lobbyType : d };
      // The engine rides with the rung it was picked for, snake only (engineOf decides the rest).
      if (game === 'snake' && sel.stake !== undefined && d.engine === 'sl') sel.engine = 'sl';
      if (stakeRef.current) stakeRef.current(game, sel);
    };
    window.addEventListener('duel:play', onPlay);
    return () => window.removeEventListener('duel:play', onPlay);
  }, []);

  // In-game "Play again": the game iframe asks us to re-stake (duel:restake); we run the wallet
  // approval and post the fresh entry token back so it can respawn without a trip to the lobby.
  // The bridge (restakeBridge.mjs) answers only the document that asked: a page the lobby
  // cleared while the wallet was open gets no token posted into a blank frame. Gone before the
  // money moved, nothing is submitted; gone after, the round that was paid for opens instead.
  // Made once, so an outstanding request survives re-renders; the latest wallet via refs.
  const walletRef = useRef(null);
  walletRef.current = wallet;
  const signRef = useRef(null);
  signRef.current = signTx;
  const restakeRef = useRef(null);
  if (!restakeRef.current) {
    const frameFor = (game) => document.getElementById(game === 'agar' ? 'agar-frame' : 'game-frame');
    restakeRef.current = createRestakeBridge({
      origin: window.location.origin,
      frames: frameFor,
      stake: async (req, hooks) => {
        const w = walletRef.current;
        if (!w) throw new Error('Wallet not ready. Return to the lobby.');
        // agar.io's Play again names its rung, like Paper's; a tier name stakes nothing.
        refuseAgarTier(req.game, req.sel);
        // An /sl page's Play again (engine 'sl') is staked on this origin and answered in that page; if the page
        // went after the money moved, relaunch below opens /sl again through launchStaked, never /game.html.
        const route = stakeRoute(req.game, pageRegion(), engineOf(req.game, req.sel));
        let staked;
        try {
          staked = await stakeOnly(req.sel, w, signRef.current, () => {}, route.base, hooks);
        } catch (e) {
          // The game's card shows this line under Play again: plain words, same error object.
          if (e && /not confirmed in time/i.test(e.message || '')) e.message = errCopy(e.message).line + ' Press Play again to try once more.';
          throw e;
        }
        // Return focus to the game after the wallet modal so keyboard works without a click.
        const f = frameFor(req.game);
        const focusGame = () => { try { f && f.contentWindow && f.contentWindow.focus(); } catch (_) {} };
        focusGame(); setTimeout(focusGame, 150);
        return Object.assign({}, staked, { region: route.region });
      },
      relaunch: (req, staked) => {
        const f = frameFor(req.game);
        const w = walletRef.current;
        if (busyRef.current || !w || !f || f.style.display === 'block') return false;
        launchStaked(req.game, req.sel, staked, w, () => setPlaying(true));
        return true;
      },
      log: (m) => console.warn('[restake] ' + m),
    });
  }
  useEffect(() => {
    const onMsg = (e) => { restakeRef.current.onMessage(e); };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Expose wallet actions for the lobby's wallet card (Phase 4d: the card is the wallet UI).
  useEffect(() => {
    /* A token straight from Privy at the moment it is needed. The localStorage copy
       below is a cache for pages that cannot await anything (the game iframes); a
       lobby action should not fail just because that cache is empty or stale. */
    window.duelWalletToken = async () => {
      let access = null;
      try { access = await getAccessToken(); } catch (_) {}
      if (!access) { try { access = localStorage.getItem('duel_admin_token'); } catch (_) {} }
      let identity = identityToken;
      if (!identity) { try { identity = localStorage.getItem('duel_id_token'); } catch (_) {} }
      return { access, identity };
    };
    /* Proof that this wallet asked for this name, needing nothing from Privy's
       servers at the moment it is used. The string must match the server's
       nameMessage() byte for byte. */
    window.duelWalletSignName = async (name) => {
      if (!wallet || !address) return null;
      // A browser wallet would show a popup for this, even when the lobby syncs a saved name on its own: the server
      // takes the Privy token for a name instead (play.js pushName), which names this same wallet.
      if (wallet.external) return null;
      const ts = Date.now();
      const msg = 'DuelSeries: change display name\n'
                + 'wallet: ' + address + '\n'
                + 'name: ' + name + '\n'
                + 'at: ' + ts;
      const { signature } = await signMsg({
        message: new TextEncoder().encode(msg),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return { wallet: address, ts, sig: bs58.encode(signature) };
    };
    /* Signs an OWNER action. Same mechanism as the name change and the same
       reason: it needs nothing from Privy at the moment it is used, so owner
       controls cannot be locked out by an app id, a rate limit or an outage.
       The string must match server/ownerAuth.js actionMessage() byte for byte. */
    window.duelWalletSignAction = async (action, args) => {
      if (!wallet || !address) return null;
      /* A browser wallet signs play:identify and skins:pass with its device key (deviceKey.mjs), never a popup on a
         game join; with no key yet, no proof (the round plays, paid rounds still count). Anything else it signs
         itself, with its own approval. */
      if (wallet.external && DEVICE_ACTIONS.includes(action)) {
        let d = loadDeviceKey(localStorage, address);
        /* No key yet: a game join (play:identify, a player's own act) asks for it, once, so the round counts and an
           event prize can pay (a Battle Royale pays only proven wallets). A skin pass never asks on its own. Refused
           in the last hour: not asked again yet. */
        let no = 0;
        try { no = Number(localStorage.getItem('duel.devkey.no.' + address)) || 0; } catch (_) {}
        if (!d && action === 'play:identify' && wallet.std && Date.now() - no > 60 * 60 * 1000) {
          if (await deviceKeyFor(wallet.std, address, null)) d = loadDeviceKey(localStorage, address);
        }
        return signWithDeviceKey(d, action, args);
      }
      // What a page asks on its own and only an owner can use (the owner's wallet is never a browser wallet): no popup.
      if (wallet.external && (action === 'clips:queue' || action === 'owner:alerts')) return null;
      const ts = Date.now();
      const a = args || {};
      const msg = 'DuelSeries owner action\n'
                + 'action: ' + action + '\n'
                + 'args: ' + JSON.stringify(a) + '\n'
                + 'wallet: ' + address + '\n'
                + 'at: ' + ts;
      const { signature } = await signMsg({
        message: new TextEncoder().encode(msg),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return { action, args: a, wallet: address, ts, sig: bs58.encode(signature) };
    };
    window.duelWalletLogin = signIn;
    /* Sign out. A browser wallet's device key goes too (a shared computer keeps no way to play as it), and the
       extension is told this page is done with it. */
    window.duelWalletLogout = () => {
      if (wallet && wallet.external) {
        forgetDeviceKey(localStorage, address);
        try { const d = wallet.std && wallet.std.features['standard:disconnect']; if (d) d.disconnect(); } catch (_) {}
      }
      return logout();
    };
    // Asked for after a game, a send or a top-up landed: a fresh read, never one shared from before it
    window.duelWalletRefresh = async () => {
      if (!address) return null;
      const b = await fetchBalances(address, { fresh: true });
      applyBalances(b);
      return b.balance;
    };
    /* Send out of the wallet. USDC mode: amount is USDC. SOL mode: amount is SOL by default, or USDC when
       asset is 'usdc' (old USDC still in the wallet). A SOL-mode send is checked against a FRESH balance
       first and never leaves the wallet holding between 0 and 0.001 SOL after the amount and the fee.
       A balance that cannot be read fresh just now no longer stops it (night review 2026-10-29, third pass): the
       send goes ahead unchecked and the chain refuses one the wallet cannot cover (freshSol). */
    window.duelWalletSend = async (amount, toAddress, asset) => {
      if (!wallet) return Promise.reject(new Error('Wallet not ready — try again in a moment.'));
      const cfg = await moneyConfig();
      /* The amount's unit is the sheet's, so the sheet must say which it drew: a sheet drawn before the mode was
         known (no asset) is never sent as SOL, and a SOL sheet never as USDC dollars (Fable review 2026-10-21). */
      const CHANGED = 'The money settings changed while this was open. Close it and try again.';
      if (cfg.mode === 'usdc') {
        if (asset === 'sol') throw new Error(CHANGED);
        return sendUsdc(toAddress, amount, cfg.usdcMint, cfg.decimals, wallet, signTx);
      }
      if (cfg.mode !== 'sol') throw new Error('Could not read the money settings. Try again in a moment.');
      if (asset !== 'sol' && asset !== 'usdc') throw new Error(CHANGED);
      const have = await freshSol(wallet.address);
      const haveLamports = have == null ? null : Math.round(have * 1e9);
      if (asset === 'usdc') {
        // The fee, and the receiver's USDC account rent when it has none (the sender pays it), and the reserve after
        if (haveLamports != null && !leavesReserve(haveLamports, USDC_ACCOUNT_RENT, SEND_FEE_LAMPORTS)) throw new Error(SOL_SEND_LOW);
        return sendUsdc(toAddress, amount, cfg.usdcMint, cfg.decimals, wallet, signTx);
      }
      const lamports = Math.round(Number(amount) * 1e9);
      if (!(lamports > 0)) throw new Error('Enter an amount to send.');
      if (haveLamports != null) {
        if (haveLamports < lamports + SEND_FEE_LAMPORTS) throw new Error('That is more SOL than your wallet has after the network fee.');
        if (!leavesReserve(haveLamports, lamports, SEND_FEE_LAMPORTS)) throw new Error(SOL_SEND_LOW);
      }
      return sendSol(toAddress, amount, wallet, signTx);
    };
    /* Add funds: Privy's own funding sheet, "Add funds to your DuelSeries wallet", with Pay with
       card and Receive funds (Owen, 2026-10-15, like playpulp.io). The asset is SOL because MoonPay
       sells SOL to Canada and does not sell USDC on Solana there ("Coming soon to your region");
       the SOL then becomes USDC with one tap on the Wallet tab (swapQuote / swapRun). Receive
       funds shows this same address, which takes SOL and USDC alike. Which rows the sheet shows
       is the Privy dashboard's (Onramps: MoonPay on, SVM); the amount is MoonPay's starting
       figure in SOL, its minimum for a Canadian card (cardStartSol, server/index.js), and the
       player changes it there in their own currency. */
    /* method: 'card' opens straight on Pay with card, 'manual' on Receive funds (the lobby's own Add funds sheet
       when a browser wallet is there to link, wallet.js); none opens Privy's sheet with both, as before. */
    window.duelWalletFund = async (method) => {
      if (!address) throw new Error('Connect your wallet first.');
      const cfg = await moneyConfig();
      const solMode = cfg.mode === 'sol';
      const start = Number(cfg.cardStartSol) > 0 ? Number(cfg.cardStartSol) : 0.156;
      return fundWallet({ address, options: {
        chain: 'solana:mainnet', asset: 'native-currency', amount: String(start),
        ...(method === 'card' || method === 'manual' ? { defaultFundingMethod: method } : {}),
        card: { preferredProvider: 'moonpay' },
        uiConfig: {
          landing: { title: wallet && wallet.external ? 'Add funds to your ' + wallet.name + ' wallet' : 'Add funds to your DuelSeries wallet' },
          receiveFundsTitle: solMode ? 'Receive SOL' : 'Receive SOL or USDC',
          receiveFundsSubtitle: solMode
            ? 'Send SOL on Solana to this address. Your balance shows in dollars on your Wallet tab.'
            : 'Send SOL or USDC on Solana to this address. SOL turns into USDC with one tap on your Wallet tab.',
        },
      } });
    };
    /* A checked price for converting this wallet's SOL to USDC (dir 'toUsdc', amount in
       lamports; USDC mode only), its USDC to SOL paid to an outside address (dir 'toSol', amount in
       USDC units, receiver), or its old USDC to SOL in the same wallet (dir 'usdcToSol', amount in
       USDC units, no receiver; SOL mode only). Resolves the quote; nothing is signed. */
    window.duelWalletSwapQuote = (dir, amount, receiver) => {
      if (!address) return Promise.reject(new Error('Connect your wallet first.'));
      return swapQuote(address, dir, amount, receiver);
    };
    /* Signs and sends a quote the player has just confirmed. Resolves { ok, signature, inAmount,
       outAmount }, then reads the balances again. */
    window.duelWalletSwapRun = async (q) => {
      if (!wallet) throw new Error('Wallet not ready — try again in a moment.');
      const r = await swapRun(q && q.requestId, wallet, signTx);
      fetchBalances(wallet.address, { fresh: true }).then(applyBalances).catch(() => {});
      return r;
    };
    /* SOL mode: a checked price for turning ALL the old USDC in this wallet into SOL (dir 'usdcToSol', amount
       in USDC units, no receiver). The amount is read fresh here, so it is the whole balance as it is now.
       Resolves the quote; nothing is signed (duelWalletSwapRun does that, from the player's tap). */
    window.duelWalletUsdcToSolQuote = async () => {
      if (!address) throw new Error('Connect your wallet first.');
      const b = await fetchBalances(address, { fresh: true });
      const units = b.usdc == null || b.stale ? 0 : Math.round(b.usdc * 1e6);
      if (!(units > 0)) throw new Error('There is no USDC to convert.');
      return swapQuote(address, 'usdcToSol', units);
    };
    // Signs a skin's payment from the server's quote; resolves the signed bytes (base64). Sends nothing.
    window.duelWalletSignSkin = (quote) => {
      if (!wallet) return Promise.reject(new Error('Connect your wallet first.'));
      return signSkinPayment(quote, wallet, signTx);
    };

    /* -- A linked browser wallet (Google and email players only; linkedWallet.mjs) -- */
    const notLinkable = () => (!address || isExternal ? 'Sign in with Google or email to link a wallet.' : null);
    /* Link one of the installed three ('phantom' | 'solflare' | 'backpack'): its connect, then one signature that
       Privy keeps on the account. Resolves { address, name }. */
    window.duelWalletLink = async (id) => {
      const no = notLinkable(); if (no) throw new Error(no);
      const k = WALLETS.find((x) => x.id === id);
      const std = k && detected.find((d) => k.names.includes(String(d.name || '').trim().toLowerCase()));
      if (!std) throw new Error((k ? k.label : 'That wallet') + ' is not installed in this browser.');
      const addr = await inTime(linkWith(std, { generateSiwsMessage: (a) => linkRef.current.generateSiwsMessage(a),
        linkWithSiws: (a) => linkRef.current.linkWithSiws(a), gameAddress: address }), 120000, std.name + ' did not answer. Open it and try again.');
      try { if (window.DSTrack) window.DSTrack.event('wallet_linked', { wallet_app: k.label }); } catch (_) {}
      return { address: addr, name: k.label };
    };
    // Forget the linked wallet on the account. Its money stays where it is; nothing moves.
    window.duelWalletUnlink = async () => {
      if (!linked) throw new Error('No wallet is linked.');
      await unlinkWallet(linked.address);
      return true;
    };
    // The linked wallet's SOL right now, read by the server like any balance, and the most one add may carry. A balance
    // that cannot be read fresh just now is unknown (the lobby still lets the add go ahead: the add checks again).
    window.duelWalletLinkedBalance = async () => {
      if (!linked) throw new Error('No wallet is linked.');
      const b = await fetchBalances(linked.address, { fresh: true });
      if (b.sol == null || b.stale) throw new Error('Could not read ' + linked.name + '\'s balance.');
      const lamports = Math.round(b.sol * 1e9);
      return { sol: b.sol, lamports, max: maxAddLamports(lamports) };
    };
    /* Add funds from the linked wallet: exactly `lamports` from it to this game wallet, one approval in it, sent and
       confirmed by the server like a withdraw. Checked against a FRESH balance first: the linked wallet keeps
       0.001 SOL. Resolves { sig, lamports } once confirmed, then reads this wallet's balance again. A balance that
       cannot be read fresh just now does not stop it (night review 2026-10-29, third pass): the linked wallet shows
       what it can send when it asks for approval, and the chain refuses an overdraw (addProblem, freshSol). */
    window.duelWalletAddFromLinked = async (lamports, opts) => {
      const no = notLinkable(); if (no) throw new Error(no);
      if (!linked) throw new Error('Link a wallet first.');
      if (!linkedStd) throw new Error(linked.name + ' is not in this browser. Open DuelSeries where ' + linked.name + ' is installed.');
      const n = Number(lamports);
      const have = await freshSol(linked.address);
      const why = addProblem(have == null ? null : Math.round(have * 1e9), n);
      if (why) throw new Error(why);
      const { blockhash } = await (await fetch('/api/blockhash')).json();
      const bytes = buildAdd({ from: linked.address, to: address, lamports: n, blockhash });
      const { signedTransaction } = await signTransactionWith(linkedStd, linked.address, bytes);
      try { if (opts && typeof opts.onSigned === 'function') opts.onSigned(); } catch (_) {}
      const r = await (await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTx: Buffer.from(signedTransaction).toString('base64'), kind: 'add' }) })).json();
      if (!r.ok) throw new Error(r.error || 'The transfer did not go through. Check both balances before trying again.');
      fetchBalances(address, { fresh: true }).then(applyBalances).catch(() => {});
      return { sig: r.sig, lamports: n };
    };
  }, [wallet, signTx, signMsg, address, login, logout, fundWallet, identityToken, getAccessToken,
      isExternal, linkedKey, linkableKey, detected, unlinkWallet]);

  // Keep the Privy access token in localStorage so same-origin admin pages + game iframes can
  // authenticate owner-only actions (the server verifies it → OWNER_WALLET). Refreshed on a timer.
  useEffect(() => {
    if (!authenticated) {
      try { localStorage.removeItem('duel_admin_token'); localStorage.removeItem('duel_id_token'); } catch (_) {}
      return;
    }
    let live = true;
    const refresh = async () => {
      try { const t = await getAccessToken(); if (live && t) localStorage.setItem('duel_admin_token', t); } catch (_) {}
      try { if (live && identityToken) localStorage.setItem('duel_id_token', identityToken); } catch (_) {}
    };
    refresh();
    const id = setInterval(refresh, 5 * 60 * 1000);
    return () => { live = false; clearInterval(id); };
  }, [authenticated, identityToken]);

  const doStake = async (game, sel) => {
    if (busyRef.current) return; // already staking — drop the rapid re-clicks (no double charge)
    if (!wallet) { setErr('Wallet still loading — try again in a moment.'); return; }
    busyRef.current = true;
    setWhat({ game, stake: Number(stakeSpec(sel).stake) });
    setBusy(true); setErr(''); setStatus('');
    try {
      await stakeAndPlay(game, sel, wallet, signTx, setStatus, () => setPlaying(true));
    } catch (e) {
      const m = (e && e.message) || 'Stake failed';
      setErr(/insufficient funds|\brent\b|TokenAccountNotFound|could not find account/i.test(m)
        ? (mode === 'sol'
            ? SOL_LOW_MSG
            : `Not enough funds — your wallet needs ${unit} for the entry plus a little SOL for network fees.`)
        : m);
      setBusy(false); setStatus('');
    } finally {
      busyRef.current = false;
    }
  };
  stakeRef.current = doStake; // keep the latest closure for the lobby's duel:play event

  // While a stake is in flight, a full-screen blocking card (DSDialog) gives feedback AND covers
  // the Play button so extra clicks can't fire more stakes. On error, a card with OK. The widget
  // itself draws nothing (the lobby card is the wallet UI).
  useEffect(() => {
    const D = window.DSDialog;
    if (!D) return;
    if (!playing && busy) {
      dialogOwned.current = true;
      D.busy(busyCopy(what, status));
    } else if (!playing && err) {
      dialogOwned.current = true;
      D.alert(errCopy(err, what)).then(() => setErr(''));
    } else if (dialogOwned.current) {
      dialogOwned.current = false;
      D.close();
    }
  }, [busy, status, err, playing, what]);
  return null;
}

// swim: SwimSim.NAME (shared/swimSim.js) when the lobby has loaded it, so a rename there reaches this too.
const GAME_NAMES = { snake: 'Slither', agar: 'agar.io', paper: 'Paper.io', knockout: 'Knockout', battleship: 'Battleship',
  get swim() { return (typeof window !== 'undefined' && window.SwimSim && window.SwimSim.NAME) || 'Swim'; },
  headsoccer: 'Head Soccer', pool8: '8 Ball Pool', rooftop: 'Rooftop Snipers', crossy: 'Crossy Road', airhockey: 'Air Hockey' };
const money = (n) => (Number.isFinite(n) && n > 0 ? '$' + n.toFixed(2) + ' ' : '');

/* The popup's words for each step stakeAndPlay reports (onStatus). */
function busyCopy(what, status) {
  const name = what && GAME_NAMES[what.game];
  const amt = money(what && what.stake);
  const line = {
    'Getting quote…': 'Getting the entry price',
    'Building stake…': `Preparing your ${amt}entry`,
    'Confirm in your wallet…': 'Approving in your wallet',
    'Submitting stake…': `Sending your ${amt}entry`,
    'Joining…': 'Entry confirmed, loading the game',
  }[status] || 'Getting ready';
  return { title: name ? `Joining ${name}` : 'Joining', line };
}

/* An error as a title and a plain line. Messages come from the server and the chain helpers, some
   with a spaced dash; that becomes a full stop here. */
function errCopy(m, what) {
  const amt = money(what && what.stake).trim();
  if (/^Add a little SOL/.test(m)) {
    return { title: 'Add a little SOL', line: `Your wallet needs ${amt ? 'about ' + amt + ' in SOL' : 'the entry'} plus 0.001 SOL left over for network fees.` };
  }
  if (/^Not enough funds/.test(m)) {
    return { title: 'Not enough in your wallet', line: `You need ${amt || 'the entry'} plus a little SOL for network fees.` };
  }
  if (/not confirmed in time/i.test(m)) {
    return { title: "Entry didn't go through", line: "The network didn't confirm it in time. If it lands later it's refunded to your wallet automatically." };
  }
  const line = String(m).replace(/\s+[—–]\s+(\w)/g, (_, c) => '. ' + c.toUpperCase()).replace(/…/g, '.');
  return { title: "Entry didn't go through", line };
}

const st = {
  box: { position: 'fixed', bottom: 14, right: 14, zIndex: 99999, width: 240, padding: '12px 14px', background: 'rgba(10,14,26,0.92)', border: '1px solid #1c2a44', borderRadius: 12, color: '#cfe3ff', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 8px 28px rgba(0,0,0,0.4)' },
  title: { fontWeight: 700, marginBottom: 8, fontSize: 12, letterSpacing: '0.3px', color: '#9fb6d6' },
  beta: { fontSize: 9, color: '#08210f', background: '#14F195', padding: '1px 5px', borderRadius: 6, marginLeft: 6, fontWeight: 800, verticalAlign: 'middle' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0' },
  muted: { color: '#7e93b4' },
  mono: { fontFamily: 'ui-monospace, monospace', color: '#eaf2ff' },
  btn: { width: '100%', padding: '8px 10px', background: '#14F195', color: '#08210f', border: 0, borderRadius: 8, fontWeight: 700, cursor: 'pointer' },
  link: { marginTop: 8, background: 'none', border: 0, color: '#7e93b4', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },
  hint: { marginTop: 8, fontSize: 11, color: '#e0b65a' },
  err: { marginTop: 8, fontSize: 11, color: '#ff7a7a', wordBreak: 'break-word' },
  bal: { fontSize: 26, fontWeight: 800, color: '#eaf2ff', margin: '2px 0 6px', letterSpacing: '0.5px' },
  balUnit: { fontSize: 13, fontWeight: 700, color: '#7e93b4' },
  actions: { display: 'flex', gap: 8, marginTop: 10 },
  btnSm: { flex: 1, padding: '9px 6px', background: 'rgba(20,241,149,0.12)', color: '#14F195', border: '1px solid #14F195', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  addr: { fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#eaf2ff', background: '#0a0e1a', border: '1px solid #1c2a44', borderRadius: 8, padding: '8px', margin: '8px 0', wordBreak: 'break-all' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', margin: '6px 0', background: '#0a0e1a', border: '1px solid #1c2a44', borderRadius: 8, color: '#eaf2ff', fontSize: 13 },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(6,9,18,0.82)' },
  card: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(12,17,30,0.97)', border: '1px solid #1c2a44', borderRadius: 16, color: '#eaf2ff', font: '15px/1.45 system-ui, sans-serif', minWidth: 200, maxWidth: 340, textAlign: 'center', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' },
  spinner: { width: 34, height: 34, borderRadius: '50%', border: '3px solid #1c2a44', borderTopColor: '#14F195', animation: 'duelspin 0.8s linear infinite' },
  ovText: { fontWeight: 600, color: '#cfe3ff', wordBreak: 'break-word' },
};

function App() {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        // Privy's own sign-in, wallets included (Owen 2026-10-26: a known third party's sign-in reads as safe)
        loginMethods: ['google', 'email', 'wallet'],
        // showWalletUIs:false → sign the stake / cash-out silently (no Privy approve + "all set"
        // screens). The Join Game / Cash Out Send click is the confirmation; one tap into the game.
        // Wallets are made by the widget (walletSetup.mjs), not Privy's on-login screen, which can
        // stall for good on "Creating your wallet" when its wallet frame loads late.
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: false },
        // Solana wallets only, and only these three (no EVM wallets). Signing after sign-in still goes through the
        // browser wallet itself (browserWallets.mjs), always the signed-in account.
        appearance: {
          theme: 'dark',
          accentColor: '#f0a830',
          logo: '/img/signin-logo.webp',
          walletChainType: 'solana-only',
          walletList: ['phantom', 'solflare', 'backpack'],
          showWalletLoginFirst: false,
        },
        legal: { termsAndConditionsUrl: '/terms.html', privacyPolicyUrl: '/privacy.html' },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc(RPC_HTTP),
              rpcSubscriptions: createSolanaRpcSubscriptions(RPC_WSS),
            },
          },
        },
      }}
    >
      <WalletPanel />
    </PrivyProvider>
  );
}

/* Before Privy is made, so the fetch its client keeps is this one (holdCoinbase.mjs: the Coinbase
   row stays out of the Add funds sheet while Coinbase caps this app at about US$5 a buy). */
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = holdBackCoinbase(globalThis.fetch.bind(globalThis), APP_ID,
    () => moneyConfig().then((c) => !!(c && c.coinbaseOnramp)).catch(() => false));
}

const mount = document.getElementById('wallet-root');
if (mount) createRoot(mount).render(<App />);
console.log('[wallet-widget] v2 (stake-on-join) loaded');
