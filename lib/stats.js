// Integer win-rate percent over all games; 0 when there are none (divide-by-zero safe).
export const winRatePercent = (wins, losses, draws) => {
  const total = wins + losses + draws;
  return total === 0 ? 0 : Math.round((wins / total) * 100);
};

// ISO-8601 week key, e.g. "2026-W28". Standard "nearest Thursday" algorithm.
export const isoWeekKey = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};
