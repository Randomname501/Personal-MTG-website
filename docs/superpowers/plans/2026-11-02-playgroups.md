# Playgroups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members-only playgroups with invites, a per-group leaderboard and history, and optional playgroup tagging on games.

**Architecture:** New `Playgroup` model plus an optional `playgroup` ref on `GameRecord`. Membership writes live in `lib/playgroups.js` (single-document atomic `updateOne`s); `routes/playgroups.js` is thin. The group leaderboard reuses `lib/leaderboards.js` with an optional `$match`.

**Tech Stack:** Node (ESM), Express, Mongoose, express-handlebars, `node --test` on local MongoDB.

**Spec:** `docs/superpowers/specs/2026-11-02-playgroups-design.md`

## Global Constraints

- Server-rendered Handlebars, no client JS libraries, no new dependencies.
- Tests: `node --test`, real local MongoDB; new DB-backed test file uses its own DB name `mtg_tracker_playgroups_test`.
- Non-members (and bad/malformed ids) get `res.status(404).render('404', { title: 'Not Found' })` — never a 500, never the group's name.
- Deck names on group pages go through `canSeeDeck`; hidden ones render "Hidden deck" (class `hidden-deck`), the real name never in the HTML.
- Playgroup name: trimmed, 1–60 chars.
- Tagged games still count in global leaderboards and personal stats; global calls stay unchanged.
- Branch `feat/playgroups` (already exists, off `development`). Commit per task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Malformed ObjectId in any `/playgroups/:id/...` route → 404 (or redirect for POSTs), not a CastError 500. Tests in Task 3.
2. Invite by username in a different case ("bob" for "Bob") resolves via the collated `findUserByName`; unknown username → error message, not 500. Tests in Task 2.
3. Inviting someone whose friendship is one-sided (they unfriended) is refused — check with `mutualFriends`, not `user.friends`. Test in Task 2.
4. Editing a game still tagged to a group you've since left: the unchanged tag is kept (not a 400, not silently cleared). Test in Task 5.
5. Owner can't leave or remove themselves (would orphan the group); only delete. Tests in Task 2.

---

### Task 1: Model, game field, filtered leaderboards

**Files:**
- Create: `models/Playgroup.js`
- Modify: `models/index.js`, `models/GameRecord.js`, `lib/leaderboards.js`, `routes/leaderboards.js`
- Test: `test/playgroups.test.js` (new; DB-backed, harness copied from `test/profiles.test.js`: `makeClient`, `registerClient`, `before`/`after` with DB `mtg_tracker_playgroups_test`)

**Interfaces:**
- Produces: `Playgroup` model and `PLAYGROUP_NAME_MAX = 60`, exported from `models/index.js`. Fields: `name` (String, required, trim, maxlength 60), `owner` (ObjectId→User, required), `members` ([ObjectId→User], index), `invites` ([ObjectId→User], index), timestamps.
- Produces: `GameRecord.playgroup` — ObjectId→Playgroup, optional, `index: true`.
- Produces: `getPlayerLeaderboard(match = {})`, `getDeckLeaderboard(match = {})` — prepend `{ $match: match }` to the pipeline.
- Produces: `maskHiddenDecks(rows, viewer)` in `lib/leaderboards.js` — the `.map` currently inline in `routes/leaderboards.js` (`/deckLeaderboard`), moved verbatim; the route calls it.

- [ ] **Step 1: Write the failing tests** in `test/playgroups.test.js`:
  - `getPlayerLeaderboard({ playgroup: g._id })` counts only games tagged `g`: create two users' games, one tagged and one untagged per user; assert each row's `wins + losses + draws === 1`.
  - `getPlayerLeaderboard()` with no arg still counts all games (both).
  - `getDeckLeaderboard({ playgroup: g._id })` returns only decks with a tagged game.
  - `maskHiddenDecks` on a private deck row for a non-owner viewer → row has `hidden: true` and no `deckName` key.
- [ ] **Step 2:** `npm test` → new tests FAIL (Playgroup / maskHiddenDecks not exported).
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** `npm test` → all pass, including existing `leaderboardRoutes.test.js`.
- [ ] **Step 5:** Commit `feat: playgroup model, game playgroup field, filtered leaderboards`.

### Task 2: Membership operations

**Files:**
- Create: `lib/playgroups.js`
- Test: `test/playgroups.test.js`

**Interfaces:**
- Consumes: `Playgroup`, `PLAYGROUP_NAME_MAX` (Task 1); `mutualFriends(user)` from `lib/friends.js`; `findUserByName(username)` from `routes/users.js` (move it to `lib/friends.js` and re-import in `routes/users.js`, so lib doesn't import a router).
- Produces (all ids may be ObjectId or string; "error" functions return an error string or `null` on success):
  - `cleanName(raw) -> string | null` — trimmed name, or `null` if empty or > 60.
  - `findMemberGroup(id, userId) -> Promise<lean doc | null>` — `null` for malformed id, missing group, or non-member.
  - `createPlaygroup(ownerId, name) -> Promise<doc>` — `members: [ownerId]`. Caller validates the name.
  - `invite(group, inviter, username) -> Promise<string | null>` — `inviter` is the full user (needs `friends` for `mutualFriends`). Error copy, exactly:
    - unknown user: `No player named "<username>".`
    - not a mutual friend of inviter: `You can only invite your friends.`
    - already member: `<Username> is already in this playgroup.`
    - already invited: `<Username> has already been invited.`
    - success: `$addToSet: { invites }`.
  - `acceptInvite(groupId, userId)` — one `updateOne({ _id, invites: userId }, { $pull: { invites }, $addToSet: { members } })`.
  - `declineInvite(groupId, userId)` — `$pull` invites.
  - `leave(groupId, userId)` — `updateOne({ _id, owner: { $ne: userId } }, { $pull: { members } })`.
  - `removeMember(groupId, ownerId, memberId)` — no-op unless `owner === ownerId` and `memberId !== ownerId`.
  - `rename(groupId, ownerId, name)` — owner-filtered `updateOne`.
  - `deletePlaygroup(groupId, ownerId)` — only if owner matches: `GameRecord.updateMany({ playgroup }, { $unset: { playgroup: 1 } })` then delete.

- [ ] **Step 1: Write the failing tests** (create users directly with `User.create` + `setPassword`, friendship by writing both `friends` arrays):
  - `cleanName('  ')` → null; `cleanName('x'.repeat(61))` → null; `cleanName('  Pod  ')` → `'Pod'`.
  - `invite` of a mutual friend → `null`, group `invites` contains them; inviting `'bob'` for user `Bob` works.
  - `invite('Nobody')` → `'No player named "Nobody".'`
  - one-sided friendship (only inviter lists invitee) → `'You can only invite your friends.'`
  - inviting a member → `'… is already in this playgroup.'`; inviting twice → `'… has already been invited.'`
  - `acceptInvite` moves user invites→members; calling it by a non-invitee changes nothing.
  - `leave` by owner leaves members unchanged; by member removes them.
  - `removeMember(g, owner, owner)` no-op; by non-owner no-op; by owner removes.
  - `deletePlaygroup` by non-owner leaves group; by owner deletes it and a tagged game's `playgroup` is unset (game still exists).
- [ ] **Step 2:** `npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/playgroups.js`; move `findUserByName` to `lib/friends.js`.
- [ ] **Step 4:** `npm test` → all pass (profiles tests still green after the move).
- [ ] **Step 5:** Commit `feat: playgroup membership operations`.

### Task 3: Routes, list page, group page (members), nav

**Files:**
- Create: `routes/playgroups.js`, `views/playgroups.handlebars`, `views/playgroup.handlebars`
- Modify: `routes/index.js` (mount `playgroupsRouter`), `middleware/auth.js` (`loggedInNav` gains `{ link: '/playgroups', text: 'Playgroups' }` after Browse Decks)
- Test: `test/playgroups.test.js`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `groupView(group, viewer) -> Promise<object>` in `routes/playgroups.js` — the group page's render context (so error re-renders reuse it, like `profileView`). Task 4 extends it. Contains at least `{ title: group.name, group: { _id, name }, isOwner, members: [{ username, isOwner }] (sorted by username), invites: [{ username }] }`.

Routes (all `requireAuth`):
- `GET /playgroups` → `playgroups` view: my groups `{ _id, name, memberCount }` sorted by name, pending invites `{ _id, name }`, create form.
- `POST /playgroups` → `cleanName`; invalid → 400 re-render of the list with `error: 'Playgroup names must be 1–60 characters.'`; else create, redirect `/playgroups/<id>`.
- `GET /playgroups/:id` → `findMemberGroup`, 404 if null; render `playgroup`.
- `POST /playgroups/:id/invite` (body `username`) → non-member/bad id → 404; error → 400 re-render of `playgroup` with `error`; success → redirect to group.
- `POST /playgroups/:id/accept` → redirect to group; `/decline` → redirect `/playgroups`. Malformed id → redirect `/playgroups`.
- `POST /playgroups/:id/leave` → redirect `/playgroups`.
- `POST /playgroups/:id/remove` (body `username`) → redirect to group.
- `POST /playgroups/:id/rename` (body `name`) → invalid name → 400 re-render with the create-name error; else redirect to group.
- `POST /playgroups/:id/delete` → redirect `/playgroups`.
Group page shows: member list (owner marked), invite form (username text input), pending invitees, Leave button (non-owner), and for the owner: Remove buttons, rename form, Delete button. Follow `profile.handlebars` / dashboard markup and classes.

- [ ] **Step 1: Write the failing tests** (HTTP, via `registerClient`):
  - Create `POST /playgroups { name: 'Friday Pod' }` → 302 to `/playgroups/<id>`; GET it → 200 contains `Friday Pod`.
  - `POST /playgroups { name: '' }` → 400 contains `Playgroup names must be 1–60 characters.`
  - Non-member GET `/playgroups/<id>` → 404 and body does not contain `Friday Pod`; anonymous → redirect to login.
  - `GET /playgroups/not-an-id` → 404; `POST /playgroups/not-an-id/invite|leave|remove|rename|delete|accept` → none is 500.
  - Invite flow: owner invites friend by username → 302; friend's `GET /playgroups` lists the invite; accept → friend's GET of group → 200.
  - Invite of a non-friend → 400 contains `You can only invite your friends.`
  - Nav: logged-in `GET /dashboard` contains `href="/playgroups"`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement routes, views, nav.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: playgroup pages, invites and nav`.

### Task 4: Group leaderboard and recent games

**Files:**
- Modify: `routes/playgroups.js` (`groupView`), `views/playgroup.handlebars`
- Test: `test/playgroups.test.js`

**Interfaces:**
- Consumes: `getPlayerLeaderboard`, `getDeckLeaderboard`, `maskHiddenDecks` (Task 1); `canSeeDeck`, `opponentList`.
- Produces: `groupView` additionally returns `players` (player leaderboard rows), `decks` (masked deck rows), and `games`: the 10 newest tagged games as `{ username, result, createdAt, opponents, deck: { _id, name } | null }` — `deck` null when `canSeeDeck` fails, same as `profileView`.

Render the two leaderboards with the existing leaderboard card markup (see `leaderboard.handlebars` / `deckLeaderboard.handlebars`; extract a partial only if it's a straight copy), and a recent-games list like the profile's.

- [ ] **Step 1: Write the failing tests:**
  - Group page shows a member's tagged game (opponent name visible) and not their untagged game (a distinct opponent name absent).
  - Player rows on the group page: a member with 2 tagged wins shows rank 1 above a member with 1.
  - A tagged game played with another member's **private** deck: group page contains `Hidden deck` and not the deck's name; the deck owner viewing sees the name.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Extend `groupView` and the view.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: playgroup leaderboard and recent games`.

### Task 5: Tag games with a playgroup

**Files:**
- Modify: `routes/gameRecords.js`, `routes/dashboard.js`, `views/gameRecordForm.handlebars`, `views/userDashboard.handlebars`
- Test: `test/playgroups.test.js`

**Interfaces:**
- Consumes: `Playgroup`, `GameRecord.playgroup` (Task 1).
- Produces: `resolveGameInput({ deckId, body, result, playgroupId, keepPlaygroup }, userId)` returns `{ deck, opponents, result, playgroup }` where `playgroup` is an ObjectId or `null`. Empty `playgroupId` → `null`. Otherwise valid only if the user is in that group's `members`, **or** `String(playgroupId) === String(keepPlaygroup)` (the record's current tag, so an unchanged tag on edit survives leaving). Invalid → whole input `null`, as today.
- Produces: `listMemberGroups(userId)` in `lib/playgroups.js` → lean `[{ _id, name }]` sorted by name.

Form field: `<select name="playgroup_id">` labelled "Playgroup (optional)", first option `value=""` "None", then member groups; on the edit form also the record's current group if not in that list (load its name), selected. Render the select only when there's at least one option beyond "None". POST create sets `playgroup` when non-null; PUT sets it or `$unset`s (`record.playgroup = input.playgroup ?? undefined`). Extend the PUT 400 copy: `Please pick one of your decks and playgroups, choose a result, and give every opponent (up to ${MAX_OPPONENTS}) both a name and a deck.` and echo `values.playgroup`.

- [ ] **Step 1: Write the failing tests:**
  - Dashboard quick-log with `playgroup_id` of my group → saved record has that `playgroup`.
  - Quick-log with a group I'm not in → no record created (redirect, matching current invalid-input behavior).
  - Edit with `playgroup_id: ''` clears the tag; with a group I'm not in → 400.
  - Record tagged to group G, user leaves G, edit submitting the same `playgroup_id` → 302 and tag still G.
  - Dashboard HTML contains `name="playgroup_id"` for a member, and not for a user with no groups.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: tag games with a playgroup`.
