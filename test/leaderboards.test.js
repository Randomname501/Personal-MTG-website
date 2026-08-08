import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankRows } from '../lib/leaderboards.js';

// rankRows is the one place both leaderboards attach display fields, so these
// are pure unit tests over plain rows — no database needed.

test('rankRows tiers the top three and leaves the rest untiered', () => {
  const rows = rankRows([
    { username: 'a', wins: 5, losses: 0, draws: 0 },
    { username: 'b', wins: 4, losses: 0, draws: 0 },
    { username: 'c', wins: 3, losses: 0, draws: 0 },
    { username: 'd', wins: 2, losses: 0, draws: 0 },
  ]);

  assert.deepEqual(
    rows.map((r) => [r.rank, r.tier]),
    [
      [1, 'gold'],
      [2, 'silver'],
      [3, 'bronze'],
      [4, ''],
    ]
  );
});

test('rankRows totals wins, losses and draws for the meter bar', () => {
  const [row] = rankRows([{ username: 'a', wins: 3, losses: 2, draws: 1 }]);
  assert.equal(row.total, 6);
});

test('rankRows treats a missing draws count as zero', () => {
  const [row] = rankRows([{ username: 'a', wins: 3, losses: 2 }]);
  assert.equal(row.total, 5);
});

test('rankRows sorts by wins, then ratio, then fewer losses', () => {
  const rows = rankRows([
    { username: 'fewer-wins', wins: 1, losses: 0, draws: 0 },
    { username: 'more-losses', wins: 4, losses: 4, draws: 0 },
    { username: 'better-ratio', wins: 4, losses: 1, draws: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.username), ['better-ratio', 'more-losses', 'fewer-wins']);
});

test('rankRows formats the win/loss ratio, including the no-game and no-loss cases', () => {
  const rows = rankRows([
    { username: 'undefeated', wins: 3, losses: 0, draws: 0 },
    { username: 'even', wins: 2, losses: 4, draws: 0 },
    { username: 'drawn-only', wins: 0, losses: 0, draws: 2 },
  ]);
  const ratios = Object.fromEntries(rows.map((r) => [r.username, r.winLossRatio]));
  assert.equal(ratios.undefeated, '∞');
  assert.equal(ratios.even, '0.50');
  assert.equal(ratios['drawn-only'], '—');
});
