import express from 'express';
import mongoose from 'mongoose';
import { Deck, DECK_FORMATS, MTG_COLORS, User } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getDeckStats } from '../lib/stats.js';
import { getCardInsights, groupCards, withoutCommander } from '../lib/cardInsights.js';
import { searchCards, getCardById, getCardByName, getCardsByNames } from '../lib/scryfall.js';
import { parseDecklist } from '../lib/decklist.js';

const router = express.Router();

// Load a deck only if it belongs to the user; null for a bad id or non-owner.
const findOwnedDeck = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Deck.findOne({ _id: id, owner: userId });
};

// Only allow local relative redirects (a path starting with a single '/'),
// never an absolute/scheme URL — prevents open redirects.
const safeBack = (value, fallback) =>
  (typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : fallback);

router.get('/decks/new', requireAuth, (req, res) => {
  res.render('deckForm', {
    title: 'New Deck',
    formats: DECK_FORMATS,
    colorOptions: MTG_COLORS,
  });
});

router.get('/decks', requireAuth, async (req, res, next) => {
  try {
    const filter = {};
    if (DECK_FORMATS.includes(req.query.format)) filter.format = req.query.format;

    const decks = await Deck.find(filter)
      .sort({ createdAt: -1 })
      .populate('owner', 'username')
      .lean();

    const trackedIds = new Set((req.currentUser.trackedDecks || []).map((id) => id.toString()));
    const userId = req.currentUser._id.toString();
    const rows = decks.map((d) => ({
      _id: d._id,
      name: d.name,
      format: d.format,
      colors: d.colors,
      owner: d.owner?.username ?? '—',
      isOwner: d.owner?._id?.toString() === userId,
      isTracked: trackedIds.has(d._id.toString()),
    }));

    res.render('deckBrowse', {
      title: 'Browse Decks',
      decks: rows,
      formats: DECK_FORMATS,
      filter: { format: filter.format ?? '' },
      hasFilter: Boolean(filter.format),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/decks', requireAuth, async (req, res, next) => {
  const { name, format, commander, archetype, description } = req.body;
  // Checkboxes arrive as a single string (one box) or an array (several); normalize.
  let colors = req.body.colors ?? [];
  if (!Array.isArray(colors)) colors = [colors];
  colors = colors.filter((c) => MTG_COLORS.includes(c));

  const commanderName = (commander || '').trim();

  try {
    // Best-effort: an unrecognized or misspelled commander name just means no
    // image, not a failed deck creation.
    const commanderCard = format === 'Commander' && commanderName ? await getCardByName(commanderName).catch(() => null) : null;

    await Deck.create({
      name: (name || '').trim(),
      format,
      owner: req.currentUser._id,
      colors,
      commander: commanderName || undefined,
      commanderImageUrl: commanderCard?.imageUrl || '',
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
    const isTracked = (req.currentUser.trackedDecks || []).some((t) => t.toString() === deck._id.toString());
    // The commander lives outside deck.cards; it joins the list (and the count)
    // only on Commander-format decks.
    const hasCommander = deck.format === 'Commander' && Boolean(deck.commander);
    const cards = hasCommander ? withoutCommander(deck.cards, deck.commander) : deck.cards || [];
    const cardCount = cards.reduce((sum, c) => sum + c.quantity, 0) + (hasCommander ? 1 : 0);
    const insights = getCardInsights(cards);
    const groupMode = ['type', 'cmc'].includes(req.query.group) ? req.query.group : 'type';
    const cardGroups = groupCards(cards, {
      mode: groupMode,
      commander: hasCommander ? { name: deck.commander, imageUrl: deck.commanderImageUrl } : undefined,
    });
    res.render('deckDetail', { title: deck.name, deck, stats, isOwner, isTracked, cardCount, insights, cardGroups, groupMode });
  } catch (err) {
    next(err);
  }
});

// The card manager page; `extra` carries search results or an import outcome.
const renderManager = (res, deck, extra = {}) => {
  const plain = deck.toObject();
  res.render('deckCards', {
    title: `Manage: ${deck.name}`,
    deck: plain,
    query: '',
    searched: false,
    results: [],
    cardGroups: groupCards(plain.cards),
    isCommanderDeck: deck.format === 'Commander',
    ...extra,
  });
};

router.get('/decks/:id/cards', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const query = (req.query.q || '').trim();
    const searched = query.length > 0;
    const results = searched ? await searchCards(query) : [];

    renderManager(res, deck, { query, searched, results });
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

// Replace a deck's cards with a pasted Moxfield/Archidekt text export. Names are
// resolved through Scryfall; unmatched lines are reported back, and a paste that
// matches nothing leaves the deck as it was.
const MAX_IMPORT_NAMES = 250;

router.post('/decks/:id/import', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const decklist = typeof req.body.decklist === 'string' ? req.body.decklist : '';
    const { cards, commander } = parseDecklist(decklist);
    const isCommanderDeck = deck.format === 'Commander';
    // A commander line only means something on a Commander deck; elsewhere it's an ordinary card.
    const wanted = commander && !isCommanderDeck ? [...cards, { name: commander, quantity: 1 }] : cards;
    const names = [...wanted.map((c) => c.name), ...(commander && isCommanderDeck ? [commander] : [])];

    const fail = (message, notFound = []) =>
      renderManager(res, deck, { importResult: { message, notFound }, importText: decklist });
    if (names.length === 0) return fail('No cards were imported — paste a decklist like "1 Sol Ring".');
    if (names.length > MAX_IMPORT_NAMES) return fail(`No cards were imported — that list has more than ${MAX_IMPORT_NAMES} different cards.`);

    const { found, notFound } = await getCardsByNames(names);
    const byId = new Map(); // two spellings of one card (e.g. a DFC's front face) merge
    for (const { name, quantity } of wanted) {
      const card = found.get(name.toLowerCase());
      if (!card) continue;
      const entry = byId.get(card.scryfallId);
      if (entry) entry.quantity += quantity;
      else byId.set(card.scryfallId, { ...card, quantity });
    }
    const commanderCard = commander && isCommanderDeck ? found.get(commander.toLowerCase()) : undefined;
    if (byId.size === 0 && !commanderCard) return fail('No cards were imported — none of those names matched a card.', notFound);

    deck.cards = [...byId.values()];
    if (commanderCard) {
      deck.commander = commanderCard.name;
      deck.commanderImageUrl = commanderCard.imageUrl;
    }
    await deck.save();

    const total = deck.cards.reduce((sum, c) => sum + c.quantity, 0);
    const message = `Imported ${total} cards${commanderCard ? ` with ${commanderCard.name} as commander` : ''}.`;
    renderManager(res, deck, { importResult: { message, notFound } });
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/commander', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const scryfallId = (req.body.scryfall_id || '').trim();
    const q = (req.body.q || '').trim();
    const back = q ? `/decks/${deck._id}/cards?q=${encodeURIComponent(q)}` : `/decks/${deck._id}/cards`;
    if (deck.format !== 'Commander' || !scryfallId) return res.redirect(back);

    // Re-fetch for the canonical name and art; never trust client-posted card fields.
    const card = await getCardById(scryfallId);
    deck.commander = card.name;
    deck.commanderImageUrl = card.imageUrl;
    await deck.save();

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/track', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/decks');
    const back = safeBack(req.body.back, `/decks/${req.params.id}`);

    const deck = await Deck.findById(req.params.id).select('owner').lean();
    // Can't track a missing deck or your own deck.
    if (deck && deck.owner.toString() !== req.currentUser._id.toString()) {
      await User.updateOne(
        { _id: req.currentUser._id },
        { $addToSet: { trackedDecks: deck._id } }
      );
    }
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/untrack', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/decks');
    const back = safeBack(req.body.back, `/decks/${req.params.id}`);

    await User.updateOne(
      { _id: req.currentUser._id },
      { $pull: { trackedDecks: req.params.id } }
    );
    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

export { router as decksRouter };
