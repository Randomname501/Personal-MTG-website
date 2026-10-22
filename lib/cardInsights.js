// Pure deck-card analytics for the deck detail page's "Card breakdown".
// Input is a deck's `cards` array; output is bar-ready groups. No I/O.

const LAND_RE = /\bland\b/i;
const MANA_COLORS = ['W', 'U', 'B', 'R', 'G'];
const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'];
// First whole-word match against typeLine wins; 'Other' is the fallback.
const TYPE_PRIORITY = ['Land', 'Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle'];
const TYPE_ORDER = [...TYPE_PRIORITY, 'Other'];
const TYPE_MATCHERS = TYPE_PRIORITY.map((t) => [t, new RegExp(`\\b${t}\\b`, 'i')]);
const COLOR_ORDER = [...MANA_COLORS, 'C'];

const bucketKey = (cmc) => {
  const n = Math.floor(Number(cmc) || 0);
  return n >= 7 ? '7+' : String(n);
};

const primaryType = (typeLine) => {
  const line = typeLine || '';
  for (const [t, re] of TYPE_MATCHERS) {
    if (re.test(line)) return t;
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
  const colors = new Map(COLOR_ORDER.map((c) => [c, 0]));
  const types = new Map(TYPE_ORDER.map((t) => [t, 0]));

  for (const c of list) {
    const qty = c.quantity || 0;
    total += qty;

    const isLand = LAND_RE.test(c.typeLine || '');
    if (!isLand) {
      nonlandTotal += qty;
      const b = bucketKey(c.cmc);
      curve.set(b, curve.get(b) + qty);

      const cardColors = Array.isArray(c.colors) ? c.colors.filter((x) => MANA_COLORS.includes(x)) : [];
      if (cardColors.length === 0) colors.set('C', colors.get('C') + qty);
      else for (const x of cardColors) colors.set(x, colors.get(x) + qty);
    }

    const t = primaryType(c.typeLine);
    types.set(t, types.get(t) + qty);
  }

  const manaCurve = withPct(CURVE_BUCKETS.map((b) => ({ bucket: b, count: curve.get(b) })));
  const colorRows = withPct(COLOR_ORDER.map((x) => ({ color: x, count: colors.get(x) })).filter((r) => r.count > 0));
  const typeRows = withPct(TYPE_ORDER.map((t) => ({ type: t, count: types.get(t) })).filter((r) => r.count > 0));

  return { total, nonlandTotal, manaCurve, colors: colorRows, types: typeRows };
};

// Moxfield-style decklist groups: by primary type (lands last, sorted by mana
// value then name) or by mana value (curve buckets, lands last, sorted by name).
// A named commander is prepended as its own group. Counts are quantity-weighted.
const GROUP_ORDER = ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Battle', 'Other', 'Land'];
const GROUP_LABELS = { Creature: 'Creatures', Planeswalker: 'Planeswalkers', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artifacts', Enchantment: 'Enchantments', Battle: 'Battles', Other: 'Other', Land: 'Lands' };

const byName = (a, b) => a.name.localeCompare(b.name);
const byCmcThenName = (a, b) => (a.cmc || 0) - (b.cmc || 0) || byName(a, b);

export const groupCards = (cards, { mode = 'type', commander } = {}) => {
  const list = Array.isArray(cards) ? cards : [];
  const byCmc = mode === 'cmc';
  const keys = byCmc ? [...CURVE_BUCKETS, 'Land'] : GROUP_ORDER;
  const keyOf = byCmc
    ? (c) => (LAND_RE.test(c.typeLine || '') ? 'Land' : bucketKey(c.cmc))
    : (c) => primaryType(c.typeLine);

  const groups = new Map(keys.map((k) => [k, []]));
  for (const c of list) groups.get(keyOf(c)).push(c);

  const rows = keys.filter((k) => groups.get(k).length).map((k) => {
    const cs = groups.get(k).sort(byCmc ? byName : byCmcThenName);
    return { label: GROUP_LABELS[k] ?? k, count: cs.reduce((s, c) => s + (c.quantity || 0), 0), cards: cs };
  });

  if (commander?.name) {
    rows.unshift({ label: 'Commander', count: 1, cards: [{ name: commander.name, imageUrl: commander.imageUrl, quantity: 1 }] });
  }
  return rows;
};

// The commander is stored apart from `cards`, but a deck can also hold it as a
// card (added before being set as commander, or imported from an older list).
// Drop one copy by name so the commander is shown and counted only once.
export const withoutCommander = (cards, commanderName) => {
  const list = Array.isArray(cards) ? cards : [];
  const target = (commanderName || '').toLowerCase();
  const i = target ? list.findIndex((c) => (c.name || '').toLowerCase() === target) : -1;
  if (i === -1) return list;
  const rest = list.filter((_, j) => j !== i);
  return list[i].quantity > 1 ? [...rest, { ...list[i], quantity: list[i].quantity - 1 }] : rest;
};
