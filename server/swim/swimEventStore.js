'use strict';
/* ─── Swim Race: what a restart must not forget ────────────────────────────────
   The last race's podium (the Events tab shows it until the next race, as the
   battle royale's does, server/slBr/brLastPodium.js) and the slot the timer
   last went off for, so a restart inside the start's minute does not run the
   same slot twice. Display and scheduling only: no wallet, nothing that pays.
   One small JSON file, written whole to a temp file and renamed over the old. */
const fs = require('fs');
const path = require('path');

const cleanName = (n) => (typeof n === 'string' ? n.slice(0, 24) : '');

function cleanLast(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.podium)) return null;
  const podium = j.podium.slice(0, 3).map(cleanName).filter(Boolean);
  if (!podium.length) return null;
  return {
    id: typeof j.id === 'string' ? j.id.slice(0, 24) : '',
    at: Number.isFinite(j.at) ? j.at : 0,
    lanes: Number.isInteger(j.lanes) && j.lanes > 0 && j.lanes <= 64 ? j.lanes : 0,
    why: typeof j.why === 'string' ? j.why.slice(0, 16) : '',
    podium,
    winner: cleanName(j.winner) || null,
    people: Number.isInteger(j.people) && j.people >= 0 ? j.people : 0,
  };
}

function createSwimEventStore({ file, fsx = fs, log = console } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createSwimEventStore: file is required');
  let mem = { last: null, slot: null };
  function load() {
    try {
      if (!fsx.existsSync(file)) return mem;
      const j = JSON.parse(fsx.readFileSync(file, 'utf8'));
      mem = { last: cleanLast(j && j.last), slot: j && typeof j.slot === 'string' ? j.slot.slice(0, 20) : null };
    } catch (e) {
      log.warn('[SE] saved state unreadable, starting empty: ' + (e && e.message));
    }
    return mem;
  }
  function save(part) {
    mem = Object.assign({}, mem, part);
    if (part && 'last' in part) mem.last = cleanLast(part.last);
    const tmp = file + '.tmp';
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(tmp, JSON.stringify(mem) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.warn('[SE] state not saved: ' + (e && e.message));
      return false;
    }
  }
  return { load, save, get: () => mem, file };
}

module.exports = { createSwimEventStore, cleanLast };
