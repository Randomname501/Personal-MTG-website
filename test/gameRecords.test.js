import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord } from '../models/index.js';

// A client is one isolated cookie jar + request helper, so we can drive the app
// as two different logged-in users in the same test file.
const makeClient = () => {
  const cookies = new Map();
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
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
      // Repeated keys for array values (not comma-joined), matching real form posts.
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (Array.isArray(value)) for (const v of value) params.append(key, v);
        else params.append(key, value);
      }
      body = params.toString();
    }
    const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
    store(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return { request };
};

let baseUrl;
let server;
let alice;

// Log a game for a client and return the created GameRecord document.
const logGame = async (client, deckId, opponent, result) => {
  await client.request('POST', '/game-records', {
    deck_id: deckId.toString(),
    opponent_deck: opponent,
    result,
  });
  return GameRecord.findOne({ opponentDeck: opponent }).sort({ createdAt: -1 });
};

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_games_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  alice = makeClient();
  await alice.request('POST', '/register', { username_input: 'Alice', password_input: 'hunter2hunter' });
  await alice.request('POST', '/decks', { name: 'Aggro', format: 'Modern', colors: ['R'] });
  await alice.request('POST', '/decks', { name: 'Control', format: 'Modern', colors: ['U'] });
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const control = await Deck.findOne({ name: 'Control' });
  await logGame(alice, aggro._id, 'Burn', 'win');
  await logGame(alice, aggro._id, 'Tron', 'loss');
  await logGame(alice, control._id, 'Goblins', 'win');
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('match history lists the user\'s games', async () => {
  const res = await alice.request('GET', '/game-records');
  assert.equal(res.status, 200);
  assert.match(res.text, /Match History/);
  assert.match(res.text, /Burn/);
  assert.match(res.text, /Tron/);
  assert.match(res.text, /Goblins/);
});

test('filter by deck shows only that deck\'s games', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const res = await alice.request('GET', `/game-records?deck=${aggro._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Burn/); // Aggro game
  assert.match(res.text, /Tron/); // Aggro game
  assert.doesNotMatch(res.text, /Goblins/); // Control game excluded
});

test('filter by result shows only matching games; invalid result is ignored', async () => {
  const losses = await alice.request('GET', '/game-records?result=loss');
  assert.match(losses.text, /Tron/); // the only loss
  assert.doesNotMatch(losses.text, /Burn/);
  assert.doesNotMatch(losses.text, /Goblins/);

  const bogus = await alice.request('GET', '/game-records?result=bogus');
  assert.match(bogus.text, /Burn/);
  assert.match(bogus.text, /Tron/);
  assert.match(bogus.text, /Goblins/); // unfiltered
});

export { makeClient, logGame };
