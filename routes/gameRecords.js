import express from 'express';
import mongoose from 'mongoose';
import { Deck, GameRecord, Playgroup, GAME_RESULTS, MAX_OPPONENTS, opponentList } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { listMemberGroups } from '../lib/playgroups.js';
import { gamesToCsv } from '../lib/gameCsv.js';

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

// A submitted playgroup must be one the user is in, or the record's existing
// tag (keepPlaygroup), so an unchanged tag survives leaving the group. Returns
// the id, null for none, or false when invalid.
const resolvePlaygroup = async (playgroupId, keepPlaygroup, userId) => {
  if (!playgroupId) return null;
  if (keepPlaygroup && String(playgroupId) === String(keepPlaygroup)) return keepPlaygroup;
  if (!mongoose.Types.ObjectId.isValid(playgroupId)) return false;
  const group = await Playgroup.exists({ _id: playgroupId, members: userId });
  return group ? group._id : false;
};

// Validate a game-record submission for a user. Returns the owned deck, the
// opponents, the result and the playgroup (or null) on success; null if
// anything is invalid.
const resolveGameInput = async ({ deckId, body, result, playgroupId, keepPlaygroup }, userId) => {
  const opponents = resolveOpponents(body);
  if (!opponents || !GAME_RESULTS.includes(result)) return null;
  if (!mongoose.Types.ObjectId.isValid(deckId)) return null;
  const deck = await Deck.findOne({ _id: deckId, owner: userId });
  if (!deck) return null;
  const playgroup = await resolvePlaygroup(playgroupId, keepPlaygroup, userId);
  if (playgroup === false) return null;
  return { deck, opponents, result, playgroup };
};

// The edit form's playgroup options: groups the user is in, plus the record's
// current group if they have since left it.
const playgroupOptions = async (userId, currentId) => {
  const groups = await listMemberGroups(userId);
  if (currentId && !groups.some((g) => String(g._id) === String(currentId))) {
    const current = await Playgroup.findById(currentId).select('name').lean();
    if (current) groups.unshift(current);
  }
  return groups;
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

// The user's games, newest-first, with optional deck/result filters from the query.
const loadHistory = async (userId, query) => {
  const decks = await listOwnedDecks(userId);

  const filter = { user: userId };
  const deckIds = new Set(decks.map((d) => d._id.toString()));
  if (query.deck && deckIds.has(query.deck)) filter.deck = query.deck;
  if (GAME_RESULTS.includes(query.result)) filter.result = query.result;

  const records = await GameRecord.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .populate('deck', 'name')
    .lean();
  // Normalize here so consumers never have to know about the legacy field.
  return { decks, filter, games: records.map((g) => ({ ...g, opponents: opponentList(g) })) };
};

// Match history as a CSV download, narrowed by the same filters as the page.
router.get('/game-records/export', requireAuth, async (req, res, next) => {
  try {
    const { games } = await loadHistory(req.currentUser._id, req.query);
    res.attachment('game-history.csv').send(gamesToCsv(games));
  } catch (err) {
    next(err);
  }
});

router.get('/game-records', requireAuth, async (req, res, next) => {
  try {
    const { decks, filter, games } = await loadHistory(req.currentUser._id, req.query);

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
    const fields = { deckId: req.body.deck_id, body: req.body, result: req.body.result };
    // A stale playgroup (the user was just removed, or it was deleted) shouldn't
    // cost them the game: fall back to saving it untagged.
    const input =
      (await resolveGameInput({ ...fields, playgroupId: req.body.playgroup_id }, req.currentUser._id)) ??
      (req.body.playgroup_id ? await resolveGameInput(fields, req.currentUser._id) : null);
    // Silently ignore invalid quick-log input, matching prior behavior.
    if (!input) return res.redirect('/dashboard');

    await GameRecord.create({
      user: req.currentUser._id,
      deck: input.deck._id,
      opponents: input.opponents,
      result: input.result,
      playgroup: input.playgroup ?? undefined,
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

    const [decks, playgroups] = await Promise.all([
      listOwnedDecks(req.currentUser._id),
      playgroupOptions(req.currentUser._id, record.playgroup),
    ]);
    res.render('gameRecordForm', {
      title: 'Edit Game',
      decks,
      playgroups,
      results: GAME_RESULTS,
      maxOpponents: MAX_OPPONENTS,
      values: {
        id: record._id.toString(),
        deck: record.deck.toString(),
        // A legacy record surfaces as one row with a blank name; saving the
        // form then writes it forward into the new shape.
        opponents: opponentList(record),
        result: record.result,
        playgroup: record.playgroup ? String(record.playgroup) : '',
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
      {
        deckId: req.body.deck_id,
        body: req.body,
        result: req.body.result,
        playgroupId: req.body.playgroup_id,
        keepPlaygroup: record.playgroup,
      },
      req.currentUser._id
    );
    if (!input) {
      const [decks, playgroups] = await Promise.all([
        listOwnedDecks(req.currentUser._id),
        playgroupOptions(req.currentUser._id, record.playgroup),
      ]);
      return res.status(400).render('gameRecordForm', {
        title: 'Edit Game',
        hasError: true,
        recordError: `Please pick one of your decks and playgroups, choose a result, and give every opponent (up to ${MAX_OPPONENTS}) both a name and a deck.`,
        decks,
        playgroups,
        results: GAME_RESULTS,
        maxOpponents: MAX_OPPONENTS,
        values: {
          id: record._id.toString(),
          deck: (req.body.deck_id || '').toString(),
          opponents: echoOpponents(req.body),
          result: req.body.result || '',
          playgroup: (req.body.playgroup_id || '').toString(),
        },
      });
    }

    record.deck = input.deck._id;
    record.opponents = input.opponents;
    // Saving migrates a legacy record forward; drop the superseded field.
    record.opponentDeck = undefined;
    record.result = input.result;
    record.playgroup = input.playgroup ?? undefined;
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
