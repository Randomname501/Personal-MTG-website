# Card / Deck Browser (Spec 1: search + add/remove + card list) — Design

**Date:** 2026-07-17
**Status:** Approved (pending spec review)
**Feature:** Third of four planned features (see the feature roadmap). Gives decks real
card lists sourced from Scryfall. Card-derived **insights** (mana curve, color/type
breakdown) are a deliberately separate follow-up spec built on the card data this spec
introduces.

## Goal

Today a `Deck` stores only name/format/colors/commander — no cards. This spec lets a user
search Scryfall for real cards and build a deck's actual card list (add, remove,
quantities), then see that list on the deck's page. It introduces the app's first
external network dependency (the Scryfall API), isolated behind one module.

## Constraints

- **Stack:** Express 4 + Mongoose + Handlebars, server-rendered, no client-side JS
  framework, no new runtime dependencies (uses the built-in `fetch`).
- **External dependency isolation:** all Scryfall access goes through `lib/scryfall.js`.
  No other module imports `fetch` or knows Scryfall's URL shape.
- **Testability:** the Scryfall base URL is read from
  `process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com'` so tests point it at a
  local fake server and never touch the real network.
- **Ownership:** managing a deck's cards (the manager page, add, remove) is owner-only;
  a non-owner or bad id returns 404. The read-only card list on the deck detail page is
  visible to any authenticated user, matching the existing public deck pages.
- Reuse existing patterns: `requireAuth`, `.lean()` in read routes, `try/catch → next(err)`,
  the deck-ownership check style already used in `routes/decks.js` / `routes/gameRecords.js`.

## Scryfall Integration — `lib/scryfall.js`

A small isolated client. Sends `Accept: application/json` and a descriptive `User-Agent`
(Scryfall asks for both). Exports:

- `searchCards(query)` → `Promise<Card[]>`
  - Calls `GET {BASE}/cards/search?q=<encoded query>`.
  - Returns up to **20** normalized cards (first page, capped).
  - Scryfall returns HTTP 404 with `{ object: 'error' }` when a search has no matches —
    this is treated as **empty results** (`[]`), not an error.
  - Other non-OK responses throw (surfaced to the route's `catch → next(err)`).
- `getCardById(id)` → `Promise<Card>`
  - Calls `GET {BASE}/cards/:id`. Throws if not found / non-OK.

Both normalize a raw Scryfall card into this **snapshot shape** (`Card`):

```
{
  scryfallId,  // Scryfall card `id` (specific printing) — identity for dedupe
  name,        // card name
  manaCost,    // e.g. "{1}{U}{U}" ('' if none)
  cmc,         // Number (mana value) — stored for the future insights spec
  colors,      // string[] e.g. ["U"]
  typeLine,    // e.g. "Creature — Merfolk"
  imageUrl     // normal-size image URL ('' if none)
}
```

Normalization rules:
- `manaCost` from `mana_cost`; for double-faced cards without a top-level `mana_cost`,
  fall back to `card_faces[0].mana_cost`.
- `imageUrl` from `image_uris.normal`; if absent (double-faced), from
  `card_faces[0].image_uris.normal`; else `''`.
- `cmc` from `cmc` (default 0); `colors` from `colors` (default `[]`);
  `typeLine` from `type_line` (default `''`).

## Data Model — additive field on `Deck`

Embed cards in the deck document (a personal tracker's decks are ~100 cards, well under
Mongo's document limit; no joins needed):

```js
cards: [{
  scryfallId: { type: String, required: true },
  name:       { type: String, required: true },
  manaCost:   { type: String, default: '' },
  cmc:        { type: Number, default: 0 },
  colors:     [{ type: String }],
  typeLine:   { type: String, default: '' },
  imageUrl:   { type: String, default: '' },
  quantity:   { type: Number, default: 1, min: 1 },
}]
```

This is a **backward-compatible schema addition**: existing decks simply have an empty
`cards` array. No migration needed. No other model changes.

## Routes (in `routes/decks.js`)

A private helper (extracted, reused by all three) loads a deck the current user owns, or
returns null → 404:

```
findOwnedDeck(id, userId) -> Deck document | null   // isValid guard + { _id, owner } query
```

- **`GET /decks/:id/cards`** (owner-only) — the manager page.
  - Loads the owned deck (404 if not owner/found).
  - If `req.query.q` is a non-empty string, calls `searchCards(q)` and passes the results.
  - Renders `deckCards` with: the deck, its current `cards`, the search `query`, the
    `results` (or empty), and a `searched` flag (so "no results" only shows after a search).
- **`POST /decks/:id/cards`** (owner-only) — add a card.
  - Body: `scryfall_id` (required) and optional hidden `q`.
  - Loads the owned deck (404 otherwise). If `scryfall_id` missing → redirect back.
  - Calls `getCardById(scryfall_id)` for an **authoritative** snapshot (never trusts
    client-supplied card fields). If a card with that `scryfallId` is already in the deck,
    `quantity += 1`; otherwise push a new entry (quantity 1). Save.
  - Redirects to `/decks/:id/cards?q=<q>` (preserving search context; omit `?q=` if none).
- **`POST /decks/:id/cards/:scryfallId/remove`** (owner-only) — remove one copy.
  - Loads the owned deck (404 otherwise). Finds the matching card; `quantity -= 1`; if it
    reaches 0, remove the entry. Save. Redirects to `/decks/:id/cards`.

Route ordering: these live after the existing `GET /decks/:id` (literal `/new` still
precedes `/:id`), and `/:id/cards` is more specific than `/:id`, so no shadowing.

## Views & Navigation

- **`views/deckCards.handlebars`** — manager page:
  - Header with deck name + a link back to the deck detail page.
  - Search form (`GET`, single text input `q`, submit).
  - Results grid (only when `searched`): each card shows image, name, mana cost, type,
    and an **Add** form (`POST /decks/:id/cards`, hidden `scryfall_id` + `q`). A "no
    results" message when `searched` and `results` is empty.
  - Current cards list: each row shows quantity, name, mana cost, type, and a **Remove**
    form (`POST /decks/:id/cards/:scryfallId/remove`). Empty state when the deck has no
    cards.
- **`views/deckDetail.handlebars`** (modify) — add a read-only **Cards** section listing
  the deck's cards (quantity + name + mana cost + type), with a total count. Add a
  **Manage Cards** button that links to `/decks/:id/cards`, shown only when the viewer
  owns the deck (`currentUser._id === deck.owner`).
  - The deck detail route (`GET /decks/:id`) already loads the deck; it will also compute
    an `isOwner` flag and a `cardCount` (sum of quantities) for the view.
- Styling for the results grid, card thumbnails, and card lists added to
  `public/css/style.css`.

## Error Handling

- All handlers wrap async work in `try/catch → next(err)`.
- Any `:id`/`:scryfallId` route with a malformed id or a non-owned deck renders `404`
  (status 404) — never 500, never another user's deck.
- `searchCards` no-match → empty results + "no results" UI, not an error.
- A Scryfall outage or unexpected non-OK response propagates to `next(err)` (the app's
  default error handling); it does not corrupt or block deck viewing (the deck detail
  page never calls Scryfall — it reads the stored snapshots).
- `getCardById` on a bad `scryfall_id` throws → `next(err)`; the deck is not modified.

## Testing

- **Unit — `test/scryfall.test.js`:** exercise `searchCards`/`getCardById` normalization
  against a **local fake Scryfall server** (set `SCRYFALL_API_BASE` to it): a normal card,
  a double-faced card (image/mana from `card_faces[0]`), and the no-results 404 (→ `[]`).
- **Integration — `test/deckCards.test.js`** (own DB `mtg_tracker_cards_test`, own fake
  Scryfall server, HTTP harness with `makeClient`):
  - `GET /decks/:id/cards?q=...` renders search results (card names from the fake server).
  - An empty-match query shows the "no results" state.
  - `POST /decks/:id/cards` snapshots the card into the deck — verified by reading the
    deck from the DB (correct name/manaCost/cmc/typeLine/quantity 1).
  - A second add of the same card sets `quantity` to 2.
  - `POST /decks/:id/cards/:scryfallId/remove` decrements to 1, then removes the entry at 0.
  - **Ownership:** a second user's `GET /decks/:id/cards`, add, and remove against the
    first user's deck all return 404 and leave the deck's cards unchanged.
  - The deck detail page (`GET /decks/:id`) shows the added card and a "Manage Cards"
    button for the owner but not for a different viewer.

## Out of Scope (YAGNI)

- Card-derived insights (mana curve, color/type breakdown) — the separate follow-up spec.
- Pagination of search results (first page, capped at 20).
- Format legality / singleton (Commander) enforcement; sideboards; categories.
- A standalone `/cards` browser with no deck context.
- Choosing a specific printing/price; card detail pages.
