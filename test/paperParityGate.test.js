'use strict';
// Solo Paper parity gate (design 4.6, 11): the eleven solo files must stay byte-identical to the
// build that passed the 600/600 golden runs at bffe6d5. Multiplayer code lives in new files only.
// These ids move ONLY in the same commit as a recorded golden re-run.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// From `git ls-tree bffe6d5 -- public/js/paper/ public/paper.html`.
const PINNED = {
  'public/js/paper/paperGeom.js': '70975bb27e5e6cd9a916c79e3cf1866b8c2f5433',
  'public/js/paper/paperTerritory.js': '0ff0e707901a47628a46578d06ac48cdc9053559',
  'public/js/paper/paperBots.js': 'a6d630d32019efcad77fc26e03c2f9dc14cdf53c',
  'public/js/paper/paperUnits.js': '92f1479d38e0c88f4bcd5b3cd06c347946cfe1be',
  'public/js/paper/paperGame.js': '02a280bdc2e4842664ac08ee92f81f1e7020fcad',
  'public/js/paper/paperGameMoves.js': '743a32fb6a28ba319b1393c0a99d011a796973fd',
  'public/js/paper/paperInput.js': 'f38ffa6c84d4e27c14d1e28bff948e6c49e8272f',
  'public/js/paper/paperSkins.js': 'b498fc53e12b06f41a64d4482e82ceaf15543a0f',
  'public/js/paper/paperRender.js': '16086b004ad517861531c7af14eb72cd7843a528',
  'public/js/paper/paperMain.js': '1da7feacd8c1dd89da543c2b26d92cb8afaa4926',
  'public/paper.html': '4aaf8bbd540dc5b14ed63c5217f7efdc1da9fbd8'
};

// git's blob id of the LF-normalised bytes (core.autocrlf=true checks the files out as CRLF).
function blobId(bytes) {
  const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha1').update('blob ' + lf.length + '\0').update(lf).digest('hex');
}

test('the eleven solo Paper files are byte-identical to bffe6d5', () => {
  assert.strictEqual(Object.keys(PINNED).length, 11);
  for (const [file, id] of Object.entries(PINNED)) {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    assert.strictEqual(blobId(bytes), id, file + ' changed: the solo parity gate fails');
  }
});

test('the ten solo modules are exactly the ones in public/js/paper', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, 'public/js/paper')).filter(f => f.endsWith('.js')).sort();
  const pinned = Object.keys(PINNED).filter(f => f.startsWith('public/js/paper/')).map(f => path.basename(f)).sort();
  assert.deepStrictEqual(onDisk, pinned, 'a new solo-level module appeared: multiplayer code goes under public/js/paper/mp/');
});
