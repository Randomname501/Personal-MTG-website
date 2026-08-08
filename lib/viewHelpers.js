// Handlebars view helpers, kept in one place so they're unit-testable and
// registered from a single import in app.js.

// Integer percentage of part within whole; 0 when whole is 0 (used for bar widths).
export const percent = (part, whole) => (whole ? Math.round((Number(part) / Number(whole)) * 100) : 0);

// String-equality helper for template subexpressions, e.g. selecting an <option>.
// Compares stringified values so an ObjectId matches its string form.
export const eq = (a, b) => String(a) === String(b);

// Renders a game's opponents as "Ana (Krenko), Ben (Yuriko)". An opponent with
// no name shows the deck alone — that's how legacy records (which stored only a
// deck string) arrive via opponentList, and they must read as they always have.
export const formatOpponents = (opponents) => {
  if (!opponents?.length) return '—';
  return opponents
    .map(({ name, deck }) => ((name || '').trim() ? `${name} (${deck})` : deck))
    .join(', ');
};

// Friendly date like "Jul 14, 2026"; empty string for missing/invalid input.
export const formatDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
};
