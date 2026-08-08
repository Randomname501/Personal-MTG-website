import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

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
    // Build params manually: URLSearchParams(form) would stringify an array
    // value as a single comma-joined string instead of repeated keys, which
    // doesn't match how a real <select multiple>/checkbox group posts.
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, v);
      } else {
        params.append(key, value);
      }
    }
    body = params.toString();
  }
  const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
};

before(async () => {
  // Dedicated DB so this suite never collides with the other test files.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_routes_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  // Register a user, add a deck, and log 3 games (2-1 -> 67% win rate).
  await request('POST', '/register', { username_input: 'Stats', password_input: 'hunter2hunter' });
  await request('POST', '/decks', { name: 'Azorius Control', format: 'Modern', colors: ['W', 'U'] });
  const deck = await Deck.findOne({ name: 'Azorius Control' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), 'opponents[0][name]': 'Ana', 'opponents[0][deck]': 'Burn', result: 'win' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), 'opponents[0][name]': 'Ana', 'opponents[0][deck]': 'Burn', result: 'loss' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), 'opponents[0][name]': 'Ben', 'opponents[0][deck]': 'Tron', result: 'win' });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('dashboard shows the overall stats summary', async () => {
  const res = await request('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Your Stats/);
  assert.match(res.text, /67%/); // 2 wins of 3 games
});

test('deck detail page shows record, matchups, and header', async () => {
  const deck = await Deck.findOne({ name: 'Azorius Control' });
  const res = await request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Azorius Control/);
  assert.match(res.text, /67% win rate/);
  assert.match(res.text, /Burn/); // a matchup row
  assert.match(res.text, /Modern.*&middot;\s*W\s*U/s); // header includes color identity
});

test('deck detail 404s for a missing deck', async () => {
  const res = await request('GET', '/decks/64b000000000000000000000');
  assert.equal(res.status, 404);
});

test('deck detail 404s for a malformed id', async () => {
  const res = await request('GET', '/decks/not-an-id');
  assert.equal(res.status, 404);
});
