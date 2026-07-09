import mongoose from 'mongoose';
import { Deck, GameRecord } from '../models/index.js';

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

// Full analytics for one deck: overall record, per-opponent matchups, weekly trend.
export const getDeckStats = async (deckId) => {
  const id = new mongoose.Types.ObjectId(deckId);
  // Sort by creation order: the matchup label tie-break below picks the
  // first-seen spelling for a given opponent, which requires a deterministic
  // order (Mongo's default "natural" order is NOT guaranteed to match
  // insertion order without an explicit sort).
  const records = await GameRecord.find({ deck: id })
    .select('opponentDeck result createdAt')
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const matchupMap = new Map(); // normalized opponent -> { labels, wins, losses, draws }
  const trendMap = new Map(); // isoWeekKey -> { games, wins }

  for (const r of records) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else draws++;

    const original = (r.opponentDeck || '').trim();
    const key = original.toLowerCase();
    let m = matchupMap.get(key);
    if (!m) {
      m = { labels: new Map(), wins: 0, losses: 0, draws: 0 };
      matchupMap.set(key, m);
    }
    m.labels.set(original, (m.labels.get(original) || 0) + 1);
    if (r.result === 'win') m.wins++;
    else if (r.result === 'loss') m.losses++;
    else m.draws++;

    const week = isoWeekKey(new Date(r.createdAt));
    let t = trendMap.get(week);
    if (!t) {
      t = { games: 0, wins: 0 };
      trendMap.set(week, t);
    }
    t.games++;
    if (r.result === 'win') t.wins++;
  }

  const matchups = [...matchupMap.values()]
    .map((m) => {
      // Display the most frequently used original spelling of the opponent name.
      let opponent = '';
      let best = -1;
      for (const [label, count] of m.labels) {
        if (count > best) {
          best = count;
          opponent = label;
        }
      }
      return {
        opponent,
        wins: m.wins,
        losses: m.losses,
        draws: m.draws,
        total: m.wins + m.losses + m.draws,
        winRate: winRatePercent(m.wins, m.losses, m.draws),
      };
    })
    .sort((a, b) => b.total - a.total);

  const trend = [...trendMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week, t]) => ({
      week,
      games: t.games,
      // Trend win rate is wins / games (non-wins passed as "losses").
      winRate: winRatePercent(t.wins, t.games - t.wins, 0),
    }));

  return { wins, losses, draws, total: wins + losses + draws, winRate: winRatePercent(wins, losses, draws), matchups, trend };
};

// A deck must have at least this many games to be eligible as "best deck",
// so a lucky 1-0 deck can't outrank a well-tested one.
const MIN_GAMES_FOR_BEST = 3;

// Account-wide totals across every deck the user owns, plus the best qualifying deck.
export const getUserSummary = async (userId) => {
  const id = new mongoose.Types.ObjectId(userId);
  const decks = await Deck.find({ owner: id }).select('name').lean();
  if (decks.length === 0) {
    return { totalGames: 0, wins: 0, losses: 0, draws: 0, winRate: 0, bestDeck: null };
  }

  const deckIds = decks.map((d) => d._id);
  const records = await GameRecord.find({ deck: { $in: deckIds } }).select('deck result').lean();

  const perDeck = new Map(); // deckId string -> { wins, losses, draws }
  for (const d of decks) perDeck.set(d._id.toString(), { wins: 0, losses: 0, draws: 0 });

  let wins = 0;
  let losses = 0;
  let draws = 0;
  const field = { win: 'wins', loss: 'losses', draw: 'draws' };
  for (const r of records) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else draws++;
    const pd = perDeck.get(r.deck.toString());
    if (pd) pd[field[r.result]]++;
  }

  let bestDeck = null;
  for (const d of decks) {
    const pd = perDeck.get(d._id.toString());
    const total = pd.wins + pd.losses + pd.draws;
    if (total < MIN_GAMES_FOR_BEST) continue;
    const winRate = winRatePercent(pd.wins, pd.losses, pd.draws);
    if (!bestDeck || winRate > bestDeck.winRate) {
      bestDeck = { name: d.name, winRate, total };
    }
  }

  return {
    totalGames: wins + losses + draws,
    wins,
    losses,
    draws,
    winRate: winRatePercent(wins, losses, draws),
    bestDeck,
  };
};
