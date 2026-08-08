import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord } from '../models/index.js';

let baseUrl;
let server;
const cookies = new Map();
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const storeCookies = (res) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
};
const request = async (method, path, form) => {
  const headers = {};
  if (cookies.size) headers.cookie = cookieHeader();
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
  storeCookies(res);
  return { status: res.status, text: await res.text() };
};

before(async () => {
  // Dedicated DB so this suite never collides with the other test files.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_leaderboard_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server.close();
});

// Runs first, while the database is still empty.
test('both leaderboards render an empty state before any game is logged', async () => {
  for (const path of ['/leaderboard', '/deckLeaderboard']) {
    const res = await request('GET', path);
    assert.equal(res.status, 200);
    assert.match(res.text, /No games have been logged yet/);
    assert.doesNotMatch(res.text, /leader-card/);
  }
});

test('the player leaderboard renders a card grid with a gold top rank', async () => {
  await request('POST', '/register', { username_input: 'Champ', password_input: 'hunter2hunter' });
  await request('POST', '/decks', { name: 'Azorius Control', format: 'Modern' });
  const deck = await Deck.findOne({ name: 'Azorius Control' });
  const user = deck.owner;
  await GameRecord.create([
    { user, deck: deck._id, opponents: [{ name: 'Ana', deck: 'Burn' }], result: 'win' },
    { user, deck: deck._id, opponents: [{ name: 'Ben', deck: 'Tron' }], result: 'win' },
    { user, deck: deck._id, opponents: [{ name: 'Cal', deck: 'Tron' }], result: 'loss' },
  ]);

  const res = await request('GET', '/leaderboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /leaderboard-grid/);
  assert.match(res.text, /leader-card--gold/);
  assert.match(res.text, /Champ/);
  assert.doesNotMatch(res.text, /No games have been logged yet/);
});

test('the deck leaderboard renders a card grid naming the deck and its owner', async () => {
  const res = await request('GET', '/deckLeaderboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /leaderboard-grid/);
  assert.match(res.text, /leader-card--gold/);
  assert.match(res.text, /Azorius Control/);
  assert.match(res.text, /Champ/); // owner
});

test('the meter bar width is the win share of total games', async () => {
  const res = await request('GET', '/leaderboard');
  // 2 wins of 3 games -> 67%
  assert.match(res.text, /leader-card__meter-fill[^>]*width:\s*67%/);
});
