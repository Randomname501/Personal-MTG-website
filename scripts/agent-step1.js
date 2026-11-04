// STEP 1 — Hello Claude.
// The smallest possible conversation: we send one message, Claude sends one back.
// Run: node --env-file=.env scripts/agent-step1.js

import Anthropic from '@anthropic-ai/sdk';

// The client reads ANTHROPIC_API_KEY from the environment (our .env file).
const client = new Anthropic();

// One API call. Everything an "agent" does is built out of calls like this.
const response = await client.messages.create({
  model: 'claude-opus-5-5', // which Claude model answers
  max_tokens: 16000, // upper limit on how long the reply may be
  output_config: { effort: 'low' }, // how hard it thinks: low is plenty for chat
  // The conversation so far. The API remembers nothing between calls —
  // we always send the whole history ourselves. Right now it's one message.
  messages: [
    { role: 'user', content: 'Suggest one green ramp card for Commander, in one sentence.' },
  ],
});

// Why did Claude stop? "end_turn" means "I'm done talking."
// (In step 2 we'll meet "tool_use", which means "please run a tool for me".)
console.log('stop_reason:', response.stop_reason);

// The reply is a list of "content blocks", not a single string.
// Usually just a "text" block. On harder questions Claude may first add a "thinking"
// block (its text is hidden by default) — it decides for itself whether to think.
console.log('block types:', response.content.map((block) => block.type));

for (const block of response.content) {
  if (block.type === 'text') console.log('\nClaude says:', block.text);
}

// Tokens are how usage is billed (roughly ¾ of a word each).
console.log('\nusage:', response.usage);
