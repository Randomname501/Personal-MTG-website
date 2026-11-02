import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord, Playgroup, User } from '../models/index.js';
import { getPlayerLeaderboard, getDeckLeaderboard, maskHiddenDecks } from '../lib/leaderboards.js';

// One isolated cookie jar + request helper per client, as in profiles.test.js.
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

const registerClient = async (username) => {
  const c = makeClient();
  await c.request('POST', '/register', { username_input: username, password_input: 'hunter2hunter' });
  return c;
};

// Users created straight in the DB, for lib-level tests.
const mkUser = async (username) => {
  const u = new User({ username });
  await u.setPassword('hunter2hunter');
  return u.save();
};

const befriend = (a, b) =>
  Promise.all([
    User.updateOne({ _id: a._id }, { $addToSet: { friends: b._id } }),
    User.updateOne({ _id: b._id }, { $addToSet: { friends: a._id } }),
  ]);

const mkGame = (user, deck, extra = {}) =>
  GameRecord.create({ user: user._id, deck: deck._id, result: 'win', opponents: [{ name: 'Zed', deck: 'Goblins' }], ...extra });

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_playgroups_test';
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
  await new Promise((resolve) => server.close(resolve));
});

// --- Task 1: filtered leaderboards ---

test('leaderboards filtered by playgroup count only tagged games; unfiltered count all', async () => {
  const a = await mkUser('LbAnn');
  const b = await mkUser('LbBen');
  const da = await Deck.create({ name: 'LbDeckA', format: 'Modern', owner: a._id });
  const db = await Deck.create({ name: 'LbDeckB', format: 'Modern', owner: b._id });
  const dUntagged = await Deck.create({ name: 'LbDeckC', format: 'Modern', owner: b._id });
  const g = await Playgroup.create({ name: 'LbPod', owner: a._id, members: [a._id, b._id] });
  await mkGame(a, da, { playgroup: g._id });
  await mkGame(a, da);
  await mkGame(b, db, { playgroup: g._id });
  await mkGame(b, dUntagged);

  const players = await getPlayerLeaderboard({ playgroup: g._id });
  assert.deepEqual(players.map((r) => r.username).sort(), ['LbAnn', 'LbBen']);
  for (const r of players) assert.equal(r.wins + r.losses + r.draws, 1);

  const all = await getPlayerLeaderboard();
  assert.equal(all.find((r) => r.username === 'LbAnn').wins, 2);

  const decks = await getDeckLeaderboard({ playgroup: g._id });
  assert.deepEqual(decks.map((r) => r.deckName).sort(), ['LbDeckA', 'LbDeckB']);
});

test('maskHiddenDecks hides a private deck from a non-owner', () => {
  const owner = new mongoose.Types.ObjectId();
  const viewer = { _id: new mongoose.Types.ObjectId(), friends: [] };
  const [row] = maskHiddenDecks([{ deckName: 'Secret', ownerId: owner, visibility: 'private', wins: 1 }], viewer);
  assert.equal(row.hidden, true);
  assert.equal('deckName' in row, false);
  assert.equal(row.wins, 1);
});
