import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gamesToCsv } from '../lib/gameCsv.js';

const HEADER = '﻿"Date","Deck","Opponents","Result"\r\n';
const game = (fields) => ({
  createdAt: new Date('2026-11-06T12:00:00Z'),
  deck: { name: 'Azorius' },
  opponents: [{ name: 'Ana', deck: 'Burn' }],
  result: 'win',
  ...fields,
});

test('an empty history is just the header row', () => {
  assert.equal(gamesToCsv([]), HEADER);
});

test('writes one row per game with every opponent in one cell', () => {
  const opponents = [{ name: 'Ana', deck: 'Burn' }, { name: 'Bo', deck: 'Tron' }];
  assert.equal(gamesToCsv([game({ opponents })]), `${HEADER}"2026-11-06","Azorius","Ana (Burn), Bo (Tron)","win"\r\n`);
});

test('leaves a deleted deck and missing opponents blank', () => {
  assert.equal(gamesToCsv([game({ deck: null, opponents: [] })]), `${HEADER}"2026-11-06","","","win"\r\n`);
});

test('escapes quotes and keeps commas and line breaks inside the cell', () => {
  const csv = gamesToCsv([game({ deck: { name: 'The "Best", Deck\nEver' } })]);
  assert.ok(csv.includes('"The ""Best"", Deck\nEver"'));
});

test('neutralizes names a spreadsheet would run as a formula', () => {
  for (const name of ['=1+1', '+1', '-1', '@SUM(A1)']) {
    assert.ok(gamesToCsv([game({ deck: { name } })]).includes(`"'${name}"`));
  }
});
