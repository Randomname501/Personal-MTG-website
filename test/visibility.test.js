import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { canSeeDeck, visibleDeckFilter } from '../lib/visibility.js';

const A = new mongoose.Types.ObjectId();
const B = new mongoose.Types.ObjectId();
const C = new mongoose.Types.ObjectId();

test('canSeeDeck: public or missing visibility is visible to anyone, including logged out', () => {
  assert.equal(canSeeDeck({ owner: A }, undefined), true);
  assert.equal(canSeeDeck({ owner: A, visibility: 'public' }, { _id: B }), true);
});
test('canSeeDeck: friends decks need friendship, private decks need ownership', () => {
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, { _id: B, friends: [A] }), true);
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, { _id: C, friends: [] }), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, undefined), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'private' }, { _id: B, friends: [A] }), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'private' }, { _id: A }), true);
});
test('canSeeDeck accepts a populated owner', () => {
  assert.equal(canSeeDeck({ owner: { _id: A }, visibility: 'private' }, { _id: A }), true);
});
test('visibleDeckFilter for a logged-out viewer only admits public or missing visibility', () => {
  assert.deepEqual(visibleDeckFilter(undefined), { visibility: { $in: ['public', null] } });
});
test('visibleDeckFilter for a viewer adds own and friends decks', () => {
  const f = visibleDeckFilter({ _id: A, friends: [B] });
  assert.deepEqual(f, {
    $or: [
      { owner: A },
      { visibility: { $in: ['public', null] } },
      { visibility: 'friends', owner: { $in: [B] } },
    ],
  });
});
