// STEP 3 — The loop. This is the agent.
// Step 2 handled exactly one tool call. Real questions may need several searches,
// so we keep going — call Claude, run whatever tools it asks for, send the
// results back — until Claude says it's done (or we hit our safety limit).
// Run: node --env-file=.env scripts/agent-step3.js

import Anthropic from '@anthropic-ai/sdk';
import { searchCards } from '../lib/scryfall.js';

const client = new Anthropic();
const MAX_TURNS = 5; // cost guard: never call Claude more than this per question

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

// Our side of a tool call: run it, and return the content for its tool_result.
const runTool = async (block) => {
  if (block.name !== 'search_cards') throw new Error(`Unknown tool: ${block.name}`);
  const cards = await searchCards(block.input.query);
  return JSON.stringify(cards.map(({ name, manaCost, typeLine, oracleText, priceUsd }) => ({
    name, manaCost, typeLine, oracleText, priceUsd,
  })));
};

const messages = [
  {
    role: 'user',
    content: 'I want one cheap ramp creature and one cheap card-draw spell, both mono-green.',
  },
];

let response;
let turn = 0;
for (; turn < MAX_TURNS; turn++) {
  response = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    tools,
    messages,
  });

  // Always keep Claude's reply in the history, unchanged.
  messages.push({ role: 'assistant', content: response.content });

  const toolUses = response.content.filter((block) => block.type === 'tool_use');
  console.log(`turn ${turn + 1}: stop_reason=${response.stop_reason}`,
    toolUses.map((t) => t.input.query));

  // Anything other than "tool_use" means Claude is finished (or can't go on).
  if (response.stop_reason !== 'tool_use') break;

  // Claude may ask for several tools at once. Run them all, and send ALL the
  // results back in ONE user message — that's what the API expects.
  const results = [];
  for (const block of toolUses) {
    try {
      results.push({ type: 'tool_result', tool_use_id: block.id, content: await runTool(block) });
    } catch (err) {
      // A failed tool isn't a crash: tell Claude, and let it try something else.
      results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
    }
  }
  messages.push({ role: 'user', content: results });
}

if (response.stop_reason === 'tool_use') {
  console.log(`\nStopped early: hit the ${MAX_TURNS}-turn limit.`);
} else {
  for (const block of response.content) {
    if (block.type === 'text') console.log('\nClaude says:', block.text);
  }
}
