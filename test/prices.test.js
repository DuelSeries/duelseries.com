'use strict';
const test = require('node:test');
const assert = require('node:assert');
const prices = require('../server/prices');

test('exposes a positive SOL/CAD rate (falls back when offline)', () => {
  assert.ok(prices.getSolCadRate() > 0);
});

test('cadToSol and solToCad are exact inverses at the current rate', () => {
  const sol = prices.cadToSol(10);
  assert.ok(Math.abs(prices.solToCad(sol) - 10) < 1e-9);
});

test('cadToSol of one rate-unit of CAD equals 1 SOL', () => {
  const rate = prices.getSolCadRate();
  assert.ok(Math.abs(prices.cadToSol(rate) - 1) < 1e-9);
});
