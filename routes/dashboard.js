import express from 'express';
import { Deck, User, MAX_OPPONENTS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getUserSummary } from '../lib/stats.js';
import { canSeeDeck } from '../lib/visibility.js';
import { listMemberGroups } from '../lib/playgroups.js';

const router = express.Router();

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    // .lean() so Handlebars can read the fields (its prototype guard blocks
    // Mongoose document getters, rendering them blank otherwise).
    const [decks, userWithTracked, summary, requesters, playgroups] = await Promise.all([
      Deck.find({ owner: req.currentUser._id }).sort({ createdAt: -1 }).lean(),
      User.findById(req.currentUser._id).populate('trackedDecks').lean(),
      getUserSummary(req.currentUser._id),
      User.find({ _id: { $in: req.currentUser.friendRequests ?? [] } }).select('username').sort({ username: 1 }).lean(),
      listMemberGroups(req.currentUser._id),
    ]);

    res.render('userDashboard', {
      title: 'Dashboard',
      user: req.currentUser,
      decks,
      trackedDecks: (userWithTracked?.trackedDecks ?? []).filter((d) => canSeeDeck(d, req.currentUser)),
      summary,
      requesters,
      playgroups,
      maxOpponents: MAX_OPPONENTS,
      // The quick-log form opens on a 1v1; the count input grows it from there.
      blankOpponents: [{ name: '', deck: '' }],
    });
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
