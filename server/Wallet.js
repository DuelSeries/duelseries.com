const {
  Connection, PublicKey, Keypair,
  Transaction, SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const RPC_URL = process.env.RPC_URL || (
  NETWORK === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com'
);

const connection = new Connection(RPC_URL, 'confirmed');

function getEscrowKeypair() {
  const b64 = process.env.ESCROW_PRIVATE_KEY;
  if (!b64) throw new Error('ESCROW_PRIVATE_KEY not set');
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

function getEscrowPublicKey() {
  return process.env.ESCROW_PUBLIC_KEY || getEscrowKeypair().publicKey.toString();
}

// In-memory cache of used sigs — DB is the source of truth
const usedSignatures = new Set();
let db = null;
function setDb(dbModule) { db = dbModule; }

// On startup, mark all existing escrow transactions as seen so old
// deposits aren't re-credited after a database reset or server restart.
async function seedUsedSignatures() {
  try {
    const escrow = new PublicKey(getEscrowPublicKey());
    const sigs = await withRetry(() =>
      connection.getSignaturesForAddress(escrow, { limit: 100 })
    );
    for (const s of sigs) usedSignatures.add(s.signature);
    console.log(`[WALLET] Seeded ${sigs.length} existing signatures`);
  } catch (e) {
    console.error('[WALLET] Seed failed:', e.message);
  }
}

// Retry wrapper for rate-limited RPC calls
async function withRetry(fn, retries = 4, delay = 1500) {
  try {
    return await fn();
  } catch (e) {
    const is429 = e.message && (e.message.includes('429') || e.message.includes('Too many'));
    if (retries > 0 && is429) {
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw e;
  }
}

// Find the most recent unclaimed deposit to the escrow
// Returns { amount, fromAddress } or null if none found
async function findLatestDeposit() {
  const escrowPubkey = getEscrowPublicKey();
  const escrow = new PublicKey(escrowPubkey);

  console.log(`[WALLET] Checking escrow ${escrowPubkey} for deposits...`);

  const sigs = await withRetry(() =>
    connection.getSignaturesForAddress(escrow, { limit: 25 })
  );

  console.log(`[WALLET] Found ${sigs.length} recent sigs, ${usedSignatures.size} already used`);

  for (const sigInfo of sigs) {
    // Check in-memory cache first, then DB
    if (usedSignatures.has(sigInfo.signature)) continue;
    if (db && await db.isTxUsed(sigInfo.signature)) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }
    if (sigInfo.err) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }

    let tx;
    try {
      tx = await withRetry(() =>
        connection.getTransaction(sigInfo.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
      );
    } catch (e) {
      console.error(`[WALLET] getTransaction failed for ${sigInfo.signature.slice(0,8)}: ${e.message}`);
      continue;
    }

    if (!tx) {
      console.log(`[WALLET] tx not found yet: ${sigInfo.signature.slice(0,8)}`);
      continue;
    }
    if (tx.meta.err) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }

    const accountKeys = tx.transaction.message.staticAccountKeys ||
      tx.transaction.message.accountKeys;
    const escrowIndex = accountKeys.findIndex(k => k.toString() === escrowPubkey);

    if (escrowIndex === -1) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }

    const lamports = tx.meta.postBalances[escrowIndex] - tx.meta.preBalances[escrowIndex];
    if (lamports <= 0) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }

    usedSignatures.add(sigInfo.signature);
    const fromAddress = accountKeys[0].toString();
    console.log(`[WALLET] Deposit found: ${lamports / LAMPORTS_PER_SOL} SOL from ${fromAddress.slice(0,8)}`);
    return { amount: lamports / LAMPORTS_PER_SOL, fromAddress, sig: sigInfo.signature };
  }

  console.log(`[WALLET] No new deposits found`);
  return null;
}

// Find all unprocessed deposits to a specific address (per-user Privy wallet)
async function findDepositsForAddress(address) {
  const pubkey = new PublicKey(address);
  const sigs = await withRetry(() =>
    connection.getSignaturesForAddress(pubkey, { limit: 25 })
  );

  const deposits = [];
  for (const sigInfo of sigs) {
    if (usedSignatures.has(sigInfo.signature)) continue;
    if (db && await db.isTxUsed(sigInfo.signature)) {
      usedSignatures.add(sigInfo.signature);
      continue;
    }
    if (sigInfo.err) { usedSignatures.add(sigInfo.signature); continue; }

    let tx;
    try {
      tx = await withRetry(() =>
        connection.getTransaction(sigInfo.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
      );
    } catch (e) {
      console.error(`[WALLET] getTransaction failed for ${sigInfo.signature.slice(0,8)}: ${e.message}`);
      continue;
    }

    if (!tx || tx.meta.err) { usedSignatures.add(sigInfo.signature); continue; }

    const accountKeys = tx.transaction.message.staticAccountKeys ||
      tx.transaction.message.accountKeys;
    const idx = accountKeys.findIndex(k => k.toString() === address);
    if (idx === -1) { usedSignatures.add(sigInfo.signature); continue; }

    const lamports = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
    if (lamports <= 0) { usedSignatures.add(sigInfo.signature); continue; }

    usedSignatures.add(sigInfo.signature);
    deposits.push({
      amount: lamports / LAMPORTS_PER_SOL,
      fromAddress: accountKeys[0].toString(),
      sig: sigInfo.signature,
    });
  }

  return deposits;
}

// Send SOL from escrow to a user wallet
async function withdraw(toAddress, amountSol) {
  const escrow = getEscrowKeypair();
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Ensure escrow keeps enough for rent-exempt minimum + tx fee
  const [escrowBalance, rentMin] = await Promise.all([
    connection.getBalance(escrow.publicKey),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  const feeBuffer = 10000; // ~0.00001 SOL for tx fee
  const maxWithdrawable = escrowBalance - rentMin - feeBuffer;

  if (maxWithdrawable <= 0) throw new Error('Escrow has insufficient funds');
  if (lamports > maxWithdrawable) {
    throw new Error(
      `Amount too large. Max withdrawable: ${(maxWithdrawable / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrow.publicKey,
      toPubkey,
      lamports,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = escrow.publicKey;
  tx.sign(escrow);

  const signature = await withRetry(() => connection.sendRawTransaction(tx.serialize()));
  await withRetry(() => connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }));
  return signature;
}

// Sweep all SOL from a user's Privy server wallet into the escrow.
// Called after a deposit is credited so the escrow stays funded for withdrawals.
async function sweepFromPrivyWallet(privyWalletAddress, privyWalletId) {
  const PRIVY_APP_ID     = process.env.PRIVY_APP_ID;
  const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) throw new Error('Privy not configured');

  const pubkey = new PublicKey(privyWalletAddress);
  const balance = await withRetry(() => connection.getBalance(pubkey));
  const FEE_BUFFER = 10000; // lamports reserved for tx fee (~0.00001 SOL)
  const sweepLamports = balance - FEE_BUFFER;
  if (sweepLamports <= 0) return null;

  const escrowAddress = getEscrowPublicKey();
  const { blockhash } = await withRetry(() => connection.getLatestBlockhash());
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: pubkey,
      toPubkey: new PublicKey(escrowAddress),
      lamports: sweepLamports,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = pubkey;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

  const creds = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  const res = await fetch(`https://api.privy.io/v2/server-wallets/${privyWalletId}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'privy-app-id': PRIVY_APP_ID,
      'Authorization': `Basic ${creds}`,
    },
    body: JSON.stringify({
      method: 'signAndSendTransaction',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpK',
      params: { transaction: serialized, encoding: 'base64' },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Privy sweep ${res.status}: ${err}`);
  }
  const data = await res.json();
  const sig = data?.data?.hash || data?.hash;
  console.log(`[WALLET] Swept ${sweepLamports / LAMPORTS_PER_SOL} SOL from ${privyWalletAddress.slice(0,8)}... sig: ${sig?.slice(0,12) || 'unknown'}`);
  return sig;
}

async function getEscrowBalance() {
  const bal = await connection.getBalance(new PublicKey(getEscrowPublicKey()));
  return bal / LAMPORTS_PER_SOL;
}

async function getRecentSigs() {
  const escrow = new PublicKey(getEscrowPublicKey());
  const sigs = await withRetry(() =>
    connection.getSignaturesForAddress(escrow, { limit: 10 })
  );
  return sigs.map(s => ({
    sig: s.signature.slice(0, 16) + '...',
    err: s.err,
    blockTime: s.blockTime,
    used: usedSignatures.has(s.signature),
  }));
}

module.exports = { getEscrowPublicKey, findLatestDeposit, findDepositsForAddress, sweepFromPrivyWallet, getRecentSigs, withdraw, getEscrowBalance, NETWORK, setDb, seedUsedSignatures };
