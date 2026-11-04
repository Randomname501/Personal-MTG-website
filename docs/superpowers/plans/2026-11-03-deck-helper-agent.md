# Deck Helper Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat panel on the owner's deck page that runs a hand-written Claude tool-use loop over Scryfall and returns card picks the owner can add with one click.

**Architecture:** Three teaching scripts (`scripts/agent-step1..3.js`) build up the loop one idea at a time. The real loop lives in `lib/deckAgent.js` and takes its Claude client and search function as parameters, so it can be tested without network access. A JSON route, `POST /decks/:id/assistant`, wraps it. The browser keeps the transcript and sends it back with each question.

**Tech Stack:** Node 22 ESM, Express 4, Mongoose, `node:test`, `@anthropic-ai/sdk` (new), Handlebars, plain browser JS.

**Spec:** `docs/superpowers/specs/2026-11-03-deck-helper-agent-design.md`

**Execution note:** The owner is learning. After each task, stop and explain in plain words what the new code does and why, then run it together before moving on.

## Global Constraints

- Model `claude-opus-5-5`; `output_config: { effort: "low" }`; `max_tokens: 16000`; omit `thinking` (adaptive by default; `disabled` is a 400 on this model).
- Do not use `tool_choice` `any`/`tool` (400 on this model). Use `auto` (the default).
- Append every assistant `response.content` to the transcript **unchanged**, thinking blocks included. Never edit or remove earlier turns.
- `lib/deckAgent.js` calls `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. The teaching scripts use plain `client.messages.create`.
- `MAX_TURNS = 5` Claude calls per question; one `AbortSignal.timeout(60_000)` shared by every call in a question.
- The only new dependency is `@anthropic-ai/sdk`. `ANTHROPIC_API_KEY` comes from `.env`. Tests set `ANTHROPIC_BASE_URL` to a fake server, mirroring `SCRYFALL_API_BASE`.
- Owner-only (`findOwnedDeck`). Panel hidden when `ANTHROPIC_API_KEY` is unset.

## Review Focus

1. **Turn limit hit right after a `tool_use`:** the transcript must still end with the matching `tool_result`s, or the owner's next question gets a 400. (Task 4 test `turn limit still answers pending tool calls`.)
2. **Deck with no colors set:** don't append `id<=` to searches (that would mean "colorless only"); search unfiltered. (Task 4 test `withColorIdentity leaves query alone when deck has no colors`.)
3. **Follow-up picks a card found in an earlier question's search:** it's still valid, because known cards are read from the whole transcript, not just this request. (Task 4 test `recommendation from an earlier turn's search is kept`.)
4. **Scryfall fails or times out mid-loop:** return an `is_error` tool_result and keep looping, never a 500. (Task 4 test `search failure becomes an error tool_result`.)
5. **Bad request body (empty or very long question, non-array or oversized transcript):** respond 400, not 500. (Task 5 test `rejects bad bodies with 400`.)

---

### Task 1: Hello Claude (teaching script)

**Files:**
- Modify: `package.json` (dependency)
- Create: `scripts/agent-step1.js`

**Interfaces:** Produces nothing that later tasks import.

- [ ] **Step 1:** `npm install @anthropic-ai/sdk`
- [ ] **Step 2:** Write `scripts/agent-step1.js`: `new Anthropic()`, one `client.messages.create` with model `claude-opus-5-5`, `max_tokens: 16000`, `output_config: { effort: "low" }`, and the user message "Suggest one green ramp card for Commander, in one sentence." Print `stop_reason`, each block's `type`, the text blocks, and `usage`. Comment each line for a beginner.
- [ ] **Step 3:** Run `node --env-file=.env scripts/agent-step1.js`. Expected: `stop_reason: end_turn` and a one-sentence card suggestion. Talk through: messages in, content blocks out, why there is a (possibly empty) `thinking` block, and what `usage` costs.
- [ ] **Step 4:** Commit: `git add package.json package-lock.json scripts/agent-step1.js && git commit -m "feat(agent): step 1 hello Claude script"`

### Task 2: One tool, one call (teaching script + Scryfall fields)

**Files:**
- Modify: `lib/scryfall.js` (`normalizeCard`)
- Modify: `test/scryfall.test.js:90-104` (expected shape)
- Create: `scripts/agent-step2.js`

**Interfaces:**
- Produces: `normalizeCard` output gains `oracleText: string` (top level, else the `card_faces` texts joined with `"\n//\n"`, else `''`) and `priceUsd: string | null` (`raw.prices?.usd ?? null`). The Deck schema ignores these on save, because Mongoose strict mode drops unknown fields.

- [ ] **Step 1:** In `test/scryfall.test.js`, add `oracle_text: 'Counter target spell.'` and `prices: { usd: '1.50' }` to `NORMAL_CARD`. Add `oracleText: 'Counter target spell.', priceUsd: '1.50'` to the `deepEqual` at line 93, and assert that the DFC card normalizes to `priceUsd: null` with `oracleText` holding both faces' texts.
- [ ] **Step 2:** `npm test`. Expected: the scryfall tests FAIL on the missing fields.
- [ ] **Step 3:** Add the two fields to `normalizeCard`.
- [ ] **Step 4:** `npm test`. Expected: all PASS (the deck tests too, which proves the schema ignores the new fields).
- [ ] **Step 5:** Write `scripts/agent-step2.js`. Define a `search_cards` tool (`query: string`, described as Scryfall search syntax) and ask "Find me a cheap green creature that adds mana." If `stop_reason === "tool_use"`, run `searchCards(block.input.query)` for the `tool_use` block, then send a second request that has the assistant's `response.content` appended unchanged plus a user message of `[{ type: "tool_result", tool_use_id, content: JSON.stringify(trimmedCards) }]`. Print the final text. No loop yet: exactly two calls.
- [ ] **Step 6:** Run `node --env-file=.env scripts/agent-step2.js`. Expected: Claude's chosen query, the cards it found, and a final answer naming one of them. Talk through: the tool schema, the `tool_use` block → `tool_result` with a matching `tool_use_id`, and that *our* code runs the tool, not Claude.
- [ ] **Step 7:** Commit: `git add lib/scryfall.js test/scryfall.test.js scripts/agent-step2.js && git commit -m "feat(agent): step 2 single tool call; keep oracle text and price"`

### Task 3: The loop (teaching script)

**Files:**
- Create: `scripts/agent-step3.js`

- [ ] **Step 1:** Copy step 2 into a `for (let turn = 0; turn < 5; turn++)` loop. Each turn: call Claude, append `response.content`, and `break` unless `stop_reason === "tool_use"`. Otherwise run **every** `tool_use` block and send **all** results in **one** user message. Log each turn (`turn N: stop_reason, queries`). After the loop, print the final text, or "stopped early" if the limit was hit. Use a question that needs two searches: "I want one cheap ramp creature and one cheap card-draw spell, both green."
- [ ] **Step 2:** Run `node --env-file=.env scripts/agent-step3.js`. Expected: two or more turns logged, then a final answer. Talk through: this loop *is* the agent; the turn limit is the cost guard; and why all tool results go in one message.
- [ ] **Step 3:** Commit: `git add scripts/agent-step3.js && git commit -m "feat(agent): step 3 agent loop script"`

### Task 4: `lib/deckAgent.js`

**Files:**
- Create: `lib/deckAgent.js`
- Test: `test/deckAgent.test.js`

**Interfaces:**
- Consumes: `searchCards(query)` from `lib/scryfall.js` (Task 2 shape).
- Produces:
  - `withColorIdentity(query: string, colors: string[]) -> string` appends ` id<=<colors lowercased, joined>` unless `colors` is empty or the query already contains `id<=`, `id:`, `identity` (case-insensitive).
  - `buildSystemPrompt(deck) -> string` contains the rules (only recommend cards returned by `search_cards`; 3–8 picks with a one-line reason each, delivered through `recommend_cards`; respect color identity; skip cards already in the deck; then a short plain-text reply) and the deck block (format, colors, commander, `quantity name` lines).
  - `TOOLS` contains `search_cards` `{ query: string }` and `recommend_cards` `{ cards: [{ scryfallId: string, reason: string }] }`, both `strict: true` with `additionalProperties: false`.
  - `runDeckAgent({ client, deck, messages, question, search = searchCards, maxTurns = 5, signal }) -> Promise<{ messages, reply: string, recommendations: Array<{ scryfallId, name, manaCost, typeLine, imageUrl, priceUsd, reason }>, note: string | null }>`.
- How it works: the system prompt is rebuilt from `deck` on every call (so mid-chat adds are seen). Push `{ role: "user", content: question }`. Known cards are a `Map<scryfallId, card>` read from every `search_cards` `tool_result` already in `messages`, plus each new search. `search_cards` results are JSON arrays of `{ scryfallId, name, manaCost, typeLine, oracleText, priceUsd, imageUrl }`. `recommend_cards` keeps ids that are in known cards, not in `deck.cards`, and not named `deck.commander`; its tool_result text reports kept and dropped counts. `reply` is the last response's text blocks joined. `note`: `"Stopped after 5 steps."` on the limit, `"Reply was cut off."` on `max_tokens`, `"Claude couldn't help with that one."` on `refusal`. On `refusal`, return the input `messages` unchanged, without the question.

- [ ] **Step 1: Write the failing tests.** The fake client is `{ beta: { messages: { create: async (params, opts) => script.shift() } } }` and records `params`. Responses are `{ stop_reason, content }`. Tests:
  - `withColorIdentity appends deck colors`: `('t:creature', ['G','B'])` → `'t:creature id<=gb'`
  - `withColorIdentity keeps an explicit identity`: `('id<=g t:elf', ['G','B'])` → unchanged
  - `withColorIdentity leaves query alone when deck has no colors`: `('t:elf', [])` → `'t:elf'`
  - `search then recommend then end_turn`: script is search → recommend(`[known id]`) → end_turn text "Here you go". Assert `reply === "Here you go"`, one recommendation with `reason`, that the search fn received the color-appended query, and that `params.betas` includes `server-side-fallback-2026-07-01`, `params.fallbacks === "default"`, and `params.model === "claude-opus-5-5"`.
  - `made-up ids are dropped`: recommend `['nope']` → `recommendations` is empty
  - `cards already in the deck or the commander are dropped`
  - `recommendation from an earlier turn's search is kept`: seed `messages` with a prior search tool_result containing id `x`; recommend `['x']` with no new search → kept
  - `search failure becomes an error tool_result`: the search fn throws; the next `params.messages` holds a `tool_result` with `is_error: true`, and the loop continues
  - `turn limit still answers pending tool calls`: 5 search responses in a row → `note === "Stopped after 5 steps."`, the last message is a user message of `tool_result`s, and `create` was called 5 times
  - `refusal leaves transcript unchanged`: returned `messages` deepEquals the input
  - `assistant content is appended unchanged`: a `thinking` block in a response appears verbatim in returned `messages`
- [ ] **Step 2:** `node --test test/deckAgent.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `lib/deckAgent.js` per the Interfaces. Pass `{ signal }` as the second argument to `create`.
- [ ] **Step 4:** `npm test`. Expected: all PASS.
- [ ] **Step 5:** Talk through how this differs from step 3: injected client (testability), the server-side guard against made-up cards, and the fallback beta.
- [ ] **Step 6:** Commit: `git add lib/deckAgent.js test/deckAgent.test.js && git commit -m "feat(agent): deck agent loop with server-side pick checks"`

### Task 5: `POST /decks/:id/assistant`

**Files:**
- Modify: `routes/decks.js` (new route; pass `assistantEnabled` to `deckDetail`)
- Test: `test/deckAssistant.test.js`

**Interfaces:**
- Consumes: `runDeckAgent` (Task 4).
- Produces: JSON body `{ question: string, messages: array }` → `200 { messages, reply, recommendations, note }`. `400 { error }` for a bad body, `404` for a non-owner or bad id, `503 { error }` when no key is set, and `502 { error: "The assistant is unavailable right now." }` when the Claude call throws. `deckDetail` gets `assistantEnabled = isOwner && Boolean(process.env.ANTHROPIC_API_KEY)`.
- Validation: `question` is a trimmed string of 1–1000 chars. `messages` is an array whose `JSON.stringify` length is ≤ 300_000.
- Client: `new Anthropic()` per request (it reads `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` at that moment). `signal: AbortSignal.timeout(60_000)`.

- [ ] **Step 1: Write the failing tests.** Copy the harness from `test/deckCards.test.js` (fake Scryfall, `makeClient`, Alice and Bob users) and use database `mtg_tracker_assistant_test`. Add a fake Anthropic server that handles `POST /v1/messages` (any query string) and returns the next scripted message (`{ id, type: "message", role: "assistant", model, content, stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }`). Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY = "test"`. Add a JSON request helper. Tests:
  - `owner gets recommendations`: script search → recommend → end_turn; 200 with one recommendation
  - `non-owner gets 404`
  - `rejects bad bodies with 400`: empty question, 1001-char question, `messages: "x"`, oversized messages
  - `503 when no key`: delete the env var for this test and restore it after
  - `502 when Claude errors`: the fake returns HTTP 400 `{ type: "error", error: { type: "invalid_request_error", message: "x" } }` → 502 JSON (400 isn't retried by the SDK, so the test stays fast)
  - `deck page shows the panel only to the owner`: Alice's page matches `/deck-assistant/` and Bob's doesn't
- [ ] **Step 2:** `node --test test/deckAssistant.test.js`. Expected: FAIL (404s).
- [ ] **Step 3:** Implement the route and `assistantEnabled`. Add a minimal `<section id="deck-assistant">` placeholder in `views/deckDetail.handlebars` inside `{{#if assistantEnabled}}` so the last test can pass. Task 6 fills it in.
- [ ] **Step 4:** `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit: `git add routes/decks.js views/deckDetail.handlebars test/deckAssistant.test.js && git commit -m "feat(agent): deck assistant route"`

### Task 6: Chat panel UI

**Files:**
- Modify: `views/deckDetail.handlebars` (fill in the `#deck-assistant` section)
- Create: `public/js/deck-assistant.js`
- Modify: `public/css/style.css`

**Interfaces:**
- Consumes: the Task 5 JSON route and the existing `POST /decks/:id/cards` (form field `scryfall_id`).

- [ ] **Step 1:** Panel markup: heading "Deck helper", a message log, a form with a text input (`maxlength="1000"`) and an Ask button, and a `data-deck-id` attribute. Load `<script src="/js/deck-assistant.js" defer>` inside the `{{#if}}` only.
- [ ] **Step 2:** `deck-assistant.js` keeps `messages` in a variable (reset on page load). On submit: disable the button and show "Thinking…", POST JSON, then append the `reply` text, any `note`, and recommendation tiles (image, name, mana cost, price, reason, and an **Add** button). Store the returned `messages`. On error, show the `error` text. Render text with `textContent`, never `innerHTML`, because the text comes from the model. Add POSTs `scryfall_id` as `application/x-www-form-urlencoded`, and on `res.ok` the button becomes "Added ✓" and is disabled.
- [ ] **Step 3:** Styles: tiles in a responsive grid matching existing card styles. The panel must work at phone width.
- [ ] **Step 4:** Run `npm run dev` and open a deck you own. Ask "cheap green ramp", add one pick, ask "cheaper ones", and reload the deck page to confirm the added card is listed. Check that a deck you don't own shows no panel.
- [ ] **Step 5:** `npm test`. Expected: all PASS.
- [ ] **Step 6:** Commit: `git add views/deckDetail.handlebars public/js/deck-assistant.js public/css/style.css && git commit -m "feat(agent): deck helper chat panel"`

---

## Deviations from spec (builder's calls)

- The deck context goes in the **system prompt**, rebuilt every request, rather than in the first user message. The spec wants the list "fresh each request", and a first message in the transcript can't be refreshed without editing history, which the API forbids for thinking models.
- The browser holds the full API transcript (opaque JSON), not just text, so earlier thinking blocks and tool results are replayed unchanged. Tampering only affects the owner's own deck, and Add re-fetches the card from Scryfall anyway.
