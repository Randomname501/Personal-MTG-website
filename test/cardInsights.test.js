import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCardInsights } from '../lib/cardInsights.js';

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
