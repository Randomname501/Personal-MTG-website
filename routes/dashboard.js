import express from 'express';
import { Deck, User } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    // .lean() so Handlebars can read the fields (its prototype guard blocks
    // Mongoose document getters, rendering them blank otherwise).
    const [decks, userWithTracked] = await Promise.all([
      Deck.find({ owner: req.currentUser._id }).sort({ createdAt: -1 }).lean(),
      User.findById(req.currentUser._id).populate('trackedDecks').lean(),
    ]);

    res.render('userDashboard', {
      title: 'Dashboard',
      user: req.currentUser,
      decks,
      trackedDecks: userWithTracked?.trackedDecks ?? [],
    });
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
