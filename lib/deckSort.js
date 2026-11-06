// The ways a list of decks can be ordered; the first is the default.
export const DECK_SORTS = [
  { value: 'updated-desc', label: 'Recently modified', sort: { updatedAt: -1, _id: -1 } },
  { value: 'updated-asc', label: 'Least recently modified', sort: { updatedAt: 1, _id: 1 } },
  { value: 'name-asc', label: 'Name (A to Z)', sort: { name: 1, _id: 1 } },
  { value: 'name-desc', label: 'Name (Z to A)', sort: { name: -1, _id: -1 } },
];

// Sort names alphabetically, ignoring case.
export const DECK_COLLATION = { locale: 'en', strength: 2 };

export const deckSort = (value) => DECK_SORTS.find((s) => s.value === value) ?? DECK_SORTS[0];
