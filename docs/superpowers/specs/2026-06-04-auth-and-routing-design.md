# Design: Auth + Routing for the MTG Tracker

**Date:** 2026-06-04
**Status:** Approved

## Context

The app is an Express + Handlebars MTG match tracker backed by local MongoDB via
Mongoose. The data layer exists ([models/](../../../models/), [lib/leaderboards.js](../../../lib/leaderboards.js))
but no routes consume it — [routes/index.js](../../../routes/index.js) only renders static
views. This spec covers wiring up the full user-facing flow: registration, login/logout,
a dashboard, deck creation, game-record logging, and the two leaderboards.

The existing views already dictate the behavior:
[home.handlebars](../../../views/home.handlebars) (public landing, "Log In to Start Tracking"),
[login.handlebars](../../../views/login.handlebars) (username 3–50, password 8–50, with a
`hasError`/`loginError` pattern), [userDashboard.handlebars](../../../views/userDashboard.handlebars)
(owned `decks`, `trackedDecks`, and a game-record form posting `deck_id`, `opponent_deck`,
`result`), [leaderboard.handlebars](../../../views/leaderboard.handlebars),
[deckLeaderboard.handlebars](../../../views/deckLeaderboard.handlebars), and
[logout.handlebars](../../../views/logout.handlebars) (a confirm page).

There is **no** registration page, **no** deck-creation UI, and **no** route that renders
the dashboard yet. This spec fills those gaps.

## Decisions (locked)

- **Registration:** add a dedicated `/register` page (self-serve signup), separate from login.
- **Decks this round:** create + list only. Defer the `/decks/:id` detail page (deck cards
  become non-links) and defer deck *tracking* UI. `trackedDecks` stays in the model but has
  no UI yet.
- **Auth gating:** dynamic nav (logged-out: Home/Leaderboards/Login/Register; logged-in:
  Home/Leaderboards/Dashboard/Logout); protected routes redirect to `/login`; land on
  `/dashboard` after login/register.
- **Logout:** `GET /logout` shows the confirm page; `POST /logout` destroys the session.
- **Code structure:** split route modules + a `middleware/` layer; query logic stays in `lib/`.

## Architecture

Slim [routes/index.js](../../../routes/index.js) mounts focused sub-routers:

| File | Responsibility | Auth |
|---|---|---|
| `middleware/auth.js` | `requireAuth` (redirect `/login` if no session); `attachUser` (load session user once → `res.locals.currentUser` + dynamic `res.locals.navLink`) | — |
| `routes/pages.js` | `GET /` home | public |
| `routes/auth.js` | `GET/POST /register`, `GET/POST /login`, `GET /logout` (confirm), `POST /logout` (destroy) | public |
| `routes/dashboard.js` | `GET /dashboard` | guarded |
| `routes/decks.js` | `GET /decks/new`, `POST /decks` | guarded |
| `routes/gameRecords.js` | `POST /game-records` | guarded |
| `routes/leaderboards.js` | `GET /leaderboard`, `GET /deckLeaderboard` | public |
| `lib/leaderboards.js` | leaderboard aggregations (already built) | — |

### Views
- **New:** `register.handlebars` (mirrors login: username + password fields, error block),
  `deckForm.handlebars` (name; `format` dropdown from `DECK_FORMATS`; `colors` checkboxes from
  `MTG_COLORS`; optional commander, archetype, description).
- **Modified:** `userDashboard.handlebars` — deck cards become non-links (no detail page yet);
  add a "New Deck" link.
- Nav is rendered from `res.locals.navLink`, set centrally by `attachUser`, so individual
  routes stop passing `navLink` by hand.

## Data flow

Session stores **only** `userId`. `attachUser` runs on every request: if `session.userId`,
load the user (sans hash) into `res.locals.currentUser` and build the logged-in nav;
otherwise build the logged-out nav.

- **Register** (`POST /register`): validate username (3–50, required) and password (8–50);
  `new User({ username })` + `await user.setPassword(pw)` + save; on success set
  `session.userId` → redirect `/dashboard`. Duplicate username (caught via the case-insensitive
  unique index → Mongo `E11000`) or validation error → re-render `register` with an error message.
- **Login** (`POST /login`): find user by username using the case-insensitive collation;
  `await user.verifyPassword(pw)`; on success set `session.userId` → redirect `/dashboard`;
  on failure re-render `login` with `hasError: true`, `loginError: 'Invalid username or password'`.
- **Logout:** `GET /logout` renders the confirm page; the "Yes, Sign Out" button issues a
  `POST /logout` (via the existing `_method` override or a real form POST) which calls
  `req.session.destroy()` → redirect `/`.
- **Dashboard** (`GET /dashboard`, guarded): `decks = Deck.find({ owner: userId })`;
  `trackedDecks` via `User.findById(userId).populate('trackedDecks')`; render with the deck
  list feeding the game-record form's `<select>`.
- **New deck** (`POST /decks`, guarded): build a `Deck` with `owner = session userId`, `colors`
  from the checked boxes (array), optional fields trimmed; on validation error re-render
  `deckForm` with the message; on success redirect `/dashboard`.
- **Game record** (`POST /game-records`, guarded): confirm the posted `deck_id` belongs to the
  current user; validate `result ∈ {win,loss,draw}` and non-empty `opponent_deck`; create the
  `GameRecord`; redirect `/dashboard`. Invalid input → redirect back with an error.
- **Leaderboards:** call `getPlayerLeaderboard()` / `getDeckLeaderboard()` and render.

## Error handling

- Form validation + duplicate-username errors re-render the originating form with a visible
  message (same `hasError`/`loginError` pattern the login view already uses).
- Guarded routes with no session redirect to `/login`.
- Mongoose `ValidationError` and duplicate-key (`E11000`) are caught per-route and turned into
  friendly messages rather than 500s.

## Enabling refactors (small, in-scope)

1. **`config/db.js`** — read `process.env.MONGODB_URI` *inside* `connectMongo()` rather than at
   module import time, so scripts/tests can point at a throwaway database before connecting.
   (Preserve the user's current shortened error message.)
2. **`app.js`** — export the configured Express `app`; only `connectMongo()` + `listen()` when
   the module is run directly. Enables importing the app into an automated test without binding
   the dev database or port.

## Testing / Verification

- **Automated integration test** (temporary, deleted after): Node's built-in `node:test` +
  global `fetch` with manual cookie capture (no new dependencies), against a throwaway DB
  (`mtg_tracker_test`). Flow: register a user → `GET /dashboard` returns 200 with the username →
  `POST /decks` creates a deck → `POST /game-records` logs a win → `GET /leaderboard` shows the
  user with 1 win. Also assert an unauthenticated `GET /dashboard` redirects to `/login`, and a
  wrong-password `POST /login` re-renders with the error. Drop the test DB at the end.
- **Manual smoke:** `node app.js` boots, "Connected to MongoDB", home + leaderboards return 200.

## Out of scope (deferred)

- Deck detail page `/decks/:id` and per-deck game history.
- Deck tracking UI (browse/follow other users' decks → `User.trackedDecks`).
- Password complexity rules beyond length; email, password reset, "remember me".
- Editing/deleting decks or game records.
