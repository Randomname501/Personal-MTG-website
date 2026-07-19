import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, User } from '../models/index.js';

// A client is one isolated cookie jar + request helper, so we can drive the app
// as two different logged-in users (and an anonymous one) in the same file.
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
let bob;

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_social_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  alice = makeClient();
  bob = makeClient();
  await alice.request('POST', '/register', { username_input: 'Alice', password_input: 'hunter2hunter' });
  await bob.request('POST', '/register', { username_input: 'Bob', password_input: 'hunter2hunter' });
  await alice.request('POST', '/decks', { name: 'AliceDeck', format: 'Modern', colors: ['W'] });
  await bob.request('POST', '/decks', { name: 'BobDeck', format: 'Legacy', colors: ['U'] });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('Alice can track Bob\'s deck, idempotently', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' }); // again
  const a = await User.findOne({ username: 'Alice' });
  const matches = a.trackedDecks.filter((id) => id.toString() === bobDeck._id.toString());
  assert.equal(matches.length, 1);
});

test('Alice cannot track her own deck', async () => {
  const aliceDeck = await Deck.findOne({ name: 'AliceDeck' });
  await alice.request('POST', `/decks/${aliceDeck._id}/track`, { back: '/decks' });
  const a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === aliceDeck._id.toString()));
});

test('untracking removes the deck and is a safe no-op when repeated', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' });
  let a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === bobDeck._id.toString()));
  const res = await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' }); // again
  assert.equal(res.status, 302);
  a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === bobDeck._id.toString()));
});

test('deck page shows Track for a non-owner, Untrack once tracked, and neither for the owner', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' }); // ensure not tracked

  let page = await alice.request('GET', `/decks/${bobDeck._id}`);
  assert.match(page.text, /\/track/); // Track form action present
  assert.doesNotMatch(page.text, /\/untrack/);

  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: `/decks/${bobDeck._id}` });
  page = await alice.request('GET', `/decks/${bobDeck._id}`);
  assert.match(page.text, /\/untrack/); // now Untrack

  const ownerPage = await bob.request('GET', `/decks/${bobDeck._id}`);
  assert.match(ownerPage.text, /Manage Cards/);
  assert.doesNotMatch(ownerPage.text, /\/track/); // owner sees no track/untrack control
});

test('tracking requires auth', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  const anon = makeClient();
  const res = await anon.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('track rejects a non-local back redirect (no open redirect)', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  const res = await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: 'http://evil.com' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/decks/${bobDeck._id}`); // safe default, not evil.com
});
