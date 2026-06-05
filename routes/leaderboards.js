import express from 'express';
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
    const leaderboard = await getDeckLeaderboard();
    res.render('deckLeaderboard', { title: 'Deck Leaderboard', leaderboard });
  } catch (err) {
    next(err);
  }
});

export { router as leaderboardsRouter };
