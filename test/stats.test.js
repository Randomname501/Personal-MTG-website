import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRatePercent, isoWeekKey } from '../lib/stats.js';

test('winRatePercent rounds wins over total games', () => {
  assert.equal(winRatePercent(2, 1, 0), 67); // 2/3 = 66.6 -> 67
  assert.equal(winRatePercent(12, 6, 1), 63); // 12/19 = 63.15 -> 63
});

test('winRatePercent returns 0 for no games (no divide-by-zero)', () => {
  assert.equal(winRatePercent(0, 0, 0), 0);
});

test('isoWeekKey formats a date as ISO year-week', () => {
  // 2026-07-08 falls in ISO week 28; 2026-07-15 in week 29.
  assert.equal(isoWeekKey(new Date('2026-07-08T12:00:00Z')), '2026-W28');
  assert.equal(isoWeekKey(new Date('2026-07-15T12:00:00Z')), '2026-W29');
});
