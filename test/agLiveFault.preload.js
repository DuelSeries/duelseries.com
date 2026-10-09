'use strict';
// Test-only preload (test/agPaidJoinSmoke.test.js, node -r): agArenas.boardRows throws, so /api/live's own agar try
// is exercised on the real server. Never loaded by the server itself.
const { AgArenas } = require('../server/ag/agArenas.js');

AgArenas.prototype.boardRows = function () { throw new Error('test fault: agar rows'); };
