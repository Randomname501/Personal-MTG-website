# Leaderboard Grid & Multi-Opponent Games — Design

Date: 2026-08-08

Two independent changes that ship together:

1. Both leaderboard pages become full-bleed card grids instead of bare tables.
2. A game record gains multiple opponents, each with a name and a deck.

They share no code. Part 1 touches only views and CSS; parts 2–3 touch the model,
routes, stats, and four views. They are described in one spec because they were
requested together, and the implementation plan may order them independently.

---

## Part 1 — Leaderboards as full-bleed card grids

### Current state

`views/leaderboard.handlebars` and `views/deckLeaderboard.handlebars` are near-identical
bare `<table>` elements with `Rank |`-style pipe characters baked into the header text
and no CSS class of any kind. Both are unstyled and sit inside the 1140px `--maxw` rhythm
of the rest of the site.

Both pages are updated. They share one set of CSS rules.

### Layout

Each page's `<main>` gets class `leaderboard-page`, whose container is:

```css
width: min(100% - 3rem, 1800px);
margin-inline: auto;
```

`main` is not width-capped by any global rule — only `header` and the landing-page
sections use `--maxw` — so this needs no override of existing CSS and cannot leak into
other pages.

The rows become a grid:

```css
grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
```

This yields roughly 6–7 cards across on a wide monitor and collapses to a single column
on mobile without any media query.

### Card anatomy

Player card (`/leaderboard`):

- Rank badge (e.g. `#4`)
- Username, as the card's heading
- `W` and `L` counts as a labelled pair
- Win/loss ratio as the card's largest number
- A thin win-rate meter bar

Deck card (`/deckLeaderboard`) is the same card with one extra line: the deck name is the
heading and the owner's username sits beneath it as a subtitle.

### Meter bar

A horizontal bar whose filled fraction is the win share, coloured with the existing
`--mana-g` token against a `--mana-r` remainder. Its purpose is to make relative strength
scannable without comparing digits across cards.

`lib/viewHelpers.js` already exports a `percent(part, whole)` helper, registered in
`app.js` and documented as being for bar widths. The view uses it directly:
`style="width: {{percent this.wins this.total}}%"`.

### Rank treatment and row data

Ranks 1, 2 and 3 receive gold, silver and bronze accent borders and a heavier rank badge,
built from the existing `--gold` and `--gold-bright` tokens. Ranks 4+ use the neutral
`--rule` border shared with `.deck-card`.

Handlebars has no numeric comparison helper registered here, and adding one used by
exactly two templates isn't worth it. Both leaderboards already funnel through a single
`rankRows` function in `lib/leaderboards.js`, which is where `rank` and `winLossRatio` are
attached. Two more fields are attached in the same place:

- `total` — `wins + losses + draws`, the denominator for the meter bar.
- `tier` — `'gold' | 'silver' | 'bronze' | ''`, derived from `rank`.

The view then emits `leader-card--{{tier}}` and reads `total` for the bar. This keeps the
views logic-free, covers both leaderboards from one edit, and puts the logic somewhere
unit-testable. `draws` is already projected by both aggregations but unused by the
current tables; it is used here only as part of `total`, and the cards continue to show
W, L and ratio — the same figures the tables show today.

### Empty state

When the leaderboard array is empty, both pages render a single centred message rather
than an empty grid: "No games have been logged yet."

### CSS placement

All new rules go in a new `LEADERBOARD` section appended to the end of
`public/css/style.css`. No existing rule is modified. New class names are prefixed
`leaderboard-` / `leader-card` and do not collide with any existing selector.

---

## Part 2 — Opponents: schema and data

### Schema

`models/GameRecord.js` gains:

```js
const opponentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    deck: { type: String, required: true, trim: true },
  },
  { _id: false }
);
```

added to the record as `opponents: { type: [opponentSchema], default: [] }`.

The existing `opponentDeck: String` field remains on the schema but loses `required: true`.
It becomes a legacy read-only field: nothing writes it again.

### Legacy compatibility

Chosen strategy: **read old, write new**. There is no migration script and nothing is run
against the production database.

A single exported normalizer is the only place that knows both shapes:

```js
// models/GameRecord.js
export const opponentList = (record) => {
  if (record.opponents?.length) return record.opponents.map((o) => ({ name: o.name, deck: o.deck }));
  const legacy = (record.opponentDeck || '').trim();
  return legacy ? [{ name: '', deck: legacy }] : [];
};
```

**Every consumer reads opponents through this function.** No view, route, or stats
function may branch on `opponents` vs `opponentDeck` directly. This is what keeps the dual
shape from spreading through the codebase.

A legacy record therefore presents as exactly one opponent with an empty name. Views
render an empty name as the deck alone (see Part 3).

### Validation

`resolveGameInput` in `routes/gameRecords.js` already centralizes validation for both the
POST (create) and PUT (edit) paths, so opponent validation is added there once.

Rules:

- Between 1 and 5 opponents inclusive.
- Each opponent's `name` and `deck` must be non-empty after trimming.
- Any violation returns `null`, which the existing callers already handle: POST silently
  redirects to `/dashboard`, PUT re-renders the edit form with an error message.

The 1–5 bound is enforced server-side regardless of what the form sends. The `max=5` on
the number input is a convenience, not the control.

### Request shape

Form fields are named with bracket syntax:

```
opponents[0][name]   opponents[0][deck]
opponents[1][name]   opponents[1][deck]
```

`express.urlencoded({ extended: true })` is already configured in `app.js`, so the `qs`
parser turns these into `req.body.opponents === [{ name, deck }, ...]` directly. Bracket
syntax is chosen over repeated flat keys (`opponent_name` × N) because it keeps each
name bound to its deck structurally, rather than relying on two parallel arrays staying
index-aligned.

Because `qs` produces an object rather than an array for sparse or non-sequential indices,
the route coerces with `Array.isArray(body.opponents) ? body.opponents : Object.values(body.opponents ?? {})`
before validating.

The legacy `opponent_deck` field name is no longer read by any route.

---

## Part 3 — Opponents: form and stats

### Form

Both the dashboard quick-log form (`views/userDashboard.handlebars`) and the edit form
(`views/gameRecordForm.handlebars`) get the same control:

```
How many opponents?  [ 3 ]        <- number input, min=1 max=5

  Opponent 1
    Name  [          ]
    Deck  [          ]
  Opponent 2
    Name  [          ]
    Deck  [          ]
  ...
```

A new `public/js/opponent-fields.js` listens for `change`/`input` on the count field and
adds or removes `Opponent N` fieldsets to match, cloning a `<template>` and renumbering
the `opponents[i][...]` names and the `for`/`id` label pairs after every mutation.
Reducing the count removes fieldsets from the end. jQuery is already loaded by the layout,
but this script has no reason to need it and is written in plain DOM API.

The script is loaded by the layout alongside the existing `password-toggle.js` and is a
no-op on pages with no opponent form.

**No-JS behaviour:** the server renders the correct number of opponent fieldsets in the
HTML — one for the create form, and for the edit form as many as the record has. With
JS disabled the count input does nothing, but the pre-rendered fieldsets submit and
validate normally. The form is never dead.

The edit form pre-fills each fieldset from `values.opponents`, which the GET
`/game-records/:id/edit` route populates via `opponentList(record)` — so editing a legacy
record shows one row with a blank name and its deck filled in, and saving it writes the
record forward into the new shape.

### Stats

`getDeckStats` in `lib/stats.js` currently reads `r.opponentDeck` once per record. It
changes to iterate `opponentList(r)` and contribute one matchup entry per opponent.

- The `.select('opponentDeck result createdAt')` projection widens to include `opponents`.
- The existing normalize-to-lowercase and pick-majority-spelling logic is unchanged; it
  simply runs over more entries.
- The deterministic `sort({ createdAt: 1, _id: 1 })` stays, and remains required for the
  spelling tie-break to be stable.

Counting semantics, stated explicitly because they diverge:

- `wins` / `losses` / `draws` / `total` count **games**. A 3-opponent win is one win.
- The weekly `trend` counts **games**. Unchanged.
- `matchups[].wins/losses/draws` count **opponents faced**. A 3-opponent win contributes
  a win to each of the three decks' rows.

Consequently the sum of matchup totals may exceed `total`. This is intended and is the
approved behaviour for pod formats.

`getUserSummary` needs no change — it never reads opponent data.

### Views

- `views/gameHistory.handlebars` — the Opponent cell renders the list as
  `Ana (Krenko), Ben (Yuriko)`. An opponent with an empty name renders as the deck alone,
  so legacy records display exactly as they do today.
- `views/gameRecordDelete.handlebars` — same rendering for its Opponent line.
- `views/deckDetail.handlebars` — a one-line clarifier under the matchup table heading:
  "One row per opponent deck faced; a multiplayer game counts once per opponent."

Formatting the list is done by a `formatOpponents` Handlebars helper registered alongside
the existing `formatDate` and `eq` helpers, so the three views share one implementation
and the empty-name rule cannot drift between them.

The routes that render these views map records through `opponentList` before passing them
to the template.

---

## Testing

### Existing tests that break

- `test/gameRecords.test.js` — the `logGame` helper posts a flat `opponent_deck` string
  and looks records up by `opponentDeck`. Updated to post bracket-syntax opponents and
  query by `opponents.deck`. The edit and authorization tests use the same helper.
- `test/statsRoutes.test.js` — three inline POSTs with `opponent_deck`. Updated.
- `test/stats.test.js` — `seedGame` constructs `GameRecord` documents directly with
  `opponentDeck`. Split into `seedGame` (new shape) and `seedLegacyGame` (old shape), so
  the legacy path stays under test rather than disappearing.
- `test/integration.test.js` — one POST with `opponent_deck`. Updated.

### New tests

- Posting 5 opponents succeeds; posting 6 is rejected and creates no record.
- Posting an opponent with a name but a blank deck is rejected; and vice versa.
- A 3-opponent win produces three matchup rows each at 1–0–0, while `getDeckStats` reports
  `total === 1` and `winRate === 100`.
- A legacy record (written directly with `opponentDeck` and no `opponents`) still appears
  in match history, still contributes one matchup row, and still counts toward
  `wins`/`total`.
- Editing a legacy record and saving writes `opponents` and leaves the record readable.
- `test/viewHelpers.test.js` gains cases for `formatOpponents`: multiple opponents join
  with `, `; an empty name renders the deck alone; an empty list renders `—`.
- `GET /leaderboard` and `GET /deckLeaderboard` return 200 and contain the grid container
  class; with no games logged, both render the empty-state message.

`lib/leaderboards.js` has no test file today. The `rankRows` changes get a new
`test/leaderboards.test.js` covering: `tier` is gold/silver/bronze for ranks 1–3 and empty
from rank 4 on; `total` equals wins + losses + draws; and the existing sort and
`winLossRatio` formatting (including the `—` and `∞` cases) still behave as before.

---

## Out of scope

- Linking opponent names to registered site accounts. That overlaps the profiles and
  following sub-project already on the roadmap and would be specced separately.
- Any migration or backfill of existing `opponentDeck` records.
- Per-opponent result tracking (who actually won a pod when it wasn't you). The record
  stores the logging user's result only, as it does today.
- Opponent-name-based statistics (e.g. "your record vs Ana"). Only opponent *decks* feed
  the matchup table.
