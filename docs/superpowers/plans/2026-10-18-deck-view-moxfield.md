# Moxfield-style Deck View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Moxfield-style deck view. Commanders can be set from search, which also backfills art on older decks. The decklist gets a Type / Mana value toggle. The commander appears as the first group, and one shared decklist partial is used on both the deck page and the card manager.

**Architecture:** One pure function, `groupCards(cards, { mode, commander })` in `lib/cardInsights.js`, produces the `[{ label, count, cards }]` groups. A new Handlebars partial, `views/partials/decklist.handlebars`, renders them on the deck page and the manager. A new owner-only route, `POST /decks/:id/commander`, re-fetches the chosen card from Scryfall and overwrites `commander` and `commanderImageUrl`.

**Tech Stack:** Node (ESM), Express, express-handlebars (partials in `views/partials`, already registered by default), Mongoose, `node --test` against a real local MongoDB, and fake Scryfall HTTP servers inside the tests.

**Spec:** `docs/superpowers/specs/2026-10-18-deck-view-moxfield-design.md`

**Starting state:** the branch is `development`, and 8 files carry uncommitted WIP from the spec's Context section: `lib/cardInsights.js` (`groupCardsByType`), `lib/scryfall.js` (`getCardByName`), `models/Deck.js` (`commanderImageUrl`), `public/css/style.css`, `routes/decks.js`, `test/cardInsights.test.js`, `views/deckDetail.handlebars` and `views/userDashboard.handlebars`. That WIP is the baseline: `npm test` passes all 101 tests. Task 1 commits it unchanged so later diffs stay reviewable.

## Global Constraints

- Server-rendered Handlebars only. No client JS and no new runtime dependencies.
- Run tests with `npm test` (`node --test "test/*.test.js"`). Each test file uses its own MongoDB database name.
- Scryfall base URL comes from `SCRYFALL_API_BASE`. Tests point it at a local fake server and never call the real API.
- Owner-only routes use `findOwnedDeck`, and a missing deck, malformed id or non-owner gets `404` rendering `'404'`.
- Never trust client-posted card fields. Always re-fetch with `getCardById`.
- `?group=` accepts only `type` and `cmc`. Anything else, including a repeated param, means `type`.
- The commander group and the +1 count apply only when `deck.format === 'Commander'` and `deck.commander` is non-empty. This is a plan-level decision consistent with the spec's Commander-only button. The New Deck form shows the commander field for every format, and a stray name on a Modern deck must not add a "Commander" group.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A Commander deck with a commander but zero cards** should render a Commander group, show `Cards (1)` and keep the "Add some" hint for the owner, without errors. Test in Task 4.
2. **A repeated or invalid `?group=` value** (`?group=cmc&group=type`, `?group=color`) should fall back to Type grouping and not crash. Test in Task 4.
3. **Search text with special characters** (`q = "a&b c"`) preserved through the Set-as-commander redirect should come back URL-encoded so the search re-runs intact. Test in Task 5.
4. **Scryfall erroring (500) during fuzzy lookup at `POST /decks`** should still create the deck, without art. Test in Task 2.
5. **A commander name typed on a non-Commander deck** should not add a Commander group or a +1. Test in Task 4.

---

## File Structure

- `lib/cardInsights.js`: replace `groupCardsByType` with `groupCards`.
- `lib/scryfall.js`: `getCardByName` already exists in WIP; this plan only adds tests.
- `routes/decks.js`: deck detail grouping and count, manager `cardGroups`/`isCommanderDeck`, and the new `POST /decks/:id/commander`.
- `views/partials/decklist.handlebars` (new): the shared grouped decklist.
- `views/deckDetail.handlebars` and `views/deckCards.handlebars`: use the partial, plus the toggle and the commander UI.
- `public/css/style.css`: `.group-toggle` and `.current-commander`.
- Tests: `test/cardInsights.test.js`, `test/scryfall.test.js`, `test/deckCards.test.js`.

---

### Task 1: `groupCards` (type and cmc modes, commander group)

**Files:**
- Modify: `lib/cardInsights.js`, replacing the WIP block from the `// Moxfield-style decklist` comment to the end of the file
- Modify: `routes/decks.js` (import and the `GET /decks/:id` call)
- Modify: `views/deckDetail.handlebars` (`this.type` becomes `this.label` inside `cardGroups`)
- Test: `test/cardInsights.test.js`

**Interfaces:**
- Produces: `groupCards(cards, { mode = 'type', commander } = {}) → Array<{ label: string, count: number, cards: object[] }>`. `commander` is `{ name, imageUrl }` or undefined.
- The `groupCardsByType` export is removed.

- [ ] **Step 1: Commit the WIP baseline**

```bash
git add lib/cardInsights.js lib/scryfall.js models/Deck.js public/css/style.css routes/decks.js test/cardInsights.test.js views/deckDetail.handlebars views/userDashboard.handlebars
git commit -m "Moxfield-style deck view WIP: commander art, type columns, deck grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Replace the WIP test with failing `groupCards` tests**

In `test/cardInsights.test.js`, change the import line to:

```js
import { getCardInsights, groupCards } from '../lib/cardInsights.js';
```

Delete the test `'groupCardsByType orders groups (lands last) and sorts by cmc then name'` and append:

```js
test('groupCards type mode orders groups (lands last) and sorts by cmc then name', () => {
  const g = groupCards([
    card({ name: 'Island', typeLine: 'Basic Land — Island', quantity: 30 }),
    card({ name: 'Zebra', typeLine: 'Creature — Zebra', cmc: 2 }),
    card({ name: 'Ape', typeLine: 'Creature — Ape', cmc: 2, quantity: 2 }),
    card({ name: 'Elf', typeLine: 'Creature — Elf', cmc: 1 }),
    card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 }),
  ]);
  assert.deepEqual(g.map((x) => x.label), ['Creatures', 'Instants', 'Lands']);
  assert.deepEqual(g[0].cards.map((c) => c.name), ['Elf', 'Ape', 'Zebra']);
  assert.equal(g[0].count, 4);
  assert.equal(g[2].count, 30);
});

test('groupCards cmc mode buckets nonlands 0..7+, lands last, sorted by name, empties dropped', () => {
  const g = groupCards([
    card({ name: 'Forest', typeLine: 'Basic Land — Forest', quantity: 10 }),
    card({ name: 'Zap', typeLine: 'Instant', cmc: 1 }),
    card({ name: 'Arrow', typeLine: 'Instant', cmc: 1, quantity: 2 }),
    card({ name: 'Emrakul', typeLine: 'Legendary Creature — Eldrazi', cmc: 15 }),
    card({ name: 'Ornithopter', typeLine: 'Artifact Creature — Thopter', cmc: 0 }),
  ], { mode: 'cmc' });
  assert.deepEqual(g.map((x) => x.label), ['0', '1', '7+', 'Lands']);
  assert.deepEqual(g[1].cards.map((c) => c.name), ['Arrow', 'Zap']);
  assert.equal(g[1].count, 3);
  assert.equal(g[3].count, 10);
});

test('groupCards puts a named commander first and omits it when there is no name', () => {
  const cards = [card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 })];
  const withCmdr = groupCards(cards, { commander: { name: 'Atraxa', imageUrl: 'http://img/a.jpg' } });
  assert.equal(withCmdr[0].label, 'Commander');
  assert.equal(withCmdr[0].count, 1);
  assert.deepEqual(withCmdr[0].cards, [{ name: 'Atraxa', imageUrl: 'http://img/a.jpg', quantity: 1 }]);
  assert.equal(withCmdr[1].label, 'Instants');

  assert.deepEqual(groupCards(cards, { commander: { name: '', imageUrl: '' } }).map((x) => x.label), ['Instants']);
  assert.deepEqual(groupCards([], { mode: 'cmc', commander: { name: 'Atraxa' } }).map((x) => x.label), ['Commander']);
});

test('groupCards falls back to type mode and treats non-arrays as empty', () => {
  const cards = [card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 })];
  assert.deepEqual(groupCards(cards, { mode: 'color' }).map((x) => x.label), ['Instants']);
  assert.deepEqual(groupCards(undefined), []);
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `node --test test/cardInsights.test.js`
Expected: FAIL. The import fails with `does not provide an export named 'groupCards'`.

- [ ] **Step 4: Implement `groupCards`**

In `lib/cardInsights.js`, replace everything from `// Moxfield-style decklist:` to the end of the file with:

```js
// Moxfield-style decklist groups: by primary type (lands last, sorted by mana
// value then name) or by mana value (curve buckets, lands last, sorted by name).
// A named commander is prepended as its own group. Counts are quantity-weighted.
const GROUP_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Other', 'Land'];
const GROUP_LABELS = { Creature: 'Creatures', Planeswalker: 'Planeswalkers', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artifacts', Enchantment: 'Enchantments', Battle: 'Battles', Other: 'Other', Land: 'Lands' };

const byName = (a, b) => a.name.localeCompare(b.name);
const byCmcThenName = (a, b) => (a.cmc || 0) - (b.cmc || 0) || byName(a, b);

export const groupCards = (cards, { mode = 'type', commander } = {}) => {
  const list = Array.isArray(cards) ? cards : [];
  const byCmc = mode === 'cmc';
  const keys = byCmc ? [...CURVE_BUCKETS, 'Land'] : GROUP_ORDER;
  const keyOf = byCmc
    ? (c) => (LAND_RE.test(c.typeLine || '') ? 'Land' : bucketKey(c.cmc))
    : (c) => primaryType(c.typeLine);

  const groups = new Map(keys.map((k) => [k, []]));
  for (const c of list) groups.get(keyOf(c)).push(c);

  const rows = keys.filter((k) => groups.get(k).length).map((k) => {
    const cs = groups.get(k).sort(byCmc ? byName : byCmcThenName);
    return { label: GROUP_LABELS[k] ?? k, count: cs.reduce((s, c) => s + (c.quantity || 0), 0), cards: cs };
  });

  if (commander?.name) {
    rows.unshift({ label: 'Commander', count: 1, cards: [{ name: commander.name, imageUrl: commander.imageUrl, quantity: 1 }] });
  }
  return rows;
};
```

`GROUP_LABELS['0']` is undefined, so bucket keys label themselves. `'Land'` maps to `'Lands'` in both modes.

- [ ] **Step 5: Point the route and view at the new name and key**

In `routes/decks.js`, change the import to:

```js
import { getCardInsights, groupCards } from '../lib/cardInsights.js';
```

and in `GET /decks/:id`, replace

```js
    const cardGroups = groupCardsByType(deck.cards || []);
```

with

```js
    const cardGroups = groupCards(deck.cards);
```

In `views/deckDetail.handlebars`, replace `<h3>{{this.type}} <span>({{this.count}})</span></h3>` with `<h3>{{this.label}} <span>({{this.count}})</span></h3>`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (104 tests).

- [ ] **Step 7: Commit**

```bash
git add lib/cardInsights.js routes/decks.js views/deckDetail.handlebars test/cardInsights.test.js
git commit -m "Add groupCards with type/cmc modes and a commander group

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tests for `getCardByName` and commander art at deck creation

**Files:**
- Test: `test/scryfall.test.js`
- Test: `test/deckCards.test.js` (add a `/cards/named` route to the fake server, plus new tests)
- No production code changes. `getCardByName` and the `POST /decks` lookup already exist in the WIP. If a test fails, fix the production code in `lib/scryfall.js` or `routes/decks.js`, not the test.

**Interfaces:**
- Consumes: `getCardByName(name) → Promise<normalizedCard | null>`, which throws on non-404 errors.
- Produces: the fake Scryfall server in `test/deckCards.test.js` answers `GET /cards/named?fuzzy=…`. `atraxa` returns `ATRAXA`, `explode` returns 500, anything else returns 404. Tasks 4 and 5 depend on this.

- [ ] **Step 1: Add the `getCardByName` tests**

In `test/scryfall.test.js`, change the import to:

```js
import { searchCards, getCardById, getCardByName } from '../lib/scryfall.js';
```

In the fake server handler, before the final `res.statusCode = 404;`, add:

```js
    if (u.pathname === '/cards/named') {
      const fuzzy = u.searchParams.get('fuzzy');
      if (fuzzy === 'counterspel') return res.end(JSON.stringify(NORMAL_CARD));
      if (fuzzy === 'explode') { res.statusCode = 500; return res.end(JSON.stringify({ object: 'error' })); }
      res.statusCode = 404;
      return res.end(JSON.stringify({ object: 'error' }));
    }
```

Append:

```js
test('getCardByName fuzzy-matches and normalizes the card', async () => {
  const card = await getCardByName('counterspel');
  assert.equal(card.scryfallId, 'abc-123');
  assert.equal(card.name, 'Counterspell');
  assert.equal(card.imageUrl, 'http://img/cs.jpg');
});

test('getCardByName returns null when Scryfall 404s', async () => {
  assert.equal(await getCardByName('nomatchxyz'), null);
});

test('getCardByName throws on other Scryfall errors', async () => {
  await assert.rejects(() => getCardByName('explode'), /Scryfall name lookup failed: 500/);
});
```

- [ ] **Step 2: Add `/cards/named` to the deckCards fake server**

In `test/deckCards.test.js`, below the `CARD` constant, add:

```js
const ATRAXA = {
  id: 'atraxa-1',
  name: "Atraxa, Praetors' Voice",
  mana_cost: '{G}{W}{U}{B}',
  cmc: 4,
  colors: ['W', 'U', 'B', 'G'],
  type_line: 'Legendary Creature — Phyrexian Angel Horror',
  image_uris: { normal: 'http://img/atraxa.jpg' },
};
```

In the fake Scryfall handler, before `if (u.pathname === '/cards/abc-123')`, add:

```js
    if (u.pathname === '/cards/named') {
      const fuzzy = u.searchParams.get('fuzzy');
      if (fuzzy === 'atraxa') return res.end(JSON.stringify(ATRAXA));
      if (fuzzy === 'explode') { res.statusCode = 500; return res.end(JSON.stringify({ object: 'error' })); }
      res.statusCode = 404;
      return res.end(JSON.stringify({ object: 'error' }));
    }
    if (u.pathname === '/cards/atraxa-1') return res.end(JSON.stringify(ATRAXA));
```

- [ ] **Step 3: Add the deck-creation tests**

Add these to `test/deckCards.test.js`, above the trailing `export { makeClient, aliceDeck };` line:

```js
test('creating a deck with a commander name stores the fuzzy-matched art', async () => {
  const ivy = makeClient();
  await ivy.request('POST', '/register', { username_input: 'Ivy', password_input: 'hunter2hunter' });
  const res = await ivy.request('POST', '/decks', { name: 'IvysAtraxa', format: 'Commander', commander: 'atraxa' });
  assert.equal(res.status, 302);
  const deck = await Deck.findOne({ name: 'IvysAtraxa' });
  assert.equal(deck.commander, 'atraxa'); // typed name kept at creation
  assert.equal(deck.commanderImageUrl, 'http://img/atraxa.jpg');
});

test('an unmatched or erroring commander lookup still creates the deck, without art', async () => {
  const jack = makeClient();
  await jack.request('POST', '/register', { username_input: 'Jack', password_input: 'hunter2hunter' });
  await jack.request('POST', '/decks', { name: 'JacksNoMatch', format: 'Commander', commander: 'nomatchxyz' });
  await jack.request('POST', '/decks', { name: 'JacksBoom', format: 'Commander', commander: 'explode' });
  for (const name of ['JacksNoMatch', 'JacksBoom']) {
    const deck = await Deck.findOne({ name });
    assert.ok(deck, `${name} was created`);
    assert.equal(deck.commanderImageUrl, '');
  }
});
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/scryfall.test.js test/deckCards.test.js`
Expected: PASS. The behaviour already exists, so these lock it in.

- [ ] **Step 5: Commit**

```bash
git add test/scryfall.test.js test/deckCards.test.js
git commit -m "Test getCardByName and commander art on deck creation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared `decklist` partial on the deck page and manager

**Files:**
- Create: `views/partials/decklist.handlebars`
- Modify: `views/deckDetail.handlebars` (replace the inline `.decklist` block)
- Modify: `views/deckCards.handlebars` (replace the "In this deck" `<ul>`)
- Modify: `routes/decks.js` (`GET /decks/:id/cards` passes `cardGroups`)
- Test: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `groupCards` from Task 1.
- Produces: partial `decklist` with params `groups` (required), `deckId` and `editable` (optional). When `editable` is set, rows with a `scryfallId` get a Remove form that posts to `/decks/<deckId>/cards/<scryfallId>/remove`.

- [ ] **Step 1: Write a failing manager-render test**

Add this to `test/deckCards.test.js` above the `export` line:

```js
test('manager lists deck cards grouped by type with a Remove button per card', async () => {
  const deck = await aliceDeck(); // holds Counterspell (Instant) from earlier tests
  const res = await alice.request('GET', `/decks/${deck._id}/cards`);
  assert.equal(res.status, 200);
  assert.match(res.text, /class="decklist"/);
  assert.match(res.text, /Instants <span>\(2\)<\/span>/);
  assert.match(res.text, new RegExp(`action="/decks/${deck._id}/cards/abc-123/remove"`));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/deckCards.test.js`
Expected: FAIL on `/class="decklist"/`, because the manager still renders a flat list.

- [ ] **Step 3: Create the partial**

Create `views/partials/decklist.handlebars`:

```hbs
<div class="decklist">
  {{#each groups}}
    <div class="decklist__group">
      <h3>{{this.label}} <span>({{this.count}})</span></h3>
      <ul class="cardlist">
        {{#each this.cards}}
          <li tabindex="0">
            <span class="cardlist__qty">{{this.quantity}}</span>
            <span class="cardlist__name">{{this.name}}</span>
            <span class="cardlist__meta">{{this.manaCost}}</span>
            {{#if this.imageUrl}}<img class="cardlist__preview" src="{{this.imageUrl}}" alt="" loading="lazy" />{{/if}}
            {{#if ../../editable}}{{#if this.scryfallId}}
              <form action="/decks/{{../../deckId}}/cards/{{this.scryfallId}}/remove" method="POST">
                <button type="submit" class="button cancel-button">Remove</button>
              </form>
            {{/if}}{{/if}}
          </li>
        {{/each}}
      </ul>
    </div>
  {{/each}}
</div>
```

`../../` climbs out of both `each` blocks to the partial's own context, which holds the hash params. `{{#if}}` doesn't change context, so the depth stays two. The Step 1 test checks this path: if `deckId` resolved empty, the action would read `/decks//cards/…` and the regex would fail.

- [ ] **Step 4: Use the partial on the deck page**

In `views/deckDetail.handlebars`, replace the whole block from `<div class="decklist">` through its matching `</div>` (the one just before `{{else}}`) with:

```hbs
      {{> decklist groups=cardGroups}}
```

- [ ] **Step 5: Use the partial on the manager**

In `routes/decks.js`, in `GET /decks/:id/cards`, add `cardGroups: groupCards(deck.cards),` to the `res.render('deckCards', { … })` object, after `results,`.

In `views/deckCards.handlebars`, replace the whole `<ul class="cardlist"> … </ul>` inside `{{#if deck.cards.length}}` with:

```hbs
      {{> decklist groups=cardGroups deckId=deck._id editable=true}}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. This includes the existing remove, add and deck-detail tests, so nothing regressed.

- [ ] **Step 7: Commit**

```bash
git add views/partials/decklist.handlebars views/deckDetail.handlebars views/deckCards.handlebars routes/decks.js test/deckCards.test.js
git commit -m "Share a grouped decklist partial between deck page and card manager

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Deck page group toggle and commander group and count

**Files:**
- Modify: `routes/decks.js` (`GET /decks/:id`)
- Modify: `views/deckDetail.handlebars` (toggle above the decklist)
- Modify: `public/css/style.css` (`.group-toggle`)
- Test: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `groupCards`, the `decklist` partial, the `eq` helper (registered in `app.js`) and Task 2's `/cards/named` fake (`atraxa`).
- Produces: `deckDetail` receives `groupMode: 'type' | 'cmc'` and `cardGroups`. `cardCount` includes the commander.

- [ ] **Step 1: Write the failing tests**

Add these to `test/deckCards.test.js` above the `export` line:

```js
test('deck detail groups by mana value with ?group=cmc and falls back to type otherwise', async () => {
  const deck = await aliceDeck(); // Counterspell, cmc 2
  const cmc = await alice.request('GET', `/decks/${deck._id}?group=cmc`);
  assert.match(cmc.text, /<h3>2 <span>\(2\)<\/span><\/h3>/);
  assert.match(cmc.text, /href="\?group=cmc"[^>]*aria-current="true"/);

  for (const qs of ['?group=color', '?group=cmc&group=type', '']) {
    const res = await alice.request('GET', `/decks/${deck._id}${qs}`);
    assert.equal(res.status, 200, qs);
    assert.match(res.text, /<h3>Instants <span>\(2\)<\/span><\/h3>/, qs);
    assert.match(res.text, /href="\?group=type"[^>]*aria-current="true"/, qs);
  }
});

test('a Commander deck with a commander and no cards shows a Commander group and Cards (1)', async () => {
  const kim = makeClient();
  await kim.request('POST', '/register', { username_input: 'Kim', password_input: 'hunter2hunter' });
  await kim.request('POST', '/decks', { name: 'KimsAtraxa', format: 'Commander', commander: 'atraxa' });
  const deck = await Deck.findOne({ name: 'KimsAtraxa' });
  const res = await kim.request('GET', `/decks/${deck._id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Cards \(1\)/);
  assert.match(res.text, /<h3>Commander <span>\(1\)<\/span><\/h3>/);
  assert.match(res.text, /Add some/); // owner hint still shown: deck.cards is empty
});

test('a commander name on a non-Commander deck adds no Commander group or count', async () => {
  const lee = makeClient();
  await lee.request('POST', '/register', { username_input: 'Lee', password_input: 'hunter2hunter' });
  await lee.request('POST', '/decks', { name: 'LeesModern', format: 'Modern', commander: 'atraxa' });
  const deck = await Deck.findOne({ name: 'LeesModern' });
  const res = await lee.request('GET', `/decks/${deck._id}`);
  assert.match(res.text, /Cards \(0\)/);
  assert.doesNotMatch(res.text, /<h3>Commander/);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --test test/deckCards.test.js`
Expected: FAIL. There's no `2` heading for `?group=cmc` and no toggle links, and the Kim deck shows `Cards (0)`.

- [ ] **Step 3: Implement the route changes**

In `routes/decks.js`, in `GET /decks/:id`, replace these two lines:

```js
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
```

```js
    const cardGroups = groupCards(deck.cards);
```

with:

```js
    // The commander lives outside deck.cards; it joins the list (and the count)
    // only on Commander-format decks.
    const hasCommander = deck.format === 'Commander' && Boolean(deck.commander);
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0) + (hasCommander ? 1 : 0);
```

```js
    const groupMode = ['type', 'cmc'].includes(req.query.group) ? req.query.group : 'type';
    const cardGroups = groupCards(deck.cards, {
      mode: groupMode,
      commander: hasCommander ? { name: deck.commander, imageUrl: deck.commanderImageUrl } : undefined,
    });
```

Then add `groupMode` to the `res.render('deckDetail', { … })` object.

- [ ] **Step 4: Add the toggle and keep the empty hint**

In `views/deckDetail.handlebars`, replace the cards section body (from `<h2>Cards ({{cardCount}})</h2>` through the closing `{{/if}}` of `{{#if cardGroups.length}}`) with:

```hbs
    <div class="deck-cards-view__head">
      <h2>Cards ({{cardCount}})</h2>
      <p class="group-toggle">Group by:
        <a href="?group=type"{{#if (eq groupMode "type")}} aria-current="true"{{/if}}>Type</a> &middot;
        <a href="?group=cmc"{{#if (eq groupMode "cmc")}} aria-current="true"{{/if}}>Mana value</a>
      </p>
    </div>
    {{#if cardGroups.length}}
      {{> decklist groups=cardGroups}}
    {{/if}}
    {{#unless deck.cards.length}}
      <p>No cards in this deck yet.{{#if isOwner}} <a href="/decks/{{deck._id}}/cards">Add some</a>.{{/if}}</p>
    {{/unless}}
```

- [ ] **Step 5: Style the toggle**

In `public/css/style.css`, after the `.cardlist li:hover .cardlist__preview, …` rule, add:

```css
.group-toggle { color: var(--ink-soft); font-size: 0.9rem; margin: 0; }
.group-toggle a[aria-current="true"] { font-weight: 700; text-decoration: none; color: inherit; }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. The existing `Cards \(2\)` test still passes because Alice's deck is Modern.

- [ ] **Step 7: Commit**

```bash
git add routes/decks.js views/deckDetail.handlebars public/css/style.css test/deckCards.test.js
git commit -m "Add Type/Mana value group toggle and commander group to deck page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `POST /decks/:id/commander` and the manager UI

**Files:**
- Modify: `routes/decks.js` (new route and the `isCommanderDeck` render flag)
- Modify: `views/deckCards.handlebars` (Set-as-commander form and the current-commander line)
- Modify: `public/css/style.css` (`.current-commander`)
- Test: `test/deckCards.test.js`

**Interfaces:**
- Consumes: `findOwnedDeck`, `getCardById`, and the Task 2 fake (`/cards/atraxa-1`, `/cards/abc-123`).
- Produces: `POST /decks/:id/commander` with body `{ scryfall_id, q? }`. It responds 302 to `/decks/:id/cards[?q=…]`, or 404 if the user isn't the owner.

- [ ] **Step 1: Write the failing tests**

Add these to `test/deckCards.test.js` above the `export` line:

```js
test('Set as commander overwrites name and art from the re-fetched card, keeping q', async () => {
  const max = makeClient();
  await max.request('POST', '/register', { username_input: 'Max', password_input: 'hunter2hunter' });
  await max.request('POST', '/decks', { name: 'MaxsCmdr', format: 'Commander', commander: 'nomatchxyz' });
  const deck = await Deck.findOne({ name: 'MaxsCmdr' });

  const page = await max.request('GET', `/decks/${deck._id}/cards?q=counterspell`);
  assert.match(page.text, /Set as commander/);

  const res = await max.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1', q: 'a&b c' });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/decks/${deck._id}/cards?q=a%26b%20c`);

  const updated = await Deck.findOne({ name: 'MaxsCmdr' });
  assert.equal(updated.commander, "Atraxa, Praetors' Voice");
  assert.equal(updated.commanderImageUrl, 'http://img/atraxa.jpg');
  assert.equal(updated.cards.length, 0); // commander is not added to the card list

  const managerPage = await max.request('GET', `/decks/${deck._id}/cards`);
  assert.match(managerPage.text, /class="current-commander"/);
});

test('Set as commander is refused for non-owners, non-Commander decks, and empty ids', async () => {
  const deck = await aliceDeck(); // Alice's Modern deck
  const nia = makeClient();
  await nia.request('POST', '/register', { username_input: 'Nia', password_input: 'hunter2hunter' });
  const denied = await nia.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1' });
  assert.equal(denied.status, 404);

  const page = await alice.request('GET', `/decks/${deck._id}/cards?q=counterspell`);
  assert.doesNotMatch(page.text, /Set as commander/);
  const modern = await alice.request('POST', `/decks/${deck._id}/commander`, { scryfall_id: 'atraxa-1' });
  assert.equal(modern.status, 302);
  assert.equal((await aliceDeck()).commanderImageUrl, '');

  await nia.request('POST', '/decks', { name: 'NiasCmdr', format: 'Commander' });
  const own = await Deck.findOne({ name: 'NiasCmdr' });
  const empty = await nia.request('POST', `/decks/${own._id}/commander`, { scryfall_id: '' });
  assert.equal(empty.status, 302);
  assert.equal((await Deck.findOne({ name: 'NiasCmdr' })).commander, undefined);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --test test/deckCards.test.js`
Expected: FAIL. The manager has no "Set as commander" text and the route returns 404.

- [ ] **Step 3: Implement the route**

In `routes/decks.js`, add this after the `POST /decks/:id/cards/:scryfallId/remove` handler:

```js
router.post('/decks/:id/commander', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const scryfallId = (req.body.scryfall_id || '').trim();
    const q = (req.body.q || '').trim();
    const back = q ? `/decks/${deck._id}/cards?q=${encodeURIComponent(q)}` : `/decks/${deck._id}/cards`;
    if (deck.format !== 'Commander' || !scryfallId) return res.redirect(back);

    // Re-fetch for the canonical name and art; never trust client-posted card fields.
    const card = await getCardById(scryfallId);
    deck.commander = card.name;
    deck.commanderImageUrl = card.imageUrl;
    await deck.save();

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});
```

In `GET /decks/:id/cards`, add `isCommanderDeck: deck.format === 'Commander',` to the `res.render('deckCards', { … })` object.

- [ ] **Step 4: Add the manager UI**

In `views/deckCards.handlebars`, inside each search result's `card-tile__body`, after the Add `</form>`, add:

```hbs
                {{#if ../isCommanderDeck}}
                  <form action="/decks/{{../deck._id}}/commander" method="POST">
                    <input type="hidden" name="scryfall_id" value="{{this.scryfallId}}" />
                    <input type="hidden" name="q" value="{{../query}}" />
                    <button type="submit" class="button">Set as commander</button>
                  </form>
                {{/if}}
```

In the same file, directly after `<h2>In this deck</h2>`, add:

```hbs
    {{#if isCommanderDeck}}{{#if deck.commander}}
      <p class="current-commander">
        {{#if deck.commanderImageUrl}}<img src="{{deck.commanderImageUrl}}" alt="" />{{/if}}
        Commander: <strong>{{deck.commander}}</strong>
      </p>
    {{/if}}{{/if}}
```

- [ ] **Step 5: Style the current-commander line**

In `public/css/style.css`, after the `.group-toggle` rules, add:

```css
.current-commander { display: flex; align-items: center; gap: 0.8rem; margin-bottom: 1rem; }
.current-commander img { width: 4rem; border-radius: 4px; box-shadow: var(--shadow-card); }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add routes/decks.js views/deckCards.handlebars public/css/style.css test/deckCards.test.js
git commit -m "Let owners set a Commander deck's commander from Scryfall search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Browser verification

**Files:** none, unless a defect turns up. Any fix gets its own failing test first.

- [ ] **Step 1:** Run `npm test` and confirm everything passes.
- [ ] **Step 2:** Start the app with `npm run dev` against the local MongoDB. Use the real Scryfall API, with `SCRYFALL_API_BASE` unset.
- [ ] **Step 3:** In the browser, check:
  - **Dashboard:** the deck grid shows commander art.
  - **Commander deck page:** the hero art and the Commander group come first. Type and Mana value both render, and the active link is bold. Hover and keyboard focus show the card preview. The layout holds at phone width (around 375px).
  - **Manager:** grouped list, a working Remove button and hover previews. Search for a commander, click "Set as commander", and confirm the redirect keeps the search and that the current-commander line and deck art update.
  - **Modern deck manager:** there's no "Set as commander" button.
- [ ] **Step 4:** Report the results. If no fixes were needed, there's nothing to commit.
