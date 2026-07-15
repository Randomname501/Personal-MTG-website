import express from 'express';
import mongoose from 'mongoose';
import { Deck, GameRecord, GAME_RESULTS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Validate a game-record submission for a user. Returns the owned deck, the
// trimmed opponent, and the result on success; null if anything is invalid.
const resolveGameInput = async ({ deckId, opponentDeck, result }, userId) => {
  const opponent = (opponentDeck || '').trim();
  if (!GAME_RESULTS.includes(result) || !opponent) return null;
  if (!mongoose.Types.ObjectId.isValid(deckId)) return null;
  const deck = await Deck.findOne({ _id: deckId, owner: userId });
  if (!deck) return null;
  return { deck, opponent, result };
};

// Load a record only if it belongs to the user; null for a bad id or non-owner.
const findOwnedRecord = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return GameRecord.findOne({ _id: id, user: userId });
};

// Match history: the user's games, newest-first, with optional deck/result filters.
router.get('/game-records', requireAuth, async (req, res, next) => {
  try {
    const userId = req.currentUser._id;
    const decks = await Deck.find({ owner: userId }).sort({ name: 1 }).lean();

    const filter = { user: userId };
    const deckIds = new Set(decks.map((d) => d._id.toString()));
    if (req.query.deck && deckIds.has(req.query.deck)) filter.deck = req.query.deck;
    if (GAME_RESULTS.includes(req.query.result)) filter.result = req.query.result;

    const games = await GameRecord.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .populate('deck', 'name')
      .lean();

    res.render('gameHistory', {
      title: 'Match History',
      games,
      decks,
      results: GAME_RESULTS,
      filter: { deck: filter.deck ?? '', result: filter.result ?? '' },
      hasFilter: Boolean(filter.deck || filter.result),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/game-records', requireAuth, async (req, res, next) => {
  try {
    const input = await resolveGameInput(
      { deckId: req.body.deck_id, opponentDeck: req.body.opponent_deck, result: req.body.result },
      req.currentUser._id
    );
    // Silently ignore invalid quick-log input, matching prior behavior.
    if (!input) return res.redirect('/dashboard');

    await GameRecord.create({
      user: req.currentUser._id,
      deck: input.deck._id,
      opponentDeck: input.opponent,
      result: input.result,
    });
    res.redirect('/dashboard');
  } catch (err) {
    next(err);
  }
});

router.get('/game-records/:id/edit', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    const decks = await Deck.find({ owner: req.currentUser._id }).sort({ name: 1 }).lean();
    res.render('gameRecordForm', {
      title: 'Edit Game',
      decks,
      results: GAME_RESULTS,
      values: {
        id: record._id.toString(),
        deck: record.deck.toString(),
        opponentDeck: record.opponentDeck,
        result: record.result,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/game-records/:id', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    const input = await resolveGameInput(
      { deckId: req.body.deck_id, opponentDeck: req.body.opponent_deck, result: req.body.result },
      req.currentUser._id
    );
    if (!input) {
      const decks = await Deck.find({ owner: req.currentUser._id }).sort({ name: 1 }).lean();
      return res.status(400).render('gameRecordForm', {
        title: 'Edit Game',
        hasError: true,
        recordError: 'Please pick one of your decks, name an opponent, and choose a result.',
        decks,
        results: GAME_RESULTS,
        values: {
          id: record._id.toString(),
          deck: (req.body.deck_id || '').toString(),
          opponentDeck: req.body.opponent_deck || '',
          result: req.body.result || '',
        },
      });
    }

    record.deck = input.deck._id;
    record.opponentDeck = input.opponent;
    record.result = input.result;
    await record.save();
    res.redirect('/game-records');
  } catch (err) {
    next(err);
  }
});

router.get('/game-records/:id/delete', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const record = await GameRecord.findOne({ _id: req.params.id, user: req.currentUser._id })
      .populate('deck', 'name')
      .lean();
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    res.render('gameRecordDelete', { title: 'Delete Game', record });
  } catch (err) {
    next(err);
  }
});

router.delete('/game-records/:id', requireAuth, async (req, res, next) => {
  try {
    const record = await findOwnedRecord(req.params.id, req.currentUser._id);
    if (!record) return res.status(404).render('404', { title: 'Not Found' });

    await record.deleteOne();
    res.redirect('/game-records');
  } catch (err) {
    next(err);
  }
});

export { router as gameRecordsRouter };
