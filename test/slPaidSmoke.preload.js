'use strict';
// Test-only preload (test/slPaidJoinSmoke.test.js, node -r). Never loaded by the server itself. Each part is off unless
// its env var is set:
//   SLP_SMOKE_ESCROW=<USDC>     money.escrowBalance answers this number with no network, so the owner's
//                               /api/admin/solvency computes the live stakes sum on a box with no chain
//   SLP_SMOKE_BOARD_FAULT=1     the paid sl directory's boardRows throws (/api/live's own try: unknown ['slpaid'])
//   SLP_SMOKE_TRIGGER=<dir>     polled every 100 ms: a file 'sigint' there emits SIGINT once (the shutdown settle; the
//                               process lives on, the leaderboard listens too), a file 'crash' throws an uncaught
//                               exception (the crash settle, then the process dies)
const fs = require('fs');
const path = require('path');

if (process.env.SLP_SMOKE_ESCROW) {
  const money = require('../server/money');
  const usdc = Number(process.env.SLP_SMOKE_ESCROW);
  money.escrowBalance = async () => usdc;
}

if (process.env.SLP_SMOKE_BOARD_FAULT === '1') {
  const { SlPaidArenas } = require('../server/slPaid/slPaidArenas');
  SlPaidArenas.prototype.boardRows = function () { throw new Error('test fault: sl paid rows'); };
}

if (process.env.SLP_SMOKE_TRIGGER) {
  const dir = process.env.SLP_SMOKE_TRIGGER;
  let signalled = false;
  const t = setInterval(() => {
    if (!signalled && fs.existsSync(path.join(dir, 'sigint'))) {
      signalled = true;
      process.emit('SIGINT');
    }
    if (fs.existsSync(path.join(dir, 'crash'))) {
      clearInterval(t);
      setImmediate(() => { throw new Error('test crash: slPaidJoinSmoke'); });
    }
  }, 100);
  if (t.unref) t.unref();
}
