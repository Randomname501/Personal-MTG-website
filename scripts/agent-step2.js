// STEP 2 — One tool, one call.
// We tell Claude it may use a "search_cards" tool. Claude can't run code itself:
// it *asks* us to run the tool, we run it, and we send back what happened.
// Run: node --env-file=.env scripts/agent-step2.js

import Anthropic from '@anthropic-ai/sdk';
import { searchCards } from '../lib/scryfall.js';

const client = new Anthropic();

// A tool is just a name, a description, and the shape of its input (JSON Schema).
// The description is the only thing Claude knows about the tool, so it matters.
const tools = [
  {
    name: 'search_cards',
    description:
      'Search Magic cards on Scryfall. `query` uses Scryfall search syntax, e.g. ' +
      '`t:creature o:"add {G}" cmc<=2 usd<1`. Returns up to 20 matching cards.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Scryfall search query' } },
      required: ['query'],
    },
  },
];

const messages = [
  { role: 'user', content: 'Find me a cheap green creature that adds mana.' },
];

// ---- Call 1: Claude decides whether to use the tool ----
const first = await client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 16000,
  output_config: { effort: 'low' },
  tools,
  messages,
});
console.log('call 1 stop_reason:', first.stop_reason); // expect "tool_use"

if (first.stop_reason !== 'tool_use') {
  console.log('Claude answered without the tool. Try a different question.');
  process.exit(0);
}

// The request to run the tool arrives as a "tool_use" block.
const toolUse = first.content.find((block) => block.type === 'tool_use');
console.log('Claude wants:', toolUse.name, toolUse.input);

// *We* run the tool — it's our own code from lib/scryfall.js.
const cards = await searchCards(toolUse.input.query);
console.log(`Scryfall found ${cards.length} cards:`, cards.map((c) => c.name).join(', '));

// Only send Claude what it needs: fewer tokens, less cost.
const trimmed = cards.map(({ name, manaCost, typeLine, oracleText, priceUsd }) => ({
  name, manaCost, typeLine, oracleText, priceUsd,
}));

// ---- Call 2: send the result back ----
// First Claude's own reply, exactly as received (tool_use block and all)...
messages.push({ role: 'assistant', content: first.content });
// ...then the tool's result, as a user message. tool_use_id ties it to the request.
messages.push({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(trimmed) }],
});

const second = await client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 16000,
  output_config: { effort: 'low' },
  tools, // tools must be sent on every call
  messages,
});
console.log('\ncall 2 stop_reason:', second.stop_reason); // expect "end_turn"
for (const block of second.content) {
  if (block.type === 'text') console.log('\nClaude says:', block.text);
}

// Note: if call 2 had asked for *another* search, this script would just stop.
// Handling "keep going until Claude is done" is step 3: the loop.
