import { formatOpponents } from './viewHelpers.js';

// Spreadsheets run a cell starting with these as a formula, and deck and opponent
// names are free text, so a leading quote keeps them as plain text.
const cell = (value) => {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${text.replaceAll('"', '""')}"`;
};

// Games as CSV, opponents already normalized by opponentList(). The byte order mark
// tells Excel the file is UTF-8, so accented names survive.
export const gamesToCsv = (games) => {
  const rows = games.map((g) => [
    g.createdAt.toISOString().slice(0, 10),
    g.deck?.name ?? '',
    g.opponents.length ? formatOpponents(g.opponents) : '',
    g.result,
  ]);
  const lines = [['Date', 'Deck', 'Opponents', 'Result'], ...rows].map((row) => row.map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
};
