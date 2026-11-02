# Playgroups (social sub-project D) — design

Status: draft, written without a brainstorming round (user said "start working on the
next task"). Every decision below is Claude's call unless marked otherwise; review them.

## Intent

The people you actually sit down with every week are a small, fixed group. Today the
only leaderboards are global, so your pod's standings are buried among everyone else's.
A playgroup gives that group a home: who's in it, the games you played together, and a
leaderboard that counts only those games.

## Goals

- A user can create a named playgroup and becomes its owner.
- Members invite their (mutual) friends; the invitee accepts or declines.
- When logging or editing a game, a user can tag it with one playgroup they belong to.
- Each playgroup has a members-only page: member list, group leaderboard (players and
  decks, counting only games tagged to the group), and recent tagged games.
- A "Playgroups" nav link → list of my groups, pending invites, and a create form.

## Non-goals

- Public/discoverable groups, join requests, group comments/chat, scheduling.
- Linking free-text opponents to accounts. Opponents stay free text.
- Changing global leaderboards or personal stats: tagged games still count everywhere.

## Anti-goals

- A non-member learning anything about a group (name, members, games) — 404 for them.
- A tagged game revealing a hidden deck's name: deck names on the group page go through
  `canSeeDeck`, rendering "Hidden deck" otherwise, same as the profile page.

## Data

New model `Playgroup`:

```
name:    String, required, trim, maxlength 60
owner:   ObjectId → User, required
members: [ObjectId → User]   // includes the owner; index
invites: [ObjectId → User]   // pending invitees; index
timestamps
```

`GameRecord` gains optional `playgroup: ObjectId → Playgroup` (index). Additive; old
records simply have none.

## Behavior

- **Create** `POST /playgroups` → owner = me, members = [me]. Redirect to the group page.
- **List** `GET /playgroups` → my groups (name, member count) + pending invites with
  Accept/Decline + create form.
- **Group page** `GET /playgroups/:id` → members only, else 404 (bad id too).
- **Invite** `POST /playgroups/:id/invite` (username) → any member may invite a user who
  is their mutual friend (`mutualFriends`) and not already a member/invitee. Otherwise
  the page re-renders with an error.
- **Accept / decline** `POST /playgroups/:id/accept|decline` → only if I'm in `invites`.
  Accept is one `updateOne` (`$pull` invites, `$addToSet` members) filtered on
  `invites: me`, so it can't double-apply.
- **Leave** `POST /playgroups/:id/leave` → a non-owner member pulls themselves out.
- **Remove member** `POST /playgroups/:id/remove` → owner only, not themselves.
- **Rename / delete** → owner only. Delete clears `playgroup` from its tagged games
  (`updateMany $unset`), then removes the group.
- **Game form** gets a "Playgroup (optional)" `<select>` of groups I'm a member of. On
  save, a submitted playgroup id must be one I'm a member of; otherwise 400 like other
  validation errors. Editing can change or clear it.
- Leaving or being removed does not untag your past games; they stay in the group's
  history and leaderboard (the games happened).

## Group leaderboard

Reuse `lib/leaderboards.js`: parameterize `getPlayerLeaderboard` / the deck leaderboard
with an optional `$match` (`{ playgroup: id }`) so the global calls stay unchanged.
Deck rows on the group page apply `canSeeDeck` for the viewer.

## Constraints (from the project)

Server-rendered Handlebars, no client JS libraries, no new deps. Tests with `node --test`
on a real local MongoDB, own DB name per test file. Owner-scoped 404 pattern as in decks
and game records. Branch `feat/playgroups` off `development` → PR into `development`.

## Left to the builder

Markup and styling (follow the profile page and leaderboard cards), exact error copy,
how many recent games to show (profile uses 10).
