import express from 'express';
import mongoose from 'mongoose';
import { Deck, DECK_FORMATS, DECK_VISIBILITY, MTG_COLORS, User } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getDeckStats } from '../lib/stats.js';
import { GROUP_MODES, getCardInsights, groupCards, withoutCommander } from '../lib/cardInsights.js';
import { DECK_COLLATION, DECK_SORTS, deckSort } from '../lib/deckSort.js';
import { searchCards, getCardById, getCardByName, getCardsByNames } from '../lib/scryfall.js';
import { formatDecklist, parseDecklist } from '../lib/decklist.js';
import { pairRefusal } from '../lib/commanderPair.js';
import Anthropic from '@anthropic-ai/sdk';
import { runDeckAgent } from '../lib/deckAgent.js';
import { safeBack } from '../lib/safeBack.js';
import { canSeeDeck, visibleDeckFilter } from '../lib/visibility.js';

const router = express.Router();

// Load a deck only if it belongs to the user; null for a bad id or non-owner.
const findOwnedDeck = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Deck.findOne({ _id: id, owner: userId });
};

// The deck field a form's board value names; anything else means the main deck.
const boardField = (board) => (board === 'considering' ? 'considering' : 'cards');

// `colors` are the boxes to re-tick when a rejected form comes back.
const renderDeckForm = (res, { colors = [], ...extra } = {}) =>
  res.render('deckForm', {
    title: 'New Deck',
    formats: DECK_FORMATS,
    colorOptions: MTG_COLORS.map((value) => ({ value, checked: colors.includes(value) })),
    visibilities: DECK_VISIBILITY,
    ...extra,
  });

router.get('/decks/new', requireAuth, (req, res) => renderDeckForm(res));

router.get('/decks', requireAuth, async (req, res, next) => {
  try {
    const filter = {};
    if (DECK_FORMATS.includes(req.query.format)) filter.format = req.query.format;

    const order = deckSort(req.query.sort);
    const decks = await Deck.find({ $and: [filter, visibleDeckFilter(req.currentUser)] })
      .sort(order.sort)
      .collation(DECK_COLLATION)
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
      ownerName: d.owner?.username ?? null,
      isOwner: d.owner?._id?.toString() === userId,
      isTracked: trackedIds.has(d._id.toString()),
    }));

    res.render('deckBrowse', {
      title: 'Browse Decks',
      decks: rows,
      formats: DECK_FORMATS,
      filter: { format: filter.format ?? '' },
      hasFilter: Boolean(filter.format),
      deckSorts: DECK_SORTS,
      sort: order.value,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/decks', requireAuth, async (req, res, next) => {
  const { name, format, commander, partner, archetype, description } = req.body;
  // Checkboxes arrive as a single string (one box) or an array (several); normalize.
  let colors = req.body.colors ?? [];
  if (!Array.isArray(colors)) colors = [colors];
  colors = colors.filter((c) => MTG_COLORS.includes(c));

  const visibility = DECK_VISIBILITY.includes(req.body.visibility) ? req.body.visibility : 'public';
  const commanderName = (commander || '').trim();
  const partnerName = format === 'Commander' ? (partner || '').trim() : '';

  try {
    // Best-effort: an unrecognized or misspelled commander name just means no
    // image, not a failed deck creation. A pair is stricter: both must be found.
    const lookup = (cardName) => (format === 'Commander' && cardName ? getCardByName(cardName).catch(() => null) : null);
    const [commanderCard, partnerCard] = await Promise.all([lookup(commanderName), lookup(partnerName)]);
    const refusal = partnerName && pairRefusal(commanderCard, partnerCard);
    if (refusal) {
      return renderDeckForm(res.status(400), { colors, hasError: true, deckError: refusal, values: req.body });
    }

    await Deck.create({
      name: (name || '').trim(),
      format,
      owner: req.currentUser._id,
      visibility,
      colors,
      commander: commanderCard?.name ?? (commanderName || undefined),
      commanderImageUrl: commanderCard?.imageUrl || '',
      partner: partnerCard?.name,
      partnerImageUrl: partnerCard?.imageUrl || '',
      archetype: (archetype || '').trim() || undefined,
      description: (description || '').trim() || undefined,
    });
    res.redirect('/dashboard');
  } catch (err) {
    if (err.name === 'ValidationError') {
      return renderDeckForm(res.status(400), {
        colors,
        hasError: true,
        deckError: 'Please provide a name and a valid format.',
        values: req.body,
      });
    }
    next(err);
  }
});

// Commanders live outside deck.cards; they join the list (and the count) only
// on Commander-format decks.
const commandersAndCards = (deck) => {
  const commanders = deck.format !== 'Commander' ? [] : [
    { name: deck.commander, imageUrl: deck.commanderImageUrl },
    { name: deck.partner, imageUrl: deck.partnerImageUrl },
  ].filter((c) => c.name);
  const cards = commanders.reduce((list, c) => withoutCommander(list, c.name), deck.cards || []);
  return { commanders, cards };
};

const decklistText = ({ commanders, cards }) => formatDecklist({ commanders: commanders.map((c) => c.name), cards });

router.get('/decks/:id/export', requireAuth, async (req, res, next) => {
  try {
    const deck = mongoose.Types.ObjectId.isValid(req.params.id) ? await Deck.findById(req.params.id).lean() : null;
    if (!deck || !canSeeDeck(deck, req.currentUser)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    res.attachment(`${deck.name}.txt`).send(decklistText(commandersAndCards(deck)));
  } catch (err) {
    next(err);
  }
});

router.get('/decks/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const deck = await Deck.findById(req.params.id).populate('owner', 'username').lean();
    if (!deck || !canSeeDeck(deck, req.currentUser)) {
      return res.status(404).render('404', { title: 'Not Found' });
    }
    const stats = await getDeckStats(deck._id);
    const isOwner = req.currentUser._id.toString() === deck.owner._id.toString();
    const isTracked = (req.currentUser.trackedDecks || []).some((t) => t.toString() === deck._id.toString());
    const { commanders, cards } = commandersAndCards(deck);
    const cardCount = cards.reduce((sum, c) => sum + c.quantity, 0) + commanders.length;
    const insights = getCardInsights(cards);
    const groupMode = GROUP_MODES.includes(req.query.group) ? req.query.group : 'type';
    const sortDir = req.query.dir === 'desc' ? 'desc' : 'asc';
    // A commander also stored as a card keeps that card's id and note on its row.
    const asCard = ({ name }) => (deck.cards || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
    const cardGroups = groupCards(cards, {
      mode: groupMode,
      descending: sortDir === 'desc',
      commanders: commanders.map((c) => ({ ...asCard(c), ...c })),
    });
    const consideringGroups = isOwner ? groupCards(deck.considering) : [];
    const assistantEnabled = isOwner && Boolean(process.env.ANTHROPIC_API_KEY);
    const exportText = decklistText({ commanders, cards });
    res.render('deckDetail', { title: deck.name, deck, visibilities: DECK_VISIBILITY, stats, isOwner, isTracked, cardCount, insights, cardGroups, consideringGroups, groupMode, sortDir, assistantEnabled, exportText });
  } catch (err) {
    next(err);
  }
});

// Make the next save fail if a second tab changed the commanders since this deck
// was read. Call before changing them: only changed fields are written, so a pair
// checked against stale data could otherwise end up saved half and half.
const COMMANDERS_CHANGED = 'The commanders on this deck just changed. Check them and try again.';
const guardCommanders = (deck) => {
  deck.$where = { commander: deck.commander ?? null, partner: deck.partner ?? null };
};
// Mongoose reports a failed guard as VersionError when the card list changed too.
const isCommandersChanged = (err) => ['DocumentNotFoundError', 'VersionError'].includes(err.name);

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
    consideringGroups: groupCards(plain.considering),
    isCommanderDeck: deck.format === 'Commander',
    ...extra,
  });
};

router.post('/decks/:id/visibility', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });
    if (DECK_VISIBILITY.includes(req.body.visibility)) {
      deck.visibility = req.body.visibility;
      await deck.save();
    }
    res.redirect(`/decks/${deck._id}`);
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
    const board = deck[boardField(req.body.board)];
    const existing = board.find((c) => c.scryfallId === card.scryfallId);
    if (existing) existing.quantity += 1;
    else board.push({ ...card, quantity: 1 });
    await deck.save();

    res.redirect(back);
  } catch (err) {
    next(err);
  }
});

// The deck helper agent (lib/deckAgent.js). JSON in, JSON out. The browser keeps
// the transcript and sends it back with each question; nothing is saved here.
router.post('/decks/:id/assistant', async (req, res, next) => {
  try {
    // A JSON caller can't follow requireAuth's redirect to /login, so say it plainly.
    if (!req.currentUser) return res.status(401).json({ error: 'Your session ended. Log in again to keep chatting.' });
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).json({ error: 'Not found' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'The assistant is not set up.' });

    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    const { messages } = req.body;
    if (!question || question.length > 1000) {
      return res.status(400).json({ error: 'Ask a question of up to 1000 characters.' });
    }
    if (!Array.isArray(messages) || JSON.stringify(messages).length > 300_000) {
      return res.status(400).json({ error: 'This conversation is too long. Reload the page to start over.' });
    }

    let result;
    try {
      result = await runDeckAgent({
        client: new Anthropic(), // reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL in tests)
        deck: deck.toObject(),
        messages,
        question,
        signal: AbortSignal.timeout(60_000), // one budget for the whole question
      });
    } catch (err) {
      console.error('Deck assistant failed:', err);
      return res.status(502).json({ error: 'The assistant is unavailable right now.' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/cards/:scryfallId/remove', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const field = boardField(req.body.board);
    const card = deck[field].find((c) => c.scryfallId === req.params.scryfallId);
    if (card) {
      card.quantity -= 1;
      if (card.quantity <= 0) {
        deck[field] = deck[field].filter((c) => c.scryfallId !== req.params.scryfallId);
      }
      await deck.save();
    }
    res.redirect(`/decks/${deck._id}/cards`);
  } catch (err) {
    next(err);
  }
});

// Move every copy of a card to the board named by `to`, keeping its note.
router.post('/decks/:id/cards/:scryfallId/move', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const to = boardField(req.body.to);
    const from = to === 'cards' ? 'considering' : 'cards';
    const isThisCard = (c) => c.scryfallId === req.params.scryfallId;
    const card = deck[from].find(isThisCard)?.toObject();
    if (card) {
      deck[from] = deck[from].filter((c) => !isThisCard(c));
      const existing = deck[to].find(isThisCard);
      if (existing) {
        existing.quantity += card.quantity;
        // Two different notes are both kept, up to the limit.
        const notes = new Set([existing.note, card.note].filter(Boolean));
        existing.note = [...notes].join('\n\n').slice(0, NOTE_MAX);
      } else {
        deck[to].push(card);
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

// Owner-only page for a private note on one card in a deck.
const NOTE_MAX = 2000;

const findOwnedCard = async (req) => {
  const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
  const card = deck?.cards.find((c) => c.scryfallId === req.params.scryfallId);
  return card ? { deck, card } : null;
};

// `card` is a plain object so a rejected edit can be re-shown with the text the owner typed.
const renderNote = (res, deck, card, extra = {}) =>
  res.render('cardNote', { title: `${card.name} — ${deck.name}`, deck: deck.toObject(), card, noteMax: NOTE_MAX, ...extra });

router.get('/decks/:id/cards/:scryfallId/note', requireAuth, async (req, res, next) => {
  try {
    const found = await findOwnedCard(req);
    if (!found) return res.status(404).render('404', { title: 'Not Found' });
    renderNote(res, found.deck, found.card.toObject());
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/cards/:scryfallId/note', requireAuth, async (req, res, next) => {
  try {
    const found = await findOwnedCard(req);
    if (!found) return res.status(404).render('404', { title: 'Not Found' });
    const { deck, card } = found;

    const note = (typeof req.body.note === 'string' ? req.body.note : '').trim();
    if (note.length > NOTE_MAX) {
      return renderNote(res.status(400), deck, { ...card.toObject(), note }, {
        noteError: `Notes can be at most ${NOTE_MAX} characters.`,
      });
    }
    card.note = note;
    await deck.save();
    res.redirect(`/decks/${deck._id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/import', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const decklist = typeof req.body.decklist === 'string' ? req.body.decklist : '';
    const { cards, commanders } = parseDecklist(decklist);
    const isCommanderDeck = deck.format === 'Commander';
    // A commander line only means something on a Commander deck; elsewhere it's an ordinary card.
    const wanted = isCommanderDeck ? cards : [...cards, ...commanders.map((name) => ({ name, quantity: 1 }))];
    const names = [...cards.map((c) => c.name), ...commanders];

    const fail = (message, notFound = []) =>
      renderManager(res, deck, { importResult: { message, notFound }, importText: decklist });
    if (names.length === 0) return fail('No cards were imported — paste a decklist like "1 Sol Ring".');
    if (names.length > MAX_IMPORT_NAMES) return fail(`No cards were imported — that list has more than ${MAX_IMPORT_NAMES} different cards.`);
    if (isCommanderDeck && commanders.length > 2) return fail('No cards were imported — a deck can have at most two commanders.');

    const found = await getCardsByNames(names);
    const notFound = names.filter((n) => !found.has(n.toLowerCase()));
    const byId = new Map(); // two spellings of one card (e.g. a DFC's front face) merge
    for (const { name, quantity } of wanted) {
      const card = found.get(name.toLowerCase());
      if (!card) continue;
      const entry = byId.get(card.scryfallId);
      if (entry) entry.quantity += quantity;
      else byId.set(card.scryfallId, { ...card, quantity });
    }
    const [commanderCard, partnerCard] = isCommanderDeck ? commanders.map((name) => found.get(name.toLowerCase())) : [];
    const refusal = commanders.length === 2 && isCommanderDeck && pairRefusal(commanderCard, partnerCard);
    if (refusal) return fail(`No cards were imported — ${refusal}`, notFound);
    if (byId.size === 0 && !commanderCard) return fail('No cards were imported — none of those names matched a card.', notFound);

    // Carry notes over to cards that survive the import (matched by name, since
    // the pasted list may name a different printing).
    const notes = new Map(deck.cards.filter((c) => c.note).map((c) => [c.name.toLowerCase(), c.note]));
    // Commanders stay out of the card list, unless their card carries a note to keep.
    for (const card of [commanderCard, partnerCard]) {
      if (card && notes.has(card.name.toLowerCase()) && !byId.has(card.scryfallId)) {
        byId.set(card.scryfallId, { ...card, quantity: 1 });
      }
    }
    for (const c of byId.values()) c.note = notes.get(c.name.toLowerCase()) ?? '';
    deck.cards = [...byId.values()];
    if (commanderCard) {
      guardCommanders(deck);
      deck.commander = commanderCard.name;
      deck.commanderImageUrl = commanderCard.imageUrl;
      // The pasted list replaces the old pair, so a single commander clears the second.
      deck.partner = partnerCard?.name;
      deck.partnerImageUrl = partnerCard?.imageUrl ?? '';
    }
    try {
      await deck.save();
    } catch (err) {
      if (!isCommandersChanged(err)) throw err;
      const current = await findOwnedDeck(deck._id, req.currentUser._id);
      return renderManager(res.status(409), current, { importResult: { message: `No cards were imported — ${COMMANDERS_CHANGED}`, notFound: [] }, importText: decklist });
    }

    const total = deck.cards.reduce((sum, c) => sum + c.quantity, 0);
    const commanderNote = partnerCard
      ? ` with ${commanderCard.name} and ${partnerCard.name} as commanders`
      : commanderCard ? ` with ${commanderCard.name} as commander` : '';
    const message = `Imported ${total} cards${commanderNote}.`;
    renderManager(res, deck, { importResult: { message, notFound } });
  } catch (err) {
    next(err);
  }
});

// Fill one commander slot ('commander' or 'partner'), checking the card against
// whoever holds the other slot.
const setCommanderSlot = (slot, otherSlot) => async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });

    const scryfallId = (req.body.scryfall_id || '').trim();
    const q = (req.body.q || '').trim();
    const back = q ? `/decks/${deck._id}/cards?q=${encodeURIComponent(q)}` : `/decks/${deck._id}/cards`;
    if (deck.format !== 'Commander' || !scryfallId || (slot === 'partner' && !deck.commander)) return res.redirect(back);

    // Re-fetch for the canonical name and art; never trust client-posted card fields.
    const card = await getCardById(scryfallId);
    guardCommanders(deck);
    const refuse = async (status, target, commanderError) => {
      const results = q ? await searchCards(q).catch(() => []) : [];
      return renderManager(res.status(status), target, { commanderError, query: q, searched: Boolean(q), results });
    };
    if (deck[otherSlot]) {
      // Fuzzy, because a commander from the new deck form is stored as typed.
      const otherCard = await getCardByName(deck[otherSlot]).catch(() => null);
      const refusal = pairRefusal(card, otherCard);
      if (refusal) return await refuse(400, deck, refusal);
      deck[otherSlot] = otherCard.name;
      deck[`${otherSlot}ImageUrl`] = otherCard.imageUrl;
    }
    deck[slot] = card.name;
    deck[`${slot}ImageUrl`] = card.imageUrl;
    try {
      await deck.save();
    } catch (err) {
      if (!isCommandersChanged(err)) throw err;
      return await refuse(409, await findOwnedDeck(deck._id, req.currentUser._id), COMMANDERS_CHANGED);
    }

    res.redirect(back);
  } catch (err) {
    next(err);
  }
};

router.post('/decks/:id/commander', requireAuth, setCommanderSlot('commander', 'partner'));
router.post('/decks/:id/partner', requireAuth, setCommanderSlot('partner', 'commander'));

router.post('/decks/:id/partner/remove', requireAuth, async (req, res, next) => {
  try {
    const deck = await findOwnedDeck(req.params.id, req.currentUser._id);
    if (!deck) return res.status(404).render('404', { title: 'Not Found' });
    deck.partner = undefined;
    deck.partnerImageUrl = '';
    await deck.save();
    res.redirect(`/decks/${deck._id}/cards`);
  } catch (err) {
    next(err);
  }
});

router.post('/decks/:id/track', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.redirect('/decks');
    const back = safeBack(req.body.back, `/decks/${req.params.id}`);

    const deck = await Deck.findById(req.params.id).select('owner visibility').lean();
    // Can't track a missing, hidden or own deck.
    if (deck && canSeeDeck(deck, req.currentUser) && deck.owner.toString() !== req.currentUser._id.toString()) {
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
