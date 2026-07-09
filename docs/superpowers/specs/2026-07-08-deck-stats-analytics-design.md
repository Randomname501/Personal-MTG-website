# Deck Stats & Analytics — Design

**Date:** 2026-07-08
**Status:** Approved (pending spec review)
**Feature:** First of four planned features. Focused on surfacing analytics from data
already collected. Later features (game session tracker, card/deck browser, social/sharing)
are separate specs.

## Goal

Show players useful analytics derived entirely from existing data — no new data
collection and no schema changes. Read and aggregate `GameRecord` documents and
present win rates, matchup breakdowns, over-time trends, and an account-wide summary.

## Constraints

- **Stack:** Express + Mongoose + Handlebars (`express-handlebars`, `defaultLayout: main`).
- **No new runtime dependencies.** Presentation is server-rendered CSS bars + tables.
  Everything works with JavaScript disabled.
- **No schema changes.** `GameRecord` already stores `{ user, deck, opponentDeck, result, timestamps }`
  and `Deck` stores `{ name, format, owner, colors, commander, archetype, description }`.
- Reuse existing patterns: `.lean()` in routes for Handlebars, `requireAuth` middleware,
  aggregation style from `lib/leaderboards.js`.

## Data Sources (existing, unchanged)

- `GameRecord`: `user` (ObjectId), `deck` (ObjectId), `opponentDeck` (String, free text),
  `result` (`'win' | 'loss' | 'draw'`), `createdAt` (timestamp).
  Existing indexes: `{ deck, result }`, `{ user, result }`.
- `Deck`: owned by a `User`; has `name`, `format`, `colors`, `commander`, `archetype`.

## Architecture

### 1. New module: `lib/stats.js`

Kept separate from `lib/leaderboards.js` (which stays focused on cross-user ranking).
This module holds user/deck-scoped analytics. Two exported functions:

#### `getDeckStats(deckId)`

Returns:

```js
{
  wins, losses, draws, total,
  winRate,        // whole-number percent, 0 when total === 0
  matchups: [     // sorted by games played desc
    { opponent, wins, losses, draws, total, winRate }
  ],
  trend: [        // ISO-week buckets, only weeks that have games, chronological
    { week, games, winRate }   // week e.g. "2026-W27"
  ]
}
```

- **Matchups:** group this deck's games by `opponentDeck` normalized to `trim().toLowerCase()`
  for the grouping key, but display the most frequently used original spelling as `opponent`.
  Sorted by `total` desc.
- **Trend:** bucket by ISO week of `createdAt`. Only include weeks that contain games.
  Chronological order.

#### `getUserSummary(userId)`

Returns account-wide totals across all decks owned by the user:

```js
{
  totalGames, wins, losses, draws,
  winRate,        // whole-number percent, 0 when totalGames === 0
  bestDeck         // { name, winRate, total } or null
}
```

- **bestDeck:** highest win rate among the user's decks that have **≥ 3 games**
  (threshold avoids a 1-0 deck outranking a 12-6 deck). `null` if no deck qualifies.

#### Shared helpers

- `winRatePercent(wins, losses, draws)`: `total = wins + losses + draws`; returns
  `total === 0 ? 0 : Math.round((wins / total) * 100)`. Divide-by-zero safe.
- ISO-week key helper for trend bucketing.

### 2. Dashboard — `GET /dashboard` (`routes/dashboard.js`)

- Also call `getUserSummary(req.currentUser._id)` and pass a `summary` object to the view.
- `views/userDashboard.handlebars`: add a summary band above "My Decks" showing overall
  record (W-L-D), win rate, and best deck. Make each deck card a link to `/decks/:id`.

### 3. Deck detail page — `GET /decks/:id` (new, `routes/decks.js`)

- `requireAuth`. Any authenticated user may view any deck (consistent with the existing
  public leaderboards). Invalid or missing id → `404`.
- Loads the deck (`.lean()`) and `getDeckStats(deck._id)`.
- New view `views/deckDetail.handlebars`:
  - Header: name, format, colors, commander, archetype.
  - Win-rate summary + W/L/D as CSS bars.
  - Matchups table (opponent, W-L-D, win rate) with small CSS bars.
  - Weekly win-rate trend as CSS bars.
- Editing a deck from this page is **out of scope**.

### 4. Presentation — `public/css/style.css`

- Add styles for a horizontal bar component (a track + a filled portion sized by percent)
  and the summary band / stats sections. Bar widths are set via inline `style="width:NN%"`
  computed server-side, so no client JS is required.

## Error Handling

- Route handlers wrap async work in `try/catch` and call `next(err)`, matching existing routes.
- `GET /decks/:id` with a malformed ObjectId or no match renders a 404 (do not 500).
- All win-rate math is divide-by-zero safe and renders `0%` / `—` for empty data.

## Testing — `test/stats.test.js` (`node --test`)

Seed `GameRecord`/`Deck`/`User` docs and assert:

- **Win rate & record:** correct W/L/D counts and rounded win-rate percent.
- **Zero games:** `getDeckStats` and `getUserSummary` return zeros / empty arrays / `null`
  best deck without throwing (divide-by-zero guard).
- **Matchup grouping:** case/whitespace variants of the same opponent name collapse into
  one row; display label is the most common original spelling; sorted by games desc.
- **Trend bucketing:** games in the same ISO week group together; only weeks with games appear.
- **bestDeck threshold:** a deck with < 3 games is not chosen; among qualifying decks the
  highest win rate wins; `null` when none qualify.

## Out of Scope (YAGNI)

- Schema changes or richer game logging — that is the separate "game session tracker" feature.
- Interactive/JS charts (Chart.js etc.).
- Editing or deleting decks from the detail page.
- Analytics across other users' decks beyond viewing a single deck's page.
