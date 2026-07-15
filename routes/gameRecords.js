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

export { router as gameRecordsRouter };
