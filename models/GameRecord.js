import mongoose from 'mongoose';

export const GAME_RESULTS = ['win', 'loss', 'draw'];

// A game may be a 1v1 or a multiplayer pod; 5 opponents covers a six-seat table.
export const MAX_OPPONENTS = 5;

// One seat at the table: who they were and what they were piloting. Neither is
// an account — both are free text, same as the deck string always was.
const opponentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    deck: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const gameRecordSchema = new mongoose.Schema(
  {
    // Who logged the game (taken from the session, not the form).
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // The deck played (the form's deck_id).
    deck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Deck',
      required: true,
    },
    // Everyone else at the table. New records always write this.
    opponents: {
      type: [opponentSchema],
      default: [],
    },
    // Legacy: records written before opponents had names stored a single deck
    // string here. Read-only — nothing writes it any more. Read it through
    // opponentList() below rather than touching it directly.
    opponentDeck: {
      type: String,
      trim: true,
    },
    result: {
      type: String,
      required: true,
      enum: GAME_RESULTS,
    },
  },
  { timestamps: true }
);

// Speed up the leaderboard aggregations, which group by deck/user and split on result.
gameRecordSchema.index({ deck: 1, result: 1 });
gameRecordSchema.index({ user: 1, result: 1 });

// The only place that knows a record may be in either shape. Every consumer —
// views, routes, stats — reads opponents through this, so the legacy field
// never has to be handled twice.
export const opponentList = (record) => {
  if (record.opponents?.length) {
    return record.opponents.map((o) => ({ name: o.name, deck: o.deck }));
  }
  const legacy = (record.opponentDeck || '').trim();
  return legacy ? [{ name: '', deck: legacy }] : [];
};

export const GameRecord = mongoose.model('GameRecord', gameRecordSchema);
