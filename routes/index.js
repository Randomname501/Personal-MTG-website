import express from 'express';
import { pagesRouter } from './pages.js';
import { authRouter } from './auth.js';
import { dashboardRouter } from './dashboard.js';
import { decksRouter } from './decks.js';
import { gameRecordsRouter } from './gameRecords.js';
import { leaderboardsRouter } from './leaderboards.js';

const router = express.Router();

router.use(pagesRouter);
router.use(authRouter);
router.use(dashboardRouter);
router.use(decksRouter);
router.use(gameRecordsRouter);
router.use(leaderboardsRouter);

export { router };
