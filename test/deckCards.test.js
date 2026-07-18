import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

// --- HTTP client factory (per-client cookie jar) ---
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

// --- Fake Scryfall server ---
const CARD = {
  id: 'abc-123',
  name: 'Counterspell',
  mana_cost: '{U}{U}',
  cmc: 2,
  colors: ['U'],
  type_line: 'Instant',
  image_uris: { normal: 'http://img/cs.jpg' },
};

let baseUrl;
let server;
let scryfall;
let alice;

// Look up Alice's deck fresh (tests mutate its cards).
const aliceDeck = () => Deck.findOne({ name: 'Azorius' });

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_cards_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();

  scryfall = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/cards/search') {
      if (u.searchParams.get('q') === 'counterspell') return res.end(JSON.stringify({ data: [CARD] }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ object: 'error' }));
    }
    if (u.pathname === '/cards/abc-123') return res.end(JSON.stringify(CARD));
    res.statusCode = 404;
    res.end(JSON.stringify({ object: 'error' }));
  });
  await new Promise((resolve) => {
    scryfall.listen(0, () => {
      process.env.SCRYFALL_API_BASE = `http://127.0.0.1:${scryfall.address().port}`;
      resolve();
    });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  alice = makeClient();
  await alice.request('POST', '/register', { username_input: 'Alice', password_input: 'hunter2hunter' });
  await alice.request('POST', '/decks', { name: 'Azorius', format: 'Modern', colors: ['W', 'U'] });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => scryfall.close(resolve));
});

test('manager page renders Scryfall search results', async () => {
  const deck = await aliceDeck();
  const res = await alice.request('GET', `/decks/${deck._id}/cards?q=counterspell`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Manage Cards/);
  assert.match(res.text, /Counterspell/);
});

test('a search with no matches shows the no-results state', async () => {
  const deck = await aliceDeck();
  const res = await alice.request('GET', `/decks/${deck._id}/cards?q=nomatchxyz`);
  assert.equal(res.status, 200);
  assert.match(res.text, /No cards found/);
});

test('a non-owner cannot open the manager page', async () => {
  const deck = await aliceDeck();
  const bob = makeClient();
  await bob.request('POST', '/register', { username_input: 'Bob', password_input: 'hunter2hunter' });
  const res = await bob.request('GET', `/decks/${deck._id}/cards`);
  assert.equal(res.status, 404);
});

test('adding a card snapshots it into the deck', async () => {
  const deck = await aliceDeck();
  const res = await alice.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123', q: 'counterspell' });
  assert.equal(res.status, 302);
  assert.match(res.location, /\/cards\?q=counterspell$/);

  const updated = await aliceDeck();
  const card = updated.cards.find((c) => c.scryfallId === 'abc-123');
  assert.ok(card, 'card was added');
  assert.equal(card.name, 'Counterspell');
  assert.equal(card.manaCost, '{U}{U}');
  assert.equal(card.cmc, 2);
  assert.equal(card.typeLine, 'Instant');
  assert.equal(card.quantity, 1);
});

test('adding the same card again increments its quantity', async () => {
  const deck = await aliceDeck();
  await alice.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  const updated = await aliceDeck();
  const card = updated.cards.find((c) => c.scryfallId === 'abc-123');
  assert.equal(card.quantity, 2);
});

test('a non-owner cannot add a card', async () => {
  const deck = await aliceDeck();
  const before = (await aliceDeck()).cards.find((c) => c.scryfallId === 'abc-123').quantity;
  const carol = makeClient();
  await carol.request('POST', '/register', { username_input: 'Carol', password_input: 'hunter2hunter' });
  const res = await carol.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  assert.equal(res.status, 404);

  const updated = await aliceDeck();
  assert.equal(updated.cards.filter((c) => c.scryfallId === 'abc-123').length, 1); // unchanged (qty still one entry)
  assert.equal(updated.cards.find((c) => c.scryfallId === 'abc-123').quantity, before); // quantity unchanged
});

test('removing a card decrements its quantity, then deletes it at zero', async () => {
  // Fresh deck so this test is independent of the add tests' state.
  const dave = makeClient();
  await dave.request('POST', '/register', { username_input: 'Dave', password_input: 'hunter2hunter' });
  await dave.request('POST', '/decks', { name: 'DavesDeck', format: 'Modern', colors: ['U'] });
  const deck = await Deck.findOne({ name: 'DavesDeck' });

  // Add the card twice -> quantity 2.
  await dave.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  await dave.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });

  const dec = await dave.request('POST', `/decks/${deck._id}/cards/abc-123/remove`);
  assert.equal(dec.status, 302);
  let updated = await Deck.findOne({ name: 'DavesDeck' });
  assert.equal(updated.cards.find((c) => c.scryfallId === 'abc-123').quantity, 1);

  await dave.request('POST', `/decks/${deck._id}/cards/abc-123/remove`);
  updated = await Deck.findOne({ name: 'DavesDeck' });
  assert.equal(updated.cards.find((c) => c.scryfallId === 'abc-123'), undefined); // entry gone at 0
});

test('a non-owner cannot remove a card', async () => {
  const deck = await aliceDeck(); // Alice's deck still has the Counterspell from Task 3
  const erin = makeClient();
  await erin.request('POST', '/register', { username_input: 'Erin', password_input: 'hunter2hunter' });
  const res = await erin.request('POST', `/decks/${deck._id}/cards/abc-123/remove`);
  assert.equal(res.status, 404);

  const updated = await aliceDeck();
  assert.ok(updated.cards.find((c) => c.scryfallId === 'abc-123'), 'card untouched');
});

test('deck detail shows the card list and a Manage Cards button for the owner', async () => {
  const deck = await aliceDeck(); // has Counterspell from Task 3
  const res = await alice.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Counterspell/);
  assert.match(res.text, /Manage Cards/);
});

test('deck detail shows the card list but no Manage button to a non-owner', async () => {
  const deck = await aliceDeck();
  const frank = makeClient();
  await frank.request('POST', '/register', { username_input: 'Frank', password_input: 'hunter2hunter' });
  const res = await frank.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Counterspell/); // list is public
  assert.doesNotMatch(res.text, /Manage Cards/); // but the button is owner-only
});

test('adding with no scryfall_id redirects without modifying the deck', async () => {
  const gwen = makeClient();
  await gwen.request('POST', '/register', { username_input: 'Gwen', password_input: 'hunter2hunter' });
  await gwen.request('POST', '/decks', { name: 'GwensDeck', format: 'Modern', colors: ['G'] });
  const deck = await Deck.findOne({ name: 'GwensDeck' });

  const res = await gwen.request('POST', `/decks/${deck._id}/cards`, { q: '' }); // no scryfall_id
  assert.equal(res.status, 302);

  const updated = await Deck.findOne({ name: 'GwensDeck' });
  assert.equal(updated.cards.length, 0);
});

test('removing a card that is not in the deck is a no-op', async () => {
  const hugo = makeClient();
  await hugo.request('POST', '/register', { username_input: 'Hugo', password_input: 'hunter2hunter' });
  await hugo.request('POST', '/decks', { name: 'HugosDeck', format: 'Modern', colors: ['R'] });
  const deck = await Deck.findOne({ name: 'HugosDeck' });

  const res = await hugo.request('POST', `/decks/${deck._id}/cards/does-not-exist/remove`);
  assert.equal(res.status, 302);

  const updated = await Deck.findOne({ name: 'HugosDeck' });
  assert.equal(updated.cards.length, 0);
});

test('deck detail shows the card count (sum of quantities)', async () => {
  const deck = await aliceDeck();
  const res = await alice.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Cards \(2\)/);
});

test('deck detail shows the card breakdown for a deck with cards', async () => {
  const deck = await aliceDeck(); // holds Counterspell (Instant), from earlier tests
  const res = await alice.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Card breakdown/);
  assert.match(res.text, /Mana curve/);
  assert.match(res.text, /Instant/); // Counterspell's primary type
});

export { makeClient, aliceDeck };
