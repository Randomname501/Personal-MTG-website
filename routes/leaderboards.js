import express from 'express';
import { canSeeDeck } from '../lib/visibility.js';
import { getPlayerLeaderboard, getDeckLeaderboard } from '../lib/leaderboards.js';

const router = express.Router();

router.get('/leaderboard', async (req, res, next) => {
  try {
    const leaderboard = await getPlayerLeaderboard();
    res.render('leaderboard', { title: 'Leaderboard', leaderboard });
  } catch (err) {
    next(err);
  }
});

router.get('/deckLeaderboard', async (req, res, next) => {
  try {
    const leaderboard = (await getDeckLeaderboard()).map((row) => {
      if (canSeeDeck({ owner: row.ownerId, visibility: row.visibility }, req.currentUser)) return row;
      const { deckName, ...rest } = row;
      return { ...rest, hidden: true };
    });
    res.render('deckLeaderboard', { title: 'Deck Leaderboard', leaderboard });
  } catch (err) {
    next(err);
  }
});

export { router as leaderboardsRouter };
