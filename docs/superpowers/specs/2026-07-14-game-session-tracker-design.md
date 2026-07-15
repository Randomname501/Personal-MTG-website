# Game Session Tracker — Design

**Date:** 2026-07-14
**Status:** Approved (pending spec review)
**Feature:** Second of four planned features (see the feature roadmap). Makes game
records first-class: browsable history plus edit and delete. The card/deck browser
and social/sharing features are separate, later specs.

## Goal

Today a `GameRecord` is write-only: the dashboard has a quick-log form, and records
surface only through leaderboards and the deck-stats aggregations. This feature lets a
user **browse** their past games, **edit** a mistaken entry, and **delete** one — full
CRUD on the record they already log, with no new per-game fields.

## Constraints

- **Stack:** Express 4 + Mongoose + Handlebars (`express-handlebars`, `defaultLayout: main`),
  server-rendered, no client-side JS framework, no new runtime dependencies.
- **No schema changes.** `GameRecord` keeps `{ user, deck, opponentDeck, result, timestamps }`.
- Reuse existing patterns: `requireAuth`, `.lean()` in read routes for Handlebars, the
  `_method` override middleware (already in `app.js`) for `PUT`/`DELETE` from forms, and
  the `deckForm` / logout-confirm view patterns.
- Existing `POST /game-records` (the dashboard quick-log) stays unchanged so current
  behavior and tests are untouched.

## Data Sources (existing, unchanged)

- `GameRecord`: `user` (ObjectId), `deck` (ObjectId, ref Deck), `opponentDeck` (String,
  free text), `result` (`'win' | 'loss' | 'draw'`), `createdAt`.
- `Deck`: owned by a `User`; `name`, `format`, etc.

## Architecture

All routes live in `routes/gameRecords.js`, RESTful under `/game-records`. Each is
`requireAuth` and scoped to `req.currentUser`.

| Route | Purpose |
|---|---|
| `GET /game-records` | Match history: the user's games, newest-first, with filters |
| `POST /game-records` | Create (existing — unchanged) |
| `GET /game-records/:id/edit` | Pre-filled edit form |
| `PUT /game-records/:id` | Save an edit |
| `GET /game-records/:id/delete` | "Are you sure?" confirmation page |
| `DELETE /game-records/:id` | Delete the record |

### Shared validation helper

Extract the create route's validation into a small reusable function so create and edit
cannot drift:

```
validateGameRecordInput({ deckId, opponentDeck, result }, userId) ->
  { ok: true, deck, opponentDeck: <trimmed> } | { ok: false }
```

It verifies the deck exists AND belongs to `userId`, `result` is in `GAME_RESULTS`, and
`opponentDeck` is non-empty after trim. `POST /game-records` is refactored to use it
(behavior identical: invalid input redirects to `/dashboard`).

### List — `GET /game-records`

- Read `deck` and `result` query params. Build a filter: always `{ user }`; add
  `deck` only if it is a valid ObjectId belonging to the user; add `result` only if it is
  in `GAME_RESULTS`. Unknown/invalid values are ignored (no error, just unfiltered on
  that axis).
- `GameRecord.find(filter).sort({ createdAt: -1 }).populate('deck', 'name').lean()`.
- Render `gameHistory` with: the rows, the user's decks (for the filter `<select>`),
  and the currently-applied filter values (to pre-select and to show a "Clear" link).

### Edit — `GET /game-records/:id/edit`, `PUT /game-records/:id`

- Both load the record via `GameRecord.findOne({ _id: id, user: currentUser._id })`.
  Missing/malformed id or non-owned record → render `404` with status 404. (Ownership is
  enforced by the query itself — another user's record simply is not found.)
- `GET` renders `gameRecordForm` pre-filled (deck `<select>` of the user's decks with the
  record's deck selected, opponent input, result `<select>`).
- `PUT` runs `validateGameRecordInput`. On success, update `deck`, `opponentDeck`,
  `result` and redirect to `/game-records`. On failure, re-render `gameRecordForm` with
  status 400, an error banner, and the submitted values (a small UX improvement over the
  create route's silent redirect).

### Delete — `GET /game-records/:id/delete`, `DELETE /game-records/:id`

- Both load the record with the same owner-scoped query; not found → 404.
- `GET` renders `gameRecordDelete`, a small confirmation page (mirroring the logout
  page): shows the record summary and a form that `POST`s with `_method=DELETE`, plus a
  cancel link back to `/game-records`.
- `DELETE` calls `GameRecord.deleteOne({ _id: id, user: currentUser._id })` and redirects
  to `/game-records`.

### Views

- `views/gameHistory.handlebars` — filter bar (GET form: deck select, result select,
  Apply, Clear) + a table of games (date, deck, opponent, result, Edit / Delete actions).
  Empty state when there are no games (or none match the filter).
- `views/gameRecordForm.handlebars` — the edit form, following `deckForm` structure and
  error-banner pattern.
- `views/gameRecordDelete.handlebars` — confirmation page, following the logout pattern.

### Navigation

- Add `{ link: '/game-records', text: 'Match History' }` to `loggedInNav` in
  `middleware/auth.js`.
- Add a "View match history" link near the dashboard quick-log form in
  `views/userDashboard.handlebars`.

### Styling

- `public/css/style.css`: styles for the history table, filter bar, and row actions,
  reusing the existing custom properties and the `.deck-card` / table conventions.

## Error Handling

- All handlers wrap async work in `try/catch → next(err)`, matching existing routes.
- Any `:id` route with a malformed ObjectId or a non-owned/missing record renders `404`
  (status 404) — never a 500, never another user's data.
- Invalid filter values on the list are ignored rather than erroring.
- Invalid edit input re-renders the edit form (status 400) with an error message.

## Testing — `test/gameRecords.test.js` (`node --test`, own DB `mtg_tracker_games_test`)

Using the same HTTP integration harness as the other suites (cookie jar + `request`
helper; array form fields sent as repeated keys). Register a user, create two decks, log
several games, then assert:

- **List:** `GET /game-records` shows the logged games, newest-first.
- **Filter by deck:** `?deck=<id>` shows only that deck's games.
- **Filter by result:** `?result=loss` shows only losses; an invalid `result` value is
  ignored (all games shown).
- **Edit:** `GET .../edit` renders pre-filled; `PUT` updates the record (verified by
  re-reading the list / the DB).
- **Edit validation:** a `PUT` with an empty opponent re-renders the form with status 400
  and does not change the record.
- **Delete:** `GET .../delete` renders the confirm page; `DELETE` removes the record.
- **Ownership:** a second user's `GET .../edit`, `PUT`, and `DELETE` against the first
  user's record all return 404 and leave the record unchanged.

## Out of Scope (YAGNI)

- New per-game fields (play/draw, mulligans, turns, notes, format-per-game).
- Best-of-three matches / sideboarding.
- Analytics over history (the deck-stats feature already covers aggregate analytics).
- Bulk actions, pagination (a personal tracker's game counts stay small; revisit if
  volumes grow).
