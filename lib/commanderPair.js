// Which two cards can be commanders of one deck. Reads rules text, not Scryfall's
// keywords: those say "Partner" for every variant, including "Partner with".

// 'partner', 'partner with <name>', 'partner—<variant>', or undefined.
const partnerAbility = (card) => card.oracleText.match(/^Partner\b(?:(?: with |—)[^(\n]+)?/im)?.[0].trim().toLowerCase();

const frontName = (card) => card.name.split(' // ')[0].toLowerCase();

// One-way pairings. A Doctor must have no creature type besides Time Lord Doctor.
const brings = (a, b) =>
  (/^Choose a Background\b/im.test(a.oracleText) && /^Legendary .*\bBackground\b/.test(b.typeLine)) ||
  (/^Doctor's companion\b/im.test(a.oracleText) && /^Legendary .*— Time Lord Doctor(?: \/\/|$)/.test(b.typeLine));

export const canPair = (a, b) => {
  if (a.name === b.name) return false;
  const [abilityA, abilityB] = [partnerAbility(a), partnerAbility(b)];
  const namedEachOther = abilityA === `partner with ${frontName(b)}` && abilityB === `partner with ${frontName(a)}`;
  const sameAbility = Boolean(abilityA) && abilityA === abilityB && !abilityA.startsWith('partner with ');
  // Not either/or: Amy Pond has Partner with and Doctor's companion.
  return namedEachOther || sameAbility || brings(a, b) || brings(b, a);
};

// Why this pair can't be saved, or null if it can. A card that couldn't be looked
// up (null) is refused too: a pair that can't be checked isn't allowed through.
export const pairRefusal = (a, b) => {
  if (!a || !b) return "Couldn't check those two commanders. Check both names and try again.";
  return canPair(a, b) ? null : `${a.name} and ${b.name} can't be commanders together.`;
};
