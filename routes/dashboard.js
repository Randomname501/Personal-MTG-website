import express from 'express';
import { Deck, User, MAX_OPPONENTS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getUserSummary } from '../lib/stats.js';

const router = express.Router();

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    // .lean() so Handlebars can read the fields (its prototype guard blocks
    // Mongoose document getters, rendering them blank otherwise).
    const [decks, userWithTracked, summary] = await Promise.all([
      Deck.find({ owner: req.currentUser._id }).sort({ createdAt: -1 }).lean(),
      User.findById(req.currentUser._id).populate('trackedDecks').lean(),
      getUserSummary(req.currentUser._id),
    ]);

    res.render('userDashboard', {
      title: 'Dashboard',
      user: req.currentUser,
      decks,
      trackedDecks: userWithTracked?.trackedDecks ?? [],
      summary,
      maxOpponents: MAX_OPPONENTS,
      // The quick-log form opens on a 1v1; the count input grows it from there.
      blankOpponents: [{ name: '', deck: '' }],
    });
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
