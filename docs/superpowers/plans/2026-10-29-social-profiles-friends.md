# Profiles, Friends, Deck Visibility & Profile Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every user a public profile page where others can send a mutual friend request, browse the decks they're allowed to see, and (as friends) leave comments; add a per-deck public/friends/private setting enforced everywhere decks appear.

**Architecture:** Friendship lives on `User` (`friends`, `friendRequests` = incoming senders). Deck visibility is one field on `Deck` plus one pure check (`canSeeDeck`) and one query filter (`visibleDeckFilter`) in `lib/visibility.js`, which every deck-listing route uses. A new `routes/users.js` serves the profile and all friend/comment actions; comments are a small `Comment` model.

**Tech Stack:** Node (ESM), Express 4, Mongoose 9, express-handlebars 8, `node --test` against a real local MongoDB.

**Spec:** `docs/superpowers/specs/2026-10-29-social-profiles-friends-design.md`

## Global Constraints

- Server-rendered Handlebars, no client JS libraries, no new runtime dependencies.
- Forms POST and the server redirects back; every state-changing route checks login, ownership or friendship on the server.
- Any user-supplied "back" redirect goes through `safeBack` (local `/…` paths only).
- Visibility values exactly: `public`, `friends`, `private`. New decks default `public`; a deck with no `visibility` field is treated as `public` in both the check and the query filter.
- Profiles are open to logged-out visitors (treated as strangers). Browse and deck pages keep `requireAuth`.
- A deck the viewer can't see must never put its real name in the HTML. Show the placeholder text `Hidden deck` with class `hidden-deck` (CSS blur), unlinked.
- Leaderboard and stat totals are never filtered by visibility.
- Comments: plain text, trimmed, 1–1000 characters, Handlebars-escaped. Only friends post; only the author deletes.
- Profile shows the 10 most recent games.
- Each test file uses its own DB name; new integration file uses `mongodb://localhost:27017/mtg_tracker_profiles_test`.

## Review Focus

- **Odd usernames** (spaces, `&`, `<b>`, mixed case): `/users/tess` finds "Tess", every profile link is URL-encoded, and the nav (currently `{{{text}}}`) escapes the name. → Task 2 test `profile links encode and nav escapes odd usernames`.
- **Hidden deck name leaking into page source** on a profile game row or the deck leaderboard. → Task 4 test `a hidden deck's name never appears in the profile or deck leaderboard HTML`.
- **Logged-out viewer** on a profile and the deck leaderboard: renders 200, public decks only, no friend button, no comment box. → Task 2 and Task 4 tests.
- **Forged friend POSTs**: friending yourself, accepting a request that doesn't exist, double-sending, unknown username — all no-ops, never a 500. → Task 3 test `friend actions ignore self, duplicates and missing requests`.
- **Forged comment POSTs**: whitespace-only, 1001 chars, non-friend poster, deleting someone else's comment, malformed comment id. → Task 5 test `comments reject bad bodies, non-friends and non-authors`.

---

## File Structure

- Create `lib/visibility.js` — `DECK_VISIBILITY` check + query filter. Pure check, no I/O.
- Create `lib/friends.js` — friendship state transitions (`relation`, `sendRequest`, `acceptRequest`, `declineRequest`, `cancelRequest`, `unfriend`).
- Create `lib/safeBack.js` — `safeBack` moved out of `routes/decks.js` so `routes/users.js` and `routes/dashboard.js` share it.
- Create `routes/users.js` — profile page, friend actions, comment actions.
- Create `models/Comment.js`.
- Create `views/profile.handlebars`.
- Create `test/visibility.test.js` (unit), `test/friends.test.js` (DB, `mtg_tracker_friends_unit_test`), `test/profiles.test.js` (integration).
- Modify `models/Deck.js`, `models/User.js`, `models/index.js`, `middleware/auth.js`, `views/layouts/main.handlebars`, `lib/viewHelpers.js`, `app.js`, `routes/index.js`, `routes/decks.js`, `routes/dashboard.js`, `routes/leaderboards.js`, `lib/leaderboards.js`, views `deckBrowse`, `deckForm`, `deckDetail`, `userDashboard`, `leaderboard`, `deckLeaderboard`, `public/css/style.css`.

`test/profiles.test.js` copies the `makeClient` helper and `before`/`after` setup from `test/deckTracking.test.js` (change only the DB name).

---

### Task 1: Deck visibility model and check

**Files:**
- Modify: `models/Deck.js`, `models/index.js`
- Create: `lib/visibility.js`
- Test: `test/visibility.test.js`

**Interfaces:**
- Produces:
  - `DECK_VISIBILITY = ['public', 'friends', 'private']` exported from `models/Deck.js` and re-exported from `models/index.js`.
  - `Deck.visibility: { type: String, enum: DECK_VISIBILITY, default: 'public' }`.
  - `canSeeDeck(deck: { owner: ObjectId|{_id}, visibility?: string }, viewer?: { _id, friends?: ObjectId[] }) -> boolean` in `lib/visibility.js`.
  - `visibleDeckFilter(viewer?) -> object` — a Mongo filter to `$and` with other conditions. Logged out: public-or-missing only. Logged in: `$or` of owner = viewer, public-or-missing (`visibility: { $in: ['public', null] }`), and `visibility: 'friends'` with `owner: { $in: viewer.friends ?? [] }`.

- [ ] **Step 1: Write the failing tests** in `test/visibility.test.js`:

```js
test('canSeeDeck: public or missing visibility is visible to anyone, including logged out', () => {
  assert.equal(canSeeDeck({ owner: A }, undefined), true);
  assert.equal(canSeeDeck({ owner: A, visibility: 'public' }, { _id: B }), true);
});
test('canSeeDeck: friends decks need friendship, private decks need ownership', () => {
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, { _id: B, friends: [A] }), true);
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, { _id: C, friends: [] }), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'friends' }, undefined), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'private' }, { _id: B, friends: [A] }), false);
  assert.equal(canSeeDeck({ owner: A, visibility: 'private' }, { _id: A }), true);
});
test('canSeeDeck accepts a populated owner', () => {
  assert.equal(canSeeDeck({ owner: { _id: A }, visibility: 'private' }, { _id: A }), true);
});
test('visibleDeckFilter for a logged-out viewer only admits public or missing visibility', () => {
  assert.deepEqual(visibleDeckFilter(undefined), { visibility: { $in: ['public', null] } });
});
```
(`A`, `B`, `C` are `new mongoose.Types.ObjectId()`; compare ids by string.)

- [ ] **Step 2: Run** `node --test test/visibility.test.js` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the schema field, `DECK_VISIBILITY` export, and `lib/visibility.js` per the Interfaces block.
- [ ] **Step 4: Run** `node --test test/visibility.test.js` — PASS; then `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: deck visibility field and visibility check`.

---

### Task 2: Public profile page, profile links, safe nav

**Files:**
- Modify: `models/User.js` (add `friends: [{ type: ObjectId, ref: 'User' }]`, `friendRequests: [{ type: ObjectId, ref: 'User' }]` — incoming request senders)
- Create: `lib/safeBack.js` (move `safeBack` verbatim from `routes/decks.js`; `routes/decks.js` imports it)
- Modify: `lib/viewHelpers.js`, `app.js` (register `profilePath`)
- Create: `routes/users.js`; modify `routes/index.js` to mount it
- Create: `views/profile.handlebars`
- Modify: `middleware/auth.js`, `views/layouts/main.handlebars`, `views/deckBrowse.handlebars`, `views/leaderboard.handlebars`, `routes/decks.js` (Browse rows carry `ownerName`), `public/css/style.css`
- Test: `test/viewHelpers.test.js`, `test/profiles.test.js`

**Interfaces:**
- Consumes: `canSeeDeck`, `visibleDeckFilter` (Task 1); `getUserSummary(userId)` from `lib/stats.js`.
- Produces:
  - `profilePath(username: string) -> string` = `/users/${encodeURIComponent(username)}` (view helper).
  - `findUserByName(username) -> Promise<lean User|null>` in `routes/users.js` — case-insensitive via `.collation({ locale: 'en', strength: 2 })`, excluding `passwordHash`.
  - `GET /users/:username` (no `requireAuth`) renders `profile` with: `profile` (username, createdAt), `isSelf`, `summary` (from `getUserSummary`), `decks` (owner's decks `$and` `visibleDeckFilter(viewer)`, newest first, each with `visibility`), `games` (10 newest `GameRecord`s with `user: profile._id`, each `{ result, createdAt, opponents: opponentList(g), deck: { _id, name } | null }` — `null` when `canSeeDeck` fails or the deck is gone), `friends` (`[{ username }]`), `comments: []` placeholder, `relation` placeholder `'none'`. Unknown username → 404 page.
  - `safeBack(value, fallback)` from `lib/safeBack.js`.

- [ ] **Step 1: Write failing tests.**
  - `test/viewHelpers.test.js`: `profilePath('Tess') === '/users/Tess'`, `profilePath('a b&c') === '/users/a%20b%26c'`.
  - `test/profiles.test.js`:
    - `a profile is open to logged-out visitors and shows public decks only` — Tess creates decks via `Deck.create` with visibility public / friends / private; anonymous GET `/users/Tess` → 200, matches the public name, doesNotMatch the friends and private names, doesNotMatch `Add friend`.
    - `the owner sees all their decks with visibility badges on their own profile` — Tess's GET shows all three names and the text `Private`.
    - `profile lookup is case-insensitive and unknown users 404` — `/users/tess` 200, `/users/nobody-here` 404.
    - `a profile game shows a blurred placeholder for a deck the viewer can't see` — a game on Tess's private deck: anonymous view matches `class="hidden-deck">Hidden deck<` and doesNotMatch the private deck's name.
    - `profile links encode and nav escapes odd usernames` — register `<b>Odd & Co</b>`; its own dashboard HTML contains `&lt;b&gt;Odd` and `href="/users/%3Cb%3EOdd%20%26%20Co%3C%2Fb%3E"`, never `<b>Odd`; `/users/%3Cb%3EOdd%20%26%20Co%3C%2Fb%3E` → 200.
    - `Browse and the player leaderboard link usernames to profiles` — both pages match `href="/users/Tess"`.
- [ ] **Step 2: Run** `node --test test/profiles.test.js test/viewHelpers.test.js` — FAIL.
- [ ] **Step 3: Implement.**
  - `attachUser`: for a signed-in user, `navLink` = `loggedInNav` with `{ link: profilePath(username), text: username }` inserted before Logout (Task 3 adds the count).
  - Layout: `<a href="{{link}}">{{text}}</a>` (escaped; it was triple-stash).
  - Browse owner and player leaderboard username: `<a href="{{profilePath …}}">`.
  - `profile.handlebars` follows layout B:
    - header: username, `Joined {{formatDate profile.createdAt}}`, friend count, `summary.winRate`% when `summary.totalGames`;
    - `.profile-main`: decks list linking `/decks/:id`, badge only when `isSelf`; games list using `formatOpponents`, deck shown as link or `<span class="hidden-deck">Hidden deck</span>`;
    - `.profile-side`: friends list, comments section stub.
  - CSS:
    - `.profile-layout { display: grid; grid-template-columns: 2fr 1fr; gap: 2rem; }`, collapsing to one column at `max-width: 860px`;
    - `.hidden-deck { filter: blur(3px); user-select: none; }`;
    - a small `.visibility-badge`.
- [ ] **Step 4: Run** the two files, then `npm test` — all pass (existing tests matching nav text may need the new escaped form; fix assertions, not behaviour).
- [ ] **Step 5: Commit** `feat: public profile pages with profile links`.

---

### Task 3: Friend requests and friendships

**Files:**
- Create: `lib/friends.js`; Test: `test/friends.test.js`
- Modify: `routes/users.js`, `views/profile.handlebars`, `routes/dashboard.js`, `views/userDashboard.handlebars`, `middleware/auth.js`
- Test: `test/profiles.test.js`

**Interfaces:**
- Consumes: `User.friends`, `User.friendRequests` (Task 2); `findUserByName`, `safeBack`.
- Produces (all ids are ObjectIds; all functions are no-ops when the precondition fails, never throw on them):
  - `relation(viewer?: lean User, target: lean User) -> 'anon'|'self'|'friends'|'received'|'sent'|'none'` — pure.
  - `sendRequest(fromId, toId) -> Promise<void>` — no-op if same id or already friends. If `to` already sent `from` a request, behave as `acceptRequest(fromId, toId)`. Otherwise `$addToSet` `fromId` into `to.friendRequests`.
  - `acceptRequest(userId, fromId)` — only when `fromId ∈ user.friendRequests`: pull it, `$addToSet` each into the other's `friends`. Guard with a conditional `updateOne({ _id: userId, friendRequests: fromId }, …)` and only touch the other side if `modifiedCount === 1`.
  - `declineRequest(userId, fromId)` — `$pull` `fromId` from `user.friendRequests`.
  - `cancelRequest(fromId, toId)` — `$pull` `fromId` from `to.friendRequests`.
  - `unfriend(aId, bId)` — `$pull` each from the other's `friends`.
  - Routes, all `requireAuth`, all `POST`, target resolved by `findUserByName`, redirect to `safeBack(req.body.back, profilePath(target.username))`: `/users/:username/friend`, `/cancel`, `/accept`, `/decline`, `/unfriend`. Unknown user → redirect to `/dashboard`.
  - `res.locals.pendingRequests` (number) set in `attachUser`; the nav profile entry's text becomes `${username} (${n})` when `n > 0`.

- [ ] **Step 1: Write failing tests.**
  - `test/friends.test.js`, against DB `mtg_tracker_friends_unit_test`:
    - `relation covers every state`.
    - `send then accept makes both sides friends and clears the request`.
    - `crossing requests become a friendship immediately`.
    - `decline and cancel remove the pending request only`.
    - `unfriend removes both sides`.
    - `friend actions ignore self, duplicates and missing requests`: `sendRequest(a, a)` leaves `a` unchanged; sending twice leaves `friendRequests.length === 1`; `acceptRequest(b, c)` with no request leaves both `friends` empty.
  - `test/profiles.test.js`:
    - `the friend button walks through Add friend → Request sent → Accept → Friends` — two clients; assert button text on each profile view after each POST.
    - `incoming requests show on the dashboard with a nav count and can be declined from there` — Uma's dashboard matches `Friend requests`, Tess's username, and nav text `Uma (1)`; POST `/users/Tess/decline` with `back=/dashboard` → 302 to `/dashboard`; the count is gone.
    - `friend action routes require login and 404-safe usernames` — anonymous POST → 302 `/login`; logged-in POST to `/users/nobody-here/friend` → 302 `/dashboard`.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement** `lib/friends.js`, the routes, the profile header button states (per the spec's state table; logged-out shows a `Log in to add friend` link to `/login`), the dashboard "Friend requests" section (hidden when empty; Accept/Decline forms with `back=/dashboard`), and the nav count.
- [ ] **Step 4: Run** both files, then `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: mutual friend requests`.

---

### Task 4: Enforce deck visibility everywhere

**Files:**
- Modify: `views/deckForm.handlebars`, `views/deckDetail.handlebars`, `routes/decks.js`, `routes/dashboard.js`, `lib/leaderboards.js`, `routes/leaderboards.js`, `views/deckLeaderboard.handlebars`
- Test: `test/profiles.test.js`, `test/leaderboards.test.js` (if it asserts the row shape)

**Interfaces:**
- Consumes: `DECK_VISIBILITY`, `canSeeDeck`, `visibleDeckFilter`, `profilePath`.
- Produces:
  - `POST /decks` reads `visibility`; anything not in `DECK_VISIBILITY` becomes `'public'`.
  - `POST /decks/:id/visibility` (`requireAuth`, owner only via `findOwnedDeck`, else 404) sets it and redirects to `/decks/:id`. This is needed because existing decks have no edit form.
  - `getDeckLeaderboard()` rows additionally carry `deckId`, `ownerId`, `visibility`. `routes/leaderboards.js` maps each row: when `!canSeeDeck({ owner: ownerId, visibility }, req.currentUser)` it sets `hidden: true` and deletes `deckName`.

- [ ] **Step 1: Write failing tests** in `test/profiles.test.js`:
  - `new decks default to public and the form offers all three settings` — GET `/decks/new` has `name="visibility"` with three options; POST without the field → stored `public`; POST `visibility=bogus` → `public`.
  - `the owner can change a deck's visibility; others cannot` — owner POST `/decks/:id/visibility` `{ visibility: 'friends' }` → stored; a stranger's POST → 404, unchanged.
  - `friends-only and private decks are hidden from Browse, deck pages and tracking for non-friends` — a stranger's Browse doesNotMatch either name; GET `/decks/:id` → 404; POST track leaves `trackedDecks` empty. A friend sees the friends deck on Browse and its page (200) but not the private one.
  - `a tracked deck drops off the dashboard when access is lost and returns when regained` — Uma tracks Tess's friends deck while friends, then they unfriend: the deck name is absent from Uma's dashboard and `trackedDecks` still holds the id. Re-friend: it's back.
  - `a hidden deck's name never appears in the profile or deck leaderboard HTML` — logged-out and stranger GET `/deckLeaderboard` and `/users/Tess`: doesNotMatch the private deck's name, match `Hidden deck`, match `href="/users/Tess"`, and the W/L numbers equal the owner's view.
- [ ] **Step 2: Run** `node --test test/profiles.test.js` — new tests FAIL.
- [ ] **Step 3: Implement.**
  - Form `<select name="visibility">`: Public (selected), Friends, Private.
  - Owner-only visibility form in the deck page hero.
  - Browse `Deck.find({ $and: [filter, visibleDeckFilter(req.currentUser)] })`.
  - Deck page and track route call `canSeeDeck` (deck page → 404, track → no-op redirect).
  - Dashboard filters the populated `trackedDecks` with `canSeeDeck(d, req.currentUser)`.
  - Deck leaderboard view: hidden rows render `<span class="hidden-deck">Hidden deck</span>` in the name slot. The owner is wrapped in a profile link.
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: enforce deck visibility across browse, deck pages, tracking and leaderboard`.

---

### Task 5: Profile comments

**Files:**
- Create: `models/Comment.js`; modify `models/index.js`
- Modify: `routes/users.js`, `views/profile.handlebars`, `public/css/style.css`
- Test: `test/profiles.test.js`

**Interfaces:**
- Consumes: `relation` (Task 3), `findUserByName`, `profilePath`.
- Produces:
  - `Comment`: `{ profile: ObjectId ref User (required, indexed), author: ObjectId ref User (required), body: String (required, trim, maxlength 1000) }`, timestamps.
  - `COMMENT_MAX = 1000` exported from `models/Comment.js`.
  - `POST /users/:username/comments` (`requireAuth`): allowed only when `relation(viewer, target) === 'friends'`. The body is trimmed; when it's empty or over `COMMENT_MAX`, re-render the profile with status 400, the error `Comments must be 1–1000 characters.` and the text kept. On success, redirect to the profile.
  - `POST /comments/:id/delete` (`requireAuth`): deletes only when `author` equals the viewer. A malformed id or a non-author is a no-op redirect to `safeBack(req.body.back, '/dashboard')`.
  - The profile renders `comments` newest first, each with `{ _id, body, createdAt, author: { username }, canDelete }`. It shows the comment box only when `relation === 'friends'`.

- [ ] **Step 1: Write failing tests:**
  - `a friend can comment and the comment shows newest first with the author linked` — two comments, order asserted by index in HTML, `href="/users/Uma"`.
  - `comments reject bad bodies, non-friends and non-authors`:
    - whitespace-only → 400 with the error;
    - 1001 × `x` → 400;
    - a stranger's POST → no new Comment document;
    - Tess (the profile owner, not the author) POSTs a delete → the comment remains;
    - `/comments/not-an-id/delete` → 302, no 500.
  - `the author can delete their comment and comments survive an unfriend` — delete removes it; after an unfriend the remaining comment is still on the profile and the comment box is gone.
  - `comment bodies are escaped` — the body `<script>x</script>` appears as `&lt;script&gt;`.
- [ ] **Step 2: Run** `node --test test/profiles.test.js` — new tests FAIL.
- [ ] **Step 3: Implement** the model, the two routes, and the profile sidebar comment form and list (delete button only when `canDelete`, with `back` set to the profile path).
- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat: comments on profiles`.
