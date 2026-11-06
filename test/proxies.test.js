import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

const CARD = {
  id: 'abc-123',
  name: 'Counterspell',
  mana_cost: '{U}{U}',
  cmc: 2,
  colors: ['U'],
  type_line: 'Instant',
  image_uris: { normal: 'http://img/counterspell.jpg' },
};

let baseUrl;
let server;
let scryfall;

const makeClient = () => {
  let cookie = '';
  return async (method, path, form) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(baseUrl + path, { method, headers, body: form && new URLSearchParams(form).toString(), redirect: 'manual' });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
};

let users = 0;
const newUser = async () => {
  const request = makeClient();
  await request('POST', '/register', { username_input: `Proxier${(users += 1)}`, password_input: 'hunter2hunter' });
  return request;
};

// A deck holding `quantity` copies of the card.
let decks = 0;
const newDeck = async (request, quantity = 3) => {
  const name = `Proxy Deck ${(decks += 1)}`;
  await request('POST', '/decks', { name, format: 'Modern' });
  const deck = await Deck.findOne({ name });
  for (let i = 0; i < quantity; i += 1) await request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  return deck;
};

const setProxies = (request, deck, proxies) =>
  request('POST', `/decks/${deck._id}/cards/abc-123/proxies`, { proxies });
const storedCard = async (deck) => (await Deck.findById(deck._id)).cards[0];

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_proxies_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();

  scryfall = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/cards/abc-123') return res.end(JSON.stringify(CARD));
    if (req.url.startsWith('/cards/collection')) {
      req.resume();
      return req.on('end', () => res.end(JSON.stringify({ data: [CARD], not_found: [] })));
    }
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
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => scryfall.close(resolve));
});

test('the owner sets how many copies are proxies and can clear it', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  const res = await setProxies(user, deck, '2');
  assert.equal(res.location, `/decks/${deck._id}`);
  assert.equal((await storedCard(deck)).proxies, 2);
  await setProxies(user, deck, '0');
  assert.equal((await storedCard(deck)).proxies, 0);
});

test('a proxy count outside 0 to the quantity is refused and changes nothing', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await setProxies(user, deck, '1');
  for (const bad of ['4', '-1', '1.5', 'many']) {
    const res = await setProxies(user, deck, bad);
    assert.equal(res.status, 400, bad);
    assert.match(res.text, /between 0 and 3/, bad);
  }
  assert.equal((await storedCard(deck)).proxies, 1);
});

test('the card page offers the proxy count, capped at the quantity', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await setProxies(user, deck, '2');
  const { text } = await user('GET', `/decks/${deck._id}/cards/abc-123/note`);
  assert.match(text, /name="proxies"[^>]*max="3"[^>]*value="2"/);
});

test('the owner sees the proxy marker on the deck and manager pages', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  assert.ok(!(await user('GET', `/decks/${deck._id}`)).text.includes('cardlist__proxy'));
  await setProxies(user, deck, '2');
  for (const path of [`/decks/${deck._id}`, `/decks/${deck._id}/cards`]) {
    assert.match((await user('GET', path)).text, /title="Proxies: 2">2P</, path);
  }
});

test('other players neither see nor change proxies', async () => {
  const owner = await newUser();
  const other = await newUser();
  const deck = await newDeck(owner);
  await setProxies(owner, deck, '2');
  const page = await other('GET', `/decks/${deck._id}`);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('cardlist__proxy'));
  assert.equal((await setProxies(other, deck, '0')).status, 404);
  assert.equal((await storedCard(deck)).proxies, 2);
});

test('removing copies never leaves more proxies than copies', async () => {
  const user = await newUser();
  const deck = await newDeck(user, 2);
  await setProxies(user, deck, '2');
  await user('POST', `/decks/${deck._id}/cards/abc-123/remove`);
  const card = await storedCard(deck);
  assert.equal(card.quantity, 1);
  assert.equal(card.proxies, 1);
});

test('adding a copy keeps the proxy count', async () => {
  const user = await newUser();
  const deck = await newDeck(user, 1);
  await setProxies(user, deck, '1');
  await user('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  const card = await storedCard(deck);
  assert.equal(card.quantity, 2);
  assert.equal(card.proxies, 1);
});

test('an import adds up proxies across printings and keeps their note', async () => {
  const user = await newUser();
  const deck = await newDeck(user, 0);
  const printing = (scryfallId, fields) => ({ scryfallId, name: 'Counterspell', quantity: 1, ...fields });
  await Deck.updateOne({ _id: deck._id }, {
    cards: [printing('old-1', { proxies: 1, note: 'Keep me' }), printing('old-2', { proxies: 1 })],
  });
  await user('POST', `/decks/${deck._id}/import`, { decklist: '2 Counterspell' });
  const card = await storedCard(deck);
  assert.equal(card.proxies, 2);
  assert.equal(card.note, 'Keep me');
});

test('moving a card onto a board that has it adds up the proxies', async () => {
  const user = await newUser();
  const deck = await newDeck(user, 2);
  await setProxies(user, deck, '1');
  await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'considering' });
  await user('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  await setProxies(user, deck, '1');
  await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'cards' });
  const card = await storedCard(deck);
  assert.equal(card.quantity, 3);
  assert.equal(card.proxies, 2);
});

test('an import keeps proxy counts, capped at the new quantity', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await setProxies(user, deck, '3');
  await user('POST', `/decks/${deck._id}/import`, { decklist: '2 Counterspell' });
  const card = await storedCard(deck);
  assert.equal(card.quantity, 2);
  assert.equal(card.proxies, 2);
});
