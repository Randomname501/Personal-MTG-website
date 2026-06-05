import mongoose from 'mongoose';

export const DECK_FORMATS = [
  'Commander',
  'Standard',
  'Modern',
  'Pioneer',
  'Legacy',
  'Vintage',
  'Pauper',
  'Limited',
  'Other',
];

export const MTG_COLORS = ['W', 'U', 'B', 'R', 'G'];

const deckSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    format: {
      type: String,
      required: true,
      enum: DECK_FORMATS,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Color identity, e.g. ['U', 'B'] for a Dimir deck.
    colors: [
      {
        type: String,
        enum: MTG_COLORS,
      },
    ],
    commander: {
      type: String,
      trim: true,
    },
    archetype: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
    },
  },
  { timestamps: true }
);

export const Deck = mongoose.model('Deck', deckSchema);
