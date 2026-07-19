# Social: Deck Discovery + Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing (dead) `User.trackedDecks` field and the already-public deck pages into a real feature: a Browse Decks page and Track/Untrack controls.

**Architecture:** New owner-agnostic routes in `routes/decks.js` toggle `trackedDecks` with atomic `$addToSet`/`$pull`. Track state is derived in memory from `req.currentUser.trackedDecks` (already loaded by `attachUser`), so read pages need no extra queries. Redirects are validated to local paths to prevent open-redirects.

**Tech Stack:** Node ESM, Express 4, Mongoose, express-handlebars, `node --test`.

## Global Constraints

- No schema changes: `User.trackedDecks` (array of `Deck` ObjectIds) already exists.
- No new runtime dependencies; server-rendered; all decks remain public (existing behavior).
- All new routes are `requireAuth`. Track/untrack redirect to a caller-supplied `back` field, validated by `safeBack` to a local relative path (starts with a single `/`); default `/decks/:id`. Never 500 on a malformed id — redirect instead.
- You cannot track your own deck. Track uses `$addToSet` (idempotent); untrack uses `$pull` (idempotent).
- Track state on read pages is derived from `req.currentUser.trackedDecks` in memory (no extra DB reads).
- Tests use `node --test` with a dedicated DB name `mtg_tracker_social_test` and an HTTP harness driving two distinct users.

---

## File Structure

- **Modify** `routes/decks.js` — `safeBack` helper; `GET /decks` (browse); `POST /decks/:id/track`; `POST /decks/:id/untrack`; `isTracked` added to `GET /decks/:id`.
- **Create** `views/deckBrowse.handlebars` — browse page (format filter + deck rows with track controls).
- **Modify** `views/deckDetail.handlebars` — Track/Untrack control for non-owners.
- **Modify** `views/userDashboard.handlebars` — Untrack button on each tracked-deck card; link tracked names.
- **Modify** `middleware/auth.js` — "Browse Decks" link in the logged-in nav.
- **Modify** `public/css/style.css` — `.track-label` styling.
- **Create** `test/deckTracking.test.js` — HTTP integration tests (own DB, two users); created in Task 1, appended to in Tasks 2–3.

---

### Task 1: Track / Untrack routes + deck-detail control

**Files:**
- Modify: `routes/decks.js`
- Modify: `views/deckDetail.handlebars`
- Create: `test/deckTracking.test.js`

**Interfaces:**
- Produces: `safeBack(value, fallback) -> string` (local path or fallback); `POST /decks/:id/track`, `POST /decks/:id/untrack`; `GET /decks/:id` now passes `isTracked`.

- [ ] **Step 1: Write the failing tests**

Create `test/deckTracking.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, User } from '../models/index.js';

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
let alice;
let bob;

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_social_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  alice = makeClient();
  bob = makeClient();
  await alice.request('POST', '/register', { username_input: 'Alice', password_input: 'hunter2hunter' });
  await bob.request('POST', '/register', { username_input: 'Bob', password_input: 'hunter2hunter' });
  await alice.request('POST', '/decks', { name: 'AliceDeck', format: 'Modern', colors: ['W'] });
  await bob.request('POST', '/decks', { name: 'BobDeck', format: 'Legacy', colors: ['U'] });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('Alice can track Bob\'s deck, idempotently', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' }); // again
  const a = await User.findOne({ username: 'Alice' });
  const matches = a.trackedDecks.filter((id) => id.toString() === bobDeck._id.toString());
  assert.equal(matches.length, 1);
});

test('Alice cannot track her own deck', async () => {
  const aliceDeck = await Deck.findOne({ name: 'AliceDeck' });
  await alice.request('POST', `/decks/${aliceDeck._id}/track`, { back: '/decks' });
  const a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === aliceDeck._id.toString()));
});

test('untracking removes the deck and is a safe no-op when repeated', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' });
  let a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === bobDeck._id.toString()));
  const res = await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' }); // again
  assert.equal(res.status, 302);
  a = await User.findOne({ username: 'Alice' });
  assert.ok(!a.trackedDecks.some((id) => id.toString() === bobDeck._id.toString()));
});

test('deck page shows Track for a non-owner, Untrack once tracked, and neither for the owner', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/untrack`, { back: '/decks' }); // ensure not tracked

  let page = await alice.request('GET', `/decks/${bobDeck._id}`);
  assert.match(page.text, /\/track/); // Track form action present
  assert.doesNotMatch(page.text, /\/untrack/);

  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: `/decks/${bobDeck._id}` });
  page = await alice.request('GET', `/decks/${bobDeck._id}`);
  assert.match(page.text, /\/untrack/); // now Untrack

  const ownerPage = await bob.request('GET', `/decks/${bobDeck._id}`);
  assert.match(ownerPage.text, /Manage Cards/);
  assert.doesNotMatch(ownerPage.text, /\/track/); // owner sees no track/untrack control
});

test('tracking requires auth', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  const anon = makeClient();
  const res = await anon.request('POST', `/decks/${bobDeck._id}/track`, { back: '/decks' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('track rejects a non-local back redirect (no open redirect)', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  const res = await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: 'http://evil.com' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/decks/${bobDeck._id}`); // safe default, not evil.com
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckTracking.test.js"`
Expected: FAIL — the track/untrack routes don't exist (track returns 404/no-op, the deck page has no Track control).

- [ ] **Step 3: Add `User` to the route imports**

In `routes/decks.js`, change the models import to include `User`:

```js
import { Deck, DECK_FORMATS, MTG_COLORS, User } from '../models/index.js';
```

- [ ] **Step 4: Add the `safeBack` helper and the track/untrack routes**

In `routes/decks.js`, add the helper next to the existing `findOwnedDeck` helper (after `const router = express.Router();`):

```js
// Only allow local relative redirects (a path starting with a single '/'),
// never an absolute/scheme URL — prevents open redirects.
const safeBack = (value, fallback) =>
  (typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : fallback);
```

Add these two routes before the `export` line:

```js
router.post('/decks/:id/track', requireAuth, async (req, res, next) => {
  try {
    const back = safeBack(req.body.back, `/decks/${req.params.id}`);
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/decks');

    const deck = await Deck.findById(req.params.id).select('owner').lean();
    // Can't track a missing deck or your own deck.
    if (deck && deck.owner.toString() !== req.currentUser._id.toString()) {
      await User.updateOne(
        { _id: req.currentUser._id },
        { $addToSet: { trackedDecks: deck._id } }
      );
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/untrack', requireAuth, async (req, res, next) => {
  try {
    const back = safeBack(req.body.back, `/decks/${req.params.id}`);
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/decks');

    await User.updateOne(
      { _id: req.currentUser._id },
      { $pull: { trackedDecks: req.params.id } }
    );
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Pass `isTracked` from the deck detail route**

In `routes/decks.js`, in the `GET /decks/:id` handler, replace this block:

```js
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    const insights = getCardInsights(deck.cards || []);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, cardCount, insights });
```

with:

```js
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const isTracked = (req.currentUser.trackedDecks || []).some((t) => t.toString() === deck._id.toString());
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    const insights = getCardInsights(deck.cards || []);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, isTracked, cardCount, insights });
```

- [ ] **Step 6: Add the Track/Untrack control to the deck detail view**

In `views/deckDetail.handlebars`, replace the `.deck-cards-view__head` block:

```handlebars
    <div class="deck-cards-view__head">
      <h2>Cards ({{cardCount}})</h2>
      {{#if isOwner}}<a href="/decks/{{deck._id}}/cards" class="button">Manage Cards</a>{{/if}}
    </div>
```

with:

```handlebars
    <div class="deck-cards-view__head">
      <h2>Cards ({{cardCount}})</h2>
      {{#if isOwner}}
        <a href="/decks/{{deck._id}}/cards" class="button">Manage Cards</a>
      {{else}}
        {{#if isTracked}}
          <form action="/decks/{{deck._id}}/untrack" method="POST" style="display:inline">
            <input type="hidden" name="back" value="/decks/{{deck._id}}" />
            <button type="submit" class="button cancel-button">Untrack</button>
          </form>
        {{else}}
          <form action="/decks/{{deck._id}}/track" method="POST" style="display:inline">
            <input type="hidden" name="back" value="/decks/{{deck._id}}" />
            <button type="submit" class="button">Track</button>
          </form>
        {{/if}}
      {{/if}}
    </div>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test "test/deckTracking.test.js"`
Expected: PASS (6 tests).

Run: `npm test`
Expected: PASS — all suites green (the route additions don't affect existing deck-detail behavior).

- [ ] **Step 8: Commit**

```bash
git add routes/decks.js views/deckDetail.handlebars test/deckTracking.test.js
git commit -m "Add deck track/untrack with safe redirects and deck-page control"
```

---

### Task 2: Browse Decks page

**Files:**
- Modify: `routes/decks.js`
- Create: `views/deckBrowse.handlebars`
- Modify: `middleware/auth.js`
- Modify: `test/deckTracking.test.js`

**Interfaces:**
- Consumes: track/untrack routes (Task 1), the `eq` view helper.
- Produces: `GET /decks` rendering `deckBrowse` with `{ decks: [{_id,name,format,colors,owner,isOwner,isTracked}], formats, filter, hasFilter }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/deckTracking.test.js` (at the end of the file, after the last test):

```js
test('browse lists decks from all users', async () => {
  const res = await alice.request('GET', '/decks');
  assert.equal(res.status, 200);
  assert.match(res.text, /Browse Decks/);
  assert.match(res.text, /AliceDeck/);
  assert.match(res.text, /BobDeck/);
});

test('browse filters by format', async () => {
  const res = await alice.request('GET', '/decks?format=Legacy'); // BobDeck is Legacy
  assert.equal(res.status, 200);
  assert.match(res.text, /BobDeck/);
  assert.doesNotMatch(res.text, /AliceDeck/); // Modern deck excluded
});

test('browse labels your own deck as Yours', async () => {
  const res = await alice.request('GET', '/decks');
  assert.match(res.text, /Yours/); // AliceDeck row
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/deckTracking.test.js"`
Expected: FAIL — `GET /decks` has no handler (no "Browse Decks" text).

- [ ] **Step 3: Add the browse route**

In `routes/decks.js`, add this handler immediately after the existing `GET /decks/new` handler:

```js
router.get('/decks', requireAuth, async (req, res, next) => {
  try {
    const filter = {};
    if (DECK_FORMATS.includes(req.query.format)) filter.format = req.query.format;

    const decks = await Deck.find(filter)
      .sort({ createdAt: -1 })
      .populate('owner', 'username')
      .lean();

    const trackedIds = new Set((req.currentUser.trackedDecks || []).map((id) => id.toString()));
    const userId = req.currentUser._id.toString();
    const rows = decks.map((d) => ({
      _id: d._id,
      name: d.name,
      format: d.format,
      colors: d.colors,
      owner: d.owner?.username ?? '—',
      isOwner: d.owner?._id?.toString() === userId,
      isTracked: trackedIds.has(d._id.toString()),
    }));

    res.render('deckBrowse', {
      title: 'Browse Decks',
      decks: rows,
      formats: DECK_FORMATS,
      filter: { format: filter.format ?? '' },
      hasFilter: Boolean(filter.format),
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Create the browse view**

Create `views/deckBrowse.handlebars`:

```handlebars
<main>
  <h1>Browse Decks</h1>

  <form action="/decks" method="GET" class="filter-bar">
    <div class="form-group">
      <label for="format">Format</label>
      <select name="format" id="format">
        <option value="">All formats</option>
        {{#each formats}}
          <option value="{{this}}" {{#if (eq this ../filter.format)}}selected{{/if}}>{{this}}</option>
        {{/each}}
      </select>
    </div>
    <button type="submit" class="submit-button">Apply</button>
    {{#if hasFilter}}<a href="/decks" class="button cancel-button">Clear</a>{{/if}}
  </form>

  {{#if decks.length}}
    <section class="active-decks">
      {{#each decks}}
        <div class="deck-card">
          <h3><a href="/decks/{{this._id}}">{{this.name}}</a></h3>
          <p>By {{this.owner}} &middot; {{this.format}}{{#if this.colors.length}} &middot; {{#each this.colors}}{{this}} {{/each}}{{/if}}</p>
          {{#if this.isOwner}}
            <span class="track-label">Yours</span>
          {{else}}
            {{#if this.isTracked}}
              <span class="track-label">Tracked &check;</span>
              <form action="/decks/{{this._id}}/untrack" method="POST" style="display:inline">
                <input type="hidden" name="back" value="/decks" />
                <button type="submit" class="button cancel-button">Untrack</button>
              </form>
            {{else}}
              <form action="/decks/{{this._id}}/track" method="POST" style="display:inline">
                <input type="hidden" name="back" value="/decks" />
                <button type="submit" class="button">Track</button>
              </form>
            {{/if}}
          {{/if}}
        </div>
      {{/each}}
    </section>
  {{else}}
    <p>{{#if hasFilter}}No decks match this format.{{else}}No decks yet.{{/if}}</p>
  {{/if}}
</main>
```

- [ ] **Step 5: Add the nav link**

In `middleware/auth.js`, add a Browse Decks entry to `loggedInNav`, after the Match History entry:

```js
  { link: '/game-records', text: 'Match History' },
  { link: '/decks', text: 'Browse Decks' },
  { link: '/logout', text: 'Logout' },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "test/deckTracking.test.js"`
Expected: PASS (Task 1 tests + 3 browse tests).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 7: Commit**

```bash
git add routes/decks.js views/deckBrowse.handlebars middleware/auth.js test/deckTracking.test.js
git commit -m "Add Browse Decks page with format filter and track controls"
```

---

### Task 3: Dashboard untrack control + styling

**Files:**
- Modify: `views/userDashboard.handlebars`
- Modify: `public/css/style.css`
- Modify: `test/deckTracking.test.js`

**Interfaces:**
- Consumes: the untrack route (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `test/deckTracking.test.js` (at the end of the file):

```js
test('dashboard shows an untrack control for a tracked deck', async () => {
  const bobDeck = await Deck.findOne({ name: 'BobDeck' });
  await alice.request('POST', `/decks/${bobDeck._id}/track`, { back: '/dashboard' });
  const res = await alice.request('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /BobDeck/); // the tracked deck appears
  assert.match(res.text, /\/untrack/); // with an untrack form
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/deckTracking.test.js"`
Expected: FAIL — the dashboard's Tracked Decks cards have no untrack form yet.

- [ ] **Step 3: Add the untrack control to the dashboard view**

In `views/userDashboard.handlebars`, replace the Tracked Decks `{{#each trackedDecks}}` block:

```handlebars
    {{#each trackedDecks}}
      <div class="deck-card">
        <h3>{{this.name}}</h3>
        <p>Format: {{this.format}}</p>
        <p>Created on: {{this.createdAt}}</p>
      </div>
    {{else}}
      <p>You aren't tracking any decks yet.</p>
    {{/each}}
```

with:

```handlebars
    {{#each trackedDecks}}
      <div class="deck-card">
        <h3><a href="/decks/{{this._id}}">{{this.name}}</a></h3>
        <p>Format: {{this.format}}</p>
        <p>Created on: {{this.createdAt}}</p>
        <form action="/decks/{{this._id}}/untrack" method="POST" style="display:inline">
          <input type="hidden" name="back" value="/dashboard" />
          <button type="submit" class="button cancel-button">Untrack</button>
        </form>
      </div>
    {{else}}
      <p>You aren't tracking any decks yet.</p>
    {{/each}}
```

- [ ] **Step 4: Add the track-label style**

Add to the end of `public/css/style.css`:

```css
/* ============================================================
   DECK TRACKING
   ============================================================ */
.track-label {
  display: inline-block;
  margin-right: 0.6rem;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.deck-card form { margin-top: 0.7rem; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "test/deckTracking.test.js"`
Expected: PASS (all prior tests + the dashboard untrack test).

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add views/userDashboard.handlebars public/css/style.css test/deckTracking.test.js
git commit -m "Add dashboard untrack control and tracking styles"
```

---

## Self-Review

**Spec coverage:**
- `safeBack` local-only redirect guard → Task 1 (helper + open-redirect test). ✓
- `POST /decks/:id/track` (`$addToSet`, can't-track-own, malformed-id redirect) → Task 1 + tests. ✓
- `POST /decks/:id/untrack` (`$pull`, idempotent) → Task 1 + tests. ✓
- `GET /decks/:id` passes `isTracked`; deck page shows Track/Untrack for non-owners only → Task 1 + view + test. ✓
- `GET /decks` browse (format filter, owner populated, in-memory track state) → Task 2 + view + tests. ✓
- Browse row controls (Track / Untrack+Tracked / Yours) → Task 2 view. ✓
- "Browse Decks" nav link → Task 2. ✓
- Dashboard untrack button + tracked-name links → Task 3 + test. ✓
- No schema change; requireAuth on all; no extra read-path queries (uses `req.currentUser.trackedDecks`) → Tasks 1–2. ✓
- Own test DB `mtg_tracker_social_test`, two-user harness → Task 1. ✓
- Testing list from the spec (browse+filter, track idempotent, can't-track-own, untrack, deck-page controls, dashboard untrack, auth+safeBack) → covered across Tasks 1–3. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✓

**Type consistency:** `safeBack(value, fallback)` used identically in both track and untrack. Track state key `isTracked` produced by `GET /decks/:id` (Task 1) and the browse rows (Task 2), consumed by `deckDetail`/`deckBrowse`. Form field `back` submitted by every track/untrack form (deck detail `/decks/:id`, browse `/decks`, dashboard `/dashboard`) and read by both routes. Browse row shape (`_id,name,format,colors,owner,isOwner,isTracked`) matches `deckBrowse` usage. `req.currentUser.trackedDecks` is an array of ObjectIds (from `attachUser`'s `.lean()` load), compared via `.toString()`. ✓

**Note on route non-shadowing:** `GET /decks` (exact) is distinct from `GET /decks/new` and `GET /decks/:id` (different path shapes), and `POST /decks/:id/track|untrack` are distinct from the existing `POST /decks`, `POST /decks/:id/cards`, and `POST /decks/:id/cards/:scryfallId/remove`. No route shadows another.
