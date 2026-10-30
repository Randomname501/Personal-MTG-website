import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord, User } from '../models/index.js';

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
let tess;
let anon;
let tessUser;

// Register a fresh logged-in client (reused by later tasks' tests).
const registerClient = async (username) => {
  const c = makeClient();
  await c.request('POST', '/register', { username_input: username, password_input: 'hunter2hunter' });
  return c;
};

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_profiles_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  tess = await registerClient('Tess');
  anon = makeClient();
  tessUser = await User.findOne({ username: 'Tess' });
  const mk = (name, visibility) => Deck.create({ name, format: 'Modern', owner: tessUser._id, visibility });
  await mk('PubDeckZ', 'public');
  await mk('FriendDeckZ', 'friends');
  const priv = await mk('PrivDeckZ', 'private');
  await GameRecord.create({
    user: tessUser._id, deck: priv._id, result: 'win',
    opponents: [{ name: 'Zed', deck: 'Goblins' }],
  });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('a profile is open to logged-out visitors and shows public decks only', async () => {
  const res = await anon.request('GET', '/users/Tess');
  assert.equal(res.status, 200);
  assert.match(res.text, /PubDeckZ/);
  assert.doesNotMatch(res.text, /FriendDeckZ/);
  assert.doesNotMatch(res.text, /PrivDeckZ/);
  assert.doesNotMatch(res.text, /Add friend/);
});

test('the owner sees all their decks with visibility badges on their own profile', async () => {
  const res = await tess.request('GET', '/users/Tess');
  for (const n of ['PubDeckZ', 'FriendDeckZ', 'PrivDeckZ']) assert.match(res.text, new RegExp(n));
  assert.match(res.text, /Private/);
});

test('profile lookup is case-insensitive and unknown users 404', async () => {
  assert.equal((await anon.request('GET', '/users/tess')).status, 200);
  assert.equal((await anon.request('GET', '/users/nobody-here')).status, 404);
});

test("a profile game shows a blurred placeholder for a deck the viewer can't see", async () => {
  const res = await anon.request('GET', '/users/Tess');
  assert.match(res.text, /class="hidden-deck">Hidden deck</);
  assert.doesNotMatch(res.text, /PrivDeckZ/);
});

test('profile links encode and nav escapes odd usernames', async () => {
  const odd = await registerClient('<b>Odd & Co</b>');
  const dash = await odd.request('GET', '/dashboard');
  assert.match(dash.text, /&lt;b&gt;Odd/);
  assert.match(dash.text, /href="\/users\/%3Cb%3EOdd%20%26%20Co%3C%2Fb%3E"/);
  assert.doesNotMatch(dash.text, /<b>Odd/);
  assert.equal((await anon.request('GET', '/users/%3Cb%3EOdd%20%26%20Co%3C%2Fb%3E')).status, 200);
});

test('Browse and the player leaderboard link usernames to profiles', async () => {
  const browse = await tess.request('GET', '/decks');
  assert.match(browse.text, /href="\/users\/Tess"/);
  const lb = await anon.request('GET', '/leaderboard');
  assert.match(lb.text, /href="\/users\/Tess"/);
});

test('the friend button walks through Add friend → Request sent → Accept → Friends', async () => {
  const vera = await registerClient('Vera');
  const wade = await registerClient('Wade');
  assert.match((await vera.request('GET', '/users/Wade')).text, /Add friend/);
  assert.match((await anon.request('GET', '/users/Wade')).text, /Log in to add friend/);
  assert.equal((await vera.request('POST', '/users/Wade/friend')).status, 302);
  assert.match((await vera.request('GET', '/users/Wade')).text, /Request sent/);
  assert.match((await wade.request('GET', '/users/Vera')).text, /Accept/);
  await wade.request('POST', '/users/Vera/accept');
  assert.match((await vera.request('GET', '/users/Wade')).text, /10003; Friends/);
  assert.match((await wade.request('GET', '/users/Vera')).text, /Unfriend/);
  await wade.request('POST', '/users/Vera/unfriend');
  assert.match((await vera.request('GET', '/users/Wade')).text, /Add friend/);
});

test('incoming requests show on the dashboard with a nav count and can be declined from there', async () => {
  const uma = await registerClient('Uma');
  await tess.request('POST', '/users/Uma/friend');
  const dash = await uma.request('GET', '/dashboard');
  assert.match(dash.text, /Friend requests/);
  assert.match(dash.text, /Tess/);
  assert.match(dash.text, /Uma \(1\)/);
  const res = await uma.request('POST', '/users/Tess/decline', { back: '/dashboard' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/dashboard');
  const after = await uma.request('GET', '/dashboard');
  assert.doesNotMatch(after.text, /Uma \(1\)/);
  assert.doesNotMatch(after.text, /Friend requests/);
});

test('friend action routes require login and 404-safe usernames', async () => {
  const res = await anon.request('POST', '/users/Tess/friend');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
  const missing = await tess.request('POST', '/users/nobody-here/friend');
  assert.equal(missing.status, 302);
  assert.equal(missing.location, '/dashboard');
});

// --- Task 4: visibility enforcement ---

const befriend = async (a, aName, b, bName) => {
  await a.request('POST', `/users/${bName}/friend`);
  await b.request('POST', `/users/${aName}/accept`);
};

test('new decks default to public and the form offers all three settings', async () => {
  const form = await tess.request('GET', '/decks/new');
  assert.match(form.text, /name="visibility"/);
  for (const v of ['public', 'friends', 'private']) assert.match(form.text, new RegExp(`<option value="${v}"`));
  await tess.request('POST', '/decks', { name: 'DefaultVisZ', format: 'Modern' });
  await tess.request('POST', '/decks', { name: 'BogusVisZ', format: 'Modern', visibility: 'bogus' });
  await tess.request('POST', '/decks', { name: 'PrivNewZ', format: 'Modern', visibility: 'private' });
  assert.equal((await Deck.findOne({ name: 'DefaultVisZ' })).visibility, 'public');
  assert.equal((await Deck.findOne({ name: 'BogusVisZ' })).visibility, 'public');
  assert.equal((await Deck.findOne({ name: 'PrivNewZ' })).visibility, 'private');
});

test("the owner can change a deck's visibility; others cannot", async () => {
  const stranger = await registerClient('Ines');
  const deck = await Deck.create({ name: 'ChangeVisZ', format: 'Modern', owner: tessUser._id });
  const res = await tess.request('POST', `/decks/${deck._id}/visibility`, { visibility: 'friends' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/decks/${deck._id}`);
  assert.equal((await Deck.findById(deck._id)).visibility, 'friends');
  const bad = await stranger.request('POST', `/decks/${deck._id}/visibility`, { visibility: 'private' });
  assert.equal(bad.status, 404);
  assert.equal((await Deck.findById(deck._id)).visibility, 'friends');
});

test('friends-only and private decks are hidden from Browse, deck pages and tracking for non-friends', async () => {
  const joss = await registerClient('Joss');
  const kira = await registerClient('Kira');
  await befriend(tess, 'Tess', kira, 'Kira');
  const jossBrowse = await joss.request('GET', '/decks');
  assert.match(jossBrowse.text, /PubDeckZ/);
  assert.doesNotMatch(jossBrowse.text, /FriendDeckZ/);
  assert.doesNotMatch(jossBrowse.text, /PrivDeckZ/);
  const fd = await Deck.findOne({ name: 'FriendDeckZ' });
  const pd = await Deck.findOne({ name: 'PrivDeckZ' });
  assert.equal((await joss.request('GET', `/decks/${fd._id}`)).status, 404);
  await joss.request('POST', `/decks/${fd._id}/track`);
  assert.equal((await User.findOne({ username: 'Joss' })).trackedDecks.length, 0);
  const kBrowse = await kira.request('GET', '/decks');
  assert.match(kBrowse.text, /FriendDeckZ/);
  assert.doesNotMatch(kBrowse.text, /PrivDeckZ/);
  assert.equal((await kira.request('GET', `/decks/${fd._id}`)).status, 200);
  assert.equal((await kira.request('GET', `/decks/${pd._id}`)).status, 404);
});

test('a tracked deck drops off the dashboard when access is lost and returns when regained', async () => {
  const lena = await registerClient('Lena');
  await befriend(tess, 'Tess', lena, 'Lena');
  const fd = await Deck.findOne({ name: 'FriendDeckZ' });
  await lena.request('POST', `/decks/${fd._id}/track`);
  assert.match((await lena.request('GET', '/dashboard')).text, /FriendDeckZ/);
  await tess.request('POST', '/users/Lena/unfriend');
  assert.doesNotMatch((await lena.request('GET', '/dashboard')).text, /FriendDeckZ/);
  assert.equal((await User.findOne({ username: 'Lena' })).trackedDecks.length, 1);
  await befriend(tess, 'Tess', lena, 'Lena');
  assert.match((await lena.request('GET', '/dashboard')).text, /FriendDeckZ/);
});

test("a hidden deck's name never appears in the profile or deck leaderboard HTML", async () => {
  const milo = await registerClient('Milo');
  const wl = (t) => t.match(/<dt>W<\/dt><dd>(\d+)<\/dd>[\s\S]*?<dt>L<\/dt><dd>(\d+)<\/dd>/)?.slice(1, 3).join('/');
  const ownerLb = await tess.request('GET', '/deckLeaderboard');
  assert.match(ownerLb.text, /PrivDeckZ/);
  for (const viewer of [anon, milo]) {
    for (const path of ['/deckLeaderboard', '/users/Tess']) {
      const res = await viewer.request('GET', path);
      assert.doesNotMatch(res.text, /PrivDeckZ/);
      assert.match(res.text, /Hidden deck/);
    }
    const lb = await viewer.request('GET', '/deckLeaderboard');
    assert.match(lb.text, /href="\/users\/Tess"/);
    assert.equal(wl(lb.text), wl(ownerLb.text));
  }
});

test('a legacy deck with no visibility field stays public', async () => {
  const nico = await registerClient('Nico');
  const { insertedId } = await Deck.collection.insertOne({
    name: 'LegacyDeckZ', format: 'Modern', owner: tessUser._id, cards: [], colors: [], createdAt: new Date(),
  });
  assert.match((await nico.request('GET', '/decks')).text, /LegacyDeckZ/);
  assert.equal((await nico.request('GET', `/decks/${insertedId}`)).status, 200);
});
