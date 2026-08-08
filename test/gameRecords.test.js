import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord } from '../models/index.js';

// A client is one isolated cookie jar + request helper, so we can drive the app
// as two different logged-in users in the same test file.
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
      // Repeated keys for array values (not comma-joined), matching real form posts.
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
let alice;

// Flatten opponents into the bracket-syntax field names the real form posts,
// which express.urlencoded({ extended: true }) parses back into an array.
const opponentFields = (opponents) =>
  Object.fromEntries(
    opponents.flatMap((o, i) => [
      [`opponents[${i}][name]`, o.name],
      [`opponents[${i}][deck]`, o.deck],
    ])
  );

// Log a game for a client and return the created GameRecord document.
const logGame = async (client, deckId, opponents, result) => {
  await client.request('POST', '/game-records', {
    deck_id: deckId.toString(),
    ...opponentFields(opponents),
    result,
  });
  return GameRecord.findOne({ 'opponents.deck': opponents[0].deck }).sort({ createdAt: -1, _id: -1 });
};

const solo = (deck, name = 'Ana') => [{ name, deck }];

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_games_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  alice = makeClient();
  await alice.request('POST', '/register', { username_input: 'Alice', password_input: 'hunter2hunter' });
  await alice.request('POST', '/decks', { name: 'Aggro', format: 'Modern', colors: ['R'] });
  await alice.request('POST', '/decks', { name: 'Control', format: 'Modern', colors: ['U'] });
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const control = await Deck.findOne({ name: 'Control' });
  await logGame(alice, aggro._id, solo('Burn'), 'win');
  await logGame(alice, aggro._id, solo('Tron'), 'loss');
  await logGame(alice, control._id, solo('Goblins'), 'win');
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('match history lists the user\'s games', async () => {
  const res = await alice.request('GET', '/game-records');
  assert.equal(res.status, 200);
  assert.match(res.text, /Match History/);
  assert.match(res.text, /Burn/);
  assert.match(res.text, /Tron/);
  assert.match(res.text, /Goblins/);
});

test('filter by deck shows only that deck\'s games', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const res = await alice.request('GET', `/game-records?deck=${aggro._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Burn/); // Aggro game
  assert.match(res.text, /Tron/); // Aggro game
  assert.doesNotMatch(res.text, /Goblins/); // Control game excluded
});

test('filter by result shows only matching games; invalid result is ignored', async () => {
  const losses = await alice.request('GET', '/game-records?result=loss');
  assert.match(losses.text, /Tron/); // the only loss
  assert.doesNotMatch(losses.text, /Burn/);
  assert.doesNotMatch(losses.text, /Goblins/);

  const bogus = await alice.request('GET', '/game-records?result=bogus');
  assert.match(bogus.text, /Burn/);
  assert.match(bogus.text, /Tron/);
  assert.match(bogus.text, /Goblins/); // unfiltered
});

test('edit page pre-fills and PUT updates the record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('EditMe'), 'win');

  const form = await alice.request('GET', `/game-records/${rec._id}/edit`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Edit Game/);
  assert.match(form.text, /EditMe/); // opponent deck pre-filled
  assert.match(form.text, /Ana/); // opponent name pre-filled

  const control = await Deck.findOne({ name: 'Control' });
  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: control._id.toString(),
    ...opponentFields([{ name: 'Ben', deck: 'Storm' }]),
    result: 'draw',
  });
  assert.equal(put.status, 302);
  assert.equal(put.location, '/game-records');

  const updated = await GameRecord.findById(rec._id).lean();
  assert.deepEqual(updated.opponents, [{ name: 'Ben', deck: 'Storm' }]);
  assert.equal(updated.result, 'draw');
  assert.equal(updated.deck.toString(), control._id.toString());
});

test('PUT with an empty opponent deck re-renders the form with an error and no change', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('KeepMe'), 'win');

  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    ...opponentFields([{ name: 'Ana', deck: '   ' }]),
    result: 'win',
  });
  assert.equal(put.status, 400);
  assert.match(put.text, /Edit Game/);

  const unchanged = await GameRecord.findById(rec._id).lean();
  assert.equal(unchanged.opponents[0].deck, 'KeepMe');
});

test('PUT with an empty opponent name re-renders the form with an error and no change', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('KeepMyName'), 'win');

  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    ...opponentFields([{ name: '  ', deck: 'Storm' }]),
    result: 'win',
  });
  assert.equal(put.status, 400);

  const unchanged = await GameRecord.findById(rec._id).lean();
  assert.equal(unchanged.opponents[0].deck, 'KeepMyName');
});

test('a game can be logged against a full pod of five opponents', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const pod = [
    { name: 'P1', deck: 'PodDeckOne' },
    { name: 'P2', deck: 'PodDeckTwo' },
    { name: 'P3', deck: 'PodDeckThree' },
    { name: 'P4', deck: 'PodDeckFour' },
    { name: 'P5', deck: 'PodDeckFive' },
  ];
  const rec = await logGame(alice, aggro._id, pod, 'win');

  assert.notEqual(rec, null);
  assert.equal(rec.opponents.length, 5);
  assert.deepEqual(rec.opponents.map((o) => o.name), ['P1', 'P2', 'P3', 'P4', 'P5']);
});

test('a sixth opponent is rejected and no record is created', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const before = await GameRecord.countDocuments();

  await alice.request('POST', '/game-records', {
    deck_id: aggro._id.toString(),
    ...opponentFields([
      { name: 'S1', deck: 'SixDeckOne' },
      { name: 'S2', deck: 'SixDeckTwo' },
      { name: 'S3', deck: 'SixDeckThree' },
      { name: 'S4', deck: 'SixDeckFour' },
      { name: 'S5', deck: 'SixDeckFive' },
      { name: 'S6', deck: 'SixDeckSix' },
    ]),
    result: 'win',
  });

  assert.equal(await GameRecord.countDocuments(), before);
  assert.equal(await GameRecord.findOne({ 'opponents.deck': 'SixDeckOne' }), null);
});

test('a game with no opponents at all is rejected', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const before = await GameRecord.countDocuments();

  await alice.request('POST', '/game-records', {
    deck_id: aggro._id.toString(),
    result: 'win',
  });

  assert.equal(await GameRecord.countDocuments(), before);
});

test('match history renders every opponent as "Name (Deck)"', async () => {
  const control = await Deck.findOne({ name: 'Control' });
  await logGame(
    alice,
    control._id,
    [
      { name: 'Nadia', deck: 'HistoryDeckA' },
      { name: 'Omar', deck: 'HistoryDeckB' },
    ],
    'win'
  );

  const res = await alice.request('GET', '/game-records');
  assert.match(res.text, /Nadia \(HistoryDeckA\), Omar \(HistoryDeckB\)/);
});

test('a legacy record with only opponentDeck still renders in match history', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const owner = (await Deck.findById(aggro._id)).owner;
  // Written straight to the collection, bypassing the schema, exactly as it
  // would have been stored before opponents had names.
  await mongoose.connection.collection('gamerecords').insertOne({
    user: owner,
    deck: aggro._id,
    opponentDeck: 'LegacyStorm',
    result: 'win',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const res = await alice.request('GET', '/game-records');
  assert.equal(res.status, 200);
  assert.match(res.text, /LegacyStorm/);
});

test('editing a legacy record pre-fills its deck and writes the new shape on save', async () => {
  const rec = await GameRecord.findOne({ opponentDeck: 'LegacyStorm' });

  const form = await alice.request('GET', `/game-records/${rec._id}/edit`);
  assert.equal(form.status, 200);
  assert.match(form.text, /LegacyStorm/);

  const aggro = await Deck.findOne({ name: 'Aggro' });
  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    ...opponentFields([{ name: 'Zoe', deck: 'LegacyStorm' }]),
    result: 'win',
  });
  assert.equal(put.status, 302);

  const updated = await GameRecord.findById(rec._id).lean();
  assert.deepEqual(updated.opponents, [{ name: 'Zoe', deck: 'LegacyStorm' }]);
});

test('a user cannot view or edit another user\'s record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('AlicesGame'), 'win');

  const bob = makeClient();
  await bob.request('POST', '/register', { username_input: 'Bob', password_input: 'hunter2hunter' });

  const view = await bob.request('GET', `/game-records/${rec._id}/edit`);
  assert.equal(view.status, 404);

  const put = await bob.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    ...opponentFields(solo('Hacked')),
    result: 'loss',
  });
  assert.equal(put.status, 404);

  const unchanged = await GameRecord.findById(rec._id).lean();
  assert.equal(unchanged.opponents[0].deck, 'AlicesGame');
});

test('delete confirmation renders and DELETE removes the record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('DeleteMe'), 'loss');

  const confirm = await alice.request('GET', `/game-records/${rec._id}/delete`);
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /Delete Game/);
  assert.match(confirm.text, /DeleteMe/);

  const del = await alice.request('DELETE', `/game-records/${rec._id}`);
  assert.equal(del.status, 302);
  assert.equal(del.location, '/game-records');

  const gone = await GameRecord.findById(rec._id).lean();
  assert.equal(gone, null);
});

test('a user cannot delete another user\'s record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, solo('DontDeleteMe'), 'win');

  const carol = makeClient();
  await carol.request('POST', '/register', { username_input: 'Carol', password_input: 'hunter2hunter' });

  const del = await carol.request('DELETE', `/game-records/${rec._id}`);
  assert.equal(del.status, 404);

  const stillThere = await GameRecord.findById(rec._id).lean();
  assert.notEqual(stillThere, null);
});

test('filtering by another user\'s deck id is ignored (not leaked/filtered to it)', async () => {
  const dave = makeClient();
  await dave.request('POST', '/register', { username_input: 'Dave', password_input: 'hunter2hunter' });
  await dave.request('POST', '/decks', { name: 'DavesDeck', format: 'Modern', colors: ['B'] });
  const davesDeck = await Deck.findOne({ name: 'DavesDeck' });

  const res = await alice.request('GET', `/game-records?deck=${davesDeck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Burn/);
  assert.match(res.text, /Tron/);
  assert.match(res.text, /Goblins/);
});

export { makeClient, logGame, opponentFields };
