// Devnet end-to-end test of the USDC money layer (server/Usdc.js).
// Mints our OWN 6-decimal test token (so we can hand out free "USDC"), then runs the full loop:
//   create ATAs -> player stakes into escrow -> verifyUsdcStake -> escrow pays out -> check balances.
// Run: SOLANA_NETWORK=devnet node scripts/usdc-devnet-test.js
'use strict';
process.env.SOLANA_NETWORK = 'devnet';
const web3 = require('@solana/web3.js');
const spl  = require('@solana/spl-token');

const conn = new web3.Connection('https://api.devnet.solana.com', 'confirmed');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function airdrop(kp, sol) {
  for (let i = 0; i < 5; i++) {
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, sol * web3.LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
      return;
    } catch (e) { console.log(`  airdrop retry (${e.message.slice(0, 40)})`); await sleep(2000); }
  }
  throw new Error('airdrop failed (devnet faucet rate-limited) — try again in a bit');
}

(async () => {
  console.log('=== USDC devnet test ===');
  const escrow = web3.Keypair.generate();
  const player = web3.Keypair.generate();
  const auth   = web3.Keypair.generate(); // test-token mint authority

  console.log('funding 3 keypairs with devnet SOL (gas/rent)...');
  await airdrop(escrow, 1); await airdrop(player, 1); await airdrop(auth, 1);

  console.log('creating 6-decimal test mint (stand-in for USDC)...');
  const mint = await spl.createMint(conn, auth, auth.publicKey, null, 6);
  console.log('  test mint:', mint.toString());

  // Point the Usdc module at our test mint + this escrow, THEN require it (config is read at load).
  process.env.USDC_MINT = mint.toString();
  process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
  const Usdc = require('../server/Usdc');

  console.log('creating ATAs + minting 10 test-USDC to the player...');
  const playerAta = await spl.getOrCreateAssociatedTokenAccount(conn, player, mint, player.publicKey);
  await spl.getOrCreateAssociatedTokenAccount(conn, escrow, mint, escrow.publicKey); // escrow must have an ATA to receive stakes
  await spl.mintTo(conn, auth, mint, playerAta.address, auth, 10_000000n); // 10.000000 USDC

  console.log('player USDC:', await Usdc.usdcBalanceOf(player.publicKey.toString()), '| escrow USDC:', await Usdc.escrowUsdcBalance());

  // ── STAKE: player transfers 1 USDC into the escrow ATA ──
  console.log('\n[STAKE] player sends 1 USDC to escrow...');
  const t = Usdc.stakeTargets();
  const stakeIx = spl.createTransferCheckedInstruction(playerAta.address, mint, new web3.PublicKey(t.escrowAta), player.publicKey, 1_000000n, 6);
  const stakeTx = new web3.Transaction().add(stakeIx);
  const stakeSig = await web3.sendAndConfirmTransaction(conn, stakeTx, [player]);
  await sleep(1500); // let the tx index for getTransaction

  let v;
  for (let i = 0; i < 6; i++) { try { v = await Usdc.verifyUsdcStake(stakeSig, 0.95); break; } catch (e) { if (/not found|not yet/.test(e.message)) { await sleep(1500); continue; } throw e; } }
  console.log('  verifyUsdcStake ->', v, '(want payer=player, usdc=1)');
  if (!v || Math.abs(v.usdc - 1) > 1e-9 || v.payer !== player.publicKey.toString()) throw new Error('STAKE VERIFY FAILED');
  console.log('  escrow USDC after stake:', await Usdc.escrowUsdcBalance(), '(want 1)');

  // ── PAYOUT: escrow sends 0.9 USDC back to the player ──
  console.log('\n[PAYOUT] escrow pays player 0.9 USDC...');
  const paySig = await Usdc.withdrawUsdc(player.publicKey.toString(), 0.9);
  console.log('  payout sig:', String(paySig).slice(0, 16) + '...');
  await sleep(1500);
  const pBal = await Usdc.usdcBalanceOf(player.publicKey.toString());
  const eBal = await Usdc.escrowUsdcBalance();
  console.log('  player USDC after payout:', pBal, '(want 9.9)');
  console.log('  escrow USDC after payout:', eBal, '(want 0.1)');
  if (Math.abs(pBal - 9.9) > 1e-6 || Math.abs(eBal - 0.1) > 1e-6) throw new Error('PAYOUT BALANCES WRONG');

  // ── PAYOUT to a FRESH wallet (forces escrow to create the recipient ATA) ──
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
