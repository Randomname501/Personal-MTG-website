import express from 'express';
import mongoose from 'mongoose';
import { Deck, DECK_FORMATS, MTG_COLORS } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getDeckStats } from '../lib/stats.js';
import { getCardInsights } from '../lib/cardInsights.js';
import { searchCards, getCardById } from '../lib/scryfall.js';

const router = express.Router();

// Load a deck only if it belongs to the user; null for a bad id or non-owner.
const findOwnedDeck = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Deck.findOne({ _id: id, owner: userId });
};

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
    const isOwner = req.currentUser._id.toString() === deck.owner.toString();
    const cardCount = (deck.cards || []).reduce((sum, c) => sum + c.quantity, 0);
    const insights = getCardInsights(deck.cards || []);
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, cardCount, insights });
  } catch (err) {
    next(err);
  }
});

router.get('/decks/:id/cards', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const query = (req.query.q || '').trim();
    const searched = query.length > 0;
    const results = searched ? await searchCards(query) : [];

    res.render('deckCards', {
      title: `Manage: ${deck.name}`,
      deck: deck.toObject(),
      query,
      searched,
      results,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/cards', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const scryfallId = (req.body.scryfall_id || '').trim();
    const q = (req.body.q || '').trim();
    const back = q ? `/decks/${deck._id}/cards?q=${encodeURIComponent(q)}` : `/decks/${deck._id}/cards`;
    if (!scryfallId) return res.redirect(back);

    // Re-fetch the card server-side for an authoritative snapshot; never trust
    // client-posted card fields.
    const card = await getCardById(scryfallId);
    const existing = deck.cards.find((c) => c.scryfallId === card.scryfallId);
    if (existing) existing.quantity += 1;
    else deck.cards.push({ ...card, quantity: 1 });
    await deck.save();

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/cards/:scryfallId/remove', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const card = deck.cards.find((c) => c.scryfallId === req.params.scryfallId);
    if (card) {
      card.quantity -= 1;
      if (card.quantity <= 0) {
        deck.cards = deck.cards.filter((c) => c.scryfallId !== req.params.scryfallId);
      }
      await deck.save();
    }
    res.redirect(`/decks/${deck._id}/cards`);
  } catch (err) {
    next(err);
  }
});

export { router as decksRouter };
