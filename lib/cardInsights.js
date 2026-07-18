// Pure deck-card analytics for the deck detail page's "Card breakdown".
// Input is a deck's `cards` array; output is bar-ready groups. No I/O.

const LAND_RE = /\bland\b/i;
const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'];
// First whole-word match against typeLine wins; 'Other' is the fallback.
const TYPE_PRIORITY = ['Land', 'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle'];
const TYPE_ORDER = [...TYPE_PRIORITY, 'Other'];

const bucketKey = (cmc) => {
  const n = Math.floor(Number(cmc) || 0);
  return n >= 7 ? '7+' : String(n);
};

const primaryType = (typeLine) => {
  const line = typeLine || '';
  for (const t of TYPE_PRIORITY) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(line)) return t;
  }
  return 'Other';
};

// Attach pct (count relative to the group's max count) to each row.
const withPct = (rows) => {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return rows.map((r) => ({ ...r, pct: max === 0 ? 0 : Math.round((r.count / max) * 100) }));
};

export const getCardInsights = (cards) => {
  const list = Array.isArray(cards) ? cards : [];

  let total = 0;
  let nonlandTotal = 0;
  const curve = new Map(CURVE_BUCKETS.map((b) => [b, 0]));
  const colors = new Map([...MANA_COLORS, 'C'].map((c) => [c, 0]));
  const types = new Map(TYPE_ORDER.map((t) => [t, 0]));

  for (const c of list) {
    const qty = c.quantity || 0;
    total += qty;

    if (LAND_RE.test(c.typeLine || '')) {
      // lands are excluded from the mana curve
    } else {
      nonlandTotal += qty;
      const b = bucketKey(c.cmc);
      curve.set(b, curve.get(b) + qty);
    }

    const cardColors = Array.isArray(c.colors) ? c.colors.filter((x) => MANA_COLORS.includes(x)) : [];
    if (cardColors.length === 0) colors.set('C', colors.get('C') + qty);
    else for (const x of cardColors) colors.set(x, colors.get(x) + qty);

    const t = primaryType(c.typeLine);
    types.set(t, types.get(t) + qty);
  }

  const manaCurve = withPct(CURVE_BUCKETS.map((b) => ({ bucket: b, count: curve.get(b) })));
  const colorRows = withPct([...MANA_COLORS, 'C'].map((x) => ({ color: x, count: colors.get(x) })).filter((r) => r.count > 0));
  const typeRows = withPct(TYPE_ORDER.map((t) => ({ type: t, count: types.get(t) })).filter((r) => r.count > 0));

  return { total, nonlandTotal, manaCurve, colors: colorRows, types: typeRows };
};
