# Game Session Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn write-only game records into a browsable match history with edit and delete, all scoped to the logged-in user, with no schema changes.

**Architecture:** Add RESTful routes under `/game-records` in the existing `routes/gameRecords.js`, three new Handlebars views, two new view helpers, and a shared input-validator that both create and edit use. Ownership is enforced by every `:id` query filtering on `user`. Presentation is server-rendered; forms use the app's existing `_method` override for `PUT`/`DELETE`.

**Tech Stack:** Node ESM, Express 4, Mongoose, express-handlebars, `node --test`.

## Global Constraints

- No schema changes. `GameRecord` stays `{ user, deck, opponentDeck, result, timestamps }`.
- No new runtime dependencies. Server-rendered only; works with JavaScript disabled.
- Every route is `requireAuth` and scoped to `req.currentUser._id`. A `:id` route for a malformed id or a record the user does not own renders the `404` view with status 404 — never a 500, never another user's data.
- `PUT`/`DELETE` from forms go through the existing `_method` body override (`app.js`): forms `POST` with a hidden `<input name="_method" value="PUT|DELETE">`.
- Reuse existing patterns: `.lean()` in read routes, the `deckForm` form/error pattern, the logout confirm-page pattern, `try/catch → next(err)`.
- The existing `POST /game-records` behavior (invalid input → redirect `/dashboard`) must not change.
- Tests use `node --test` with a dedicated DB name `mtg_tracker_games_test`. The HTTP harness sends array form fields as repeated keys (not comma-joined).

---

## File Structure

- **Create** `lib/viewHelpers.js` — exported Handlebars helpers `percent`, `eq`, `formatDate` (moves the existing inline `percent` here so all view helpers live together and are unit-testable).
- **Create** `test/viewHelpers.test.js` — unit tests for the three helpers.
- **Create** `views/gameHistory.handlebars` — filter bar + history table.
- **Create** `views/gameRecordForm.handlebars` — edit form.
- **Create** `views/gameRecordDelete.handlebars` — delete confirmation page.
- **Create** `test/gameRecords.test.js` — HTTP integration tests (own DB).
- **Modify** `app.js` — import helpers from `lib/viewHelpers.js` instead of the inline `percent`.
- **Modify** `routes/gameRecords.js` — add `resolveGameInput`, refactor `POST`, add list / edit / delete routes.
- **Modify** `middleware/auth.js` — add "Match History" to `loggedInNav`.
- **Modify** `views/userDashboard.handlebars` — add a "View match history" link.
- **Modify** `public/css/style.css` — history table, filter bar, row actions, result colors.

`test/gameRecords.test.js` is created in Task 2 and appended to in Tasks 3 and 4; its `before()` hook seeds the read-only fixtures, and each mutating test creates its own record so tests stay order-independent.

---

### Task 1: View helpers module (`percent`, `eq`, `formatDate`)

**Files:**
- Create: `lib/viewHelpers.js`
- Create: `test/viewHelpers.test.js`
- Modify: `app.js` (engine registration)

**Interfaces:**
- Produces: `percent(part, whole) -> integer 0..100`; `eq(a, b) -> boolean` (string-compares); `formatDate(value) -> string` (e.g. `"Jul 14, 2026"`, `''` for missing/invalid). Consumed by Tasks 2-4 views and by `app.js`.

- [ ] **Step 1: Write the failing test**

Create `test/viewHelpers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percent, eq, formatDate } from '../lib/viewHelpers.js';

test('percent is integer part-of-whole, 0 when whole is 0', () => {
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(2, 3), 67);
  assert.equal(percent(5, 0), 0);
});

test('eq string-compares its two arguments', () => {
  assert.equal(eq('a', 'a'), true);
  assert.equal(eq(1, '1'), true); // ObjectId vs string form
  assert.equal(eq('a', 'b'), false);
});

test('formatDate renders a friendly date, empty for missing/invalid', () => {
  assert.equal(formatDate(new Date('2026-07-14T12:00:00Z')), 'Jul 14, 2026');
  assert.equal(formatDate(undefined), '');
  assert.equal(formatDate('not-a-date'), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/viewHelpers.test.js"`
Expected: FAIL — cannot import from `../lib/viewHelpers.js` (module missing).

- [ ] **Step 3: Create the helpers module**

Create `lib/viewHelpers.js`:

```js
// Handlebars view helpers, kept in one place so they're unit-testable and
// registered from a single import in app.js.

// Integer percentage of part within whole; 0 when whole is 0 (used for bar widths).
export const percent = (part, whole) => (whole ? Math.round((Number(part) / Number(whole)) * 100) : 0);

// String-equality helper for template subexpressions, e.g. selecting an <option>.
// Compares stringified values so an ObjectId matches its string form.
export const eq = (a, b) => String(a) === String(b);

// Friendly date like "Jul 14, 2026"; empty string for missing/invalid input.
export const formatDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
};
```

- [ ] **Step 4: Rewire `app.js` to use the module**

In `app.js`, add an import near the other imports (after `import { attachUser } from './middleware/auth.js';`):

```js
import { percent, eq, formatDate } from './lib/viewHelpers.js';
```

Replace the current engine registration block:

```js
app.engine(
  'handlebars',
  engine({
    defaultLayout: 'main',
    helpers: {
      // Integer percentage of part within whole; 0 when whole is 0 (used for bar widths).
      percent: (part, whole) => (whole ? Math.round((Number(part) / Number(whole)) * 100) : 0),
    },
  })
);
```

with:

```js
app.engine('handlebars', engine({ defaultLayout: 'main', helpers: { percent, eq, formatDate } }));
```

- [ ] **Step 5: Run the helper test and the full suite**

Run: `node --test "test/viewHelpers.test.js"`
Expected: PASS (3 tests).

Run: `npm test`
Expected: PASS — all existing suites still green (the `percent` helper still works on the deck detail page; `statsRoutes.test.js` asserts rendered bar widths).

- [ ] **Step 6: Commit**

```bash
git add lib/viewHelpers.js test/viewHelpers.test.js app.js
git commit -m "Extract view helpers module; add eq and formatDate"
```

---

### Task 2: Match history list + shared validator

**Files:**
- Modify: `routes/gameRecords.js`
- Create: `views/gameHistory.handlebars`
- Modify: `middleware/auth.js`
- Modify: `views/userDashboard.handlebars`
- Create: `test/gameRecords.test.js`

**Interfaces:**
- Consumes: `eq`, `formatDate` (Task 1).
- Produces: `resolveGameInput({ deckId, opponentDeck, result }, userId) -> { deck, opponent, result } | null` (async; used by Task 3's `PUT`). `GET /game-records` renders `gameHistory` with `{ games, decks, results, filter: { deck, result }, hasFilter }`.

- [ ] **Step 1: Write the failing tests**

Create `test/gameRecords.test.js`:

```js
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

// Log a game for a client and return the created GameRecord document.
const logGame = async (client, deckId, opponent, result) => {
  await client.request('POST', '/game-records', {
    deck_id: deckId.toString(),
    opponent_deck: opponent,
    result,
  });
  return GameRecord.findOne({ opponentDeck: opponent }).sort({ createdAt: -1 });
};

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
  await logGame(alice, aggro._id, 'Burn', 'win');
  await logGame(alice, aggro._id, 'Tron', 'loss');
  await logGame(alice, control._id, 'Goblins', 'win');
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

export { makeClient, logGame };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/gameRecords.test.js"`
Expected: FAIL — `GET /game-records` has no handler yet (returns 404, so "Match History" is absent).

- [ ] **Step 3: Add the shared validator and refactor the create route**

In `routes/gameRecords.js`, replace the entire file with:

```js
import express from 'express';
import mongoose from 'mongoose';
import { Deck, GameRecord, GAME_RESULTS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Validate a game-record submission for a user. Returns the owned deck, the
// trimmed opponent, and the result on success; null if anything is invalid.
const resolveGameInput = async ({ deckId, opponentDeck, result }, userId) => {
  const opponent = (opponentDeck || '').trim();
  if (!GAME_RESULTS.includes(result) || !opponent) return null;
  if (!mongoose.Types.ObjectId.isValid(deckId)) return null;
  const deck = await Deck.findOne({ _id: deckId, owner: userId });
  if (!deck) return null;
  return { deck, opponent, result };
};

// Match history: the user's games, newest-first, with optional deck/result filters.
router.get('/game-records', requireAuth, async (req, res, next) => {
  try {
    const userId = req.currentUser._id;
    const decks = await Deck.find({ owner: userId }).sort({ name: 1 }).lean();

    const filter = { user: userId };
    const deckIds = new Set(decks.map((d) => d._id.toString()));
    if (req.query.deck && deckIds.has(req.query.deck)) filter.deck = req.query.deck;
    if (GAME_RESULTS.includes(req.query.result)) filter.result = req.query.result;

    const games = await GameRecord.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .populate('deck', 'name')
      .lean();

    res.render('gameHistory', {
      title: 'Match History',
      games,
      decks,
      results: GAME_RESULTS,
      filter: { deck: filter.deck ?? '', result: filter.result ?? '' },
      hasFilter: Boolean(filter.deck || filter.result),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/game-records', requireAuth, async (req, res, next) => {
  try {
    const input = await resolveGameInput(
      { deckId: req.body.deck_id, opponentDeck: req.body.opponent_deck, result: req.body.result },
      req.currentUser._id
    );
    // Silently ignore invalid quick-log input, matching prior behavior.
    if (!input) return res.redirect('/dashboard');

    await GameRecord.create({
      user: req.currentUser._id,
      deck: input.deck._id,
      opponentDeck: input.opponent,
      result: input.result,
    });
    res.redirect('/dashboard');
  } catch (err) {
    next(err);
  }
});

export { router as gameRecordsRouter };
```

- [ ] **Step 4: Create the history view**

Create `views/gameHistory.handlebars`:

```handlebars
<main>
  <h1>Match History</h1>
  <p><a href="/dashboard" class="button">&larr; Dashboard</a></p>

  <form action="/game-records" method="GET" class="filter-bar">
    <div class="form-group">
      <label for="deck">Deck</label>
      <select name="deck" id="deck">
        <option value="">All decks</option>
        {{#each decks}}
          <option value="{{this._id}}" {{#if (eq this._id ../filter.deck)}}selected{{/if}}>{{this.name}}</option>
        {{/each}}
      </select>
    </div>
    <div class="form-group">
      <label for="result">Result</label>
      <select name="result" id="result">
        <option value="">All results</option>
        {{#each results}}
          <option value="{{this}}" {{#if (eq this ../filter.result)}}selected{{/if}}>{{this}}</option>
        {{/each}}
      </select>
    </div>
    <button type="submit" class="submit-button">Apply</button>
    {{#if hasFilter}}<a href="/game-records" class="button cancel-button">Clear</a>{{/if}}
  </form>

  {{#if games.length}}
    <table class="history-table">
      <thead>
        <tr><th>Date</th><th>Deck</th><th>Opponent</th><th>Result</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {{#each games}}
          <tr>
            <td>{{formatDate this.createdAt}}</td>
            <td>{{#if this.deck}}{{this.deck.name}}{{else}}&mdash;{{/if}}</td>
            <td>{{this.opponentDeck}}</td>
            <td class="result-{{this.result}}">{{this.result}}</td>
            <td class="row-actions">
              <a href="/game-records/{{this._id}}/edit">Edit</a>
              <a href="/game-records/{{this._id}}/delete">Delete</a>
            </td>
          </tr>
        {{/each}}
      </tbody>
    </table>
  {{else}}
    <p>{{#if hasFilter}}No games match this filter.{{else}}You haven't logged any games yet.{{/if}}</p>
  {{/if}}
</main>
```

- [ ] **Step 5: Add the nav link and dashboard link**

In `middleware/auth.js`, in the `loggedInNav` array, add a Match History entry after the Dashboard entry:

```js
  { link: '/dashboard', text: 'Dashboard' },
  { link: '/game-records', text: 'Match History' },
  { link: '/logout', text: 'Logout' },
```

In `views/userDashboard.handlebars`, add a link under the "Enter Game Records" heading. Change:

```handlebars
<h2>Enter Game Records</h2>
```

to:

```handlebars
<h2>Enter Game Records</h2>
    <p><a href="/game-records">View match history</a></p>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "test/gameRecords.test.js"`
Expected: PASS (3 tests).

Run: `npm test`
Expected: PASS — all suites green (the create-route refactor keeps `integration.test.js`'s "logging a game" green).

- [ ] **Step 7: Commit**

```bash
git add routes/gameRecords.js views/gameHistory.handlebars middleware/auth.js views/userDashboard.handlebars test/gameRecords.test.js
git commit -m "Add match history list with deck/result filters"
```

---

### Task 3: Edit a game record

**Files:**
- Modify: `routes/gameRecords.js`
- Create: `views/gameRecordForm.handlebars`
- Modify: `test/gameRecords.test.js`

**Interfaces:**
- Consumes: `resolveGameInput` (Task 2), `eq` (Task 1), `makeClient`/`logGame` (Task 2 test).
- Produces: `GET /game-records/:id/edit` (renders `gameRecordForm`), `PUT /game-records/:id`.

- [ ] **Step 1: Write the failing tests**

Append to `test/gameRecords.test.js` (before the `export { makeClient, logGame };` line):

```js
test('edit page pre-fills and PUT updates the record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, 'EditMe', 'win');

  const form = await alice.request('GET', `/game-records/${rec._id}/edit`);
  assert.equal(form.status, 200);
  assert.match(form.text, /Edit Game/);
  assert.match(form.text, /EditMe/); // opponent pre-filled

  const control = await Deck.findOne({ name: 'Control' });
  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: control._id.toString(),
    opponent_deck: 'Storm',
    result: 'draw',
  });
  assert.equal(put.status, 302);
  assert.equal(put.location, '/game-records');

  const updated = await GameRecord.findById(rec._id).lean();
  assert.equal(updated.opponentDeck, 'Storm');
  assert.equal(updated.result, 'draw');
  assert.equal(updated.deck.toString(), control._id.toString());
});

test('PUT with an empty opponent re-renders the form with an error and no change', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, 'KeepMe', 'win');

  const put = await alice.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    opponent_deck: '   ',
    result: 'win',
  });
  assert.equal(put.status, 400);
  assert.match(put.text, /Edit Game/);

  const unchanged = await GameRecord.findById(rec._id).lean();
  assert.equal(unchanged.opponentDeck, 'KeepMe');
});

test('a user cannot view or edit another user\'s record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, 'AlicesGame', 'win');

  const bob = makeClient();
  await bob.request('POST', '/register', { username_input: 'Bob', password_input: 'hunter2hunter' });

  const view = await bob.request('GET', `/game-records/${rec._id}/edit`);
  assert.equal(view.status, 404);

  const put = await bob.request('PUT', `/game-records/${rec._id}`, {
    deck_id: aggro._id.toString(),
    opponent_deck: 'Hacked',
    result: 'loss',
  });
  assert.equal(put.status, 404);

  const unchanged = await GameRecord.findById(rec._id).lean();
  assert.equal(unchanged.opponentDeck, 'AlicesGame');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/gameRecords.test.js"`
Expected: FAIL — the edit/PUT routes don't exist (GET `/edit` currently 404s with no "Edit Game" text; PUT is unhandled).

- [ ] **Step 3: Add the edit routes**

In `routes/gameRecords.js`, add this helper after `resolveGameInput`:

```js
// Load a record only if it belongs to the user; null for a bad id or non-owner.
const findOwnedRecord = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return GameRecord.findOne({ _id: id, user: userId });
};
```

Then add these routes before the `export` line:

```js
router.get('/game-records/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    const decks = await Deck.find({ owner: req.currentUser._id }).sort({ name: 1 }).lean();
    res.render('gameRecordForm', {
      title: 'Edit Game',
      decks,
      results: GAME_RESULTS,
      values: {
        id: record._id.toString(),
        deck: record.deck.toString(),
        opponentDeck: record.opponentDeck,
        result: record.result,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/game-records/:id', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    const input = await resolveGameInput(
      { deckId: req.body.deck_id, opponentDeck: req.body.opponent_deck, result: req.body.result },
      req.currentUser._id
    );
    if (!input) {
      const decks = await Deck.find({ owner: req.currentUser._id }).sort({ name: 1 }).lean();
      return res.status(400).render('gameRecordForm', {
        title: 'Edit Game',
        hasError: true,
        recordError: 'Please pick one of your decks, name an opponent, and choose a result.',
        decks,
        results: GAME_RESULTS,
        values: {
          id: record._id.toString(),
          deck: (req.body.deck_id || '').toString(),
          opponentDeck: req.body.opponent_deck || '',
          result: req.body.result || '',
        },
      });
    }

    record.deck = input.deck._id;
    record.opponentDeck = input.opponent;
    record.result = input.result;
    await record.save();
    res.redirect('/game-records');
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Create the edit form view**

Create `views/gameRecordForm.handlebars`:

```handlebars
<main class="deck-form-container">
  {{#if hasError}}
    <div class="error-message">{{recordError}}</div>
  {{/if}}
  <h1>Edit Game</h1>
  <form action="/game-records/{{values.id}}" method="POST" class="deck-form">
    <input type="hidden" name="_method" value="PUT" />
    <div class="form-group">
      <label for="deck_id">Deck</label>
      <select name="deck_id" id="deck_id" required>
        {{#each decks}}
          <option value="{{this._id}}" {{#if (eq this._id ../values.deck)}}selected{{/if}}>{{this.name}}</option>
        {{/each}}
      </select>
    </div>
    <div class="form-group">
      <label for="opponent_deck">Opponent's Deck</label>
      <input type="text" name="opponent_deck" id="opponent_deck" required value="{{values.opponentDeck}}" />
    </div>
    <div class="form-group">
      <label for="result">Result</label>
      <select name="result" id="result" required>
        {{#each results}}
          <option value="{{this}}" {{#if (eq this ../values.result)}}selected{{/if}}>{{this}}</option>
        {{/each}}
      </select>
    </div>
    <div class="form-actions">
      <button type="submit" class="submit-button">Save Changes</button>
      <a href="/game-records" class="button cancel-button">Cancel</a>
    </div>
  </form>
</main>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "test/gameRecords.test.js"`
Expected: PASS (Task 2 tests + 3 new edit tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add routes/gameRecords.js views/gameRecordForm.handlebars test/gameRecords.test.js
git commit -m "Add game record edit with ownership checks and validation"
```

---

### Task 4: Delete a game record

**Files:**
- Modify: `routes/gameRecords.js`
- Create: `views/gameRecordDelete.handlebars`
- Modify: `test/gameRecords.test.js`

**Interfaces:**
- Consumes: `findOwnedRecord` (Task 3), `formatDate` (Task 1), `makeClient`/`logGame` (Task 2 test).
- Produces: `GET /game-records/:id/delete` (renders `gameRecordDelete`), `DELETE /game-records/:id`.

- [ ] **Step 1: Write the failing tests**

Append to `test/gameRecords.test.js` (before the `export { makeClient, logGame };` line):

```js
test('delete confirmation renders and DELETE removes the record', async () => {
  const aggro = await Deck.findOne({ name: 'Aggro' });
  const rec = await logGame(alice, aggro._id, 'DeleteMe', 'loss');

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
  const rec = await logGame(alice, aggro._id, 'DontDeleteMe', 'win');

  const carol = makeClient();
  await carol.request('POST', '/register', { username_input: 'Carol', password_input: 'hunter2hunter' });

  const del = await carol.request('DELETE', `/game-records/${rec._id}`);
  assert.equal(del.status, 404);

  const stillThere = await GameRecord.findById(rec._id).lean();
  assert.notEqual(stillThere, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/gameRecords.test.js"`
Expected: FAIL — the delete confirm/DELETE routes don't exist.

- [ ] **Step 3: Add the delete routes**

In `routes/gameRecords.js`, add these routes before the `export` line:

```js
router.get('/game-records/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const record = await GameRecord.findOne({ _id: req.params.id, user: req.currentUser._id })
      .populate('deck', 'name')
      .lean();
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    res.render('gameRecordDelete', { title: 'Delete Game', record });
  } catch (err) {
    next(err);
  }
});

router.delete('/game-records/:id', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    await record.deleteOne();
    res.redirect('/game-records');
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Create the delete confirmation view**

Create `views/gameRecordDelete.handlebars`:

```handlebars
<main>
  <h1>Delete Game</h1>
  <p>Delete this game record? This can't be undone.</p>
  <div class="deck-card">
    <p><strong>Date:</strong> {{formatDate record.createdAt}}</p>
    <p><strong>Deck:</strong> {{#if record.deck}}{{record.deck.name}}{{else}}&mdash;{{/if}}</p>
    <p><strong>Opponent:</strong> {{record.opponentDeck}}</p>
    <p><strong>Result:</strong> {{record.result}}</p>
  </div>
  <div class="signout-buttons">
    <form action="/game-records/{{record._id}}" method="POST" style="display:inline">
      <input type="hidden" name="_method" value="DELETE" />
      <button type="submit" class="button signout-button">Yes, Delete</button>
    </form>
    <a href="/game-records" class="button cancel-button">Cancel</a>
  </div>
</main>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "test/gameRecords.test.js"`
Expected: PASS (all prior tests + 2 new delete tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add routes/gameRecords.js views/gameRecordDelete.handlebars test/gameRecords.test.js
git commit -m "Add game record delete with confirmation and ownership check"
```

---

### Task 5: Style the history table, filter bar, and actions

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Append the styles**

Add to the end of `public/css/style.css`:

```css
/* ============================================================
   MATCH HISTORY
   ============================================================ */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.9rem;
  margin-bottom: 1.4rem;
  padding: 1rem 1.2rem;
  background: var(--paper-deep);
  border: 1px solid var(--rule);
  border-radius: 8px;
}
.filter-bar .form-group { margin-bottom: 0; }
.filter-bar select { min-width: 10rem; }

.history-table {
  width: 100%;
  border-collapse: collapse;
}
.history-table th,
.history-table td {
  text-align: left;
  padding: 0.6rem 0.7rem;
  border-bottom: 1px solid var(--rule);
  font-size: 0.92rem;
}
.history-table th {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.history-table tbody tr:hover { background: rgba(168, 134, 63, 0.08); }

.result-win { color: var(--mana-g); font-weight: 600; text-transform: capitalize; }
.result-loss { color: var(--mana-r); font-weight: 600; text-transform: capitalize; }
.result-draw { color: var(--gold); font-weight: 600; text-transform: capitalize; }

.row-actions { white-space: nowrap; }
.row-actions a {
  color: var(--mana-u);
  font-size: 0.85rem;
  font-weight: 600;
}
.row-actions a:hover { text-decoration: underline; }
.row-actions a + a { margin-left: 0.8rem; }
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `npm test`
Expected: PASS — CSS-only change; all 20+ tests green.

- [ ] **Step 3: Manual visual check**

Run `npm start`, log in, log a couple of games, open "Match History": confirm the filter bar, table, colored results, and Edit/Delete links render cleanly; exercise a filter, an edit, and a delete end to end.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "Style match history table, filter bar, and actions"
```

---

## Self-Review

**Spec coverage:**
- Browsable history newest-first with deck + result filters → Task 2 (`GET /game-records`, `gameHistory.handlebars`, filter tests). ✓
- Edit (pre-filled form, PUT, validation error re-render) → Task 3. ✓
- Delete (confirm page + DELETE) → Task 4. ✓
- Ownership: non-owner edit/PUT/delete → 404, record unchanged → Tasks 3 & 4 tests. ✓
- Shared validator reused by create and edit → `resolveGameInput` (Task 2), consumed by Task 3 PUT; create refactored to use it. ✓
- `_method` PUT/DELETE via forms → hidden inputs in `gameRecordForm`/`gameRecordDelete`. ✓
- Nav link + dashboard link → Task 2. ✓
- No schema changes; server-rendered; no new deps → confirmed across tasks. ✓
- Malformed id / invalid filter handling → `findOwnedRecord` isValid guard, deck/result filter validation (Task 2). ✓
- Own test DB `mtg_tracker_games_test`, repeated-key array form fields → Task 2 harness. ✓
- Testing list of the spec (list, filter-by-deck, filter-by-result + invalid ignored, edit, edit-validation, delete, ownership) → covered across Tasks 2-4. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✓

**Type consistency:** `resolveGameInput(...) -> { deck, opponent, result } | null` used identically in create and PUT. `findOwnedRecord(id, userId)` used by edit GET/PUT and DELETE. Helpers `percent`/`eq`/`formatDate` defined in Task 1 and used by all views. Form field names `deck_id`/`opponent_deck`/`result` are consistent between the create route, the edit form, and `resolveGameInput`'s `deckId`/`opponentDeck`/`result` mapping. View context keys (`games`, `decks`, `results`, `filter`, `hasFilter`, `values`, `record`) match between routes and templates. ✓

**Note on the `_method` override:** `app.js`'s `rewriteUnsupportedBrowserMethods` reads `req.body._method`, so the PUT/DELETE forms submit it as a hidden POST body field (not a query param) — reflected in both form views and in the tests, which call `request('PUT'|'DELETE', ...)` directly (the app accepts real method verbs too, since the test client isn't a browser).
