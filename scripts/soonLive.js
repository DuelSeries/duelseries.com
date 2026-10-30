'use strict';
/* A Coming soon switch file with every game Live (server/comingSoon.js), for local runs and test servers. With no
   file the server boots with agar.io and Battleship Coming soon, which is production's default (Owen 2026-10-30),
   not what a local run or a test of those games wants. A run about the switch itself passes its own
   COMING_SOON_PATH. -> the path of a fresh file in its own temp folder */
const fs = require('fs');
const os = require('os');
const path = require('path');

function soonLiveFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soon-live-')), 'coming-soon.json');
  fs.writeFileSync(file, JSON.stringify({ soon: { agar: false, battleship: false } }) + '\n');
  return file;
}

module.exports = { soonLiveFile };
