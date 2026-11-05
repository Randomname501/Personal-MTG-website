// Parse a pasted text decklist (Moxfield / Archidekt "copy as text" exports)
// into { cards: [{ name, quantity }], commanders: [name] }. Pure; no I/O.
//
// Card lines look like `1 Sol Ring`, `1x Sol Ring (cmr) 263 [Ramp] ^Have^ *F*`.
// Lines without a leading quantity are section headers: "Commander" marks the
// commander, sideboard/maybeboard sections are skipped, anything else is main.
const CARD_LINE = /^(\d+)x?\s+(.+)$/i;
const SKIP_SECTION = /^(sideboard|maybeboard|considering|tokens)\b/i;
const COMMANDER_SECTION = /^commanders?(?:\s*\(\d+\))?$/i;
const COMMANDER_TAG = /^commanders?(?:\{.*\})?$/i;

export const parseDecklist = (text) => {
  const totals = new Map(); // lowercased name -> { name, quantity }
  const commanders = [];
  let section = 'main';

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    const m = line.match(CARD_LINE);
    if (!m) {
      if (COMMANDER_SECTION.test(line)) section = 'commander';
      else if (SKIP_SECTION.test(line)) section = 'skip';
      else section = 'main';
      continue;
    }
    if (section === 'skip') continue;

    const quantity = Number(m[1]);
    const rest = m[2];
    // Everything from the set code, tags, or markers onward is not part of the name.
    const name = rest.split(/\s+[([^*]/)[0].trim();
    if (!name || quantity < 1) continue;

    const taggedCommander = [...rest.matchAll(/\[([^\]]*)\]/g)].some((t) => t[1].split(',').some((tag) => COMMANDER_TAG.test(tag.trim())));
    if (section === 'commander' || taggedCommander) {
      commanders.push(name);
      continue;
    }

    const key = name.toLowerCase();
    const entry = totals.get(key);
    if (entry) entry.quantity += quantity;
    else totals.set(key, { name, quantity });
  }

  return { cards: [...totals.values()], commanders };
};
