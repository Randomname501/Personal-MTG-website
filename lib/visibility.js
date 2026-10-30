// Deck visibility: 'public' (or missing, for legacy decks), 'friends', 'private'.
const PUBLIC = { $in: ['public', null] };

const idOf = (x) => String(x?._id ?? x);

export function canSeeDeck(deck, viewer) {
  if (!deck.visibility || deck.visibility === 'public') return true;
  if (!viewer) return false;
  const owner = idOf(deck.owner);
  if (owner === idOf(viewer._id)) return true;
  return deck.visibility === 'friends' && (viewer.friends ?? []).some((f) => idOf(f) === owner);
}

// Mongo filter to $and with other conditions.
export function visibleDeckFilter(viewer) {
  if (!viewer) return { visibility: PUBLIC };
  return {
    $or: [
      { owner: viewer._id },
      { visibility: PUBLIC },
      { visibility: 'friends', owner: { $in: viewer.friends ?? [] } },
    ],
  };
}
