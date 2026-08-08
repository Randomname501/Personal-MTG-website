import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percent, eq, formatDate, formatOpponents } from '../lib/viewHelpers.js';

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

test('formatOpponents lists each opponent as "Name (Deck)"', () => {
  const list = [
    { name: 'Ana', deck: 'Krenko' },
    { name: 'Ben', deck: 'Yuriko' },
  ];
  assert.equal(formatOpponents(list), 'Ana (Krenko), Ben (Yuriko)');
});

test('formatOpponents renders a nameless opponent as the deck alone', () => {
  // This is how a legacy record arrives, and it must read exactly as it did
  // before opponents had names.
  assert.equal(formatOpponents([{ name: '', deck: 'Storm' }]), 'Storm');
});

test('formatOpponents renders an em dash for an empty or missing list', () => {
  assert.equal(formatOpponents([]), '—');
  assert.equal(formatOpponents(undefined), '—');
});
