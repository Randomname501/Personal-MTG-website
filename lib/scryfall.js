// Isolated Scryfall client. Base URL is read at call time so tests can point it
// at a local fake server via SCRYFALL_API_BASE.
const base = () => process.env.SCRYFALL_API_BASE || 'https://api.scryfall.com';

// Scryfall asks callers to send an Accept header and a descriptive User-Agent.
const HEADERS = { Accept: 'application/json', 'User-Agent': 'PersonalMTGTracker/1.0' };

// Normalize a raw Scryfall card into our stored snapshot shape. Double-faced cards
// carry mana cost / image on card_faces[0] rather than the top level.
const normalizeCard = (raw) => {
  const face = Array.isArray(raw.card_faces) ? raw.card_faces[0] : undefined;
  return {
    scryfallId: raw.id,
    name: raw.name,
    manaCost: raw.mana_cost ?? face?.mana_cost ?? '',
    cmc: raw.cmc ?? 0,
    colors: raw.colors ?? [],
    typeLine: raw.type_line ?? '',
    imageUrl: raw.image_uris?.normal ?? face?.image_uris?.normal ?? '',
  };
};

// Search cards; returns up to 20 normalized cards. Scryfall replies 404 when a
// search has no matches — treat that as empty results, not an error.
export const searchCards = async (query) => {
  const res = await fetch(`${base()}/cards/search?q=${encodeURIComponent(query)}`, { headers: HEADERS });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Scryfall search failed: ${res.status}`);
  const body = await res.json();
  return (body.data ?? []).slice(0, 20).map(normalizeCard);
};

// Fetch a single card by Scryfall id and normalize it. Throws on a non-OK response.
export const getCardById = async (id) => {
  const res = await fetch(`${base()}/cards/${encodeURIComponent(id)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Scryfall card fetch failed: ${res.status}`);
  return normalizeCard(await res.json());
};
