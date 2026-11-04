# Deck Helper Agent — Design

**Date:** 2026-11-03
**Status:** Approved in chat, pending doc review

## Intent

A chat box on a deck's page where the owner asks in plain English ("cheap green
ramp under $2", "more card draw that fits this deck") and gets real card
recommendations, then picks which ones to add.

The second goal matters as much as the feature: **the owner is building this to
learn how an agent works.** So the agent loop is written by hand, in small steps
that each run on their own, and the code should read like a tutorial: nothing
clever, no hidden machinery.

## Goals

- Plain-English request in, a short list of real cards out, each with a one-line reason.
- The agent knows the current deck: format, colors, commander, and card list.
- Recommendations come from Scryfall searches the agent runs itself. It never
  names a card from memory without having found it.
- Each suggestion has an **Add** button. Clicking it adds one copy to the deck.
- Short back-and-forth within one page visit ("cheaper ones", "only creatures").

## Non-goals

- No saved chat history. Leaving the page resets the conversation.
- No agent-driven writes. The agent never changes the deck; only the owner's click does.
- No framework or SDK tool runner. The loop is ours.
- Not available to non-owners viewing a deck.

## Anti-goals (would count as failure even if it "works")

- Suggesting cards that don't exist, or that break the deck's color identity.
- Suggesting cards already in the deck.
- A single question that silently makes dozens of API calls and runs up a bill.
- Loop code so abstracted that the owner can't follow one request end to end.

## Decisions made (by the owner)

- Lives on the deck detail page, owner-only.
- Knows the deck it's on.
- Hand-written agent loop on the Claude API.
- Agent suggests; the owner picks; Add reuses the existing add-card behavior.

## How it works

### The loop (the part being learned)

```
messages = [deck context + user's question]
repeat up to MAX_TURNS (5):
    response = Claude(messages, tools)
    append response to messages
    if stop_reason == "tool_use":
        run each tool_use block, append ALL tool_results in one user message
        continue
    else (end_turn): done; return the final answer
if the limit is hit: return what we have plus a "stopped early" note
```

Handle `stop_reason` explicitly: `tool_use` (continue), `end_turn` (done),
`max_tokens` and `refusal` (stop and show a friendly message).

### Tools given to Claude

1. **`search_cards(query)`**: wraps the existing `searchCards` in
   [lib/scryfall.js](../../../lib/scryfall.js). Claude writes Scryfall search
   syntax (e.g. `o:"add {G}" t:creature cmc<=2 id<=BG`). The result returned to
   Claude is trimmed to what it needs: name, scryfallId, mana cost, type line,
   and oracle text. *(Builder's call: `normalizeCard` currently drops oracle text
   and price. Add `oracleText` and `priceUsd` to it, because Claude can't judge
   "ramp" or "under $2" without them.)*
2. **`recommend_cards(cards: [{scryfallId, reason}])`**: how Claude hands back
   its final picks. The server checks every id against the cards returned by
   searches in *this* conversation and drops any it didn't actually find. That
   is the guard against made-up cards. It also drops cards already in the deck.

Color identity is enforced in two places: the system prompt tells Claude to put
`id<=<deck colors>` in every search, and the server appends it to the query if
it's missing.

### Model and API

- **Model:** `claude-opus-5-5`, with adaptive thinking (the default) and
  `effort: "low"`, since this is chat, not deep reasoning.
- **Client:** the official `@anthropic-ai/sdk` package, using plain
  `client.messages.create`. We still write the loop ourselves; the SDK only
  handles HTTP, retries, and types. *(Changed from "plain fetch" in the chat:
  the SDK is Anthropic's supported path and makes the same loop easier to read.
  This is the one new dependency.)*
- **Refusal fallback:** `fallbacks: "default"` with the
  `server-side-fallback-2026-07-01` beta, so a rare false-positive refusal is
  retried on another model instead of failing. Easy to remove if unwanted.
- **Key:** `ANTHROPIC_API_KEY` in `.env` locally (already loaded by
  `npm start`), and as a Vercel env var in production. If it's missing, the
  helper is hidden instead of erroring.

### Deck context sent each request

The system prompt holds the rules (only recommend searched cards, respect color
identity, 3–8 picks, a one-line reason each). The first user message holds the
deck: format, colors, commander, and the card list as `quantity name` lines.
The list goes in fresh each request, so cards added mid-chat are counted.

### Web pieces

- `POST /decks/:id/assistant` (owner-only via `findOwnedDeck`) takes
  `{ messages }` (the chat so far, kept in the browser) and returns
  `{ messages, recommendations: [card…], note? }`.
- Deck page: a small chat panel, shown only when `isOwner` and a key is set.
  Plain JS in `public/js/deck-assistant.js`, matching the existing
  `public/js/*.js` style. Recommendations render as card images with an
  **Add** button.
- **Add** POSTs `scryfall_id` to the existing `POST /decks/:id/cards` with
  `fetch`, then marks the button "Added ✓". The route re-fetches the card
  server-side, so nothing from the browser is trusted. No new add logic.

### Cost and limits

- At most 5 loop turns per question, and at most 20 cards per search result
  (already true).
- A 60s overall timeout on the request.
- *(Builder's call: no per-user rate limit for now. Add one if the site gets
  other users who use the helper heavily.)*

## Build order (each step runnable on its own)

1. **Hello Claude:** a script `scripts/agent-step1.js` that sends one message and prints the reply.
2. **One tool, one call:** give Claude `search_cards`, run the one tool call it makes, send back the result, and print the final answer.
3. **The loop:** turn step 2 into the loop above with the turn limit and stop-reason handling.
4. **Deck context and `recommend_cards`:** load a real deck from Mongo and check the picks on the server. Move the loop into `lib/deckAgent.js`.
5. **The route:** `POST /decks/:id/assistant`, with tests using a fake Claude client.
6. **The UI:** chat panel and Add buttons on the deck page.

Steps 1–3 are teaching scripts. They can stay in `scripts/` as a record, or be deleted once `lib/deckAgent.js` exists. That's the owner's choice.

## Testing

- `lib/deckAgent.js` takes the Claude client as a parameter, so tests pass a
  fake one that replays scripted responses (tool_use → end_turn). This covers
  the turn limit, made-up-id filtering, already-in-deck filtering, and the
  color-identity append.
- The Scryfall fake server already used by the tests (`SCRYFALL_API_BASE`)
  covers `search_cards`.
- Route test: non-owners get 404, and a missing key hides the panel.

## Left to the builder

The system prompt wording, panel styling, and loading/error text in the UI.
