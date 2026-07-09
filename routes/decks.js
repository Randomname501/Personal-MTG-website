import express from 'express';
import mongoose from 'mongoose';
import { Deck, DECK_FORMATS, MTG_COLORS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getDeckStats } from '../lib/stats.js';

const router = express.Router();

router.get('/decks/new', requireAuth, (req, res) => {
  res.render('deckForm', {
    title: 'New Deck',
    formats: DECK_FORMATS,
    colorOptions: MTG_COLORS,
  });
});

router.post('/decks', requireAuth, async (req, res, next) => {
  const { name, format, commander, archetype, description } = req.body;
  // Checkboxes arrive as a single string (one box) or an array (several); normalize.
  let colors = req.body.colors ?? [];
  if (!Array.isArray(colors)) colors = [colors];
  colors = colors.filter((c) => MTG_COLORS.includes(c));

  try {
    await Deck.create({
      name: (name || '').trim(),
      format,
      owner: req.currentUser._id,
      colors,
      commander: (commander || '').trim() || undefined,
      archetype: (archetype || '').trim() || undefined,
      description: (description || '').trim() || undefined,
    });
    res.redirect('/dashboard');
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).render('deckForm', {
        title: 'New Deck',
        formats: DECK_FORMATS,
        colorOptions: MTG_COLORS,
        hasError: true,
        deckError: 'Please provide a name and a valid format.',
        values: req.body,
      });
    }
    next(err);
  }
});

router.get('/decks/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const deck = await Deck.findById(req.params.id).lean();
    if (!deck) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const stats = await getDeckStats(deck._id);
    res.render('deckDetail', { title: deck.name, deck, stats });
  } catch (err) {
    next(err);
  }
});

export { router as decksRouter };
