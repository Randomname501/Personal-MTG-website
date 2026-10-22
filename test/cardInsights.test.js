import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCardInsights, groupCards, withoutCommander } from '../lib/cardInsights.js';

// Minimal card with sensible defaults; override per case.
const card = (over) => ({ quantity: 1, cmc: 0, colors: [], typeLine: '', ...over });

test('empty deck returns zeros and 8 zeroed curve buckets', () => {
  const r = getCardInsights([]);
  assert.equal(r.total, 0);
  assert.equal(r.nonlandTotal, 0);
  assert.equal(r.manaCurve.length, 8);
  assert.ok(r.manaCurve.every((b) => b.count === 0 && b.pct === 0));
  assert.deepEqual(r.colors, []);
  assert.deepEqual(r.types, []);
});

test('undefined input is treated as empty', () => {
  const r = getCardInsights(undefined);
  assert.equal(r.total, 0);
  assert.equal(r.manaCurve.length, 8);
});

test('mana curve excludes lands, groups 7+, weights by quantity', () => {
  const r = getCardInsights([
    card({ typeLine: 'Basic Land — Island', cmc: 0, quantity: 10 }),
    card({ typeLine: 'Creature — Elf', cmc: 1, quantity: 4 }),
    card({ typeLine: 'Sorcery', cmc: 9, quantity: 1 }),
  ]);
  assert.equal(r.total, 15);
  assert.equal(r.nonlandTotal, 5);
  const byBucket = Object.fromEntries(r.manaCurve.map((b) => [b.bucket, b.count]));
  assert.equal(byBucket['0'], 0); // the Island is a land, excluded from the curve
  assert.equal(byBucket['1'], 4);
  assert.equal(byBucket['7+'], 1); // cmc 9
});

test('colors count each color of a multicolor card; colorless to C; weighted; only >0 in WUBRG C order', () => {
  const r = getCardInsights([
    card({ colors: ['U', 'B'], typeLine: 'Creature', quantity: 2 }),
    card({ colors: [], typeLine: 'Artifact', quantity: 3 }),
  ]);
  const byColor = Object.fromEntries(r.colors.map((c) => [c.color, c.count]));
  assert.equal(byColor.U, 2);
  assert.equal(byColor.B, 2);
  assert.equal(byColor.C, 3);
  assert.equal(byColor.W, undefined); // zero-count colors omitted
  assert.deepEqual(r.colors.map((c) => c.color), ['U', 'B', 'C']);
});

test('colors exclude lands', () => {
  const r = getCardInsights([
    card({ colors: ['U'], typeLine: 'Creature', quantity: 3 }),
    card({ colors: [], typeLine: 'Basic Land — Island', quantity: 20 }),
  ]);
  assert.equal(r.colors.length, 1);
  assert.equal(r.colors[0].color, 'U');
  assert.equal(r.colors[0].count, 3);
  assert.equal(r.colors[0].pct, 100);
  assert.ok(!r.colors.some((c) => c.color === 'C'));
});

test('types use priority so each card counts once and the counts sum to total', () => {
  const r = getCardInsights([
    card({ typeLine: 'Artifact Creature — Golem' }),      // Creature (beats Artifact)
    card({ typeLine: 'Artifact Land' }),                  // Land (beats Artifact)
    card({ typeLine: 'Legendary Planeswalker — Jace' }),  // Planeswalker
    card({ typeLine: 'Snow Enchantment' }),               // Enchantment
    card({ typeLine: 'Weird Frame — Thing' }),            // Other (no match)
  ]);
  const byType = Object.fromEntries(r.types.map((t) => [t.type, t.count]));
  assert.equal(byType.Creature, 1);
  assert.equal(byType.Land, 1);
  assert.equal(byType.Planeswalker, 1);
  assert.equal(byType.Enchantment, 1);
  assert.equal(byType.Other, 1);
  assert.equal(r.types.reduce((s, t) => s + t.count, 0), r.total);
});

test('type priority chain: Instant, Sorcery, Artifact, Battle, Enchantment each land standalone', () => {
  const r = getCardInsights([
    card({ typeLine: 'Instant' }),
    card({ typeLine: 'Sorcery' }),
    card({ typeLine: 'Artifact — Equipment' }),
    card({ typeLine: 'Battle — Siege' }),
    card({ typeLine: 'Enchantment — Aura' }),
  ]);
  const byType = Object.fromEntries(r.types.map((t) => [t.type, t.count]));
  assert.equal(byType.Instant, 1);
  assert.equal(byType.Sorcery, 1);
  assert.equal(byType.Artifact, 1);
  assert.equal(byType.Battle, 1);
  assert.equal(byType.Enchantment, 1);
  assert.equal(r.types.reduce((s, t) => s + t.count, 0), 5);
});

test('pct scales each group to its own max, with no divide-by-zero on empty buckets', () => {
  const r = getCardInsights([
    card({ typeLine: 'Creature', cmc: 1, quantity: 4 }),
    card({ typeLine: 'Creature', cmc: 2, quantity: 2 }),
  ]);
  const pctByBucket = Object.fromEntries(r.manaCurve.map((b) => [b.bucket, b.pct]));
  assert.equal(pctByBucket['1'], 100); // max bucket
  assert.equal(pctByBucket['2'], 50);
  assert.equal(pctByBucket['0'], 0); // empty bucket, no NaN
});

test('groupCards type mode orders groups (lands last) and sorts by cmc then name', () => {
  const g = groupCards([
    card({ name: 'Island', typeLine: 'Basic Land — Island', quantity: 30 }),
    card({ name: 'Zebra', typeLine: 'Creature — Zebra', cmc: 2 }),
    card({ name: 'Ape', typeLine: 'Creature — Ape', cmc: 2, quantity: 2 }),
    card({ name: 'Elf', typeLine: 'Creature — Elf', cmc: 1 }),
    card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 }),
  ]);
  assert.deepEqual(g.map((x) => x.label), ['Creatures', 'Instants', 'Lands']);
  assert.deepEqual(g[0].cards.map((c) => c.name), ['Elf', 'Ape', 'Zebra']);
  assert.equal(g[0].count, 4);
  assert.equal(g[2].count, 30);
});

test('groupCards cmc mode buckets nonlands 0..7+, lands last, sorted by name, empties dropped', () => {
  const g = groupCards([
    card({ name: 'Forest', typeLine: 'Basic Land — Forest', quantity: 10 }),
    card({ name: 'Zap', typeLine: 'Instant', cmc: 1 }),
    card({ name: 'Arrow', typeLine: 'Instant', cmc: 1, quantity: 2 }),
    card({ name: 'Emrakul', typeLine: 'Legendary Creature — Eldrazi', cmc: 15 }),
    card({ name: 'Ornithopter', typeLine: 'Artifact Creature — Thopter', cmc: 0 }),
  ], { mode: 'cmc' });
  assert.deepEqual(g.map((x) => x.label), ['0', '1', '7+', 'Lands']);
  assert.deepEqual(g[1].cards.map((c) => c.name), ['Arrow', 'Zap']);
  assert.equal(g[1].count, 3);
  assert.equal(g[3].count, 10);
});

test('groupCards puts a named commander first and omits it when there is no name', () => {
  const cards = [card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 })];
  const withCmdr = groupCards(cards, { commander: { name: 'Atraxa', imageUrl: 'http://img/a.jpg' } });
  assert.equal(withCmdr[0].label, 'Commander');
  assert.equal(withCmdr[0].count, 1);
  assert.deepEqual(withCmdr[0].cards, [{ name: 'Atraxa', imageUrl: 'http://img/a.jpg', quantity: 1 }]);
  assert.equal(withCmdr[1].label, 'Instants');

  assert.deepEqual(groupCards(cards, { commander: { name: '', imageUrl: '' } }).map((x) => x.label), ['Instants']);
  assert.deepEqual(groupCards([], { mode: 'cmc', commander: { name: 'Atraxa' } }).map((x) => x.label), ['Commander']);
});

test('groupCards falls back to type mode and treats non-arrays as empty', () => {
  const cards = [card({ name: 'Bolt', typeLine: 'Instant', cmc: 1 })];
  assert.deepEqual(groupCards(cards, { mode: 'color' }).map((x) => x.label), ['Instants']);
  assert.deepEqual(groupCards(undefined), []);
});

test('withoutCommander drops one copy of the commander by name, case-insensitively', () => {
  const cards = [card({ name: "Atraxa, Praetors' Voice" }), card({ name: 'Sol Ring', quantity: 2 })];
  assert.deepEqual(withoutCommander(cards, "atraxa, praetors' voice").map((c) => c.name), ['Sol Ring']);
  assert.equal(withoutCommander(cards, 'Sol Ring').find((c) => c.name === 'Sol Ring').quantity, 1);
  assert.equal(withoutCommander(cards, '').length, 2);
  assert.deepEqual(withoutCommander(undefined, 'X'), []);
});
