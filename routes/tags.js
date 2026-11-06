import express from 'express';
import mongoose from 'mongoose';
import { Deck, Tag, TAG_NAME_MAX } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const isId = (id) => mongoose.Types.ObjectId.isValid(id);
const notFound = (res) => res.status(404).render('404', { title: 'Not Found' });
const BY_NAME = { locale: 'en' };

const listTags = (userId) => Tag.find({ owner: userId }).sort({ name: 1 }).collation(BY_NAME).lean();

// Load a tag only if it belongs to the user; null for a bad id or non-owner.
const findOwnedTag = async (id, userId) => (isId(id) ? Tag.findOne({ _id: id, owner: userId }) : null);

const renderTags = async (res, userId, extra = {}) =>
  res.render('tags', { title: 'Tags', tags: await listTags(userId), nameMax: TAG_NAME_MAX, ...extra });

// Save a new or renamed tag, or show the tags page again with the reason it can't be.
const saveTag = async (req, res, tag) => {
  const userId = req.currentUser._id;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > TAG_NAME_MAX) {
    return renderTags(res.status(400), userId, { error: `Tag names need 1 to ${TAG_NAME_MAX} characters.` });
  }
  tag.name = name;
  try {
    await tag.save();
  } catch (err) {
    if (err.code !== 11000) throw err;
    return renderTags(res.status(409), userId, { error: `You already have a tag called ${name}.` });
  }
  res.redirect('/tags');
};

router.get('/tags', requireAuth, async (req, res, next) => {
  try {
    await renderTags(res, req.currentUser._id);
  } catch (err) {
    next(err);
  }
});

router.post('/tags', requireAuth, async (req, res, next) => {
  try {
    await saveTag(req, res, new Tag({ owner: req.currentUser._id }));
  } catch (err) {
    next(err);
  }
});

// A deck's card names, with its commanders where the format uses them.
const cardNames = (deck) => [
  ...(deck.format === 'Commander' ? [deck.commander, deck.partner] : []),
  ...(deck.cards || []).map((c) => c.name),
];

// Everything carrying one tag: the decks, and each deck's cards.
router.get('/tags/:id', requireAuth, async (req, res, next) => {
  try {
    const owner = req.currentUser._id;
    const tag = await findOwnedTag(req.params.id, owner);
    if (!tag) return notFound(res);

    const [decks, decksWithCards] = await Promise.all([
      Deck.find({ _id: { $in: tag.decks }, owner }).sort({ name: 1 }).collation(BY_NAME).select('name format').lean(),
      Deck.find({
        owner,
        $or: [
          { 'cards.name': { $in: tag.cards } },
          { format: 'Commander', commander: { $in: tag.cards } },
          { format: 'Commander', partner: { $in: tag.cards } },
        ],
      }).sort({ name: 1 }).collation(BY_NAME).select('name format commander partner cards.name').lean(),
    ]);
    const cardDecks = decksWithCards.map((d) => ({
      _id: d._id,
      name: d.name,
      cards: [...new Set(cardNames(d).filter((name) => tag.cards.includes(name)))],
    }));
    res.render('tag', { title: tag.name, tag: tag.toObject(), decks, cardDecks });
  } catch (err) {
    next(err);
  }
});

router.post('/tags/:id', requireAuth, async (req, res, next) => {
  try {
    const tag = await findOwnedTag(req.params.id, req.currentUser._id);
    if (!tag) return notFound(res);
    await saveTag(req, res, tag);
  } catch (err) {
    next(err);
  }
});

router.post('/tags/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const tag = await findOwnedTag(req.params.id, req.currentUser._id);
    if (!tag) return notFound(res);
    await tag.deleteOne();
    res.redirect('/tags');
  } catch (err) {
    next(err);
  }
});

// What a picker URL assigns tags to: the user's deck, or a card in it. Null if neither.
const findTarget = async (req) => {
  const { id, scryfallId } = req.params;
  if (!isId(id)) return null;
  const deck = await Deck.findOne({ _id: id, owner: req.currentUser._id }).lean();
  if (!deck) return null;
  if (!scryfallId) return { field: 'decks', value: deck._id, name: deck.name, path: `/decks/${deck._id}/tags`, back: `/decks/${deck._id}` };
  const card = (deck.cards || []).find((c) => c.scryfallId === scryfallId);
  if (!card) return null;
  const cardPath = `/decks/${deck._id}/cards/${card.scryfallId}`;
  return { field: 'cards', value: card.name, name: card.name, isCard: true, path: `${cardPath}/tags`, back: `${cardPath}/note` };
};

const PICKER_PATHS = ['/decks/:id/tags', '/decks/:id/cards/:scryfallId/tags'];

router.get(PICKER_PATHS, requireAuth, async (req, res, next) => {
  try {
    const target = await findTarget(req);
    if (!target) return notFound(res);
    const { field, value } = target;
    const tags = (await listTags(req.currentUser._id)).map((t) => ({
      ...t,
      checked: t[field].some((v) => String(v) === String(value)),
    }));
    res.render('tagPicker', { title: `Tags: ${target.name}`, target, tags });
  } catch (err) {
    next(err);
  }
});

router.post(PICKER_PATHS, requireAuth, async (req, res, next) => {
  try {
    const target = await findTarget(req);
    if (!target) return notFound(res);
    const { field, value } = target;
    const owner = req.currentUser._id;
    const chosen = [].concat(req.body.tags ?? []).filter(isId);
    await Tag.updateMany({ owner, _id: { $nin: chosen } }, { $pull: { [field]: value } });
    await Tag.updateMany({ owner, _id: { $in: chosen } }, { $addToSet: { [field]: value } });
    res.redirect(target.back);
  } catch (err) {
    next(err);
  }
});

export { router as tagsRouter };
