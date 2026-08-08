import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opponentList } from '../models/GameRecord.js';

// opponentList is the single place that knows about both the current
// `opponents` array and the legacy `opponentDeck` string. Nothing else in the
// codebase is allowed to branch on which shape a record uses, so these tests
// pin the whole compatibility contract.

test('opponentList returns the opponents array for a current record', () => {
  const record = {
    opponents: [
      { name: 'Ana', deck: 'Krenko' },
      { name: 'Ben', deck: 'Yuriko' },
    ],
  };
  assert.deepEqual(opponentList(record), [
    { name: 'Ana', deck: 'Krenko' },
    { name: 'Ben', deck: 'Yuriko' },
  ]);
});

test('opponentList presents a legacy record as one nameless opponent', () => {
  assert.deepEqual(opponentList({ opponentDeck: 'Storm' }), [{ name: '', deck: 'Storm' }]);
});

test('opponentList trims a legacy deck string', () => {
  assert.deepEqual(opponentList({ opponentDeck: '  Storm  ' }), [{ name: '', deck: 'Storm' }]);
});

test('opponentList prefers opponents when a record somehow has both', () => {
  const record = { opponents: [{ name: 'Ana', deck: 'Krenko' }], opponentDeck: 'Storm' };
  assert.deepEqual(opponentList(record), [{ name: 'Ana', deck: 'Krenko' }]);
});

test('opponentList returns an empty array when there is no opponent data', () => {
  assert.deepEqual(opponentList({}), []);
  assert.deepEqual(opponentList({ opponents: [], opponentDeck: '   ' }), []);
});
