import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';
import { groupCards } from '../lib/cardInsights.js';

let baseUrl;
let server;
let cookie = '';

const request = async (method, path, form) => {
  const headers = { cookie };
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(baseUrl + path, { method, headers, body: form && new URLSearchParams(form).toString(), redirect: 'manual' });
  const set = res.headers.getSetCookie()[0];
  if (set) cookie = set.split(';')[0];
  return { status: res.status, text: await res.text() };
};

const card = (name, typeLine, cmc, colors = []) => ({ name, typeLine, cmc, colors, quantity: 1 });
const CARDS = [
  card('Forest', 'Basic Land — Forest', 0),
  card('Sol Ring', 'Artifact', 1),
  card('Opt', 'Instant', 1, ['U']),
  card('Lightning Helix', 'Instant', 2, ['R', 'W']),
  card('Serra Angel', 'Creature — Angel', 5, ['W']),
];
const labels = (groups) => groups.map((g) => g.label);
const names = (groups) => groups.flatMap((g) => g.cards.map((c) => c.name));

// The order these strings first appear in a page.
const orderIn = (text, wanted) => wanted.filter((w) => text.includes(w)).sort((a, b) => text.indexOf(a) - text.indexOf(b));

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_sorting_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  await request('POST', '/register', { username_input: 'Sorter', password_input: 'hunter2hunter' });
  // Created out of name order; lowercase checks that case doesn't split the alphabet.
  for (const name of ['beta', 'Alpha', 'Gamma']) await request('POST', '/decks', { name, format: 'Modern' });
  await Deck.updateOne({ name: 'Alpha' }, { cards: CARDS });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('groupCards name mode is one alphabetical list', () => {
  const groups = groupCards(CARDS, { mode: 'name' });
  assert.deepEqual(labels(groups), ['All cards']);
  assert.deepEqual(names(groups), ['Forest', 'Lightning Helix', 'Opt', 'Serra Angel', 'Sol Ring']);
});

test('groupCards color mode splits by color with lands last', () => {
  const groups = groupCards(CARDS, { mode: 'color' });
  assert.deepEqual(labels(groups), ['White', 'Blue', 'Multicolor', 'Colorless', 'Lands']);
  assert.deepEqual(names(groups), ['Serra Angel', 'Opt', 'Lightning Helix', 'Sol Ring', 'Forest']);
});

test('descending reverses the groups and the cards inside them', () => {
  const groups = groupCards(CARDS, { mode: 'cmc', descending: true });
  assert.deepEqual(labels(groups), ['Lands', '5', '2', '1']);
  assert.deepEqual(names(groups), ['Forest', 'Serra Angel', 'Lightning Helix', 'Sol Ring', 'Opt']);
  assert.deepEqual(names(groupCards(CARDS, { mode: 'name', descending: true }))[0], 'Sol Ring');
});

test('descending keeps the commanders first', () => {
  const groups = groupCards(CARDS, { mode: 'type', descending: true, commanders: [{ name: 'Atraxa' }] });
  assert.equal(labels(groups)[0], 'Commander');
  assert.equal(labels(groups)[1], 'Lands');
});

test('the deck page sorts by the chosen field and order, and keeps both in its links', async () => {
  const deck = await Deck.findOne({ name: 'Alpha' });
  const { text } = await request('GET', `/decks/${deck._id}?group=name&dir=desc`);
  assert.deepEqual(orderIn(text, ['Forest', 'Opt', 'Sol Ring']), ['Sol Ring', 'Opt', 'Forest']);
  assert.match(text, /href="\?group=name&amp;dir=desc"[^>]*aria-current="true"/);
  assert.ok(text.includes('href="?group=color&amp;dir=desc"'));
  assert.ok(text.includes('href="?group=name&amp;dir=asc"'));
});

test('an unknown order falls back to ascending', async () => {
  const deck = await Deck.findOne({ name: 'Alpha' });
  const { text } = await request('GET', `/decks/${deck._id}?group=name&dir=sideways`);
  assert.deepEqual(orderIn(text, ['Forest', 'Opt', 'Sol Ring']), ['Forest', 'Opt', 'Sol Ring']);
});

for (const path of ['/decks', '/dashboard']) {
  test(`${path} sorts decks by name either way, ignoring case`, async () => {
    const up = await request('GET', `${path}?sort=name-asc`);
    assert.deepEqual(orderIn(up.text, ['>Alpha<', '>beta<', '>Gamma<']), ['>Alpha<', '>beta<', '>Gamma<']);
    assert.match(up.text, /value="name-asc" selected/);
    const down = await request('GET', `${path}?sort=name-desc`);
    assert.deepEqual(orderIn(down.text, ['>Alpha<', '>beta<', '>Gamma<']), ['>Gamma<', '>beta<', '>Alpha<']);
  });

  test(`${path} defaults to the most recently modified deck first`, async () => {
    await Deck.updateOne({ name: 'beta' }, { description: `touched for ${path}` });
    const wanted = ['>Alpha<', '>beta<', '>Gamma<'];
    const { text } = await request('GET', `${path}?sort=nonsense`);
    assert.equal(orderIn(text, wanted)[0], '>beta<');
    assert.equal(orderIn((await request('GET', `${path}?sort=updated-asc`)).text, wanted).at(-1), '>beta<');
  });
}

test('browse keeps the format filter alongside the sort', async () => {
  const { text } = await request('GET', '/decks?format=Commander&sort=name-asc');
  assert.ok(!text.includes('>Alpha<'));
  assert.match(text, /value="Commander" selected/);
});
