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
const ATRAXA = {
  id: 'atraxa-1',
  name: "Atraxa, Praetors' Voice",
  mana_cost: '{G}{W}{U}{B}',
  cmc: 4,
  colors: ['W', 'U', 'B', 'G'],
  type_line: 'Legendary Creature — Phyrexian Angel Horror',
  image_uris: { normal: 'http://img/atraxa.jpg' },
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
    if (u.pathname === '/cards/named') {
      const fuzzy = u.searchParams.get('fuzzy');
      if (fuzzy === 'atraxa') return res.end(JSON.stringify(ATRAXA));
      if (fuzzy === 'explode') { res.statusCode = 500; return res.end(JSON.stringify({ object: 'error' })); }
      res.statusCode = 404;
      return res.end(JSON.stringify({ object: 'error' }));
    }
    if (u.pathname === '/cards/atraxa-1') return res.end(JSON.stringify(ATRAXA));
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

test('creating a deck with a commander name stores the fuzzy-matched art', async () => {
  const ivy = makeClient();
  await ivy.request('POST', '/register', { username_input: 'Ivy', password_input: 'hunter2hunter' });
  const res = await ivy.request('POST', '/decks', { name: 'IvysAtraxa', format: 'Commander', commander: 'atraxa' });
  assert.equal(res.status, 302);
  const deck = await Deck.findOne({ name: 'IvysAtraxa' });
  assert.equal(deck.commander, 'atraxa'); // typed name kept at creation
  assert.equal(deck.commanderImageUrl, 'http://img/atraxa.jpg');
});

test('an unmatched or erroring commander lookup still creates the deck, without art', async () => {
  const jack = makeClient();
  await jack.request('POST', '/register', { username_input: 'Jack', password_input: 'hunter2hunter' });
  await jack.request('POST', '/decks', { name: 'JacksNoMatch', format: 'Commander', commander: 'nomatchxyz' });
  await jack.request('POST', '/decks', { name: 'JacksBoom', format: 'Commander', commander: 'explode' });
  for (const name of ['JacksNoMatch', 'JacksBoom']) {
    const deck = await Deck.findOne({ name });
    assert.ok(deck, `${name} was created`);
    assert.equal(deck.commanderImageUrl, '');
  }
});

test('manager lists deck cards grouped by type with a Remove button per card', async () => {
  const deck = await aliceDeck(); // holds Counterspell (Instant) from earlier tests
  const res = await alice.request('GET', `/decks/${deck._id}/cards`);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="decklist"/);
  assert.match(res.text, /Instants <span>\(2\)<\/span>/);
  assert.match(res.text, new RegExp(`action="/decks/${deck._id}/cards/abc-123/remove"`));
});

test('deck detail groups by mana value with ?group=cmc and falls back to type otherwise', async () => {
  const deck = await aliceDeck(); // Counterspell, cmc 2
  const cmc = await alice.request('GET', `/decks/${deck._id}?group=cmc`);
  assert.match(cmc.text, /<h3>2 <span>\(2\)<\/span><\/h3>/);
  assert.match(cmc.text, /href="\?group=cmc"[^>]*aria-current="true"/);

  for (const qs of ['?group=color', '?group=cmc&group=type', '']) {
    const res = await alice.request('GET', `/decks/${deck._id}${qs}`);
    assert.equal(res.status, 200, qs);
    assert.match(res.text, /<h3>Instants <span>\(2\)<\/span><\/h3>/, qs);
    assert.match(res.text, /href="\?group=type"[^>]*aria-current="true"/, qs);
  }
});

test('a Commander deck with a commander and no cards shows a Commander group and Cards (1)', async () => {
  const kim = makeClient();
  await kim.request('POST', '/register', { username_input: 'Kim', password_input: 'hunter2hunter' });
  await kim.request('POST', '/decks', { name: 'KimsAtraxa', format: 'Commander', commander: 'atraxa' });
  const deck = await Deck.findOne({ name: 'KimsAtraxa' });
  const res = await kim.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Cards \(1\)/);
  assert.match(res.text, /<h3>Commander <span>\(1\)<\/span><\/h3>/);
  assert.match(res.text, /Add some/); // owner hint still shown: deck.cards is empty
});

test('a commander name on a non-Commander deck adds no Commander group or count', async () => {
  const lee = makeClient();
  await lee.request('POST', '/register', { username_input: 'Lee', password_input: 'hunter2hunter' });
  await lee.request('POST', '/decks', { name: 'LeesModern', format: 'Modern', commander: 'atraxa' });
  const deck = await Deck.findOne({ name: 'LeesModern' });
  const res = await lee.request('GET', `/decks/${deck._id}`);
  assert.match(res.text, /Cards \(0\)/);
  assert.doesNotMatch(res.text, /<h3>Commander/);
});

test('Set as commander overwrites name and art from the re-fetched card, keeping q', async () => {
  const max = makeClient();
  await max.request('POST', '/register', { username_input: 'Max', password_input: 'hunter2hunter' });
  await max.request('POST', '/decks', { name: 'MaxsCmdr', format: 'Commander', commander: 'nomatchxyz' });
  const deck = await Deck.findOne({ name: 'MaxsCmdr' });

  const page = await max.request('GET', `/decks/${deck._id}/cards?q=counterspell`);
  assert.match(page.text, /Set as commander/);

  const res = await max.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1', q: 'a&b c' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/decks/${deck._id}/cards?q=a%26b%20c`);

  const updated = await Deck.findOne({ name: 'MaxsCmdr' });
  assert.equal(updated.commander, "Atraxa, Praetors' Voice");
  assert.equal(updated.commanderImageUrl, 'http://img/atraxa.jpg');
  assert.equal(updated.cards.length, 0); // commander is not added to the card list

  const managerPage = await max.request('GET', `/decks/${deck._id}/cards`);
  assert.match(managerPage.text, /class="current-commander"/);
});

test('Set as commander is refused for non-owners, non-Commander decks, and empty ids', async () => {
  const deck = await aliceDeck(); // Alice's Modern deck
  const nia = makeClient();
  await nia.request('POST', '/register', { username_input: 'Nia', password_input: 'hunter2hunter' });
  const denied = await nia.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1' });
  assert.equal(denied.status, 404);

  const page = await alice.request('GET', `/decks/${deck._id}/cards?q=counterspell`);
  assert.doesNotMatch(page.text, /Set as commander/);
  const modern = await alice.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1' });
  assert.equal(modern.status, 302);
  assert.equal((await aliceDeck()).commanderImageUrl, '');

  await nia.request('POST', '/decks', { name: 'NiasCmdr', format: 'Commander' });
  const own = await Deck.findOne({ name: 'NiasCmdr' });
  const empty = await nia.request('POST', `/decks/${own._id}/commander`, { scryfall_id: '' });
  assert.equal(empty.status, 302);
  assert.equal((await Deck.findOne({ name: 'NiasCmdr' })).commander, undefined);
});

export { makeClient, aliceDeck };
