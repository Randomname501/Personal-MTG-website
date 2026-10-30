import express from 'express';
import { User, Deck, GameRecord, opponentList } from '../models/index.js';
import { getUserSummary } from '../lib/stats.js';
import { requireAuth } from '../middleware/auth.js';
import { profilePath } from '../lib/viewHelpers.js';
import { safeBack } from '../lib/safeBack.js';
import * as friendsLib from '../lib/friends.js';
import { canSeeDeck, visibleDeckFilter } from '../lib/visibility.js';

const router = express.Router();

export const findUserByName = (username) =>
  User.findOne({ username })
    .collation({ locale: 'en', strength: 2 })
    .select('-passwordHash')
    .lean();

router.get('/users/:username', async (req, res, next) => {
  try {
    const profile = await findUserByName(req.params.username);
    if (!profile) return res.status(404).render('404', { title: 'Not Found' });

    const viewer = req.currentUser;
    const isSelf = Boolean(viewer) && viewer._id.toString() === profile._id.toString();

    const [summary, decks, records, friends] = await Promise.all([
      getUserSummary(profile._id),
      Deck.find({ $and: [{ owner: profile._id }, visibleDeckFilter(viewer)] })
        .sort({ createdAt: -1 })
        .lean(),
      GameRecord.find({ user: profile._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('deck')
        .lean(),
      User.find({ _id: { $in: profile.friends ?? [] } }).select('username').sort({ username: 1 }).lean(),
    ]);

    const games = records.map((g) => ({
      result: g.result,
      createdAt: g.createdAt,
      opponents: opponentList(g),
      deck: g.deck && canSeeDeck(g.deck, viewer) ? { _id: g.deck._id, name: g.deck.name } : null,
    }));

    res.render('profile', {
      title: profile.username,
      profile,
      isSelf,
      summary,
      decks,
      games,
      friends: friends.map((f) => ({ username: f.username })),
      comments: [], // Task 5 fills this
      relation: friendsLib.relation(viewer, profile),
    });
  } catch (err) {
    next(err);
  }
});

// POST /users/:username/<action>; each runs (viewerId, targetId) against lib/friends.
const actions = {
  friend: friendsLib.sendRequest,
  cancel: friendsLib.cancelRequest,
  accept: friendsLib.acceptRequest,
  decline: friendsLib.declineRequest,
  unfriend: friendsLib.unfriend,
};
for (const [name, fn] of Object.entries(actions)) {
  router.post(`/users/:username/${name}`, requireAuth, async (req, res, next) => {
    try {
      const target = await findUserByName(req.params.username);
      if (!target) return res.redirect('/dashboard');
      await fn(req.currentUser._id, target._id);
      res.redirect(safeBack(req.body.back, profilePath(target.username)));
    } catch (err) {
      next(err);
    }
  });
}

export { router as usersRouter };
