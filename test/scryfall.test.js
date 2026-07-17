import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { searchCards, getCardById } from '../lib/scryfall.js';

let server;
let baseUrl;

const NORMAL_CARD = {
  id: 'abc-123',
  name: 'Counterspell',
  mana_cost: '{U}{U}',
  cmc: 2,
  colors: ['U'],
  type_line: 'Instant',
  image_uris: { normal: 'http://img/cs.jpg' },
};
const DFC_CARD = {
  id: 'dfc-1',
  name: 'Delver of Secrets // Insectile Aberration',
  cmc: 1,
  colors: ['U'],
  type_line: 'Creature — Human Wizard // Creature — Insect',
  card_faces: [
    { mana_cost: '{U}', image_uris: { normal: 'http://img/delver.jpg' } },
    { mana_cost: '', image_uris: { normal: 'http://img/aberration.jpg' } },
  ],
};

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/cards/search') {
      const q = u.searchParams.get('q');
      if (q === 'counterspell') return res.end(JSON.stringify({ data: [NORMAL_CARD] }));
      if (q === 'many') {
        const data = Array.from({ length: 30 }, (_, i) => ({
          id: `m${i}`, name: `Card ${i}`, mana_cost: '', cmc: 0, colors: [], type_line: 'Land', image_uris: { normal: '' },
        }));
        return res.end(JSON.stringify({ data }));
      }
      res.statusCode = 404; // Scryfall's no-match behavior
      return res.end(JSON.stringify({ object: 'error', details: 'no cards found' }));
    }
    if (u.pathname === '/cards/abc-123') return res.end(JSON.stringify(NORMAL_CARD));
    if (u.pathname === '/cards/dfc-1') return res.end(JSON.stringify(DFC_CARD));
    res.statusCode = 404;
    res.end(JSON.stringify({ object: 'error' }));
  });
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      process.env.SCRYFALL_API_BASE = baseUrl;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('searchCards normalizes a card into the snapshot shape', async () => {
  const cards = await searchCards('counterspell');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    scryfallId: 'abc-123',
    name: 'Counterspell',
    manaCost: '{U}{U}',
    cmc: 2,
    colors: ['U'],
    typeLine: 'Instant',
    imageUrl: 'http://img/cs.jpg',
  });
});

test('searchCards returns [] when Scryfall 404s on no matches', async () => {
  assert.deepEqual(await searchCards('nomatchxyz'), []);
});

test('searchCards caps results at 20', async () => {
  const cards = await searchCards('many');
  assert.equal(cards.length, 20);
});

test('getCardById pulls mana cost and image from the front face of a DFC', async () => {
  const card = await getCardById('dfc-1');
  assert.equal(card.manaCost, '{U}');
  assert.equal(card.imageUrl, 'http://img/delver.jpg');
  assert.equal(card.cmc, 1);
});
