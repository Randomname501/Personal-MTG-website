import mongoose from 'mongoose';

export const GAME_RESULTS = ['win', 'loss', 'draw'];

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
    // Opponent's deck as free text — there is no opponent User in this tracker.
    opponentDeck: {
      type: String,
      required: true,
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

export const GameRecord = mongoose.model('GameRecord', gameRecordSchema);
