import express from 'express';
import mongoose from 'mongoose';
import { GameRecord, Playgroup, User, opponentList } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { findUserByName } from '../lib/friends.js';
import { getPlayerLeaderboard, getDeckLeaderboard, maskHiddenDecks } from '../lib/leaderboards.js';
import { canSeeDeck } from '../lib/visibility.js';
import * as pg from '../lib/playgroups.js';

const router = express.Router();

const NAME_ERROR = 'Playgroup names must be 1–60 characters.';
const notFound = (res) => res.status(404).render('404', { title: 'Not Found' });
const groupPath = (id) => `/playgroups/${id}`;

const usernames = async (ids) =>
  (await User.find({ _id: { $in: ids ?? [] } }).select('username').lean())
    .sort((a, b) => a.username.localeCompare(b.username));

// Everything the group page renders, so error re-renders reuse it.
export const groupView = async (group, viewer) => {
  const tagged = { playgroup: group._id };
  const [members, invites, players, decks, records] = await Promise.all([
    usernames(group.members),
    usernames(group.invites),
    getPlayerLeaderboard(tagged),
    getDeckLeaderboard(tagged),
    GameRecord.find(tagged)
      .sort({ createdAt: -1, _id: -1 })
      .limit(10)
      .populate('user', 'username')
      .populate('deck', 'name owner visibility')
      .lean(),
  ]);
  const ownerId = String(group.owner);
  return {
    players,
    decks: maskHiddenDecks(decks, viewer),
    games: records.map((g) => ({
      username: g.user?.username,
      result: g.result,
      createdAt: g.createdAt,
      opponents: opponentList(g),
      deck: g.deck && canSeeDeck(g.deck, viewer) ? { _id: g.deck._id, name: g.deck.name } : null,
    })),
    title: group.name,
    group: { _id: group._id, name: group.name },
    isOwner: ownerId === String(viewer._id),
    members: members.map((u) => ({ username: u.username, isOwner: String(u._id) === ownerId })),
    invites: invites.map((u) => ({ username: u.username })),
  };
};

const listView = async (viewer) => {
  const [groups, invites] = await Promise.all([
    Playgroup.find({ members: viewer._id }).sort({ name: 1 }).lean(),
    Playgroup.find({ invites: viewer._id }).sort({ name: 1 }).lean(),
  ]);
  return {
    title: 'Playgroups',
    groups: groups.map((g) => ({ _id: g._id, name: g.name, memberCount: g.members.length })),
    invites: invites.map((g) => ({ _id: g._id, name: g.name })),
  };
};

router.get('/playgroups', requireAuth, async (req, res, next) => {
  try {
    res.render('playgroups', await listView(req.currentUser));
  } catch (err) {
    next(err);
  }
});

router.post('/playgroups', requireAuth, async (req, res, next) => {
  try {
    const name = pg.cleanName(req.body.name);
    if (!name) {
      return res.status(400).render('playgroups', {
        ...(await listView(req.currentUser)),
        error: NAME_ERROR,
        nameDraft: String(req.body.name ?? ''),
      });
    }
    const group = await pg.createPlaygroup(req.currentUser._id, name);
    res.redirect(groupPath(group._id));
  } catch (err) {
    next(err);
  }
});

router.get('/playgroups/:id', requireAuth, async (req, res, next) => {
  try {
    const group = await pg.findMemberGroup(req.params.id, req.currentUser._id);
    if (!group) return notFound(res);
    res.render('playgroup', await groupView(group, req.currentUser));
  } catch (err) {
    next(err);
  }
});

// An invitee isn't a member yet, so these only need a well-formed id.
router.post('/playgroups/:id/accept', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.redirect('/playgroups');
    await pg.acceptInvite(req.params.id, req.currentUser._id);
    res.redirect(groupPath(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.post('/playgroups/:id/decline', requireAuth, async (req, res, next) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) await pg.declineInvite(req.params.id, req.currentUser._id);
    res.redirect('/playgroups');
  } catch (err) {
    next(err);
  }
});

// POST /playgroups/:id/<action> for members only; everyone else gets a 404.
const memberActions = {
  invite: async (req, res, group) => {
    const error = await pg.invite(group, req.currentUser, req.body.username);
    if (!error) return res.redirect(groupPath(group._id));
    res.status(400).render('playgroup', {
      ...(await groupView(group, req.currentUser)),
      error,
      inviteDraft: String(req.body.username ?? ''),
    });
  },
  leave: async (req, res, group) => {
    await pg.leave(group._id, req.currentUser._id);
    res.redirect('/playgroups');
  },
  remove: async (req, res, group) => {
    const target = await findUserByName(String(req.body.username ?? ''));
    if (target) await pg.removeMember(group._id, req.currentUser._id, target._id);
    res.redirect(groupPath(group._id));
  },
  rename: async (req, res, group) => {
    const name = pg.cleanName(req.body.name);
    if (!name) {
      return res.status(400).render('playgroup', { ...(await groupView(group, req.currentUser)), error: NAME_ERROR });
    }
    await pg.rename(group._id, req.currentUser._id, name);
    res.redirect(groupPath(group._id));
  },
  delete: async (req, res, group) => {
    await pg.deletePlaygroup(group._id, req.currentUser._id);
    res.redirect('/playgroups');
  },
};
for (const [name, handler] of Object.entries(memberActions)) {
  router.post(`/playgroups/:id/${name}`, requireAuth, async (req, res, next) => {
    try {
      const group = await pg.findMemberGroup(req.params.id, req.currentUser._id);
      if (!group) return notFound(res);
      await handler(req, res, group);
    } catch (err) {
      next(err);
    }
  });
}

export { router as playgroupsRouter };
