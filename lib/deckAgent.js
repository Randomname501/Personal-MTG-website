// The deck helper agent: the loop from scripts/agent-step3.js, grown up.
// Differences from step 3:
//   - Claude sees the deck: a fresh snapshot rides along with each question.
//   - Every search is forced into the deck's color identity by *our* code.
//   - Picks come back through a recommend_cards tool, and the server keeps only
//     cards a search actually returned — Claude can't invent a card.
//   - The Claude client and search function are parameters, so tests can pass fakes.
import { searchCards } from './scryfall.js';

const MODEL = 'claude-opus-5-5';

export const TOOLS = [
  {
    name: 'search_cards',
    description:
      'Search Magic cards on Scryfall. `query` uses Scryfall search syntax, e.g. ' +
      '`t:creature o:"add {G}" cmc<=2 usd<1`. The deck\'s color identity and format ' +
      'legality are added automatically, so don\'t add your own. Returns up to 20 cards with their ids, rules text and USD price.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Scryfall search query' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'recommend_cards',
    description:
      'Hand your final picks to the user. Only use scryfallIds returned by search_cards. ' +
      'Each pick needs a one-line reason that fits this deck.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: { scryfallId: { type: 'string' }, reason: { type: 'string' } },
            required: ['scryfallId', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['cards'],
      additionalProperties: false,
    },
  },
];

// Our formats that Scryfall can check legality for (`f:`). Limited/Other have none.
const SCRYFALL_FORMATS = {
  Commander: 'commander', Standard: 'standard', Modern: 'modern', Pioneer: 'pioneer',
  Legacy: 'legacy', Vintage: 'vintage', Pauper: 'pauper',
};

// Always add the deck's color identity and format to a Scryfall query. Claude's
// query goes in parentheses so a top-level `or` can't escape the filters, and since
// Scryfall ANDs filters, anything Claude wrote can only narrow them, never widen.
// A deck with no colors set gets no identity filter (an empty `id<=` would mean
// "colorless only").
// True if every `)` closes an earlier `(` and none are left open (quoted text ignored).
const balanced = (q) => {
  let depth = 0;
  for (const part of q.split('"').filter((_, i) => i % 2 === 0)) {
    for (const ch of part) {
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) return false;
    }
  }
  return depth === 0;
};

export const withDeckFilters = (query, { colors = [], format } = {}) => {
  const filters = [];
  if (colors.length) filters.push(`id<=${colors.join('').toLowerCase()}`);
  if (SCRYFALL_FORMATS[format]) filters.push(`f:${SCRYFALL_FORMATS[format]}`);
  // A stray `)` (e.g. `t:elf) or (t:wizard`) would close our group early and let
  // one branch skip the filters, so unbalanced queries lose their parens.
  let q = String(query ?? '').trim();
  if (!balanced(q)) q = q.replace(/[()]/g, ' ').trim();
  if (!filters.length) return q;
  return q ? `(${q}) ${filters.join(' ')}` : filters.join(' ');
};

// The system prompt must never change within a conversation: the API ties Claude's
// earlier thinking blocks to it and rejects them if it differs. So it holds only
// fixed rules, and the deck (which changes as cards are added) rides along with
// each question instead — see deckSnapshot.
export const SYSTEM_PROMPT = [
  'You help the owner of a Magic: The Gathering deck find cards to add.',
  'Rules:',
  '- Find cards with search_cards. Only recommend cards that a search returned.',
  '- Deliver 3-8 picks through recommend_cards, each with a one-line reason tied to the deck.',
  "- Respect the deck's color identity and format. Skip cards already in the deck.",
  '- The deck as it is right now comes with each question; the latest one is current.',
  '- After recommend_cards, reply with a short summary (a few sentences) in plain text: no markdown, since the page shows it as-is.',
].join('\n');

export const deckSnapshot = (deck) => {
  const list = (deck.cards || []).map((c) => `${c.quantity} ${c.name}`).join('\n') || '(no cards yet)';
  return [
    'Current deck:',
    `Format: ${deck.format}`,
    `Colors: ${(deck.colors || []).join('') || 'not set'}`,
    `Commander: ${deck.commander || 'none'}`,
    'Cards:',
    list,
  ].join('\n');
};

// What Claude sees for each card found (small = cheaper), and what we keep to show.
const toToolCard = ({ scryfallId, name, manaCost, typeLine, oracleText, priceUsd, imageUrl }) =>
  ({ scryfallId, name, manaCost, typeLine, oracleText, priceUsd, imageUrl });

// Every card any earlier search returned, read back out of the transcript's
// tool_results, so a follow-up question can recommend a card found earlier.
const knownCardsFrom = (messages) => {
  const known = new Map();
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      try {
        const parsed = JSON.parse(block.content);
        if (Array.isArray(parsed)) for (const c of parsed) if (c?.scryfallId) known.set(c.scryfallId, c);
      } catch { /* not a search result */ }
    }
  }
  return known;
};

export const runDeckAgent = async ({ client, deck, messages, question, search = searchCards, maxTurns = 5, signal }) => {
  const original = messages;
  // Append-only: earlier turns are replayed untouched; the new turn carries the deck.
  messages = [...messages, {
    role: 'user',
    content: [
      { type: 'text', text: deckSnapshot(deck) },
      { type: 'text', text: `Question: ${question}` },
    ],
  }];
  const known = knownCardsFrom(messages);
  // Match by name, not scryfallId: every printing has its own id, so the deck may
  // hold the same card under a different one. Front face only, for double-faced cards.
  const nameKey = (name) => (name || '').split(' // ')[0].trim().toLowerCase();
  const inDeck = new Set([...(deck.cards || []).map((c) => nameKey(c.name)), nameKey(deck.commander)]);
  let recommendations = [];

  // Run one tool_use block; returns its tool_result content.
  const runTool = async (block) => {
    if (block.name === 'search_cards') {
      const cards = (await search(withDeckFilters(block.input.query, deck))).map(toToolCard);
      for (const c of cards) known.set(c.scryfallId, c);
      return JSON.stringify(cards);
    }
    if (block.name === 'recommend_cards') {
      const picks = block.input.cards || [];
      recommendations = picks
        .filter((p) => known.has(p.scryfallId))
        .map((p) => ({ ...known.get(p.scryfallId), reason: p.reason }))
        .filter((c) => !inDeck.has(nameKey(c.name)))
        .map(({ oracleText, ...c }) => c);
      const dropped = picks.length - recommendations.length;
      return `Recorded ${recommendations.length} picks.` +
        (dropped ? ` Dropped ${dropped} (not found by a search, or already in the deck).` : '');
    }
    throw new Error(`Unknown tool: ${block.name}`);
  };

  let response;
  for (let turn = 0; turn < maxTurns; turn++) {
    response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // if Claude wrongly refuses, the API retries on another model
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      },
      { signal },
    );

    // Anything but a normal finish or a tool request: leave the history as it was,
    // so the owner can just ask again.
    if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'tool_use') {
      const note = response.stop_reason === 'max_tokens' ? 'Reply was cut off.' : "Claude couldn't help with that one.";
      return { messages: original, reply: textOf(response), recommendations, note };
    }

    messages.push({ role: 'assistant', content: response.content }); // unchanged, always
    if (response.stop_reason === 'end_turn') {
      return { messages, reply: textOf(response), recommendations, note: null };
    }

    // tool_use: run every tool, all results in one message — even on the last
    // turn, so the transcript never ends on an unanswered tool call.
    const results = [];
    for (const block of response.content.filter((b) => b.type === 'tool_use')) {
      try {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: await runTool(block) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return { messages, reply: textOf(response), recommendations, note: `Stopped after ${maxTurns} steps.` };
};

const textOf = (response) =>
  (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
