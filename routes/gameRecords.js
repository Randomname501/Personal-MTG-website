import express from 'express';
import mongoose from 'mongoose';
import { Deck, GameRecord, GAME_RESULTS, MAX_OPPONENTS, opponentList } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// The form posts opponents[0][name], opponents[1][name], … which the qs body
// parser turns into an array — but into an object keyed "0", "1", … whenever the
// indices are sparse or out of order. Normalize both to a plain array.
const submittedOpponents = (body) => {
  const raw = body?.opponents;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
};

// Trim every opponent and reject the set unless there are 1..MAX_OPPONENTS of
// them, each with both a name and a deck. Returns null when invalid.
const resolveOpponents = (body) => {
  const opponents = submittedOpponents(body).map((o) => ({
    name: (o?.name || '').trim(),
    deck: (o?.deck || '').trim(),
  }));
  if (opponents.length < 1 || opponents.length > MAX_OPPONENTS) return null;
  if (opponents.some((o) => !o.name || !o.deck)) return null;
  return opponents;
};

// Validate a game-record submission for a user. Returns the owned deck, the
// opponents, and the result on success; null if anything is invalid.
const resolveGameInput = async ({ deckId, body, result }, userId) => {
  const opponents = resolveOpponents(body);
  if (!opponents || !GAME_RESULTS.includes(result)) return null;
  if (!mongoose.Types.ObjectId.isValid(deckId)) return null;
  const deck = await Deck.findOne({ _id: deckId, owner: userId });
  if (!deck) return null;
  return { deck, opponents, result };
};

// What the opponent fieldsets should be pre-filled with when a form re-renders
// after a validation failure — the user's own input, never silently discarded.
const echoOpponents = (body) => {
  const submitted = submittedOpponents(body).map((o) => ({
    name: (o?.name || '').trim(),
    deck: (o?.deck || '').trim(),
  }));
  return submitted.length ? submitted : [{ name: '', deck: '' }];
};

// Load a record only if it belongs to the user; null for a bad id or non-owner.
const findOwnedRecord = async (id, userId) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return GameRecord.findOne({ _id: id, user: userId });
};

// The user's decks, name-sorted and lean — for the filter bar and the edit form's select.
const listOwnedDecks = (userId) => Deck.find({ owner: userId }).sort({ name: 1 }).lean();

// Match history: the user's games, newest-first, with optional deck/result filters.
router.get('/game-records', requireAuth, async (req, res, next) => {
  try {
    const userId = req.currentUser._id;
    const decks = await listOwnedDecks(userId);

    const filter = { user: userId };
    const deckIds = new Set(decks.map((d) => d._id.toString()));
    if (req.query.deck && deckIds.has(req.query.deck)) filter.deck = req.query.deck;
    if (GAME_RESULTS.includes(req.query.result)) filter.result = req.query.result;

    const records = await GameRecord.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .populate('deck', 'name')
      .lean();
    // Normalize here so the view never has to know about the legacy field.
    const games = records.map((g) => ({ ...g, opponents: opponentList(g) }));

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
      { deckId: req.body.deck_id, body: req.body, result: req.body.result },
      req.currentUser._id
    );
    // Silently ignore invalid quick-log input, matching prior behavior.
    if (!input) return res.redirect('/dashboard');

    await GameRecord.create({
      user: req.currentUser._id,
      deck: input.deck._id,
      opponents: input.opponents,
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

    const decks = await listOwnedDecks(req.currentUser._id);
    res.render('gameRecordForm', {
      title: 'Edit Game',
      decks,
      results: GAME_RESULTS,
      maxOpponents: MAX_OPPONENTS,
      values: {
        id: record._id.toString(),
        deck: record.deck.toString(),
        // A legacy record surfaces as one row with a blank name; saving the
        // form then writes it forward into the new shape.
        opponents: opponentList(record),
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
      { deckId: req.body.deck_id, body: req.body, result: req.body.result },
      req.currentUser._id
    );
    if (!input) {
      const decks = await listOwnedDecks(req.currentUser._id);
      return res.status(400).render('gameRecordForm', {
        title: 'Edit Game',
        hasError: true,
        recordError: `Please pick one of your decks, choose a result, and give every opponent (up to ${MAX_OPPONENTS}) both a name and a deck.`,
        decks,
        results: GAME_RESULTS,
        maxOpponents: MAX_OPPONENTS,
        values: {
          id: record._id.toString(),
          deck: (req.body.deck_id || '').toString(),
          opponents: echoOpponents(req.body),
          result: req.body.result || '',
        },
      });
    }

    record.deck = input.deck._id;
    record.opponents = input.opponents;
    // Saving migrates a legacy record forward; drop the superseded field.
    record.opponentDeck = undefined;
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

    res.render('gameRecordDelete', {
      title: 'Delete Game',
      record: { ...record, opponents: opponentList(record) },
    });
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
