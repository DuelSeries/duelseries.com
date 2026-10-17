'use strict';
// The owner's paid-room bot counts (Owen 2026-10-16), one small JSON file per game beside the money journal
// (server/data, gitignored, kept by the deploy), so a deploy or restart keeps his bots. Counts only: no money is ever
// in this file, and a bot never holds money (each game's paid bot rule).
//   load() -> { '<rung>': n } or null when there is no file; save(obj) -> true, or false when it was not written.
// The write is atomic (a temp file, then rename), so a crash mid-write leaves the old counts, never half a file.

const fs = require('fs');
const path = require('path');

function createBotStore({ file, fsx = fs, log = console } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('paidBotStore: a file is required');
  return {
    file,
    load() {
      let text;
      try {
        text = fsx.readFileSync(file, 'utf8');
      } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw e;
      }
      const obj = JSON.parse(text);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      const out = {};
      for (const [k, v] of Object.entries(obj)) if (Number.isInteger(v) && v >= 0) out[k] = v;
      return out;
    },
    save(obj) {
      try {
        fsx.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fsx.writeFileSync(tmp, JSON.stringify(obj || {}) + '\n');
        fsx.renameSync(tmp, file);
        return true;
      } catch (e) {
        log.error('[BOTS] paid bot counts not saved (' + file + '): ' + (e && e.message));
        return false;
      }
    },
  };
}

module.exports = { createBotStore };
