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
  await request('POST', '/register', { username_input: `Considerer${(users += 1)}`, password_input: 'hunter2hunter' });
  return request;
};

let decks = 0;
const newDeck = async (request) => {
  const name = `Considering ${(decks += 1)}`;
  await request('POST', '/decks', { name, format: 'Modern' });
  return Deck.findOne({ name });
};

const addTo = (request, deck, board) =>
  request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123', ...(board && { board }) });
const boards = async (deck) => {
  const { cards, considering } = await Deck.findById(deck._id);
  const list = (board) => board.map((c) => [c.name, c.quantity]);
  return { cards: list(cards), considering: list(considering) };
};

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_considering_test';
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

test('a card added to Considering stays out of the deck', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck, 'considering');
  await addTo(user, deck, 'considering');
  assert.deepEqual(await boards(deck), { cards: [], considering: [['Counterspell', 2]] });
});

test('Considering cards do not count toward the deck', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck, 'considering');
  const page = await user('GET', `/decks/${deck._id}`);
  assert.match(page.text, /Cards \(0\)/);
  assert.ok(page.text.includes('<h2>Considering</h2>'));
  assert.ok(page.text.includes('Counterspell'));
});

test('moving a card to Considering and back keeps its quantity and note', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck);
  await addTo(user, deck);
  await user('POST', `/decks/${deck._id}/cards/abc-123/note`, { note: 'Too slow?' });

  const res = await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'considering' });
  assert.equal(res.location, `/decks/${deck._id}/cards`);
  assert.deepEqual(await boards(deck), { cards: [], considering: [['Counterspell', 2]] });

  await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'cards' });
  assert.deepEqual(await boards(deck), { cards: [['Counterspell', 2]], considering: [] });
  assert.equal((await Deck.findById(deck._id)).cards[0].note, 'Too slow?');
});

test('moving a card onto a board that already has it adds the quantities', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck);
  await addTo(user, deck, 'considering');
  await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'cards' });
  assert.deepEqual(await boards(deck), { cards: [['Counterspell', 2]], considering: [] });
});

test('moving a card that is not on the other board changes nothing', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck);
  await user('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'cards' });
  assert.deepEqual(await boards(deck), { cards: [['Counterspell', 1]], considering: [] });
});

test('removing from Considering leaves the same card in the deck alone', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck);
  await addTo(user, deck, 'considering');
  await user('POST', `/decks/${deck._id}/cards/abc-123/remove`, { board: 'considering' });
  assert.deepEqual(await boards(deck), { cards: [['Counterspell', 1]], considering: [] });
});

test('importing a decklist keeps the Considering cards', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck, 'considering');
  await user('POST', `/decks/${deck._id}/import`, { decklist: '4 Counterspell' });
  assert.deepEqual(await boards(deck), { cards: [['Counterspell', 4]], considering: [['Counterspell', 1]] });
});

test('the manager page lists Considering cards with a move to the deck', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  await addTo(user, deck, 'considering');
  const { text } = await user('GET', `/decks/${deck._id}/cards`);
  assert.match(text, /name="to" value="cards"/);
  assert.match(text, /Move to deck/);
  assert.match(text, /name="board" value="considering"/);
});

test('only the owner sees or changes Considering cards', async () => {
  const owner = await newUser();
  const other = await newUser();
  const deck = await newDeck(owner);
  await addTo(owner, deck, 'considering');
  const page = await other('GET', `/decks/${deck._id}`);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('Counterspell'));
  assert.equal((await other('POST', `/decks/${deck._id}/cards/abc-123/move`, { to: 'cards' })).status, 404);
  assert.deepEqual(await boards(deck), { cards: [], considering: [['Counterspell', 1]] });
});
