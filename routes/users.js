import express from 'express';
import mongoose from 'mongoose';
import { User, Deck, GameRecord, Comment, COMMENT_MAX, opponentList } from '../models/index.js';
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

// Everything the profile page renders, so the comment 400 re-render reuses it.
const profileView = async (profile, viewer) => {
  const isSelf = Boolean(viewer) && viewer._id.toString() === profile._id.toString();

  const [summary, decks, records, friends, comments] = await Promise.all([
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
    Comment.find({ profile: profile._id }).sort({ createdAt: -1 }).populate('author', 'username').lean(),
  ]);

  const games = records.map((g) => ({
    result: g.result,
    createdAt: g.createdAt,
    opponents: opponentList(g),
    deck: g.deck && canSeeDeck(g.deck, viewer) ? { _id: g.deck._id, name: g.deck.name } : null,
  }));

  return {
    title: profile.username,
    profile,
    isSelf,
    summary,
    decks,
    games,
    friends: friends.map((f) => ({ username: f.username })),
    comments: comments
      .filter((c) => c.author)
      .map((c) => ({
        _id: c._id,
        body: c.body,
        createdAt: c.createdAt,
        author: { username: c.author.username },
        canDelete: Boolean(viewer) && c.author._id.toString() === viewer._id.toString(),
      })),
    relation: friendsLib.relation(viewer, profile),
  };
};

router.get('/users/:username', async (req, res, next) => {
  try {
    const profile = await findUserByName(req.params.username);
    if (!profile) return res.status(404).render('404', { title: 'Not Found' });
    res.render('profile', await profileView(profile, req.currentUser));
  } catch (err) {
    next(err);
  }
});

router.post('/users/:username/comments', requireAuth, async (req, res, next) => {
  try {
    const profile = await findUserByName(req.params.username);
    if (!profile) return res.redirect('/dashboard');
    if (friendsLib.relation(req.currentUser, profile) !== 'friends') {
      return res.redirect(profilePath(profile.username));
    }
    const body = String(req.body.body ?? '').trim();
    if (!body || body.length > COMMENT_MAX) {
      return res.status(400).render('profile', {
        ...(await profileView(profile, req.currentUser)),
        error: `Comments must be 1–${COMMENT_MAX} characters.`,
        commentDraft: String(req.body.body ?? ''),
      });
    }
    await Comment.create({ profile: profile._id, author: req.currentUser._id, body });
    res.redirect(profilePath(profile.username));
  } catch (err) {
    next(err);
  }
});

router.post('/comments/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await Comment.deleteOne({ _id: req.params.id, author: req.currentUser._id });
    }
    res.redirect(safeBack(req.body.back, '/dashboard'));
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
