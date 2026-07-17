# Card / Deck Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give decks real card lists sourced from Scryfall — a per-deck manager page to search and add/remove cards, and a read-only card list on the deck detail page.

**Architecture:** All Scryfall access is isolated in `lib/scryfall.js` (base URL from an env var so tests use a local fake server). Cards are embedded on the `Deck` document as a snapshot taken when the card is added (the server re-fetches the card by id — it never trusts client-posted card data). New owner-scoped routes live in `routes/decks.js`.

**Tech Stack:** Node ESM, Express 4, Mongoose, express-handlebars, built-in `fetch`, `node --test`.

## Global Constraints

- All Scryfall access goes through `lib/scryfall.js`; no other module imports `fetch` or knows Scryfall's URL shape.
- Scryfall base URL: `process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com'`, read at call time so tests can point it at a local fake server. Tests never touch the real network.
- No new runtime dependencies (use the built-in global `fetch`).
- Managing a deck's cards (manager page, add, remove) is owner-only: a malformed id or a non-owned deck renders the `404` view with status 404 — never 500, never another user's deck. The read-only card list on the deck detail page is visible to any authenticated user.
- The `Deck.cards` field is an additive, backward-compatible schema change (existing decks default to `cards: []`). No other model changes.
- Adding a card re-fetches it server-side via `getCardById` for an authoritative snapshot; client-posted card fields are never trusted (only `scryfall_id`).
- Search shows the first page, capped at 20 results.
- Card snapshot shape (used everywhere): `{ scryfallId, name, manaCost, cmc, colors[], typeLine, imageUrl, quantity }`.
- Server-rendered; no client JS. Each new test file uses its own DB name (`mtg_tracker_cards_test`) and its own local fake Scryfall server.

---

## File Structure

- **Create** `lib/scryfall.js` — `searchCards(query)`, `getCardById(id)`, and card normalization.
- **Create** `test/scryfall.test.js` — unit tests against a local fake Scryfall server.
- **Modify** `models/Deck.js` — add the embedded `cardSchema` and `cards` field.
- **Modify** `routes/decks.js` — `findOwnedDeck` helper; `GET /decks/:id/cards`, `POST /decks/:id/cards`, `POST /decks/:id/cards/:scryfallId/remove`; add `isOwner`/`cardCount` to the existing `GET /decks/:id`.
- **Create** `views/deckCards.handlebars` — the manager page (search + results + current list).
- **Modify** `views/deckDetail.handlebars` — read-only Cards section + owner-only Manage Cards button.
- **Create** `test/deckCards.test.js` — HTTP integration tests (own DB + fake Scryfall server); created in Task 2, appended to in Tasks 3–5.
- **Modify** `public/css/style.css` — results grid, card tiles, card lists.

---

### Task 1: Scryfall client (`lib/scryfall.js`)

**Files:**
- Create: `lib/scryfall.js`
- Create: `test/scryfall.test.js`

**Interfaces:**
- Produces: `searchCards(query) -> Promise<Card[]>` (≤20 cards; `[]` on no matches); `getCardById(id) -> Promise<Card>`. `Card = { scryfallId, name, manaCost, cmc, colors[], typeLine, imageUrl }`. Consumed by Tasks 2–4.

- [ ] **Step 1: Write the failing tests**

Create `test/scryfall.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { searchCards, getCardById } from '../lib/scryfall.js';

let server;
let baseUrl;

const NORMAL_CARD = {
  id: 'abc-123',
  name: 'Counterspell',
  mana_cost: '{U}{U}',
  cmc: 2,
  colors: ['U'],
  type_line: 'Instant',
  image_uris: { normal: 'http://img/cs.jpg' },
};
const DFC_CARD = {
  id: 'dfc-1',
  name: 'Delver of Secrets // Insectile Aberration',
  cmc: 1,
  colors: ['U'],
  type_line: 'Creature — Human Wizard // Creature — Insect',
  card_faces: [
    { mana_cost: '{U}', image_uris: { normal: 'http://img/delver.jpg' } },
    { mana_cost: '', image_uris: { normal: 'http://img/aberration.jpg' } },
  ],
};

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/cards/search') {
      const q = u.searchParams.get('q');
      if (q === 'counterspell') return res.end(JSON.stringify({ data: [NORMAL_CARD] }));
      if (q === 'many') {
        const data = Array.from({ length: 30 }, (_, i) => ({
          id: `m${i}`, name: `Card ${i}`, mana_cost: '', cmc: 0, colors: [], type_line: 'Land', image_uris: { normal: '' },
        }));
        return res.end(JSON.stringify({ data }));
      }
      res.statusCode = 404; // Scryfall's no-match behavior
      return res.end(JSON.stringify({ object: 'error', details: 'no cards found' }));
    }
    if (u.pathname === '/cards/abc-123') return res.end(JSON.stringify(NORMAL_CARD));
    if (u.pathname === '/cards/dfc-1') return res.end(JSON.stringify(DFC_CARD));
    res.statusCode = 404;
    res.end(JSON.stringify({ object: 'error' }));
  });
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      process.env.SCRYFALL_API_BASE = baseUrl;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('searchCards normalizes a card into the snapshot shape', async () => {
  const cards = await searchCards('counterspell');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    scryfallId: 'abc-123',
    name: 'Counterspell',
    manaCost: '{U}{U}',
    cmc: 2,
    colors: ['U'],
    typeLine: 'Instant',
    imageUrl: 'http://img/cs.jpg',
  });
});

test('searchCards returns [] when Scryfall 404s on no matches', async () => {
  assert.deepEqual(await searchCards('nomatchxyz'), []);
});

test('searchCards caps results at 20', async () => {
  const cards = await searchCards('many');
  assert.equal(cards.length, 20);
});

test('getCardById pulls mana cost and image from the front face of a DFC', async () => {
  const card = await getCardById('dfc-1');
  assert.equal(card.manaCost, '{U}');
  assert.equal(card.imageUrl, 'http://img/delver.jpg');
  assert.equal(card.cmc, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/scryfall.test.js"`
Expected: FAIL — cannot import from `../lib/scryfall.js` (module missing).

- [ ] **Step 3: Create the Scryfall client**

Create `lib/scryfall.js`:

```js
// Isolated Scryfall client. Base URL is read at call time so tests can point it
// at a local fake server via SCRYFALL_API_BASE.
const base = () => process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com';

// Scryfall asks callers to send an Accept header and a descriptive User-Agent.
const HEADERS = { Accept: 'application/json', 'User-Agent': 'PersonalMTGTracker/1.0' };

// Normalize a raw Scryfall card into our stored snapshot shape. Double-faced cards
// carry mana cost / image on card_faces[0] rather than the top level.
const normalizeCard = (raw) => {
  const face = Array.isArray(raw.card_faces) ? raw.card_faces[0] : undefined;
  return {
    scryfallId: raw.id,
    name: raw.name,
    manaCost: raw.mana_cost ?? face?.mana_cost ?? '',
    cmc: raw.cmc ?? 0,
    colors: raw.colors ?? [],
    typeLine: raw.type_line ?? '',
    imageUrl: raw.image_uris?.normal ?? face?.image_uris?.normal ?? '',
  };
};

// Search cards; returns up to 20 normalized cards. Scryfall replies 404 when a
// search has no matches — treat that as empty results, not an error.
export const searchCards = async (query) => {
  const res = await fetch(`${base()}/cards/search?q=${encodeURIComponent(query)}`, { headers: HEADERS });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Scryfall search failed: ${res.status}`);
  const body = await res.json();
  return (body.data ?? []).slice(0, 20).map(normalizeCard);
};

// Fetch a single card by Scryfall id and normalize it. Throws on a non-OK response.
export const getCardById = async (id) => {
  const res = await fetch(`${base()}/cards/${encodeURIComponent(id)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Scryfall card fetch failed: ${res.status}`);
  return normalizeCard(await res.json());
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/scryfall.test.js"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/scryfall.js test/scryfall.test.js
git commit -m "Add isolated Scryfall client with card normalization"
```

---

### Task 2: Deck cards schema + manager page (search)

**Files:**
- Modify: `models/Deck.js`
- Modify: `routes/decks.js`
- Create: `views/deckCards.handlebars`
- Create: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `searchCards` (Task 1).
- Produces: `findOwnedDeck(id, userId) -> Deck document | null` (used by Tasks 3–4); `GET /decks/:id/cards` rendering `deckCards`. The `deckCards` view references `POST /decks/:id/cards` (Task 3) and `POST /decks/:id/cards/:scryfallId/remove` (Task 4) — those routes land in later tasks; the forms are inert until then.

- [ ] **Step 1: Write the failing tests**

Create `test/deckCards.test.js`:

```js
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

export { makeClient, aliceDeck };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckCards.test.js"`
Expected: FAIL — `GET /decks/:id/cards` has no handler (returns 404 with no "Manage Cards" text).

- [ ] **Step 3: Add the `cards` field to the Deck model**

In `models/Deck.js`, add this subdocument schema immediately before `const deckSchema = ...`:

```js
// One card entry embedded in a deck — a snapshot of Scryfall data taken on add,
// so deck views never need to call Scryfall. No own _id; identity is scryfallId.
const cardSchema = new mongoose.Schema(
  {
    scryfallId: { type: String, required: true },
    name: { type: String, required: true },
    manaCost: { type: String, default: '' },
    cmc: { type: Number, default: 0 },
    colors: [{ type: String }],
    typeLine: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    quantity: { type: Number, default: 1, min: 1 },
  },
  { _id: false }
);
```

Then add a `cards` field to `deckSchema` (after the `description` field, before the closing `}` of the schema fields):

```js
    description: {
      type: String,
    },
    // Card list, built from Scryfall via the deck's Manage Cards page.
    cards: [cardSchema],
```

- [ ] **Step 4: Add the manager route**

In `routes/decks.js`, add to the imports at the top:

```js
import { searchCards, getCardById } from '../lib/scryfall.js';
```

Add this helper after `const router = express.Router();`:

```js
// Load a deck only if it belongs to the user; null for a bad id or non-owner.
const findOwnedDeck = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Deck.findOne({ _id: id, owner: userId });
};
```

Add this route after the existing `GET /decks/:id` handler, before the `export` line:

```js
router.get('/decks/:id/cards', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const query = (req.query.q || '').trim();
    const searched = query.length > 0;
    const results = searched ? await searchCards(query) : [];

    res.render('deckCards', {
      title: `Manage: ${deck.name}`,
      deck: deck.toObject(),
      query,
      searched,
      results,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Create the manager view**

Create `views/deckCards.handlebars`:

```handlebars
<main>
  <p><a href="/decks/{{deck._id}}">&larr; Back to {{deck.name}}</a></p>
  <h1>Manage Cards: {{deck.name}}</h1>

  <form action="/decks/{{deck._id}}/cards" method="GET" class="card-search">
    <input type="text" name="q" value="{{query}}" placeholder="Search Scryfall (e.g. counterspell, t:creature c:u)" />
    <button type="submit" class="submit-button">Search</button>
  </form>

  {{#if searched}}
    <section class="card-results">
      <h2>Results</h2>
      {{#if results.length}}
        <div class="card-grid">
          {{#each results}}
            <div class="card-tile">
              {{#if this.imageUrl}}<img src="{{this.imageUrl}}" alt="{{this.name}}" loading="lazy" />{{/if}}
              <div class="card-tile__body">
                <span class="card-tile__name">{{this.name}}</span>
                <span class="card-tile__meta">{{this.manaCost}} &middot; {{this.typeLine}}</span>
                <form action="/decks/{{../deck._id}}/cards" method="POST">
                  <input type="hidden" name="scryfall_id" value="{{this.scryfallId}}" />
                  <input type="hidden" name="q" value="{{../query}}" />
                  <button type="submit" class="button">Add</button>
                </form>
              </div>
            </div>
          {{/each}}
        </div>
      {{else}}
        <p>No cards found for &ldquo;{{query}}&rdquo;.</p>
      {{/if}}
    </section>
  {{/if}}

  <section class="deck-cardlist">
    <h2>In this deck</h2>
    {{#if deck.cards.length}}
      <ul class="cardlist">
        {{#each deck.cards}}
          <li>
            <span class="cardlist__qty">{{this.quantity}}&times;</span>
            <span class="cardlist__name">{{this.name}}</span>
            <span class="cardlist__meta">{{this.manaCost}}</span>
            <form action="/decks/{{../deck._id}}/cards/{{this.scryfallId}}/remove" method="POST" style="display:inline">
              <button type="submit" class="button cancel-button">Remove</button>
            </form>
          </li>
        {{/each}}
      </ul>
    {{else}}
      <p>No cards yet. Search above to add some.</p>
    {{/if}}
  </section>
</main>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "test/deckCards.test.js"`
Expected: PASS (3 tests).

Run: `npm test`
Expected: PASS — all suites green (the additive `cards` field doesn't affect existing deck behavior).

- [ ] **Step 7: Commit**

```bash
git add models/Deck.js routes/decks.js views/deckCards.handlebars test/deckCards.test.js
git commit -m "Add deck card manager page with Scryfall search"
```

---

### Task 3: Add a card to a deck

**Files:**
- Modify: `routes/decks.js`
- Modify: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `findOwnedDeck` (Task 2), `getCardById` (Task 1), `makeClient`/`aliceDeck` (Task 2 test).
- Produces: `POST /decks/:id/cards`.

- [ ] **Step 1: Write the failing tests**

Append to `test/deckCards.test.js` (before the `export { makeClient, aliceDeck };` line):

```js
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
  const carol = makeClient();
  await carol.request('POST', '/register', { username_input: 'Carol', password_input: 'hunter2hunter' });
  const res = await carol.request('POST', `/decks/${deck._id}/cards`, { scryfall_id: 'abc-123' });
  assert.equal(res.status, 404);

  const updated = await aliceDeck();
  assert.equal(updated.cards.filter((c) => c.scryfallId === 'abc-123').length, 1); // unchanged (qty still one entry)
});
```

Note: these tests run in order — the first adds the card (qty 1), the second increments to 2, the third confirms a non-owner can't touch it. They share Alice's deck deliberately.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckCards.test.js"`
Expected: FAIL — `POST /decks/:id/cards` has no handler (the add returns 404, not 302).

- [ ] **Step 3: Add the route**

In `routes/decks.js`, add after the `GET /decks/:id/cards` handler, before the `export` line:

```js
router.post('/decks/:id/cards', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const scryfallId = (req.body.scryfall_id || '').trim();
    const q = (req.body.q || '').trim();
    const back = q ? `/decks/${deck._id}/cards?q=${encodeURIComponent(q)}` : `/decks/${deck._id}/cards`;
    if (!scryfallId) return res.redirect(back);

    // Re-fetch the card server-side for an authoritative snapshot; never trust
    // client-posted card fields.
    const card = await getCardById(scryfallId);
    const existing = deck.cards.find((c) => c.scryfallId === card.scryfallId);
    if (existing) existing.quantity += 1;
    else deck.cards.push({ ...card, quantity: 1 });
    await deck.save();

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/deckCards.test.js"`
Expected: PASS (Task 2 tests + 3 new add tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add routes/decks.js test/deckCards.test.js
git commit -m "Add card-to-deck route with authoritative snapshot"
```

---

### Task 4: Remove a card from a deck

**Files:**
- Modify: `routes/decks.js`
- Modify: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `findOwnedDeck` (Task 2), `makeClient`/`aliceDeck` (Task 2 test).
- Produces: `POST /decks/:id/cards/:scryfallId/remove`.

- [ ] **Step 1: Write the failing tests**

Append to `test/deckCards.test.js` (before the `export { makeClient, aliceDeck };` line):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckCards.test.js"`
Expected: FAIL — `POST /decks/:id/cards/:scryfallId/remove` has no handler (returns 404 for the owner's decrement, so the 302 assertion fails).

- [ ] **Step 3: Add the route**

In `routes/decks.js`, add after the `POST /decks/:id/cards` handler, before the `export` line:

```js
router.post('/decks/:id/cards/:scryfallId/remove', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const card = deck.cards.find((c) => c.scryfallId === req.params.scryfallId);
    if (card) {
      card.quantity -= 1;
      if (card.quantity <= 0) {
        deck.cards = deck.cards.filter((c) => c.scryfallId !== req.params.scryfallId);
      }
      await deck.save();
    }
    res.redirect(`/decks/${deck._id}/cards`);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/deckCards.test.js"`
Expected: PASS (all prior tests + 2 new remove tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add routes/decks.js test/deckCards.test.js
git commit -m "Add remove-card route with decrement-to-delete"
```

---

### Task 5: Card list on the deck detail page

**Files:**
- Modify: `routes/decks.js`
- Modify: `views/deckDetail.handlebars`
- Modify: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `makeClient`/`aliceDeck` (Task 2 test).
- Produces: `GET /decks/:id` now also passes `isOwner` (boolean) and `cardCount` (number) to `deckDetail`.

- [ ] **Step 1: Write the failing tests**

Append to `test/deckCards.test.js` (before the `export { makeClient, aliceDeck };` line):

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckCards.test.js"`
Expected: FAIL — the deck detail page renders neither the card list nor a "Manage Cards" button yet.

- [ ] **Step 3: Pass `isOwner`/`cardCount` from the route**

In `routes/decks.js`, replace the body of the existing `GET /decks/:id` handler's `try` block (the part after loading `deck` and `stats`) so the render call becomes:

```js
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, cardCount });
```

(The lines loading the deck and the two 404 guards above stay exactly as they are.)

- [ ] **Step 4: Add the Cards section to the deck detail view**

In `views/deckDetail.handlebars`, insert this section immediately after the closing `</p>` of the `deck-meta` block (line 6, before the `<section class="deck-stats">` Record block):

```handlebars
  <section class="deck-cards-view">
    <div class="deck-cards-view__head">
      <h2>Cards ({{cardCount}})</h2>
      {{#if isOwner}}<a href="/decks/{{deck._id}}/cards" class="button">Manage Cards</a>{{/if}}
    </div>
    {{#if deck.cards.length}}
      <ul class="cardlist">
        {{#each deck.cards}}
          <li>
            <span class="cardlist__qty">{{this.quantity}}&times;</span>
            <span class="cardlist__name">{{this.name}}</span>
            <span class="cardlist__meta">{{this.manaCost}} &middot; {{this.typeLine}}</span>
          </li>
        {{/each}}
      </ul>
    {{else}}
      <p>No cards in this deck yet.{{#if isOwner}} <a href="/decks/{{deck._id}}/cards">Add some</a>.{{/if}}</p>
    {{/if}}
  </section>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "test/deckCards.test.js"`
Expected: PASS (all prior tests + 2 new detail tests).

Run: `npm test`
Expected: PASS — including `test/statsRoutes.test.js` (its deck detail assertions are unaffected; that deck simply has 0 cards and renders "No cards in this deck yet").

- [ ] **Step 6: Commit**

```bash
git add routes/decks.js views/deckDetail.handlebars test/deckCards.test.js
git commit -m "Show deck card list and owner-only Manage button on deck page"
```

---

### Task 6: Style the manager, results grid, and card lists

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Append the styles**

Add to the end of `public/css/style.css`:

```css
/* ============================================================
   CARD MANAGER & CARD LISTS
   ============================================================ */
.card-search {
  display: flex;
  gap: 0.7rem;
  margin-bottom: 1.6rem;
}
.card-search input {
  flex: 1;
  padding: 0.6rem 0.7rem;
  font-family: inherit;
  font-size: 0.95rem;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 4px;
}
.card-search input:focus {
  outline: none;
  border-color: var(--mana-u);
  box-shadow: 0 0 0 3px rgba(31, 92, 153, 0.18);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 1rem;
  margin-bottom: 1.6rem;
}
.card-tile {
  background: #fbf8ef;
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
}
.card-tile img { width: 100%; height: auto; display: block; }
.card-tile__body { padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.35rem; }
.card-tile__name { font-family: 'Cinzel', serif; font-weight: 600; font-size: 0.95rem; }
.card-tile__meta { font-size: 0.8rem; color: var(--ink-soft); }
.card-tile form { margin-top: 0.3rem; }
.card-tile .button { width: 100%; text-align: center; }

.cardlist { list-style: none; margin: 0; padding: 0; }
.cardlist li {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.45rem 0.2rem;
  border-bottom: 1px solid var(--rule);
}
.cardlist__qty { font-weight: 700; color: var(--ink-soft); min-width: 2.2rem; }
.cardlist__name { font-weight: 600; }
.cardlist__meta { color: var(--ink-soft); font-size: 0.85rem; margin-left: auto; }
.cardlist li form { margin-left: 0.8rem; }

.deck-cards-view { margin-bottom: 1.6rem; }
.deck-cards-view__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `npm test`
Expected: PASS — CSS-only change; all suites green.

- [ ] **Step 3: Manual visual check**

Run `npm start`, log in, open a deck, click "Manage Cards", search (e.g. `counterspell`), add a couple of cards, and confirm the results grid, thumbnails, current-list, and the deck-detail Cards section render cleanly; exercise add and remove.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "Style card manager, results grid, and card lists"
```

---

## Self-Review

**Spec coverage:**
- `lib/scryfall.js` with `searchCards`/`getCardById`, env-var base URL, 20-cap, no-match → `[]`, DFC normalization → Task 1 + tests. ✓
- Embedded `cards` snapshot field on `Deck` (additive) → Task 2. ✓
- `findOwnedDeck` owner-scoped helper → Task 2. ✓
- `GET /decks/:id/cards` manager with live search → Task 2 + view + tests. ✓
- `POST /decks/:id/cards` add, re-fetch snapshot, increment, preserve `q` → Task 3 + tests. ✓
- `POST /decks/:id/cards/:scryfallId/remove` decrement/delete → Task 4 + tests. ✓
- Deck detail read-only card list + owner-only Manage button + `isOwner`/`cardCount` → Task 5 + tests. ✓
- Ownership (non-owner manage/add/remove → 404, deck unchanged) → Tasks 2–4 tests. ✓
- No-results UI; snapshot-not-client-data; server-rendered; no new deps → Tasks 1–3. ✓
- Own test DB + local fake Scryfall server → Tasks 1 & 2 harness. ✓
- Testing list from the spec (normalization incl. DFC + no-match; search render; add snapshot; increment; remove; ownership; detail owner vs non-owner) → covered across Tasks 1–5. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✓

**Type consistency:** The `Card` snapshot shape `{ scryfallId, name, manaCost, cmc, colors, typeLine, imageUrl }` is produced by `lib/scryfall.js` (Task 1) and stored via `cardSchema` (Task 2, adding `quantity`) and consumed identically in views and tests. `findOwnedDeck(id, userId)` returns a Mongoose document (not lean) so Tasks 3–4 can `.save()`; the manager GET uses `.toObject()` for rendering. Form field name `scryfall_id` is consistent between the view's Add form, the POST route, and the tests. Route params `:id`/`:scryfallId` match between routes, view form actions, and tests. `isOwner`/`cardCount` produced by `GET /decks/:id` (Task 5) match the `deckDetail` template. ✓

**Note on env timing:** `lib/scryfall.js` reads `SCRYFALL_API_BASE` via `base()` at call time (not at import), so the integration test setting the env var in `before()` — after `app.js` is imported at the top of the file — still routes Scryfall calls to the fake server.

**Note on route non-shadowing:** `GET /decks/:id` matches a single path segment after `/decks`, so it never captures `/decks/:id/cards` (two segments). The literal `GET /decks/new` remains registered before `/decks/:id`. Order among the new `/decks/:id/cards...` routes is method/path-distinct.
