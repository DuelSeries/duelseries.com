'use strict';
// The law table of the LOCAL soak (task T15, scripts/slSoak.js; SL_DEV_LAWS points here). Never loaded by product
// code, and refused wherever it could be the live server (server/sl/slBoot.js loadSlLaws: NODE_ENV production, an
// ESCROW_PRIVATE_KEY or a DATABASE_URL).
//
// It is the shipped table (server/sl/slLaws.js LAWS) with three changes, each written in the row it changes:
//   C_ROOM_CAP, C_HUMAN_CAP   the load test sets them (SERVER-DESIGN 14.2 item 5), and the load test is not part of
//                             this run. The soak runs at the daily curve's peak (BOT_MAX 101, shared/constants.js:317;
//                             OWNER-ANSWERS.md:71), so both caps are that peak here: the room holds the most snakes the
//                             curve ever asks for. Since 2026-10-11 the shipped table holds the same 101 (CHOSEN by
//                             Owen until the load test, OWNER-ANSWERS.md:136-139), so only the source text changes.
//   the five SUGGESTED prey rows (server/sl/slPrey.js PREY_ROWS: L33.spont, L33.wander, L33.motion, L33.extra,
//                             L32.remove) as APPROVED rows with their suggested values: Owen approved prey "as
//                             measured" (OWNER-ANSWERS.md:85) and every open law with its suggested value on
//                             2026-10-10, so the soak runs prey as it will ship. Since the fixer pass of 2026-10-10
//                             the shipped table carries all nine prey rows (APPROVED), so this loop adds nothing.
// Every other row, value and status is the shipped one.

const { ENTRIES, STATUS, tableFrom } = require('../server/sl/slLaws');
const { PREY_ROWS, PREY_ROW_IDS } = require('../server/sl/slPrey');
const C = require('../shared/constants');

const SOAK_PEAK = C.BOT_MAX; // 101: the daily curve's peak (server/botPopulation.js botTarget clamps to it)
const APPROVED_AT = '2026-10-10';

const CAP_SOURCE = 'SOAK ONLY (scripts/slSoakLaws.js): the daily curve peak BOT_MAX ' + SOAK_PEAK +
  ' (shared/constants.js:317, OWNER-ANSWERS.md:71); the real value comes from the T15 load test (SERVER-DESIGN 14.2)';

function soakEntries() {
  const out = [];
  for (const e of ENTRIES) {
    if (e.id === 'C_ROOM_CAP' || e.id === 'C_HUMAN_CAP') {
      out.push(Object.assign({}, e, { status: STATUS.CHOSEN, value: SOAK_PEAK, source: CAP_SOURCE }));
    } else {
      out.push(e);
    }
  }
  const have = new Set(out.map((e) => e.id));
  for (const id of PREY_ROW_IDS) {
    const r = PREY_ROWS[id];
    if (have.has(id)) continue;
    if (r.status !== STATUS.SUGGESTED) {
      out.push({ id, name: r.name, status: r.status, value: r.value, unit: r.unit, source: r.source });
      continue;
    }
    out.push({
      id,
      name: r.name,
      status: STATUS.APPROVED,
      value: r.value,
      unit: r.unit,
      source: 'APPROVED by Owen ' + APPROVED_AT + ' (OWNER-ANSWERS.md:85 Q8 prey: as measured; every open law with ' +
        'its suggested value); SOAK ONLY copy of slPrey PREY_ROWS: ' + r.source,
      approvedAt: APPROVED_AT,
    });
  }
  return out;
}

const LAWS = tableFrom(soakEntries());

module.exports = { LAWS, SOAK_PEAK, APPROVED_AT };
