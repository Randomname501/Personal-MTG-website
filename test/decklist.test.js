import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecklist } from '../lib/decklist.js';

test('parses Moxfield-style lines, stripping set codes and collector numbers', () => {
  const { cards, commanders } = parseDecklist('1 Sol Ring (CMR) 263\n4 Lightning Bolt\n2x Island (UNF) 236 *F*');
  assert.deepEqual(cards, [
    { name: 'Sol Ring', quantity: 1 },
    { name: 'Lightning Bolt', quantity: 4 },
    { name: 'Island', quantity: 2 },
  ]);
  assert.deepEqual(commanders, []);
});

test('takes the commander from a Commander section header', () => {
  const { cards, commanders } = parseDecklist('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring');
  assert.deepEqual(commanders, ["Atraxa, Praetors' Voice"]);
  assert.deepEqual(cards, [{ name: 'Sol Ring', quantity: 1 }]);
});

test('takes the commander from an Archidekt [Commander] tag and drops other tags', () => {
  const { cards, commanders } = parseDecklist(
    '1x Krenko, Mob Boss (ddt) 52 [Commander{top}]\n1x Sol Ring (cmr) 263 [Ramp] ^Have,#37d67a^',
  );
  assert.deepEqual(commanders, ['Krenko, Mob Boss']);
  assert.deepEqual(cards, [{ name: 'Sol Ring', quantity: 1 }]);
});

test('keeps both commanders from a Commander section, out of the card list', () => {
  const { cards, commanders } = parseDecklist('Commander\n1 Kodama of the East Tree\n1 Kediss, Emberclaw Familiar\n\nDeck\n1 Sol Ring');
  assert.deepEqual(commanders, ['Kodama of the East Tree', 'Kediss, Emberclaw Familiar']);
  assert.deepEqual(cards, [{ name: 'Sol Ring', quantity: 1 }]);
});

test('keeps both commanders from Archidekt [Commander] tags', () => {
  const { commanders } = parseDecklist('1x Kodama of the East Tree (cmr) 1 [Commander{top}]\n1x Kediss, Emberclaw Familiar (cmr) 2 [Commander{top}]');
  assert.deepEqual(commanders, ['Kodama of the East Tree', 'Kediss, Emberclaw Familiar']);
});

test('a category that only mentions commanders is not a commander', () => {
  const { cards, commanders } = parseDecklist('1x Sol Ring (cmr) 263 [Commander Synergy]\nCommander Synergy\n1 Opt\nCommander (1)\n1 Krenko, Mob Boss');
  assert.deepEqual(commanders, ['Krenko, Mob Boss']);
  assert.deepEqual(cards.map((c) => c.name), ['Sol Ring', 'Opt']);
});

test('finds the Commander tag among several categories', () => {
  const { commanders } = parseDecklist('1x Krenko, Mob Boss (ddt) 52 [Goblins,Commander{top}]');
  assert.deepEqual(commanders, ['Krenko, Mob Boss']);
});

test('skips sideboard and maybeboard sections, comments and blank lines', () => {
  const { cards } = parseDecklist('// my deck\n1 Sol Ring\n\nSideboard\n1 Negate\nMaybeboard\n1 Duress\nDeck\n1 Opt');
  assert.deepEqual(cards.map((c) => c.name), ['Sol Ring', 'Opt']);
});

test('merges repeated names case-insensitively and ignores unparseable lines', () => {
  const { cards } = parseDecklist('1 Opt\n2 opt\nnot a card line\n0 Duress');
  assert.deepEqual(cards, [{ name: 'Opt', quantity: 3 }]);
});

test('handles empty and non-string input', () => {
  assert.deepEqual(parseDecklist(''), { cards: [], commanders: [] });
  assert.deepEqual(parseDecklist(undefined), { cards: [], commanders: [] });
});
