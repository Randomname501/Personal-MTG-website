import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRatePercent, isoWeekKey } from '../lib/stats.js';
import { before, after, beforeEach } from 'node:test';
import mongoose from 'mongoose';
import { connectMongo } from '../config/db.js';
import { User, Deck, GameRecord } from '../models/index.js';
import { getDeckStats } from '../lib/stats.js';

before(async () => {
  // Dedicated DB so this suite never collides with the other test files.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_stats_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Deck.deleteMany({}), GameRecord.deleteMany({})]);
});

// Seed one game. When createdAt is given, save with timestamps disabled so
// Mongoose keeps our date instead of overwriting it with "now".
const seedGame = async (deck, user, opponentDeck, result, createdAt) => {
  const doc = new GameRecord({ user: user._id, deck: deck._id, opponentDeck, result });
  if (createdAt) doc.createdAt = createdAt;
  await doc.save({ timestamps: !createdAt });
  return doc;
};

const makeUserAndDeck = async (deckName = 'Test Deck') => {
  const user = await User.create({ username: `u${Date.now()}${Math.random()}`, passwordHash: 'x' });
  const deck = await Deck.create({ name: deckName, format: 'Modern', owner: user._id });
  return { user, deck };
};

test('getDeckStats returns record and win rate', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'Combo', 'loss');

  const stats = await getDeckStats(deck._id);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.draws, 0);
  assert.equal(stats.total, 3);
  assert.equal(stats.winRate, 67);
});

test('getDeckStats groups matchups case/space-insensitively, sorted by games', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'aggro ', 'loss'); // same opponent, different spelling
  await seedGame(deck, user, 'Combo', 'win');

  const stats = await getDeckStats(deck._id);
  assert.equal(stats.matchups.length, 2);
  assert.equal(stats.matchups[0].opponent, 'Aggro'); // most-games group first
  assert.equal(stats.matchups[0].total, 2);
  assert.equal(stats.matchups[0].wins, 1);
  assert.equal(stats.matchups[0].losses, 1);
  assert.equal(stats.matchups[0].winRate, 50);
  assert.equal(stats.matchups[1].opponent, 'Combo');
  assert.equal(stats.matchups[1].winRate, 100);
});

test('getDeckStats buckets a weekly win-rate trend in chronological order', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'X', 'win', new Date('2026-07-06T12:00:00Z')); // week 28
  await seedGame(deck, user, 'X', 'loss', new Date('2026-07-08T12:00:00Z')); // week 28
  await seedGame(deck, user, 'X', 'win', new Date('2026-07-15T12:00:00Z')); // week 29

  const stats = await getDeckStats(deck._id);
  assert.deepEqual(stats.trend, [
    { week: '2026-W28', games: 2, winRate: 50 },
    { week: '2026-W29', games: 1, winRate: 100 },
  ]);
});

test('getDeckStats handles a deck with no games', async () => {
  const { deck } = await makeUserAndDeck();
  const stats = await getDeckStats(deck._id);
  assert.deepEqual(stats, { wins: 0, losses: 0, draws: 0, total: 0, winRate: 0, matchups: [], trend: [] });
});

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
