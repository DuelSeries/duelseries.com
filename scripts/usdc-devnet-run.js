// Devnet end-to-end USDC test using a PRE-FUNDED wallet (topped up via faucet.solana.com),
// so we don't depend on the rate-limited RPC airdrop. Loads the funder from the OS temp file,
// distributes a little SOL to a fresh escrow + player, mints a 6-decimal test token, then runs
// the real loop through server/Usdc.js: stake -> verifyUsdcStake -> withdrawUsdc -> ATA-create payout.
'use strict';
process.env.SOLANA_NETWORK = 'devnet';
const web3 = require('@solana/web3.js');
const spl  = require('@solana/spl-token');
const fs = require('fs'), os = require('os'), path = require('path');

const conn = new web3.Connection(process.env.RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const SOL = web3.LAMPORTS_PER_SOL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sendSol = (from, toPub, lamports) =>
  web3.sendAndConfirmTransaction(conn, new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: toPub, lamports })), [from]);

(async () => {
  console.log('=== USDC devnet test (pre-funded wallet) ===');
  const funder = web3.Keypair.fromSecretKey(Buffer.from(fs.readFileSync(path.join(os.tmpdir(), 'devnet-funder.b64'), 'utf8').trim(), 'base64'));
  const bal = await conn.getBalance(funder.publicKey);
  console.log('funder:', funder.publicKey.toString(), '| balance:', bal / SOL, 'SOL');
  if (bal < 0.3 * SOL) throw new Error('funder SOL too low — top it up at faucet.solana.com first');

  const escrow = web3.Keypair.generate();
  const player = web3.Keypair.generate();
  console.log('distributing SOL to escrow + player...');
  await sendSol(funder, escrow.publicKey, 0.1 * SOL);
  await sendSol(funder, player.publicKey, 0.05 * SOL);

  console.log('creating 6-decimal test mint (stand-in for USDC)...');
  const mint = await spl.createMint(conn, funder, funder.publicKey, null, 6);
  console.log('  test mint:', mint.toString());

  // Point Usdc.js at the test mint + this escrow, THEN require it (config read at load).
  process.env.USDC_MINT = mint.toString();
  process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
  const Usdc = require('../server/Usdc');

  console.log('creating ATAs + minting 10 test-USDC to player...');
  const playerAta = await spl.getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey);
  await spl.getOrCreateAssociatedTokenAccount(conn, funder, mint, escrow.publicKey); // escrow ATA to receive stakes
  await spl.mintTo(conn, funder, mint, playerAta.address, funder, 10_000000n);
  console.log('player USDC:', await Usdc.usdcBalanceOf(player.publicKey.toString()), '| escrow USDC:', await Usdc.escrowUsdcBalance());

  console.log('\n[STAKE] player sends 1 USDC to escrow...');
  const t = Usdc.stakeTargets();
  const stakeSig = await web3.sendAndConfirmTransaction(conn,
    new web3.Transaction().add(spl.createTransferCheckedInstruction(playerAta.address, mint, new web3.PublicKey(t.escrowAta), player.publicKey, 1_000000n, 6)),
    [player]);
  await sleep(1500);
  let v;
  for (let i = 0; i < 6; i++) { try { v = await Usdc.verifyUsdcStake(stakeSig, 0.95); break; } catch (e) { if (/not found|not yet/.test(e.message)) { await sleep(1500); continue; } throw e; } }
  console.log('  verifyUsdcStake ->', v, '(want payer=player, usdc=1)');
  if (!v || Math.abs(v.usdc - 1) > 1e-9 || v.payer !== player.publicKey.toString()) throw new Error('STAKE VERIFY FAILED');
  console.log('  escrow USDC after stake:', await Usdc.escrowUsdcBalance(), '(want 1)');

  console.log('\n[PAYOUT] escrow pays player 0.9 USDC...');
  const paySig = await Usdc.withdrawUsdc(player.publicKey.toString(), 0.9);
  console.log('  sig:', String(paySig).slice(0, 16) + '...');
  await sleep(1500);
  const pBal = await Usdc.usdcBalanceOf(player.publicKey.toString());
  const eBal = await Usdc.escrowUsdcBalance();
  console.log('  player USDC:', pBal, '(want 9.9) | escrow USDC:', eBal, '(want 0.1)');
  if (Math.abs(pBal - 9.9) > 1e-6 || Math.abs(eBal - 0.1) > 1e-6) throw new Error('PAYOUT BALANCES WRONG');

  console.log('\n[PAYOUT->new wallet] escrow pays a brand-new wallet 0.05 USDC (must create its ATA)...');
  const fresh = web3.Keypair.generate();
  await Usdc.withdrawUsdc(fresh.publicKey.toString(), 0.05);
  await sleep(1500);
  const fBal = await Usdc.usdcBalanceOf(fresh.publicKey.toString());
  console.log('  fresh wallet USDC:', fBal, '(want 0.05)');
  if (Math.abs(fBal - 0.05) > 1e-6) throw new Error('ATA-CREATION PAYOUT FAILED');

  console.log('\n✅ USDC devnet loop PASSED: stake verify + payout + ATA-creation payout all correct.');
  process.exit(0);
})().catch(e => { console.error('\n❌ FAILED:', e.message); process.exit(1); });
