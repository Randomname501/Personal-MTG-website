# Card Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Card breakdown" (mana curve, color spread, type counts) to the deck detail page, computed from the card snapshots already stored on each deck.

**Architecture:** One pure function `getCardInsights(cards)` in `lib/cardInsights.js` folds a deck's `cards` array into three bar-ready groups. The existing deck detail route passes the result to the view, which renders it with the CSS bar components already in use for deck stats.

**Tech Stack:** Node ESM, Express 4, Mongoose (read-only here), express-handlebars, `node --test`.

## Global Constraints

- No schema changes; reads the existing embedded `Deck.cards` (`{ scryfallId, name, manaCost, cmc, colors[], typeLine, imageUrl, quantity }`).
- No new runtime dependencies; no DB or network calls at render time — `getCardInsights` is a pure function of its input array.
- Server-rendered; reuse the existing `.bar-row` / `.bar` / `.bar__fill` markup and styles.
- Insights appear only on the deck detail page. The change is additive: a deck with no cards renders no breakdown section, leaving existing deck-detail behavior/tests unaffected.
- `getCardInsights` shape: `{ total, nonlandTotal, manaCurve[{bucket,count,pct}], colors[{color,count,pct}], types[{type,count,pct}] }`. Land test: `/\bland\b/i` on `typeLine`. Type priority (first whole-word match): `Land → Creature → Planeswalker → Instant → Sorcery → Artifact → Enchantment → Battle → Other`. Curve buckets `'0'..'6','7+'` (all 8 always present, nonland only, `cmc>=7 → '7+'`). Colors weight `quantity` into each color in `colors[]`, empty → `'C'`. `pct = round(count/groupMax*100)`, group-relative, divide-by-zero safe.

---

## File Structure

- **Create** `lib/cardInsights.js` — `getCardInsights(cards)`.
- **Create** `test/cardInsights.test.js` — pure unit tests (no DB).
- **Modify** `routes/decks.js` — `GET /decks/:id` computes and passes `insights`.
- **Modify** `views/deckDetail.handlebars` — a Card breakdown section (three bar groups).
- **Modify** `test/deckCards.test.js` — one integration assertion that the breakdown renders.
- **Modify** `public/css/style.css` — breakdown layout + mana-tinted bar fills.

---

### Task 1: `getCardInsights` module

**Files:**
- Create: `lib/cardInsights.js`
- Create: `test/cardInsights.test.js`

**Interfaces:**
- Produces: `getCardInsights(cards) -> { total, nonlandTotal, manaCurve[{bucket,count,pct}], colors[{color,count,pct}], types[{type,count,pct}] }`. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `test/cardInsights.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCardInsights } from '../lib/cardInsights.js';

// Minimal card with sensible defaults; override per case.
const card = (over) => ({ quantity: 1, cmc: 0, colors: [], typeLine: '', ...over });

test('empty deck returns zeros and 8 zeroed curve buckets', () => {
  const r = getCardInsights([]);
  assert.equal(r.total, 0);
  assert.equal(r.nonlandTotal, 0);
  assert.equal(r.manaCurve.length, 8);
  assert.ok(r.manaCurve.every((b) => b.count === 0 && b.pct === 0));
  assert.deepEqual(r.colors, []);
  assert.deepEqual(r.types, []);
});

test('undefined input is treated as empty', () => {
  const r = getCardInsights(undefined);
  assert.equal(r.total, 0);
  assert.equal(r.manaCurve.length, 8);
});

test('mana curve excludes lands, groups 7+, weights by quantity', () => {
  const r = getCardInsights([
    card({ typeLine: 'Basic Land — Island', cmc: 0, quantity: 10 }),
    card({ typeLine: 'Creature — Elf', cmc: 1, quantity: 4 }),
    card({ typeLine: 'Sorcery', cmc: 9, quantity: 1 }),
  ]);
  assert.equal(r.total, 15);
  assert.equal(r.nonlandTotal, 5);
  const byBucket = Object.fromEntries(r.manaCurve.map((b) => [b.bucket, b.count]));
  assert.equal(byBucket['0'], 0); // the Island is a land, excluded from the curve
  assert.equal(byBucket['1'], 4);
  assert.equal(byBucket['7+'], 1); // cmc 9
});

test('colors count each color of a multicolor card; colorless to C; weighted; only >0 in WUBRG C order', () => {
  const r = getCardInsights([
    card({ colors: ['U', 'B'], typeLine: 'Creature', quantity: 2 }),
    card({ colors: [], typeLine: 'Artifact', quantity: 3 }),
  ]);
  const byColor = Object.fromEntries(r.colors.map((c) => [c.color, c.count]));
  assert.equal(byColor.U, 2);
  assert.equal(byColor.B, 2);
  assert.equal(byColor.C, 3);
  assert.equal(byColor.W, undefined); // zero-count colors omitted
  assert.deepEqual(r.colors.map((c) => c.color), ['U', 'B', 'C']);
});

test('types use priority so each card counts once and the counts sum to total', () => {
  const r = getCardInsights([
    card({ typeLine: 'Artifact Creature — Golem' }),      // Creature (beats Artifact)
    card({ typeLine: 'Artifact Land' }),                  // Land (beats Artifact)
    card({ typeLine: 'Legendary Planeswalker — Jace' }),  // Planeswalker
    card({ typeLine: 'Snow Enchantment' }),               // Enchantment
    card({ typeLine: 'Weird Frame — Thing' }),            // Other (no match)
  ]);
  const byType = Object.fromEntries(r.types.map((t) => [t.type, t.count]));
  assert.equal(byType.Creature, 1);
  assert.equal(byType.Land, 1);
  assert.equal(byType.Planeswalker, 1);
  assert.equal(byType.Enchantment, 1);
  assert.equal(byType.Other, 1);
  assert.equal(r.types.reduce((s, t) => s + t.count, 0), r.total);
});

test('pct scales each group to its own max, with no divide-by-zero on empty buckets', () => {
  const r = getCardInsights([
    card({ typeLine: 'Creature', cmc: 1, quantity: 4 }),
    card({ typeLine: 'Creature', cmc: 2, quantity: 2 }),
  ]);
  const pctByBucket = Object.fromEntries(r.manaCurve.map((b) => [b.bucket, b.pct]));
  assert.equal(pctByBucket['1'], 100); // max bucket
  assert.equal(pctByBucket['2'], 50);
  assert.equal(pctByBucket['0'], 0); // empty bucket, no NaN
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/cardInsights.test.js"`
Expected: FAIL — cannot import from `../lib/cardInsights.js` (module missing).

- [ ] **Step 3: Create the module**

Create `lib/cardInsights.js`:

```js
// Pure deck-card analytics for the deck detail page's "Card breakdown".
// Input is a deck's `cards` array; output is bar-ready groups. No I/O.

const LAND_RE = /\bland\b/i;
const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'];
// First whole-word match against typeLine wins; 'Other' is the fallback.
const TYPE_PRIORITY = ['Land', 'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle'];
const TYPE_ORDER = [...TYPE_PRIORITY, 'Other'];

const bucketKey = (cmc) => {
  const n = Math.floor(Number(cmc) || 0);
  return n >= 7 ? '7+' : String(n);
};

const primaryType = (typeLine) => {
  const line = typeLine || '';
  for (const t of TYPE_PRIORITY) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(line)) return t;
  }
  return 'Other';
};

// Attach pct (count relative to the group's max count) to each row.
const withPct = (rows) => {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return rows.map((r) => ({ ...r, pct: max === 0 ? 0 : Math.round((r.count / max) * 100) }));
};

export const getCardInsights = (cards) => {
  const list = Array.isArray(cards) ? cards : [];

  let total = 0;
  let nonlandTotal = 0;
  const curve = new Map(CURVE_BUCKETS.map((b) => [b, 0]));
  const colors = new Map([...MANA_COLORS, 'C'].map((c) => [c, 0]));
  const types = new Map(TYPE_ORDER.map((t) => [t, 0]));

  for (const c of list) {
    const qty = c.quantity || 0;
    total += qty;

    if (LAND_RE.test(c.typeLine || '')) {
      // lands are excluded from the mana curve
    } else {
      nonlandTotal += qty;
      const b = bucketKey(c.cmc);
      curve.set(b, curve.get(b) + qty);
    }

    const cardColors = Array.isArray(c.colors) ? c.colors.filter((x) => MANA_COLORS.includes(x)) : [];
    if (cardColors.length === 0) colors.set('C', colors.get('C') + qty);
    else for (const x of cardColors) colors.set(x, colors.get(x) + qty);

    const t = primaryType(c.typeLine);
    types.set(t, types.get(t) + qty);
  }

  const manaCurve = withPct(CURVE_BUCKETS.map((b) => ({ bucket: b, count: curve.get(b) })));
  const colorRows = withPct([...MANA_COLORS, 'C'].map((x) => ({ color: x, count: colors.get(x) })).filter((r) => r.count > 0));
  const typeRows = withPct(TYPE_ORDER.map((t) => ({ type: t, count: types.get(t) })).filter((r) => r.count > 0));

  return { total, nonlandTotal, manaCurve, colors: colorRows, types: typeRows };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/cardInsights.test.js"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cardInsights.js test/cardInsights.test.js
git commit -m "Add getCardInsights: mana curve, colors, type counts"
```

---

### Task 2: Wire insights into the deck detail page

**Files:**
- Modify: `routes/decks.js`
- Modify: `views/deckDetail.handlebars`
- Modify: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `getCardInsights` (Task 1).
- Produces: `GET /decks/:id` now passes `insights` to `deckDetail`; the view renders a `.deck-breakdown` section.

- [ ] **Step 1: Write the failing test**

Append to `test/deckCards.test.js` (before the `export { makeClient, aliceDeck };` line):

```js
test('deck detail shows the card breakdown for a deck with cards', async () => {
  const deck = await aliceDeck(); // holds Counterspell (Instant), from earlier tests
  const res = await alice.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Card breakdown/);
  assert.match(res.text, /Mana curve/);
  assert.match(res.text, /Instant/); // Counterspell's primary type
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/deckCards.test.js"`
Expected: FAIL — the deck detail page renders no "Card breakdown" section yet.

- [ ] **Step 3: Compute `insights` in the route**

In `routes/decks.js`, add to the imports at the top (next to the existing `getDeckStats` import):

```js
import { getCardInsights } from '../lib/cardInsights.js';
```

In the `GET /decks/:id` handler, replace these lines:

```js
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, cardCount });
```

with:

```js
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    const insights = getCardInsights(deck.cards || []);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, cardCount, insights });
```

- [ ] **Step 4: Add the breakdown section to the view**

In `views/deckDetail.handlebars`, insert this immediately before the closing `</main>` tag (after the existing stats/trend sections):

```handlebars
  {{#if deck.cards.length}}
    <section class="deck-breakdown">
      <h2>Card breakdown</h2>
      <div class="breakdown-groups">
        <div class="breakdown-group">
          <h3>Mana curve</h3>
          {{#each insights.manaCurve}}
            <div class="bar-row">
              <span class="bar-label">{{this.bucket}}</span>
              <span class="bar"><span class="bar__fill bar__fill--count" style="width: {{this.pct}}%"></span></span>
              <span class="bar-val">{{this.count}}</span>
            </div>
          {{/each}}
        </div>
        <div class="breakdown-group">
          <h3>Colors</h3>
          {{#each insights.colors}}
            <div class="bar-row">
              <span class="bar-label">{{this.color}}</span>
              <span class="bar"><span class="bar__fill bar__fill--mana-{{this.color}}" style="width: {{this.pct}}%"></span></span>
              <span class="bar-val">{{this.count}}</span>
            </div>
          {{/each}}
        </div>
        <div class="breakdown-group">
          <h3>Types</h3>
          {{#each insights.types}}
            <div class="bar-row">
              <span class="bar-label">{{this.type}}</span>
              <span class="bar"><span class="bar__fill bar__fill--count" style="width: {{this.pct}}%"></span></span>
              <span class="bar-val">{{this.count}}</span>
            </div>
          {{/each}}
        </div>
      </div>
    </section>
  {{/if}}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test "test/deckCards.test.js"`
Expected: PASS (all prior tests + the new breakdown test).

Run: `npm test`
Expected: PASS — all suites green (the change is additive; decks without cards render no breakdown, so `statsRoutes.test.js` is unaffected).

- [ ] **Step 6: Commit**

```bash
git add routes/decks.js views/deckDetail.handlebars test/deckCards.test.js
git commit -m "Show card breakdown on the deck detail page"
```

---

### Task 3: Style the breakdown

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Append the styles**

Add to the end of `public/css/style.css`:

```css
/* ============================================================
   CARD BREAKDOWN (mana curve / colors / types)
   ============================================================ */
.deck-breakdown { margin-bottom: 1.6rem; }
.breakdown-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1.5rem;
}
.breakdown-group {
  background: #fbf8ef;
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: 1.1rem 1.3rem;
  box-shadow: var(--shadow-card);
}
.breakdown-group h3 {
  font-family: 'Cinzel', serif;
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 0.8rem;
}

/* Bar fills for the breakdown (base .bar/.bar-row come from the stats styles). */
.bar__fill--count { background: var(--mana-u); }
.bar__fill--mana-W { background: var(--mana-w-edge); }
.bar__fill--mana-U { background: var(--mana-u); }
.bar__fill--mana-B { background: var(--mana-b); }
.bar__fill--mana-R { background: var(--mana-r); }
.bar__fill--mana-G { background: var(--mana-g); }
.bar__fill--mana-C { background: var(--ink-soft); }
```

- [ ] **Step 2: Verify the full suite still passes**

Run: `npm test`
Expected: PASS — CSS-only change; all suites green.

- [ ] **Step 3: Manual visual check**

Run `npm start`, open a deck that has cards, and confirm the Card breakdown section shows three columns (mana curve, colors, types) with sensibly sized, mana-tinted bars.

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "Style the deck card breakdown"
```

---

## Self-Review

**Spec coverage:**
- `getCardInsights` with the exact output shape, land exclusion, 7+ bucketing, color weighting/colorless, type priority summing to total, group-relative `pct` → Task 1 + tests. ✓
- Deck detail route passes `insights` → Task 2. ✓
- Card breakdown section (curve/colors/types bar groups, mana-tinted color bars, shown only when the deck has cards) → Task 2 view + Task 3 CSS. ✓
- No schema change; pure function; no render-time I/O; additive (existing deck-detail tests unaffected) → Tasks 1–2. ✓
- Testing list from the spec (empty, curve-excludes-lands, colors, type-priority, pct) → Task 1 tests; wiring verified → Task 2 integration test. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✓

**Type consistency:** `getCardInsights` returns `{ total, nonlandTotal, manaCurve[{bucket,count,pct}], colors[{color,count,pct}], types[{type,count,pct}] }` — produced in Task 1, consumed identically by the Task 2 view (`insights.manaCurve`/`.colors`/`.types`, each item's `bucket`/`color`/`type`, `count`, `pct`). The fill classes `bar__fill--count` and `bar__fill--mana-{W,U,B,R,G,C}` used in the Task 2 view all have matching rules in the Task 3 CSS. ✓

**Note on CSS specificity:** the color bars carry `bar__fill--mana-X` and the curve/type bars carry `bar__fill--count` — each bar has exactly one of these single-class fill rules, so there is no specificity conflict with the base `.bar__fill` (which sets only size, no background).
