# Moxfield-style Deck View — Design

Date: 2026-10-18
Status: Approved design, pending implementation plan

## Context

Uncommitted work on `development` already redesigns the deck view in a Moxfield style:
- Deck detail hero with commander art.
- A decklist in type columns, with card previews on hover/focus (`groupCardsByType`).
- A dashboard deck grid with commander art.
- `Deck.commanderImageUrl`, filled at `POST /decks` by a best-effort fuzzy lookup (`getCardByName`).

This spec builds on that work and adds four extensions:
1. Pick the commander through Scryfall search.
2. Backfill commander art on existing decks.
3. A group toggle on the decklist.
4. The same card layout on the Manage Cards page.

Stack constraints are unchanged: server-rendered Handlebars, no client JS, no new dependencies.

## Goals

- An owner can set an exact commander card (name and art) from search on any Commander-format deck, including decks created before this change.
- Viewers can switch the decklist between grouping by **Type** (the default) and **Mana value**.
- The commander appears as the first group in the decklist and counts toward the card total (a 99-card list plus the commander reads 100).
- The Manage Cards page uses the same grouped layout and hover previews as the deck page, with Remove buttons.
- One shared decklist partial replaces the duplicated `<ul class="cardlist">` markup.

## Non-goals

- Grouping by color, or a separate sort control.
- The group toggle on the Manage Cards page.
- Storing the commander's Scryfall id or mana cost, or putting the commander in `deck.cards`.
- App-wide error-handling middleware (still a deferred item).
- A deck-edit route.

## Data and routes (`routes/decks.js`)

**Schema:** no change beyond the WIP `commanderImageUrl`. `commander` (the name) and `commanderImageUrl` are the whole of the commander's data.

**`POST /decks`:** keeps the WIP behaviour. A free-text commander name gets a best-effort `getCardByName` lookup. A miss or an error means no image, and deck creation still succeeds. The stored name is the one the user typed.

**`POST /decks/:id/commander`** (new; `requireAuth`, owner-only):
- `findOwnedDeck`; return 404 if it's missing, the id is malformed, or the user isn't the owner.
- If `deck.format !== 'Commander'`, redirect back without changes.
- If `scryfall_id` (trimmed) is empty, redirect back.
- `getCardById(scryfall_id)` re-fetches server-side, so client-posted card fields are never trusted.
- Set `commander = card.name` (the canonical name, which fixes fuzzy misspellings) and `commanderImageUrl = card.imageUrl`, then save.
- "Back" means `/decks/:id/cards`, with `?q=<encoded q>` when the body has a non-empty `q`. This is the same rule `POST /decks/:id/cards` uses.
- A stale or unknown id raises an error through `next(err)` and becomes a raw 500, the same as add-card. This is accepted.

**`GET /decks/:id`:**
- `groupMode = ['type', 'cmc'].includes(req.query.group) ? req.query.group : 'type'`.
- `cardGroups = groupCards(deck.cards, { mode: groupMode, commander: { name: deck.commander, imageUrl: deck.commanderImageUrl } })`.
- `cardCount` = the sum of card quantities, plus 1 when `deck.commander` is set.
- Pass `groupMode` and `cardGroups` to the view.

**`GET /decks/:id/cards`:** also passes `cardGroups = groupCards(deck.cards)` (type mode, no commander group) and `isCommanderDeck = deck.format === 'Commander'`.

## Grouping logic (`lib/cardInsights.js`)

Replace the WIP `groupCardsByType` with:

```js
groupCards(cards, { mode = 'type', commander } = {}) // → [{ label, count, cards }]
```

- `count` is the quantity-weighted sum of the group's cards. Empty groups are left out.
- **`type` mode:**
  - Groups in the order Creatures, Planeswalkers, Instants, Sorceries, Artifacts, Enchantments, Battles, Other, Lands.
  - Assignment uses the existing `primaryType`.
  - Each group is sorted by `cmc`, then by name.
- **`cmc` mode:**
  - Nonland cards go into the buckets `0`–`7+` using the existing `bucketKey`. A card is a land when it matches the existing `LAND_RE`.
  - Lands get their own final group, `Lands`.
  - Each group is sorted by name.
  - Labels are the bucket keys (`0`, `1`, …, `7+`).
- Any other `mode` falls back to `type`.
- If `commander?.name` is non-empty, prepend `{ label: 'Commander', count: 1, cards: [{ name, imageUrl, quantity: 1 }] }`.
- Non-array `cards` is treated as `[]`.

## Views

**`views/partials/decklist.handlebars`** (new). Parameters: `groups`, optional `deckId` and `editable`.
- It renders the WIP `.decklist` markup. Each group is `<h3>label <span>(count)</span></h3>`, followed by the cardlist.
- Each row is a focusable `<li tabindex="0">` with qty, name and mana cost. It has a `.cardlist__preview` image when `imageUrl` is present.
- When `editable` is set and the row has a `scryfallId`, the row includes a Remove form posting to `/decks/<deckId>/cards/<scryfallId>/remove`. The Handlebars path to `deckId` from inside the nested loops is checked during implementation.

**`deckDetail`:**
- Replaces the inline decklist markup with `{{> decklist groups=cardGroups}}`.
- A "Group by: Type · Mana value" toggle (two links, `?group=type` and `?group=cmc`) goes above it. The active link is marked using `eq` and gets `aria-current="true"`.

**`deckCards`:**
- "In this deck" becomes `{{> decklist groups=cardGroups deckId=deck._id editable=true}}`.
- When `isCommanderDeck` is true:
  - Each search result gets a "Set as commander" form (hidden `scryfall_id` and `q`) posting to `/decks/:id/commander`.
  - If a commander is set, a line above the decklist shows the current commander's name and art.

**CSS (`public/css/style.css`):**
- A `.group-toggle` style.
- Layout for a Remove button inside `.decklist` rows.
- The existing preview rules work on the manager unchanged.

## Testing

Tests use `node --test` against a real local MongoDB, and Scryfall calls go to the existing fake HTTP servers.

**`test/cardInsights.test.js` — `groupCards`:**
- Type mode: order, lands last, sort by cmc then name, `label` and `count`. This updates the WIP test.
- Cmc mode: buckets `0`–`7+`, lands last, sort by name, empty buckets dropped.
- The commander group comes first with count 1, and is left out when there's no name.
- An unknown mode falls back to type.
- `undefined` input returns `[]`.

**`test/scryfall.test.js` — `getCardByName`:**
- Add `/cards/named` to the fake server.
- A match returns a normalized card.
- A 404 returns `null`.
- A 500 throws.

**`test/deckCards.test.js`:**
- `POST /decks/:id/commander` sets the name and image from the re-fetched card.
- A non-owner gets a 404.
- On a non-Commander deck, nothing changes.
- An empty id redirects.
- The manager shows "Set as commander" only for Commander decks.
- Remove still works through the partial.

**Deck detail:**
- `?group=cmc` renders mana-value headings.
- An invalid `group` falls back to type.
- With a commander set, the Commander group renders and the count is +1.

**`POST /decks`:**
- A commander name stores the fake server's art.
- An unmatched name still creates the deck.

After the full suite passes, do a manual browser check of the deck page (both groupings), the manager (set commander, remove) and the dashboard grid.
