import { GameRecord } from '../models/index.js';
import { canSeeDeck } from './visibility.js';

// $sum expressions that count each result type within a $group stage.
const resultCounts = {
  wins: { $sum: { $cond: [{ $eq: ['$result', 'win'] }, 1, 0] } },
  losses: { $sum: { $cond: [{ $eq: ['$result', 'loss'] }, 1, 0] } },
  draws: { $sum: { $cond: [{ $eq: ['$result', 'draw'] }, 1, 0] } },
};

// Numeric ratio used only for sorting (0 losses sorts highest).
const numericRatio = (wins, losses) =>
  losses === 0 ? (wins === 0 ? 0 : Infinity) : wins / losses;

// Display string for the templates; handles divide-by-zero.
const formatRatio = (wins, losses) => {
  if (wins === 0 && losses === 0) return '—';
  if (losses === 0) return '∞';
  return (wins / losses).toFixed(2);
};

// Medal class for the top three; everyone else renders untiered.
const MEDAL_TIERS = ['gold', 'silver', 'bronze'];

// Sort by wins desc, then ratio desc, then fewer losses; attach 1-based rank,
// the formatted ratio, the medal tier, and the game total the card's meter bar
// divides by. Mutates-and-returns a fresh array of plain rows.
export const rankRows = (rows) =>
  rows
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      const ratioDiff = numericRatio(b.wins, b.losses) - numericRatio(a.wins, a.losses);
      if (ratioDiff !== 0) return ratioDiff;
      return a.losses - b.losses;
    })
    .map((row, i) => ({
      ...row,
      rank: i + 1,
      winLossRatio: formatRatio(row.wins, row.losses),
      tier: MEDAL_TIERS[i] ?? '',
      total: row.wins + row.losses + (row.draws ?? 0),
    }));

// Per-player leaderboard rows: { rank, username, wins, losses, winLossRatio }.
// `match` narrows the games counted (e.g. { playgroup: id }).
export const getPlayerLeaderboard = async (match = {}) => {
  const rows = await GameRecord.aggregate([
    { $match: match },
    { $group: { _id: '$user', ...resultCounts } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        username: '$user.username',
        wins: 1,
        losses: 1,
        draws: 1,
      },
    },
  ]);

  return rankRows(rows);
};

// Per-deck leaderboard rows: { rank, deckName, deckId, ownerId, visibility, owner, wins, losses, winLossRatio }.
export const getDeckLeaderboard = async (match = {}) => {
  const rows = await GameRecord.aggregate([
    { $match: match },
    { $group: { _id: '$deck', ...resultCounts } },
    { $lookup: { from: 'decks', localField: '_id', foreignField: '_id', as: 'deck' } },
    { $unwind: '$deck' },
    { $lookup: { from: 'users', localField: 'deck.owner', foreignField: '_id', as: 'owner' } },
    { $unwind: '$owner' },
    {
      $project: {
        _id: 0,
        deckId: '$deck._id',
        ownerId: '$deck.owner',
        visibility: '$deck.visibility',
        deckName: '$deck.name',
        owner: '$owner.username',
        wins: 1,
        losses: 1,
        draws: 1,
      },
    },
  ]);

  return rankRows(rows);
};

// Strip the name from deck rows the viewer may not see, flagging them hidden.
export const maskHiddenDecks = (rows, viewer) =>
  rows.map((row) => {
    if (canSeeDeck({ owner: row.ownerId, visibility: row.visibility }, viewer)) return row;
    const { deckName, ...rest } = row;
    return { ...rest, hidden: true };
  });
