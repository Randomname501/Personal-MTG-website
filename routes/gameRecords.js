import express from 'express';
import { Deck, GameRecord, GAME_RESULTS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/game-records', requireAuth, async (req, res, next) => {
  const { deck_id: deckId, opponent_deck: opponentDeck, result } = req.body;

  try {
    // The deck must exist AND belong to the current user — never log against
    // someone else's deck.
    const deck = await Deck.findOne({ _id: deckId, owner: req.currentUser._id });
    if (!deck || !GAME_RESULTS.includes(result) || !(opponentDeck || '').trim()) {
      return res.redirect('/dashboard');
    }

    await GameRecord.create({
      user: req.currentUser._id,
      deck: deck._id,
      opponentDeck: opponentDeck.trim(),
      result,
    });
    res.redirect('/dashboard');
  } catch (err) {
    if (err.name === 'CastError') return res.redirect('/dashboard');
    next(err);
  }
});

export { router as gameRecordsRouter };
