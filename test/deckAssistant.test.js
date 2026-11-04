import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

// --- HTTP client with its own cookie jar; sends forms or JSON ---
const makeClient = () => {
  const cookies = new Map();
  const request = async (method, path, { form, json } = {}) => {
    const headers = {};
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        for (const v of [].concat(value)) params.append(key, v);
      }
      body = params.toString();
    }
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { status: res.status, text, data };
  };
  return { request };
};

const ELVES = {
  id: 'elves-1',
  name: 'Llanowar Elves',
  mana_cost: '{G}',
  cmc: 1,
  colors: ['G'],
  type_line: 'Creature — Elf Druid',
  oracle_text: '{T}: Add {G}.',
  prices: { usd: '0.29' },
  image_uris: { normal: 'http://img/elves.jpg' },
};

// --- Fake Anthropic API: replays `script`, one response per POST /v1/messages ---
let script = [];
const message = (stop_reason, content) => ({
  status: 200,
  body: {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  },
});
const searchThenRecommend = () => [
  message('tool_use', [{ type: 'tool_use', id: 't1', name: 'search_cards', input: { query: 't:elf' } }]),
  message('tool_use', [{
    type: 'tool_use', id: 't2', name: 'recommend_cards',
    input: { cards: [{ scryfallId: 'elves-1', reason: 'One-drop ramp' }] },
  }]),
  message('end_turn', [{ type: 'text', text: 'Here you go.' }]),
];

let baseUrl;
let server;
let scryfall;
let anthropic;
let alice;
let bob;
const aliceDeck = () => Deck.findOne({ name: 'Golgari' });

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_assistant_test';
  process.env.SCRYFALL_TIMEOUT_MS = '200';
  await connectMongo();
  await mongoose.connection.dropDatabase();

  scryfall = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/cards/search')) return res.end(JSON.stringify({ data: [ELVES] }));
    res.statusCode = 404;
    res.end(JSON.stringify({ object: 'error' }));
  });
  anthropic = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const next = script.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'script empty' } } };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  const listen = (srv) => new Promise((resolve) => srv.listen(0, () => resolve(`http://127.0.0.1:${srv.address().port}`)));
  process.env.SCRYFALL_API_BASE = await listen(scryfall);
  process.env.ANTHROPIC_BASE_URL = await listen(anthropic);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  baseUrl = await new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  alice = makeClient();
  bob = makeClient();
  await alice.request('POST', '/register', { form: { username_input: 'Alice', password_input: 'hunter2hunter' } });
  await bob.request('POST', '/register', { form: { username_input: 'Bob', password_input: 'hunter2hunter' } });
  await alice.request('POST', '/decks', { form: { name: 'Golgari', format: 'Modern', colors: ['B', 'G'] } });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
  for (const srv of [scryfall, anthropic]) {
    srv.closeAllConnections();
    await new Promise((resolve) => srv.close(resolve));
  }
});

const ask = (client, deckId, json) => client.request('POST', `/decks/${deckId}/assistant`, { json });

test('owner gets recommendations', async () => {
  script = searchThenRecommend();
  const deck = await aliceDeck();
  const res = await ask(alice, deck._id, { question: 'cheap ramp', messages: [] });
  assert.equal(res.status, 200);
  assert.equal(res.data.reply, 'Here you go.');
  assert.equal(res.data.note, null);
  assert.equal(res.data.recommendations.length, 1);
  assert.equal(res.data.recommendations[0].name, 'Llanowar Elves');
  assert.equal(res.data.recommendations[0].reason, 'One-drop ramp');
  assert.ok(Array.isArray(res.data.messages) && res.data.messages.length > 1);
});

test('non-owner gets 404', async () => {
  script = searchThenRecommend();
  const deck = await aliceDeck();
  const res = await ask(bob, deck._id, { question: 'cheap ramp', messages: [] });
  assert.equal(res.status, 404);
  assert.equal(script.length, 3, 'Claude must not be called');
});

test('logged-out request gets a 401 JSON error, not a login redirect', async () => {
  script = searchThenRecommend();
  const deck = await aliceDeck();
  const res = await ask(makeClient(), deck._id, { question: 'cheap ramp', messages: [] });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /log in/i);
  assert.equal(script.length, 3, 'Claude must not be called');
});

test('rejects bad bodies with 400', async () => {
  const deck = await aliceDeck();
  const bad = [
    { question: '', messages: [] },
    { question: '   ', messages: [] },
    { question: 'x'.repeat(1001), messages: [] },
    { question: 'ok', messages: 'x' },
    { question: 'ok', messages: [{ role: 'user', content: 'x'.repeat(300_001) }] },
    { messages: [] },
  ];
  for (const body of bad) {
    const res = await ask(alice, deck._id, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(res.data.error);
  }
});

test('a body over the parser limit gets a 413, not a 500', async () => {
  const deck = await aliceDeck();
  const res = await ask(alice, deck._id, { question: 'ok', messages: [{ role: 'user', content: 'x'.repeat(500_000) }] });
  assert.equal(res.status, 413);
  assert.ok(res.data.error);
});

test('503 when no key', async () => {
  const deck = await aliceDeck();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await ask(alice, deck._id, { question: 'cheap ramp', messages: [] });
    assert.equal(res.status, 503);
    assert.ok(res.data.error);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('502 when Claude errors', async () => {
  script = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'x' } } }];
  const deck = await aliceDeck();
  const res = await ask(alice, deck._id, { question: 'cheap ramp', messages: [] });
  assert.equal(res.status, 502);
  assert.equal(res.data.error, 'The assistant is unavailable right now.');
});

test('deck page shows the panel only to the owner', async () => {
  const deck = await aliceDeck();
  await Deck.updateOne({ _id: deck._id }, { visibility: 'public' });
  const mine = await alice.request('GET', `/decks/${deck._id}`);
  const theirs = await bob.request('GET', `/decks/${deck._id}`);
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);
  assert.match(mine.text, /id="deck-assistant"/);
  assert.doesNotMatch(theirs.text, /id="deck-assistant"/);
});

test('deck page hides the panel when no key is set', async () => {
  const deck = await aliceDeck();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const mine = await alice.request('GET', `/decks/${deck._id}`);
    assert.doesNotMatch(mine.text, /id="deck-assistant"/);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});
