# Social: Deck Discovery + Tracking (Sub-project A) — Design

**Date:** 2026-07-18
**Status:** Approved (pending spec review)
**Feature:** First sub-project of the "social / sharing" roadmap item (the fourth and
last planned feature). Social was decomposed during brainstorming into: **A. deck
discovery + tracking** (this spec), B. user profiles + following, C. comments,
D. playgroups. Each gets its own spec → plan → build cycle; this is A.

## Goal

`User.trackedDecks` already exists and the dashboard renders a "Tracked Decks" section,
but there is **no route to track or untrack a deck**, so the field is dead. Deck pages
are already public (`GET /decks/:id` is viewable by any authenticated user) but there is
**no way to discover** other users' decks. This spec adds a **Browse Decks** page and
**Track/Untrack** controls, turning both into a working feature — with no schema changes.

## Constraints

- **Stack:** Express 4 + Mongoose + Handlebars, server-rendered, no client-side JS
  framework, no new runtime dependencies.
- **No schema changes.** `User.trackedDecks` (array of `Deck` ObjectIds) already exists.
- All decks remain public (existing behavior); no privacy flag is introduced.
- Reuse existing patterns: `requireAuth`, `.lean()` reads, the match-history filter-bar
  pattern, `try/catch → next(err)`, and the deck-card markup already in the views.
- **No extra queries on the read path:** `req.currentUser` (loaded by `attachUser` with
  `.select('-passwordHash').lean()`) already carries `trackedDecks`, so track state is
  derived from it in memory rather than re-queried.

## Architecture

All routes live in `routes/decks.js`.

### Safe redirect helper

Track/untrack are posted from three surfaces (deck page, browse, dashboard) and should
return the user to where they were. A small helper keeps this safe from open-redirects:

```
safeBack(value, fallback) -> a local path
```
Returns `value` only when it is a string starting with a single `/` (i.e. `/…` but not
`//…` and not containing a scheme); otherwise returns `fallback`. Forms submit the
current path in a hidden `back` field.

### `GET /decks` — Browse (new, `requireAuth`)

- Reads optional `?format=`; applies it only when it is one of `DECK_FORMATS`.
- `Deck.find(filter).sort({ createdAt: -1 }).populate('owner', 'username').lean()`.
- Builds a `Set` of the current user's tracked deck ids from `req.currentUser.trackedDecks`.
- Maps each deck to a row carrying `isOwner` (`owner._id === currentUser._id`) and
  `isTracked` (id in the set).
- Renders `deckBrowse` with the rows, the format list, and the applied filter.
- Path note: `GET /decks` (exact) does not collide with `GET /decks/new` or
  `GET /decks/:id`; register it before `GET /decks/:id`.

### `POST /decks/:id/track` — (new, `requireAuth`)

- 404-guards a malformed id (redirect to `/decks` rather than 500). Loads the deck lean;
  if missing, redirect back.
- If the deck's owner **is** the current user, do nothing (you can't track your own deck)
  and redirect back.
- Otherwise `User.updateOne({ _id: currentUser._id }, { $addToSet: { trackedDecks: id } })`
  (`$addToSet` makes it idempotent).
- Redirect to `safeBack(req.body.back, /decks/:id)`.

### `POST /decks/:id/untrack` — (new, `requireAuth`)

- Loads/validates as above (malformed id → redirect back).
- `User.updateOne({ _id: currentUser._id }, { $pull: { trackedDecks: id } })` (idempotent
  even if not currently tracked).
- Redirect to `safeBack(req.body.back, /decks/:id)`.

### `GET /decks/:id` — Deck detail (modify)

- The handler already computes `isOwner`. Also compute
  `isTracked = req.currentUser.trackedDecks.some(t => t.toString() === deck._id.toString())`
  and pass it to the view (alongside the existing `stats`, `insights`, `isOwner`,
  `cardCount`).

## Views & Navigation

- **`views/deckBrowse.handlebars`** (new): a `GET` filter form (format `<select>` +
  Apply/Clear, mirroring `gameHistory`), then a list of deck rows. Each row: deck name
  linking to `/decks/{{_id}}`, owner username, format, colors, and a track control —
  a **Track** button (`POST /decks/:id/track`, hidden `back=/decks`) when not owner and
  not tracked; an **Untrack** button + "Tracked" label when tracked; nothing when it is
  the user's own deck (labeled "Yours"). Empty state when no decks match.
- **`views/deckDetail.handlebars`** (modify): in the existing
  `.deck-cards-view__head` area, for non-owners render a Track or Untrack button
  (`back=/decks/{{deck._id}}`); owners keep only the Manage Cards button.
- **`views/userDashboard.handlebars`** (modify): add an **Untrack** button
  (`POST /decks/:id/untrack`, hidden `back=/dashboard`) to each "Tracked Decks" card, and
  link each tracked/my-deck card's name to its deck page for convenience.
- **`middleware/auth.js`** (modify): add `{ link: '/decks', text: 'Browse Decks' }` to
  `loggedInNav`.

## Error Handling

- All handlers wrap async work in `try/catch → next(err)`.
- Malformed deck id on track/untrack → redirect to a safe local path, never a 500.
- Track on a nonexistent deck or your own deck → no-op + redirect (no error surfaced).
- `safeBack` rejects absolute/scheme URLs, preventing open redirects.
- Invalid `?format=` on browse is ignored (unfiltered), matching the match-history filter.

## Testing — `test/deckTracking.test.js` (`node --test`, own DB `mtg_tracker_social_test`)

HTTP integration harness with two users (a `makeClient` factory per user):

- **Browse lists decks across users; format filter narrows.** Alice and Bob each create
  a deck (different formats); `GET /decks` shows both; `?format=<Bob's>` shows only
  matching decks.
- **Track adds a deck (idempotent).** Alice tracks Bob's deck → it appears in her
  `trackedDecks` in the DB; tracking again leaves exactly one entry (`$addToSet`).
- **Can't track your own deck.** Alice `POST /decks/:herDeck/track` → her `trackedDecks`
  does not include it.
- **Untrack removes it.** After tracking, Alice untracks Bob's deck → gone from
  `trackedDecks`; untracking again is a safe no-op (still absent, redirects).
- **Deck page track controls.** On Bob's deck page: Alice (non-owner, not tracking) sees
  "Track"; after tracking, sees "Untrack"; Bob (owner) sees "Manage Cards" and no track
  control.
- **Dashboard untrack.** Alice's dashboard "Tracked Decks" shows an Untrack control for a
  deck she tracks.
- **Auth + safety.** `POST /decks/:id/track` while logged out → redirect to `/login`; a
  malformed id → redirect (no 500); a `back` value of `http://evil.com` is rejected in
  favor of the safe default.

## Out of Scope (YAGNI)

- Following *users* (sub-project B), user profile pages, comments (C), playgroups (D).
- Deck privacy / visibility toggles — all decks remain public, as today.
- Tracked-deck activity feeds or notifications.
- Pagination or search on the browse page (format filter only; personal-scale data).
