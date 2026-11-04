import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeckFilters, runDeckAgent } from '../lib/deckAgent.js';

// --- A fake Claude: replays scripted responses and records every request. ---
const fakeClient = (script) => {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, opts) => {
          // Snapshot: the agent keeps mutating its messages array after the call.
          calls.push({ params: structuredClone(params), opts });
          if (!script.length) throw new Error('fake client: script exhausted');
          return script.shift();
        },
      },
    },
  };
};

const searchCall = (id, query) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'search_cards', input: { query } }],
});
const recommendCall = (id, cards) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'recommend_cards', input: { cards } }],
});
const endTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

const card = (scryfallId, name) => ({
  scryfallId, name, manaCost: '{G}', cmc: 1, colors: ['G'], typeLine: 'Creature — Elf',
  imageUrl: `http://img/${scryfallId}.jpg`, oracleText: '{T}: Add {G}.', priceUsd: '0.25',
});
const ELVES = card('elves-1', 'Llanowar Elves');
const MYSTIC = card('mystic-1', 'Elvish Mystic');

const DECK = {
  format: 'Commander',
  colors: ['G', 'B'],
  commander: 'Meren of Clan Nel Toth',
  cards: [{ scryfallId: 'mystic-1', name: 'Elvish Mystic', quantity: 1 }],
};

// A search fn that records queries and returns fixed cards.
const fakeSearch = (cards = [ELVES, MYSTIC]) => {
  const queries = [];
  const fn = async (q) => { queries.push(q); return cards; };
  fn.queries = queries;
  return fn;
};

// --- withDeckFilters ---
// Claude's query goes in parentheses so a top-level `or` can't escape our filters.

test('withDeckFilters appends deck colors and format', () => {
  assert.equal(withDeckFilters('t:creature', { colors: ['G', 'B'], format: 'Commander' }), '(t:creature) id<=gb f:commander');
});

test('withDeckFilters keeps a top-level or inside the filters', () => {
  assert.equal(withDeckFilters('t:elf or t:druid', { colors: ['G'], format: 'Modern' }), '(t:elf or t:druid) id<=g f:modern');
});

// Scryfall ANDs filters, so always appending is safe: a narrower identity Claude
// wrote still wins, and a wider one (id>=wubrg) can't sneak off-color cards in.
test('withDeckFilters always enforces the deck identity', () => {
  assert.equal(withDeckFilters('id>=wubrg t:elf', { colors: ['G', 'B'], format: 'Other' }), '(id>=wubrg t:elf) id<=gb');
});

test('withDeckFilters leaves query alone when deck has no colors and no Scryfall format', () => {
  assert.equal(withDeckFilters('t:elf', { colors: [], format: 'Limited' }), 't:elf');
  assert.equal(withDeckFilters('t:elf', { colors: [], format: 'Standard' }), '(t:elf) f:standard');
});

// --- runDeckAgent ---

test('search then recommend then end_turn', async () => {
  const client = fakeClient([
    searchCall('t1', 't:elf o:"add {G}"'),
    recommendCall('t2', [{ scryfallId: 'elves-1', reason: 'One-drop ramp' }]),
    endTurn('Here you go'),
  ]);
  const search = fakeSearch();
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'ramp?', search });

  assert.equal(out.reply, 'Here you go');
  assert.equal(out.note, null);
  assert.equal(out.recommendations.length, 1);
  assert.equal(out.recommendations[0].scryfallId, 'elves-1');
  assert.equal(out.recommendations[0].name, 'Llanowar Elves');
  assert.equal(out.recommendations[0].reason, 'One-drop ramp');
  assert.deepEqual(search.queries, ['(t:elf o:"add {G}") id<=gb f:commander']);

  const params = client.calls[0].params;
  assert.equal(params.model, 'claude-opus-5-5');
  assert.ok(params.betas.includes('server-side-fallback-2026-07-01'));
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.match(JSON.stringify(params.messages[0]), /Meren of Clan Nel Toth/);
  assert.match(JSON.stringify(params.messages[0]), /1 Elvish Mystic/);
  assert.equal(client.calls.length, 3);
});

test('made-up ids are dropped', async () => {
  const client = fakeClient([
    searchCall('t1', 't:elf'),
    recommendCall('t2', [{ scryfallId: 'nope', reason: 'hallucinated' }]),
    endTurn('ok'),
  ]);
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search: fakeSearch() });
  assert.deepEqual(out.recommendations, []);
});

// A search returns one printing per card, so the deck may hold the same card
// under a different scryfallId (e.g. from a decklist import).
test('a card in the deck under another printing is dropped', async () => {
  const otherPrinting = card('mystic-2', 'Elvish Mystic');
  const client = fakeClient([
    searchCall('t1', 't:elf'),
    recommendCall('t2', [{ scryfallId: 'mystic-2', reason: 'same card, new printing' }]),
    endTurn('ok'),
  ]);
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search: fakeSearch([otherPrinting]) });
  assert.deepEqual(out.recommendations, []);
});

test('cards already in the deck or the commander are dropped', async () => {
  const MEREN = card('meren-1', 'Meren of Clan Nel Toth');
  const client = fakeClient([
    searchCall('t1', 't:elf'),
    recommendCall('t2', [
      { scryfallId: 'mystic-1', reason: 'already in deck' },
      { scryfallId: 'meren-1', reason: 'is the commander' },
      { scryfallId: 'elves-1', reason: 'fine' },
    ]),
    endTurn('ok'),
  ]);
  const out = await runDeckAgent({
    client, deck: DECK, messages: [], question: 'q', search: fakeSearch([ELVES, MYSTIC, MEREN]),
  });
  assert.deepEqual(out.recommendations.map((r) => r.scryfallId), ['elves-1']);
});

test("recommendation from an earlier turn's search is kept", async () => {
  // First question: a search happens and its result lands in the transcript.
  const first = await runDeckAgent({
    client: fakeClient([searchCall('t1', 't:elf'), endTurn('found some')]),
    deck: DECK, messages: [], question: 'q1', search: fakeSearch(),
  });
  // Follow-up: Claude recommends straight away, without a new search.
  const search = fakeSearch();
  const out = await runDeckAgent({
    client: fakeClient([recommendCall('t2', [{ scryfallId: 'elves-1', reason: 'from before' }]), endTurn('ok')]),
    deck: DECK, messages: first.messages, question: 'q2', search,
  });
  assert.deepEqual(out.recommendations.map((r) => r.scryfallId), ['elves-1']);
  assert.equal(search.queries.length, 0);
});

test('search failure becomes an error tool_result', async () => {
  const client = fakeClient([searchCall('t1', 't:elf'), endTurn('Scryfall seems down')]);
  const search = async () => { throw new Error('Scryfall search failed: 503'); };
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search });

  const sent = client.calls[1].params.messages.at(-1);
  assert.equal(sent.role, 'user');
  assert.equal(sent.content[0].type, 'tool_result');
  assert.equal(sent.content[0].is_error, true);
  assert.equal(out.reply, 'Scryfall seems down');
});

test('turn limit still answers pending tool calls', async () => {
  const script = Array.from({ length: 5 }, (_, i) => searchCall(`t${i}`, 't:elf'));
  const client = fakeClient(script);
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search: fakeSearch() });

  assert.equal(out.note, 'Stopped after 5 steps.');
  assert.equal(client.calls.length, 5);
  const last = out.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.content.every((b) => b.type === 'tool_result'));
  assert.equal(last.content[0].tool_use_id, 't4');
});

test('refusal leaves transcript unchanged', async () => {
  const before = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
  const client = fakeClient([{ stop_reason: 'refusal', content: [] }]);
  const out = await runDeckAgent({
    client, deck: DECK, messages: structuredClone(before), question: 'q', search: fakeSearch(),
  });
  assert.deepEqual(out.messages, before);
  assert.equal(out.note, "Claude couldn't help with that one.");
});

test('assistant content is appended unchanged', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  const client = fakeClient([{ stop_reason: 'end_turn', content: [thinking, { type: 'text', text: 'hi' }] }]);
  const out = await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search: fakeSearch() });
  assert.deepEqual(out.messages.at(-1), { role: 'assistant', content: [thinking, { type: 'text', text: 'hi' }] });
});

// The API rejects earlier thinking blocks if the system prompt changes between
// questions, so the deck (which changes as cards are added) must not live there.
test('system prompt stays identical as the deck changes; each question carries a fresh deck snapshot', async () => {
  const first = fakeClient([endTurn('one')]);
  const out1 = await runDeckAgent({ client: first, deck: DECK, messages: [], question: 'q1', search: fakeSearch() });

  const grown = { ...DECK, cards: [...DECK.cards, { scryfallId: 'elves-1', name: 'Llanowar Elves', quantity: 1 }] };
  const second = fakeClient([endTurn('two')]);
  await runDeckAgent({ client: second, deck: grown, messages: out1.messages, question: 'q2', search: fakeSearch() });

  const [p1, p2] = [first.calls[0].params, second.calls[0].params];
  assert.equal(p1.system, p2.system);
  assert.doesNotMatch(p1.system, /Elvish Mystic/);
  // Earlier turns are replayed exactly as they were.
  assert.deepEqual(p2.messages.slice(0, out1.messages.length), out1.messages);
  // The new question's message holds the current deck and the question.
  const newest = JSON.stringify(p2.messages.at(-1));
  assert.match(newest, /1 Llanowar Elves/);
  assert.match(newest, /Meren of Clan Nel Toth/);
  assert.match(newest, /q2/);
});

test('the abort signal is passed to every Claude call', async () => {
  const signal = AbortSignal.timeout(60_000);
  const client = fakeClient([searchCall('t1', 't:elf'), endTurn('ok')]);
  await runDeckAgent({ client, deck: DECK, messages: [], question: 'q', search: fakeSearch(), signal });
  assert.ok(client.calls.every((c) => c.opts.signal === signal));
});
