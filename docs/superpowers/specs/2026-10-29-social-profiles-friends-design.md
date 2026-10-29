# Social sub-project B: profiles, friends, deck visibility, profile comments

Date: 2026-10-29. Roadmap item 4B, which takes in profile comments (the roadmap's sub-project C was deck comments; this replaces it with comments on profiles).

## Intent

Players should be able to land on another player's page, add them as a friend, look through the decks they've built and leave them a comment. Friendship is what unlocks things: each deck's owner chooses whether it is visible to everyone, to friends only, or only to themselves, and only friends can comment on a profile.

## Decided by the user

- **Profiles are open to anyone,** logged in or not.
- **Friends are mutual.** A request must be accepted before two people are friends.
- **Visibility is per deck only:** `public` (anyone), `friends` (owner's friends), `private` (owner only). It's chosen with a dropdown on the deck form. **New decks start public.** Game records have **no** visibility setting of their own.
- **Games are always shown,** but anywhere a game appears, a deck the viewer can't see is blurred out.
- **All games still count.** Leaderboards, win rates and deck stats count every game.
- **Profile layout B:** a header (username, join date, headline stats, friend button). Below it, a main column with the player's decks and recent games, and a sidebar with the friends list and comments. The sidebar stacks below on narrow screens.
- **Incoming friend requests** show on the dashboard with Accept and Decline buttons, plus a pending count beside the user's name in the nav.
- **Only friends can comment** on a profile.
- **Only the comment's author can delete it.** The profile owner cannot remove comments on their own profile.

## Goals

- A profile page for every user, open to anyone and reachable from wherever a username already appears (Browse owner column, leaderboards, deck page owner, friends lists, comments).
- Send, cancel, accept and decline friend requests, and unfriend.
- A visibility setting on decks that is enforced everywhere a deck is shown.
- Comments on a profile: friends post them, and the author deletes their own.

## Non-goals

- A visibility setting on game records.
- Notifications beyond the dashboard list and the nav count (no email, no live updates).
- Blocking users, reporting, or moderation tools.
- Editing comments (delete and re-post).
- Comments on decks or games.
- Linking opponent names in games to accounts. Opponents stay free text and are never blurred.
- Profile customisation (avatar, bio, banner).
- Opening Browse or deck pages to logged-out visitors. They still require login, as today.

## Anti-goals (would make this a failure even if it "works")

- A friends-only or private deck's name, cards or page reaches someone who shouldn't see it, on **any** page:
  - Browse
  - the deck page
  - someone's Tracked Decks
  - a profile's deck list
  - a game entry
  - the deck leaderboard

  "Reaches" includes the HTML source. A blurred deck must not carry its real name in the markup.
- Leaderboard or stat totals change because of visibility settings.
- Existing decks change behaviour after the deploy (they must all read as public).

## Behaviour

**Friend button states**, as seen by a logged-in viewer on someone else's profile:
- no relation → "Add friend"
- request sent → "Request sent", which can cancel it
- request received → "Accept" / "Decline"
- friends → "✓ Friends ▾", which can unfriend

There is no button on your own profile. Logged-out viewers see no button. *(My call: optionally a "Log in to add friend" link.)*

- *My call:* declining is silent. The sender's button goes back to "Add friend", and they may ask again.
- *My call:* if A requests B while B already has a pending request to A, they become friends immediately.
- *My call:* unfriending is immediate, and either side can do it. Friends-only decks disappear for the other person and the comment box goes away. Comments already posted remain.

**Deck visibility rule** (one shared check): the viewer can see a deck if
- they own it, or
- it is public, or
- it is `friends` and the viewer is friends with the owner.

A logged-out viewer is a stranger, so they see public decks only.

- **Browse:** lists only decks the viewer can see.
- **Deck page:** a deck the viewer can't see returns 404, the same as a missing deck. *(My call.)* Deck page stats (matchups, weekly trend) count all of that deck's games, as now. Anyone who can see the deck sees them. Opponent decks are free text, not decks, so nothing in there needs gating.
- **Tracked Decks:** a tracked deck the viewer can no longer see is left out of their dashboard. *(My call.)* It is not removed from `trackedDecks`, so it comes back if access returns.
- **Deck leaderboard:** totals are unchanged. A deck the viewer can't see keeps its row and numbers, but its name shows as a blurred placeholder and isn't linked, consistent with the game-entry blur. *(My call.)* The owner's username stays on the row, linked to their profile. *(My call.)*

**Blurred deck** (in game entries and the deck leaderboard): render a fixed placeholder, such as "Hidden deck", styled with a CSS blur, and with no link.
- The real name must not appear anywhere in the page.
- *(My call. A blur over the real text would leak the name in the page source.)*

**Profile content.**
- Header: username, "Joined <month year>", friend count, overall win rate from all of the user's games (counts everything).
- Main column:
  - The decks the viewer can see. On your own profile, each deck has a visibility badge.
  - Then that user's most recent 10 games, each with result, deck, opponents and date. The deck is blurred when the viewer can't see it.
- Sidebar:
  - The friends list, linking to their profiles.
  - The comment box, if the viewer is a logged-in friend.
  - Comments, newest first, each with a delete button shown only to its author.
- *My call:* friends lists and comments are visible to anyone who can view the profile, which is everyone.
- *My call:* deck links on a profile go to the deck page as usual, so logged-out visitors are sent to log in.

**Comments.**
- Plain text, 1 to 1000 characters, trimmed. Rendered escaped (Handlebars default).
- *My call:* when a friendship ends, existing comments stay. Losing friendship stops new comments only.

**Dashboard.** A "Friend requests" section lists incoming requests with Accept and Decline buttons. It is hidden when empty. The nav shows the pending count next to the username when it's above 0. *(My call: the nav doesn't show the username today, so add it, linked to the user's own profile.)*

## Constraints

Carried over from the rest of the project:
- Server-rendered Handlebars, no client JS libraries, no new runtime dependencies.
- Forms POST, and the server redirects back. Every state-changing route checks login, ownership or friendship on the server.
- Tests run on a real local MongoDB via `node --test`, with one database name per test file.
- Existing data: decks without a visibility field must behave as `public` (a schema default covers reads; queries filtering on visibility must also treat a missing field as public).
- Must keep the existing open-redirect guard (`safeBack`) pattern for any "back" parameters.

## Left to the builder

- How friendships and requests are stored (fields on `User` vs. a separate collection), and the indexes.
- Profile URL shape. *(My call to suggest: `/users/:username`, case-insensitive lookup, 404 when unknown.)*
- How the shared visibility check is structured, and how it's applied inside queries (Browse, profile, dashboard) vs. after fetching.
- Exact markup and CSS, following the existing look (paper/ink palette, Cinzel headings, the layout-B mockup).
- Splitting the build into phases. A natural order is profiles → friends → deck visibility → comments.
