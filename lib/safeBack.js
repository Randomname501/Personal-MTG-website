// Only allow local relative redirects (a path starting with a single '/'),
// never an absolute/scheme URL — prevents open redirects.
export const safeBack = (value, fallback) =>
  (typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : fallback);
