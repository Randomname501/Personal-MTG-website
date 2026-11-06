import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, Tag } from '../models/index.js';

let baseUrl;
let server;

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
  await request('POST', '/register', { username_input: `Tagger${(users += 1)}`, password_input: 'hunter2hunter' });
  return request;
};

const CARD = { scryfallId: 'sol-1', name: 'Sol Ring', quantity: 1 };
let decks = 0;
const newDeck = async (request, cards = [CARD]) => {
  const name = `Tag Deck ${(decks += 1)}`;
  await request('POST', '/decks', { name, format: 'Modern' });
  await Deck.updateOne({ name }, { cards });
  return Deck.findOne({ name });
};

const newTag = async (request, name) => {
  await request('POST', '/tags', { name });
  return Tag.findOne({ name });
};

// Picker checkboxes post one `tags` key per tick.
const postTags = (request, path, tags) => {
  const form = new URLSearchParams(tags.map((t) => ['tags', String(t._id)]));
  return request('POST', path, form);
};

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_tags_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await Tag.syncIndexes();
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
});

test('a player creates, renames and deletes a tag', async () => {
  const user = await newUser();
  const tag = await newTag(user, 'Budget');
  assert.match((await user('GET', '/tags')).text, /Budget/);

  await user('POST', `/tags/${tag._id}`, { name: 'Cheap' });
  assert.equal((await Tag.findById(tag._id)).name, 'Cheap');

  await user('POST', `/tags/${tag._id}/delete`);
  assert.equal(await Tag.findById(tag._id), null);
});

test('tag names must be present, short enough and unique ignoring case', async () => {
  const user = await newUser();
  const tag = await newTag(user, 'Ramp');
  const other = await newTag(user, 'Draw');

  assert.equal((await user('POST', '/tags', { name: '   ' })).status, 400);
  assert.equal((await user('POST', '/tags', { name: 'x'.repeat(41) })).status, 400);
  const dupe = await user('POST', '/tags', { name: 'RAMP' });
  assert.equal(dupe.status, 409);
  assert.match(dupe.text, /already have a tag called RAMP/);
  assert.equal((await user('POST', `/tags/${other._id}`, { name: 'ramp' })).status, 409);
  assert.equal((await Tag.findById(other._id)).name, 'Draw');

  // Renaming a tag to a new case of its own name is fine.
  assert.equal((await user('POST', `/tags/${tag._id}`, { name: 'RAMP' })).status, 302);
});

test('two players can use the same tag name', async () => {
  const first = await newUser();
  const second = await newUser();
  await first('POST', '/tags', { name: 'Shared Name' });
  assert.equal((await second('POST', '/tags', { name: 'Shared Name' })).status, 302);
});

test('a deck takes several tags, and unticking removes one', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  const a = await newTag(user, 'Deck Tag A');
  const b = await newTag(user, 'Deck Tag B');

  const res = await postTags(user, `/decks/${deck._id}/tags`, [a, b]);
  assert.equal(res.location, `/decks/${deck._id}`);
  assert.equal((await Tag.findById(a._id)).decks.length, 1);
  assert.equal((await Tag.findById(b._id)).decks.length, 1);

  const page = await user('GET', `/decks/${deck._id}/tags`);
  assert.equal(page.text.match(/ checked/g).length, 2);

  await postTags(user, `/decks/${deck._id}/tags`, [b]);
  assert.equal((await Tag.findById(a._id)).decks.length, 0);
  assert.equal((await Tag.findById(b._id)).decks.length, 1);
});

test('a tag page lists its decks, and its cards in every deck holding them', async () => {
  const user = await newUser();
  const first = await newDeck(user);
  const second = await newDeck(user);
  const untagged = await newDeck(user, [{ scryfallId: 'opt-1', name: 'Opt', quantity: 1 }]);
  const tag = await newTag(user, 'Cards Too');

  await postTags(user, `/decks/${first._id}/tags`, [tag]);
  await postTags(user, `/decks/${first._id}/cards/sol-1/tags`, [tag]);

  const { text } = await user('GET', `/tags/${tag._id}`);
  assert.ok(text.includes(`<li><a href="/decks/${first._id}">${first.name}</a> &middot; Modern</li>`));
  assert.ok(text.includes(`<a href="/decks/${second._id}">${second.name}</a>: Sol Ring`));
  assert.ok(!text.includes(untagged.name));
});

test('a card tag survives its card being replaced by another printing', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  const tag = await newTag(user, 'Printing');
  await postTags(user, `/decks/${deck._id}/cards/sol-1/tags`, [tag]);
  await Deck.updateOne({ _id: deck._id }, { cards: [{ ...CARD, scryfallId: 'sol-2' }] });
  assert.match((await user('GET', `/tags/${tag._id}`)).text, /Sol Ring/);
});

test('a tag page lists a card once when a deck holds two printings', async () => {
  const user = await newUser();
  const deck = await newDeck(user, [CARD, { ...CARD, scryfallId: 'sol-2' }]);
  const tag = await newTag(user, 'Two Printings');
  await postTags(user, `/decks/${deck._id}/cards/sol-1/tags`, [tag]);
  const { text } = await user('GET', `/tags/${tag._id}`);
  assert.equal(text.split('Sol Ring').length - 1, 1);
});

test('the deck and card pages link to their tags for the owner only', async () => {
  const owner = await newUser();
  const other = await newUser();
  const deck = await newDeck(owner);
  assert.ok((await owner('GET', `/decks/${deck._id}`)).text.includes(`href="/decks/${deck._id}/tags"`));
  assert.ok((await owner('GET', `/decks/${deck._id}/cards/sol-1/note`)).text.includes(`href="/decks/${deck._id}/cards/sol-1/tags"`));
  assert.ok(!(await other('GET', `/decks/${deck._id}`)).text.includes(`/decks/${deck._id}/tags`));
});

test('a player can neither touch another player\'s tags nor tag their decks', async () => {
  const owner = await newUser();
  const other = await newUser();
  const deck = await newDeck(owner);
  const tag = await newTag(owner, 'Mine Alone');
  const theirs = await newTag(other, 'Theirs');

  assert.equal((await other('GET', `/tags/${tag._id}`)).status, 404);
  assert.equal((await other('POST', `/tags/${tag._id}`, { name: 'Stolen' })).status, 404);
  assert.equal((await other('POST', `/tags/${tag._id}/delete`)).status, 404);
  assert.equal((await other('GET', `/decks/${deck._id}/tags`)).status, 404);
  assert.equal((await postTags(other, `/decks/${deck._id}/tags`, [theirs])).status, 404);

  // Ticking someone else's tag on your own deck does nothing to it.
  const own = await newDeck(other);
  await postTags(other, `/decks/${own._id}/tags`, [tag]);
  const untouched = await Tag.findById(tag._id);
  assert.equal(untouched.name, 'Mine Alone');
  assert.equal(untouched.decks.length, 0);
});

test('bad ids and missing cards are a 404, and junk ticks are ignored', async () => {
  const user = await newUser();
  const deck = await newDeck(user);
  assert.equal((await user('GET', '/tags/not-an-id')).status, 404);
  assert.equal((await user('GET', '/decks/not-an-id/tags')).status, 404);
  assert.equal((await user('GET', `/decks/${deck._id}/cards/missing/tags`)).status, 404);
  assert.equal((await user('POST', `/decks/${deck._id}/tags`, { tags: 'junk' })).status, 302);
});
