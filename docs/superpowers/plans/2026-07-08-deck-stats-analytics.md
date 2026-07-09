# Deck Stats & Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface win rates, matchup breakdowns, weekly trends, and an account-wide summary from data already stored in `GameRecord`, with no schema changes.

**Architecture:** A new `lib/stats.js` module aggregates `GameRecord` documents in memory (volumes are tiny for a personal tracker, and plain JS is far easier to unit-test than an aggregation pipeline). The dashboard route calls `getUserSummary` for an account-wide band; a new `GET /decks/:id` route calls `getDeckStats` and renders a deck detail page. Presentation is server-rendered CSS bars — one Handlebars `percent` helper computes bar widths. No new runtime dependencies.

**Tech Stack:** Node ESM, Express 4, Mongoose, express-handlebars, `node --test`.

---

## File Structure

- **Create** `lib/stats.js` — `winRatePercent`, `isoWeekKey` helpers; `getDeckStats(deckId)`, `getUserSummary(userId)`.
- **Create** `test/stats.test.js` — unit tests for the four exports (its own throwaway DB).
- **Create** `test/statsRoutes.test.js` — HTTP integration tests for the dashboard band and deck detail page (its own throwaway DB).
- **Create** `views/deckDetail.handlebars` — deck header, record bars, matchups table, weekly trend.
- **Create** `views/404.handlebars` — minimal not-found page (used by the deck detail route).
- **Modify** `app.js` — register a `percent` Handlebars helper on the engine.
- **Modify** `routes/dashboard.js` — also load and pass `summary`.
- **Modify** `routes/decks.js` — add `GET /decks/:id`.
- **Modify** `views/userDashboard.handlebars` — summary band; deck cards link to detail pages.
- **Modify** `public/css/style.css` — styles for the summary band, stat bars, matchup table.

Each test file uses a **distinct** database name so the three suites (this plus the existing `test/integration.test.js`) never collide when `node --test` runs them in parallel processes.

---

### Task 1: `lib/stats.js` pure helpers (`winRatePercent`, `isoWeekKey`)

**Files:**
- Create: `lib/stats.js`
- Test: `test/stats.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/stats.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winRatePercent, isoWeekKey } from '../lib/stats.js';

test('winRatePercent rounds wins over total games', () => {
  assert.equal(winRatePercent(2, 1, 0), 67); // 2/3 = 66.6 -> 67
  assert.equal(winRatePercent(12, 6, 1), 63); // 12/19 = 63.15 -> 63
});

test('winRatePercent returns 0 for no games (no divide-by-zero)', () => {
  assert.equal(winRatePercent(0, 0, 0), 0);
});

test('isoWeekKey formats a date as ISO year-week', () => {
  // 2026-07-08 falls in ISO week 28; 2026-07-15 in week 29.
  assert.equal(isoWeekKey(new Date('2026-07-08T12:00:00Z')), '2026-W28');
  assert.equal(isoWeekKey(new Date('2026-07-15T12:00:00Z')), '2026-W29');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/stats.test.js"`
Expected: FAIL — cannot import `winRatePercent`/`isoWeekKey` (module or exports missing).

- [ ] **Step 3: Write the minimal implementation**

Create `lib/stats.js`:

```js
// Integer win-rate percent over all games; 0 when there are none (divide-by-zero safe).
export const winRatePercent = (wins, losses, draws) => {
  const total = wins + losses + draws;
  return total === 0 ? 0 : Math.round((wins / total) * 100);
};

// ISO-8601 week key, e.g. "2026-W28". Standard "nearest Thursday" algorithm.
export const isoWeekKey = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test "test/stats.test.js"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/stats.js test/stats.test.js
git commit -m "Add win-rate and ISO-week stat helpers"
```

---

### Task 2: `getDeckStats` — record, matchups, and weekly trend

**Files:**
- Modify: `lib/stats.js`
- Test: `test/stats.test.js`

- [ ] **Step 1: Add DB setup and the failing tests**

Add to the top of `test/stats.test.js`, below the existing imports:

```js
import { before, after, beforeEach } from 'node:test';
import mongoose from 'mongoose';
import { connectMongo } from '../config/db.js';
import { User, Deck, GameRecord } from '../models/index.js';
import { getDeckStats, getUserSummary } from '../lib/stats.js';

before(async () => {
  // Dedicated DB so this suite never collides with the other test files.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_stats_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Deck.deleteMany({}), GameRecord.deleteMany({})]);
});

// Seed one game. When createdAt is given, save with timestamps disabled so
// Mongoose keeps our date instead of overwriting it with "now".
const seedGame = async (deck, user, opponentDeck, result, createdAt) => {
  const doc = new GameRecord({ user: user._id, deck: deck._id, opponentDeck, result });
  if (createdAt) doc.createdAt = createdAt;
  await doc.save({ timestamps: !createdAt });
  return doc;
};

const makeUserAndDeck = async (deckName = 'Test Deck') => {
  const user = await User.create({ username: `u${Date.now()}${Math.random()}`, passwordHash: 'x' });
  const deck = await Deck.create({ name: deckName, format: 'Modern', owner: user._id });
  return { user, deck };
};
```

Then add these tests:

```js
test('getDeckStats returns record and win rate', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'Combo', 'loss');

  const stats = await getDeckStats(deck._id);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.draws, 0);
  assert.equal(stats.total, 3);
  assert.equal(stats.winRate, 67);
});

test('getDeckStats groups matchups case/space-insensitively, sorted by games', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'Aggro', 'win');
  await seedGame(deck, user, 'aggro ', 'loss'); // same opponent, different spelling
  await seedGame(deck, user, 'Combo', 'win');

  const stats = await getDeckStats(deck._id);
  assert.equal(stats.matchups.length, 2);
  assert.equal(stats.matchups[0].opponent, 'Aggro'); // most-games group first
  assert.equal(stats.matchups[0].total, 2);
  assert.equal(stats.matchups[0].wins, 1);
  assert.equal(stats.matchups[0].losses, 1);
  assert.equal(stats.matchups[0].winRate, 50);
  assert.equal(stats.matchups[1].opponent, 'Combo');
  assert.equal(stats.matchups[1].winRate, 100);
});

test('getDeckStats buckets a weekly win-rate trend in chronological order', async () => {
  const { user, deck } = await makeUserAndDeck();
  await seedGame(deck, user, 'X', 'win', new Date('2026-07-06T12:00:00Z')); // week 28
  await seedGame(deck, user, 'X', 'loss', new Date('2026-07-08T12:00:00Z')); // week 28
  await seedGame(deck, user, 'X', 'win', new Date('2026-07-15T12:00:00Z')); // week 29

  const stats = await getDeckStats(deck._id);
  assert.deepEqual(stats.trend, [
    { week: '2026-W28', games: 2, winRate: 50 },
    { week: '2026-W29', games: 1, winRate: 100 },
  ]);
});

test('getDeckStats handles a deck with no games', async () => {
  const { deck } = await makeUserAndDeck();
  const stats = await getDeckStats(deck._id);
  assert.deepEqual(stats, { wins: 0, losses: 0, draws: 0, total: 0, winRate: 0, matchups: [], trend: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/stats.test.js"`
Expected: FAIL — `getDeckStats` is not exported yet (and DB-backed tests error on the missing function).

- [ ] **Step 3: Implement `getDeckStats`**

Add this import block at the very top of `lib/stats.js`, above the existing helpers (`lib/stats.js` lives in `lib/`, so models resolve at `../models/index.js`):

```js
import mongoose from 'mongoose';
import { Deck, GameRecord } from '../models/index.js';
```

Then append this function to the bottom of `lib/stats.js`:

```js
// Full analytics for one deck: overall record, per-opponent matchups, weekly trend.
export const getDeckStats = async (deckId) => {
  const id = new mongoose.Types.ObjectId(deckId);
  const records = await GameRecord.find({ deck: id })
    .select('opponentDeck result createdAt')
    .lean();

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const matchupMap = new Map(); // normalized opponent -> { labels, wins, losses, draws }
  const trendMap = new Map(); // isoWeekKey -> { games, wins }

  for (const r of records) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else draws++;

    const original = (r.opponentDeck || '').trim();
    const key = original.toLowerCase();
    let m = matchupMap.get(key);
    if (!m) {
      m = { labels: new Map(), wins: 0, losses: 0, draws: 0 };
      matchupMap.set(key, m);
    }
    m.labels.set(original, (m.labels.get(original) || 0) + 1);
    if (r.result === 'win') m.wins++;
    else if (r.result === 'loss') m.losses++;
    else m.draws++;

    const week = isoWeekKey(new Date(r.createdAt));
    let t = trendMap.get(week);
    if (!t) {
      t = { games: 0, wins: 0 };
      trendMap.set(week, t);
    }
    t.games++;
    if (r.result === 'win') t.wins++;
  }

  const matchups = [...matchupMap.values()]
    .map((m) => {
      // Display the most frequently used original spelling of the opponent name.
      let opponent = '';
      let best = -1;
      for (const [label, count] of m.labels) {
        if (count > best) {
          best = count;
          opponent = label;
        }
      }
      return {
        opponent,
        wins: m.wins,
        losses: m.losses,
        draws: m.draws,
        total: m.wins + m.losses + m.draws,
        winRate: winRatePercent(m.wins, m.losses, m.draws),
      };
    })
    .sort((a, b) => b.total - a.total);

  const trend = [...trendMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, t]) => ({
      week,
      games: t.games,
      // Trend win rate is wins / games (non-wins passed as "losses").
      winRate: winRatePercent(t.wins, t.games - t.wins, 0),
    }));

  return { wins, losses, draws, total: wins + losses + draws, winRate: winRatePercent(wins, losses, draws), matchups, trend };
};
```

Note: `Deck` is imported now for use in Task 3; it is unused until then, which is fine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/stats.test.js"`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/stats.js test/stats.test.js
git commit -m "Add getDeckStats: record, matchups, weekly trend"
```

---

### Task 3: `getUserSummary` — account-wide totals and best deck

**Files:**
- Modify: `lib/stats.js`
- Test: `test/stats.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `test/stats.test.js`:

```js
test('getUserSummary totals all decks and picks the best qualifying deck', async () => {
  const user = await User.create({ username: `sum${Date.now()}`, passwordHash: 'x' });
  const deckA = await Deck.create({ name: 'Deck A', format: 'Modern', owner: user._id });
  const deckB = await Deck.create({ name: 'Deck B', format: 'Modern', owner: user._id });

  await seedGame(deckA, user, 'X', 'win');
  await seedGame(deckA, user, 'X', 'win');
  await seedGame(deckA, user, 'X', 'loss'); // Deck A: 2-1, 3 games -> qualifies (67%)
  await seedGame(deckB, user, 'X', 'win'); // Deck B: 1-0 but only 1 game -> ineligible

  const summary = await getUserSummary(user._id);
  assert.equal(summary.totalGames, 4);
  assert.equal(summary.wins, 3);
  assert.equal(summary.losses, 1);
  assert.equal(summary.winRate, 75);
  assert.equal(summary.bestDeck.name, 'Deck A');
  assert.equal(summary.bestDeck.winRate, 67);
  assert.equal(summary.bestDeck.total, 3);
});

test('getUserSummary returns zeros and null bestDeck when there are no games', async () => {
  const user = await User.create({ username: `empty${Date.now()}`, passwordHash: 'x' });
  await Deck.create({ name: 'Idle', format: 'Modern', owner: user._id });

  const summary = await getUserSummary(user._id);
  assert.deepEqual(summary, { totalGames: 0, wins: 0, losses: 0, draws: 0, winRate: 0, bestDeck: null });
});

test('getUserSummary leaves bestDeck null when no deck reaches 3 games', async () => {
  const user = await User.create({ username: `fewgames${Date.now()}`, passwordHash: 'x' });
  const deck = await Deck.create({ name: 'Fresh', format: 'Modern', owner: user._id });
  await seedGame(deck, user, 'X', 'win');
  await seedGame(deck, user, 'X', 'win'); // 2 games only

  const summary = await getUserSummary(user._id);
  assert.equal(summary.bestDeck, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/stats.test.js"`
Expected: FAIL — `getUserSummary` is not exported yet.

- [ ] **Step 3: Implement `getUserSummary`**

Append to `lib/stats.js`:

```js
// A deck must have at least this many games to be eligible as "best deck",
// so a lucky 1-0 deck can't outrank a well-tested one.
const MIN_GAMES_FOR_BEST = 3;

// Account-wide totals across every deck the user owns, plus the best qualifying deck.
export const getUserSummary = async (userId) => {
  const id = new mongoose.Types.ObjectId(userId);
  const decks = await Deck.find({ owner: id }).select('name').lean();
  if (decks.length === 0) {
    return { totalGames: 0, wins: 0, losses: 0, draws: 0, winRate: 0, bestDeck: null };
  }

  const deckIds = decks.map((d) => d._id);
  const records = await GameRecord.find({ deck: { $in: deckIds } }).select('deck result').lean();

  const perDeck = new Map(); // deckId string -> { wins, losses, draws }
  for (const d of decks) perDeck.set(d._id.toString(), { wins: 0, losses: 0, draws: 0 });

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const field = { win: 'wins', loss: 'losses', draw: 'draws' };
  for (const r of records) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else draws++;
    const pd = perDeck.get(r.deck.toString());
    if (pd) pd[field[r.result]]++;
  }

  let bestDeck = null;
  for (const d of decks) {
    const pd = perDeck.get(d._id.toString());
    const total = pd.wins + pd.losses + pd.draws;
    if (total < MIN_GAMES_FOR_BEST) continue;
    const winRate = winRatePercent(pd.wins, pd.losses, pd.draws);
    if (!bestDeck || winRate > bestDeck.winRate) {
      bestDeck = { name: d.name, winRate, total };
    }
  }

  return {
    totalGames: wins + losses + draws,
    wins,
    losses,
    draws,
    winRate: winRatePercent(wins, losses, draws),
    bestDeck,
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/stats.test.js"`
Expected: PASS (all stats.test.js tests).

- [ ] **Step 5: Commit**

```bash
git add lib/stats.js test/stats.test.js
git commit -m "Add getUserSummary: account totals and best deck"
```

---

### Task 4: Dashboard summary band

**Files:**
- Modify: `routes/dashboard.js`
- Modify: `views/userDashboard.handlebars`
- Create: `test/statsRoutes.test.js`

- [ ] **Step 1: Write the failing integration test**

Create `test/statsRoutes.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck } from '../models/index.js';

let baseUrl;
let server;
const cookies = new Map();
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
  // Dedicated DB so this suite never collides with the other test files.
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_routes_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  // Register a user, add a deck, and log 3 games (2-1 -> 67% win rate).
  await request('POST', '/register', { username_input: 'Stats', password_input: 'hunter2hunter' });
  await request('POST', '/decks', { name: 'Azorius Control', format: 'Modern', colors: ['W', 'U'] });
  const deck = await Deck.findOne({ name: 'Azorius Control' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), opponent_deck: 'Burn', result: 'win' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), opponent_deck: 'Burn', result: 'loss' });
  await request('POST', '/game-records', { deck_id: deck._id.toString(), opponent_deck: 'Tron', result: 'win' });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('dashboard shows the overall stats summary', async () => {
  const res = await request('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.match(res.text, /Your Stats/);
  assert.match(res.text, /67%/); // 2 wins of 3 games
});

export { request }; // reused by later tests appended in Task 5
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/statsRoutes.test.js"`
Expected: FAIL — the dashboard does not render "Your Stats" yet.

- [ ] **Step 3: Load the summary in the route**

In `routes/dashboard.js`, add the import near the top (after the existing imports):

```js
import { getUserSummary } from '../lib/stats.js';
```

Replace the `Promise.all` block (currently lines 11-14) with:

```js
    const [decks, userWithTracked, summary] = await Promise.all([
      Deck.find({ owner: req.currentUser._id }).sort({ createdAt: -1 }).lean(),
      User.findById(req.currentUser._id).populate('trackedDecks').lean(),
      getUserSummary(req.currentUser._id),
    ]);
```

Replace the `res.render('userDashboard', {...})` call with (adds `summary`):

```js
    res.render('userDashboard', {
      title: 'Dashboard',
      user: req.currentUser,
      decks,
      trackedDecks: userWithTracked?.trackedDecks ?? [],
      summary,
    });
```

- [ ] **Step 4: Add the summary band to the view**

In `views/userDashboard.handlebars`, insert immediately after the `<div class="welcome-message">...</div>` line (before `<h2>My Decks</h2>`):

```handlebars
  {{#if summary.totalGames}}
    <section class="stats-summary">
      <h2>Your Stats</h2>
      <div class="stat-grid">
        <div class="stat"><span class="stat__num">{{summary.winRate}}%</span><span class="stat__label">Win Rate</span></div>
        <div class="stat"><span class="stat__num">{{summary.wins}}&ndash;{{summary.losses}}&ndash;{{summary.draws}}</span><span class="stat__label">W&ndash;L&ndash;D</span></div>
        <div class="stat"><span class="stat__num">{{summary.totalGames}}</span><span class="stat__label">Games</span></div>
        {{#if summary.bestDeck}}
          <div class="stat"><span class="stat__num">{{summary.bestDeck.name}}</span><span class="stat__label">Best Deck ({{summary.bestDeck.winRate}}%)</span></div>
        {{/if}}
      </div>
    </section>
  {{/if}}
```

Then make each deck card link to its detail page. Replace the "My Decks" `{{#each decks}}` block body (the `<div class="deck-card">...</div>`) with:

```handlebars
    {{#each decks}}
      <div class="deck-card">
        <h3><a href="/decks/{{this._id}}">{{this.name}}</a></h3>
        <p>Format: {{this.format}}</p>
        <p>Created on: {{this.createdAt}}</p>
        <a href="/decks/{{this._id}}" class="view-deck-button">View stats</a>
      </div>
    {{else}}
      <p>You haven't added any decks yet.</p>
    {{/each}}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test "test/statsRoutes.test.js"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/dashboard.js views/userDashboard.handlebars test/statsRoutes.test.js
git commit -m "Add account stats summary band to dashboard"
```

---

### Task 5: Deck detail page (`GET /decks/:id`)

**Files:**
- Modify: `app.js`
- Modify: `routes/decks.js`
- Create: `views/deckDetail.handlebars`
- Create: `views/404.handlebars`
- Modify: `test/statsRoutes.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/statsRoutes.test.js` (after the existing dashboard test):

```js
test('deck detail page shows record, matchups, and header', async () => {
  const deck = await Deck.findOne({ name: 'Azorius Control' });
  const res = await request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Azorius Control/);
  assert.match(res.text, /67% win rate/);
  assert.match(res.text, /Burn/); // a matchup row
});

test('deck detail 404s for a missing deck', async () => {
  const res = await request('GET', '/decks/64b000000000000000000000');
  assert.equal(res.status, 404);
});

test('deck detail 404s for a malformed id', async () => {
  const res = await request('GET', '/decks/not-an-id');
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/statsRoutes.test.js"`
Expected: FAIL — `/decks/:id` route does not exist (missing deck likely renders/500s or the assertion on "67% win rate" fails).

- [ ] **Step 3: Register the `percent` Handlebars helper**

In `app.js`, replace the engine registration line (currently line 27):

```js
app.engine('handlebars', engine({ defaultLayout: 'main' }));
```

with:

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

- [ ] **Step 4: Add the route**

In `routes/decks.js`, add to the imports at the top:

```js
import mongoose from 'mongoose';
import { getDeckStats } from '../lib/stats.js';
```

Add this route after the existing `POST /decks` handler and before `export { router as decksRouter };`:

```js
router.get('/decks/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const deck = await Deck.findById(req.params.id).lean();
    if (!deck) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const stats = await getDeckStats(deck._id);
    res.render('deckDetail', { title: deck.name, deck, stats });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Create the 404 view**

Create `views/404.handlebars`:

```handlebars
<main>
  <h1>Not Found</h1>
  <p>We couldn't find what you were looking for. <a href="/dashboard">Back to your dashboard</a>.</p>
</main>
```

- [ ] **Step 6: Create the deck detail view**

Create `views/deckDetail.handlebars`:

```handlebars
<main>
  <p><a href="/dashboard">&larr; Back to dashboard</a></p>
  <h1>{{deck.name}}</h1>
  <p class="deck-meta">
    {{deck.format}}{{#if deck.commander}} &middot; {{deck.commander}}{{/if}}{{#if deck.archetype}} &middot; {{deck.archetype}}{{/if}}
  </p>

  <section class="deck-stats">
    <h2>Record</h2>
    {{#if stats.total}}
      <p class="big-winrate">{{stats.winRate}}% win rate <span>({{stats.wins}}&ndash;{{stats.losses}}&ndash;{{stats.draws}})</span></p>
      <div class="bar-row">
        <span class="bar-label">Wins</span>
        <span class="bar"><span class="bar__fill bar__fill--win" style="width: {{percent stats.wins stats.total}}%"></span></span>
        <span class="bar-val">{{stats.wins}}</span>
      </div>
      <div class="bar-row">
        <span class="bar-label">Losses</span>
        <span class="bar"><span class="bar__fill bar__fill--loss" style="width: {{percent stats.losses stats.total}}%"></span></span>
        <span class="bar-val">{{stats.losses}}</span>
      </div>
      <div class="bar-row">
        <span class="bar-label">Draws</span>
        <span class="bar"><span class="bar__fill bar__fill--draw" style="width: {{percent stats.draws stats.total}}%"></span></span>
        <span class="bar-val">{{stats.draws}}</span>
      </div>
    {{else}}
      <p>No games logged for this deck yet.</p>
    {{/if}}
  </section>

  {{#if stats.matchups.length}}
    <section class="deck-stats">
      <h2>Matchups</h2>
      <table class="matchup-table">
        <thead>
          <tr><th>Opponent</th><th>W&ndash;L&ndash;D</th><th>Win rate</th></tr>
        </thead>
        <tbody>
          {{#each stats.matchups}}
            <tr>
              <td>{{this.opponent}}</td>
              <td>{{this.wins}}&ndash;{{this.losses}}&ndash;{{this.draws}}</td>
              <td>
                <span class="bar bar--inline"><span class="bar__fill bar__fill--win" style="width: {{this.winRate}}%"></span></span>
                {{this.winRate}}%
              </td>
            </tr>
          {{/each}}
        </tbody>
      </table>
    </section>
  {{/if}}

  {{#if stats.trend.length}}
    <section class="deck-stats">
      <h2>Weekly win rate</h2>
      {{#each stats.trend}}
        <div class="bar-row">
          <span class="bar-label">{{this.week}}</span>
          <span class="bar"><span class="bar__fill bar__fill--win" style="width: {{this.winRate}}%"></span></span>
          <span class="bar-val">{{this.winRate}}% ({{this.games}})</span>
        </div>
      {{/each}}
    </section>
  {{/if}}
</main>
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test "test/statsRoutes.test.js"`
Expected: PASS (dashboard + deck detail + both 404 tests).

- [ ] **Step 8: Commit**

```bash
git add app.js routes/decks.js views/deckDetail.handlebars views/404.handlebars test/statsRoutes.test.js
git commit -m "Add deck detail page with record, matchups, and trend"
```

---

### Task 6: Style the summary band, stat bars, and matchup table

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Append the styles**

Add to the end of `public/css/style.css`:

```css
/* ============================================================
   DECK STATS & ANALYTICS
   ============================================================ */
.stats-summary { margin-bottom: 1.5rem; }
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1rem;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 1rem 1.2rem;
  background: #fbf8ef;
  border: 1px solid var(--rule);
  border-top: 4px solid var(--mana-g);
  border-radius: 6px;
  box-shadow: var(--shadow-card);
}
.stat__num { font-family: 'Cinzel', serif; font-size: 1.35rem; font-weight: 700; }
.stat__label {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

.deck-meta { color: var(--ink-soft); margin-bottom: 1.5rem; }

.deck-stats {
  background: #fbf8ef;
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 1.3rem 1.5rem;
  margin-bottom: 1.4rem;
  box-shadow: var(--shadow-card);
}
.big-winrate { font-family: 'Cinzel', serif; font-size: 1.5rem; margin-bottom: 1rem; }
.big-winrate span { color: var(--ink-soft); font-size: 1rem; }

/* Horizontal stat bars: a track with a server-sized fill. */
.bar-row {
  display: grid;
  grid-template-columns: 5rem 1fr auto;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 0.5rem;
}
.bar-label { font-size: 0.85rem; color: var(--ink-soft); }
.bar {
  position: relative;
  height: 0.85rem;
  background: var(--paper-deep);
  border: 1px solid var(--rule);
  border-radius: 999px;
  overflow: hidden;
}
.bar--inline { display: inline-block; width: 4rem; vertical-align: middle; }
.bar__fill { display: block; height: 100%; border-radius: 999px; }
.bar__fill--win { background: var(--mana-g); }
.bar__fill--loss { background: var(--mana-r); }
.bar__fill--draw { background: var(--gold); }
.bar-val { font-size: 0.85rem; font-weight: 600; }

.matchup-table { width: 100%; border-collapse: collapse; }
.matchup-table th,
.matchup-table td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--rule);
  font-size: 0.9rem;
}
.matchup-table th {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

/* The deck-card title link should read as a heading, not a plain link. */
.deck-card h3 a { color: inherit; }
.deck-card h3 a:hover { color: var(--mana-u); }
```

- [ ] **Step 2: Verify the full test suite still passes**

Run: `npm test`
Expected: PASS across `test/stats.test.js`, `test/statsRoutes.test.js`, and `test/integration.test.js`.

- [ ] **Step 3: Manual visual check**

Run `npm start`, log in, log a few games, and confirm: the dashboard shows the stats band; each deck card links to a detail page; the deck page renders the record bars, matchup table, and weekly trend without layout breakage.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "Style deck stats summary, bars, and matchup table"
```

---

## Self-Review

**Spec coverage:**
- Win rate & record → `getDeckStats` (Task 2), rendered on dashboard band (Task 4) and deck page (Task 5). ✓
- Matchup breakdown (normalized, most-common label, sorted) → `getDeckStats` matchups + Task 2 tests + deck-page table (Task 5). ✓
- Trends over time (ISO week, only weeks with games, chronological) → `isoWeekKey` (Task 1) + trend in `getDeckStats` (Task 2) + deck-page bars (Task 5). ✓
- Overall summary (totals, win rate, best deck ≥3 games) → `getUserSummary` (Task 3) + dashboard band (Task 4). ✓
- CSS bars + tables, no JS lib → single `percent` helper + CSS (Tasks 5-6); works with JS disabled. ✓
- New deck detail page `GET /decks/:id`, any auth user, 404 on bad/missing id → Task 5 + tests. ✓
- Testing per spec (record, zero-games, matchup grouping, trend, best-deck threshold) → Tasks 1-3 unit tests. ✓
- No schema changes → confirmed; only reads. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code and exact commands. ✓

**Type consistency:** `getDeckStats` returns `{ wins, losses, draws, total, winRate, matchups[], trend[] }` and `getUserSummary` returns `{ totalGames, wins, losses, draws, winRate, bestDeck }` — used identically in routes and views. Helper names `winRatePercent`, `isoWeekKey`, `percent` are consistent throughout. `matchups[].opponent/winRate/total` and `trend[].week/games/winRate` match template usage. ✓

**Note on `seedGame`:** uses `save({ timestamps: false })` when a `createdAt` is supplied so Mongoose preserves the seeded date (required for the trend test). Distinct DB names per test file prevent parallel-run collisions.
