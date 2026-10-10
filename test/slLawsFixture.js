'use strict';
// FIXTURE law table for the slither.io server tests (SERVER-DESIGN 4.1, task T1). TEST ONLY: no file under server/,
// shared/, public/ or scripts/ may import this (test/slLaws.test.js scans for it).
//
// Every row of the real table (server/sl/slLaws.js) with status FIXTURE and the same value, so tests run the real
// numbers as literal vectors, while a FIXTURE table can never pass assertShippable. The rows that have no value yet
// (C_ROOM_CAP and C_HUMAN_CAP wait for the T15 load test) get fixed test numbers here, labelled as such.

const { LAWS, STATUS, tableFrom } = require('../server/sl/slLaws');

const TEST_ONLY = {
  C_ROOM_CAP: { value: 200, why: 'test number; the real cap comes from the T15 load test' },
  C_HUMAN_CAP: { value: 200, why: 'test number; the real cap comes from the T15 load test' },
};

function fixtureEntries(patch) {
  const p = patch || {};
  for (const id of Object.keys(p)) {
    if (!Object.prototype.hasOwnProperty.call(LAWS, id)) throw new Error('slLawsFixture: unknown id ' + id);
  }
  return Object.keys(LAWS).map((id) => {
    const e = LAWS[id];
    let value = e.value;
    let source = 'FIXTURE (test only): copy of the real row; ' + e.source;
    if (Object.prototype.hasOwnProperty.call(TEST_ONLY, id)) {
      value = TEST_ONLY[id].value;
      source = 'FIXTURE (test only): ' + TEST_ONLY[id].why;
    }
    if (Object.prototype.hasOwnProperty.call(p, id)) {
      value = p[id];
      source = 'FIXTURE (test only): patched by a test';
    }
    return { id, name: e.name, status: STATUS.FIXTURE, value, unit: e.unit, source };
  });
}

// A FIXTURE table with some values replaced ({ id: value }).
function makeFixture(patch) {
  return tableFrom(fixtureEntries(patch), { allowFixture: true });
}

const FIXTURE = makeFixture();

module.exports = { FIXTURE, LAWS: FIXTURE, TEST_ONLY, makeFixture };
