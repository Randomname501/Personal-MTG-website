import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecklist } from '../lib/decklist.js';

test('parses Moxfield-style lines, stripping set codes and collector numbers', () => {
  const { cards, commander } = parseDecklist('1 Sol Ring (CMR) 263\n4 Lightning Bolt\n2x Island (UNF) 236 *F*');
  assert.deepEqual(cards, [
    { name: 'Sol Ring', quantity: 1 },
    { name: 'Lightning Bolt', quantity: 4 },
    { name: 'Island', quantity: 2 },
  ]);
  assert.equal(commander, null);
});

test('takes the commander from a Commander section header', () => {
  const { cards, commander } = parseDecklist('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring');
  assert.equal(commander, "Atraxa, Praetors' Voice");
  assert.deepEqual(cards, [{ name: 'Sol Ring', quantity: 1 }]);
});

test('takes the commander from an Archidekt [Commander] tag and drops other tags', () => {
  const { cards, commander } = parseDecklist(
    '1x Krenko, Mob Boss (ddt) 52 [Commander{top}]\n1x Sol Ring (cmr) 263 [Ramp] ^Have,#37d67a^',
  );
  assert.equal(commander, 'Krenko, Mob Boss');
  assert.deepEqual(cards, [{ name: 'Sol Ring', quantity: 1 }]);
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
  assert.deepEqual(parseDecklist(''), { cards: [], commander: null });
  assert.deepEqual(parseDecklist(undefined), { cards: [], commander: null });
});
