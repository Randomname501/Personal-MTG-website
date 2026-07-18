# Card Insights (Spec 2) — Design

**Date:** 2026-07-18
**Status:** Approved (pending spec review)
**Feature:** The fast-follow to the card/deck browser (Spec 1). Adds a card-derived
"Card breakdown" — mana curve, color breakdown, type counts — to the deck detail page,
computed entirely from the card snapshots Spec 1 already stores. This is the second
sub-spec of the "card/deck browser" roadmap item.

## Goal

Now that decks store real card lists (each card carries `cmc`, `colors`, `typeLine`,
`quantity`), surface at-a-glance deckbuilding insight: how the deck's mana curve looks,
its color spread, and its composition by card type. All of it is derived from data
already on the deck — no new data collection, no DB queries, no Scryfall calls at render.

## Constraints

- **Stack:** Express 4 + Mongoose + Handlebars, server-rendered, no client-side JS
  framework, no new runtime dependencies.
- **No schema changes.** Reads the existing embedded `Deck.cards`
  (`{ scryfallId, name, manaCost, cmc, colors[], typeLine, imageUrl, quantity }`).
- **No network / DB at render:** insight is a pure function of the deck's card array.
- Reuse existing patterns: the deck detail route (`GET /decks/:id`) and the CSS bar
  components (`.bar-row`, `.bar`, `.bar__fill`) already used by the deck-stats section.

## Architecture

### 1. New module — `lib/cardInsights.js`

One exported pure function:

```
getCardInsights(cards) -> {
  total,          // Number — sum of every card's quantity
  nonlandTotal,   // Number — sum of quantity over nonland cards (the curve's population)
  manaCurve: [{ bucket, count, pct }],  // exactly 8 buckets: '0','1','2','3','4','5','6','7+'
  colors:    [{ color, count, pct }],   // subset of ['W','U','B','R','G','C'], only count > 0
  types:     [{ type,  count, pct }],   // canonical order, only count > 0
}
```

`cards` is the deck's `cards` array (may be empty or undefined → treated as `[]`).

Rules:

- **Land test** — a card is a land iff its `typeLine` contains the whole word `Land`
  (case-insensitive, e.g. `/\bland\b/i`).
- **Mana curve** — nonland cards only. Bucket key is `Math.floor(cmc)` as a string,
  except `cmc >= 7` goes to the `'7+'` bucket. All 8 buckets (`'0'`..`'6'`,`'7+'`) are
  always present, in that order, even when their count is 0. Each card contributes its
  `quantity` to its bucket's count.
- **Colors** — nonland cards only (mirrors the curve). Each nonland card contributes its
  `quantity` to each color in its `colors` array; a nonland card whose `colors` is
  empty/absent contributes to `'C'` (colorless). Lands contribute nothing to any color,
  including `'C'`. Output is in the order `W, U, B, R, G, C`, filtered to entries with
  `count > 0`.
- **Types** — each card is assigned exactly one primary category by this priority
  (first match wins), so the counts sum to `total`:
  `Land → Creature → Planeswalker → Instant → Sorcery → Artifact → Enchantment → Battle
  → Other`. Matching is a whole-word, case-insensitive check against `typeLine`
  (`Other` is the fallback when none match). Output order is that same canonical list,
  filtered to entries with `count > 0`.
- **`pct`** — for each of the three groups, `pct = Math.round(count / groupMax * 100)`
  where `groupMax` is the largest `count` in that group (0 when the group is empty),
  so the biggest bar in each group is full width. Computed in the module so the template
  carries no arithmetic. (Curve `pct` uses the max bucket count; note buckets with count
  0 yield `pct` 0.)

The function is a self-contained fold over the array — no dependencies beyond plain JS.

### 2. Deck detail route — `GET /decks/:id` (`routes/decks.js`)

The handler already loads the deck (`.lean()`) and computes `stats`, `isOwner`,
`cardCount`. Add `const insights = getCardInsights(deck.cards || []);` and pass
`insights` to `res.render('deckDetail', …)`. No other route logic changes.

### 3. View — `views/deckDetail.handlebars`

Add a **Card breakdown** section, rendered only when the deck has cards
(`{{#if deck.cards.length}}`), containing three labeled bar groups built from the
existing bar markup:

- **Mana curve** — one `.bar-row` per `manaCurve` bucket: label = bucket, bar width =
  `{{pct}}%`, value = `{{count}}`.
- **Colors** — one `.bar-row` per `colors` entry, the fill tinted by the color (via a
  `bar__fill--mana-{{color}}` class mapped to the existing `--mana-*` custom
  properties; `C` uses a neutral tone).
- **Types** — one `.bar-row` per `types` entry: label = type, bar width, value = count.

Section placement: after the existing Record/stats sections (a distinct
`<section class="deck-breakdown">`).

### 4. CSS — `public/css/style.css`

Minimal additions: a layout wrapper for the three groups and the
`bar__fill--mana-W/U/B/R/G/C` tint classes mapped to `--mana-w-edge/--mana-u/--mana-b/
--mana-r/--mana-g` and a neutral colorless tone. Reuse the existing `.bar-row`/`.bar`
sizing.

## Error Handling

- `getCardInsights` never throws on empty/undefined input: `getCardInsights(undefined)`
  and `getCardInsights([])` return `{ total: 0, nonlandTotal: 0, manaCurve: <8 zeroed
  buckets>, colors: [], types: [] }`.
- Division-by-zero in `pct` is guarded (groupMax 0 → pct 0).
- The route change is additive; a deck with no cards renders no breakdown section (the
  existing "No cards" state is unchanged), so existing deck-detail tests are unaffected.

## Testing — `test/cardInsights.test.js` (`node --test`, no DB)

Pure unit tests over hand-built card arrays:

- **Empty:** `getCardInsights([])` returns zeros, 8 zeroed curve buckets, empty
  `colors`/`types`.
- **Curve excludes lands & buckets:** a mix including lands and a `cmc 9` card — assert
  lands are absent from the curve, `nonlandTotal` is correct, the `cmc 9` card lands in
  `'7+'`, and `quantity` weighting is applied.
- **Colors:** nonland cards only (mirrors the curve) — a multicolor card (e.g.
  `['U','B']`) counts toward both U and B; a colorless nonland card lands in `C`; lands
  contribute nothing (not even to `C`); quantities weight the counts; only `> 0` colors
  appear, in `WUBRG C` order.
- **Types priority:** `Artifact Creature` → Creature; `Artifact Land` → Land;
  `Legendary Planeswalker` → Planeswalker; an unmatched line → Other; counts sum to
  `total`.
- **`pct` scaling:** the largest bucket/color/type in each group is `100`, others scale
  proportionally, and an all-zero group yields `pct` 0 (no divide-by-zero).

## Out of Scope (YAGNI)

- Mana-pip (symbol) color counting — colors are counted per card via the `colors` array.
- Average CMC or other aggregate numbers beyond the three breakdowns.
- Format legality / singleton checks.
- Any chart rendering beyond CSS bars; any surface other than the deck detail page.
