import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

// A tiny cookie jar: remember Set-Cookie values and replay them, follow
// redirects manually so we can assert on Location.
let baseUrl;
let server;
const cookies = new Map();

const cookieHeader = () =>
  [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

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
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
};

before(async () => {
  // Force a throwaway database so the suite never touches dev data, regardless
  // of what .env set. connectMongo() reads MONGODB_URI at call time.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_test';
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

test('unauthenticated dashboard redirects to login', async () => {
  const res = await request('GET', '/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('register logs the user in and lands on dashboard', async () => {
  const res = await request('POST', '/register', {
    username_input: 'Tester',
    password_input: 'hunter2hunter',
  });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/dashboard');
});

test('dashboard shows the username once authenticated', async () => {
  const res = await request('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Welcome, Tester/);
});

test('creating a deck redirects to dashboard and the deck appears', async () => {
  const create = await request('POST', '/decks', {
    name: 'Gruul Stompy',
    format: 'Modern',
    colors: ['R', 'G'],
    archetype: 'Aggro',
  });
  assert.equal(create.status, 302);
  assert.equal(create.location, '/dashboard');

  const dash = await request('GET', '/dashboard');
  assert.match(dash.text, /Gruul Stompy/);
  assert.match(dash.text, /game-record-form/);
});

test('logging a game updates the player leaderboard', async () => {
  const deck = await Deck.findOne({ name: 'Gruul Stompy' });
  const log = await request('POST', '/game-records', {
    deck_id: deck._id.toString(),
    'opponents[0][name]': 'Ana',
    'opponents[0][deck]': 'Tron',
    result: 'win',
  });
  assert.equal(log.status, 302);

  const board = await request('GET', '/leaderboard');
  assert.equal(board.status, 200);
  assert.match(board.text, /Tester/);
  // The card should show 1 win.
  assert.match(board.text, /<dt>W<\/dt><dd>1<\/dd>/);
});

test('wrong password re-renders login with an error', async () => {
  const res = await request('POST', '/login', {
    username_input: 'Tester',
    password_input: 'wrong-password',
  });
  assert.equal(res.status, 401);
  assert.match(res.text, /Invalid username or password/);
});
