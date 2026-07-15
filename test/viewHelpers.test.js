import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percent, eq, formatDate } from '../lib/viewHelpers.js';

test('percent is integer part-of-whole, 0 when whole is 0', () => {
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(5, 0), 0);
});

test('eq string-compares its two arguments', () => {
  assert.equal(eq('a', 'a'), true);
  assert.equal(eq(1, '1'), true); // ObjectId vs string form
  assert.equal(eq('a', 'b'), false);
});

test('formatDate renders a friendly date, empty for missing/invalid', () => {
  assert.equal(formatDate(new Date('2026-07-14T12:00:00Z')), 'Jul 14, 2026');
  assert.equal(formatDate(undefined), '');
  assert.equal(formatDate('not-a-date'), '');
});
