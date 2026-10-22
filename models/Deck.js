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

// One card entry embedded in a deck — a snapshot of Scryfall data taken on add,
// so deck views never need to call Scryfall. No own _id; identity is scryfallId.
const cardSchema = new mongoose.Schema(
  {
    scryfallId: { type: String, required: true },
    name: { type: String, required: true },
    manaCost: { type: String, default: '' },
    cmc: { type: Number, default: 0 },
    colors: [{ type: String }],
    typeLine: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    quantity: { type: Number, default: 1, min: 1 },
    // The owner's private note on this card in this deck.
    note: { type: String, default: '', maxlength: 2000 },
  },
  { _id: false }
);

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
    // Scryfall image for the commander, fetched by name when the deck is created.
    commanderImageUrl: {
      type: String,
      default: '',
    },
    archetype: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
    },
    // Card list, built from Scryfall via the deck's Manage Cards page.
    cards: [cardSchema],
  },
  { timestamps: true }
);

export const Deck = mongoose.model('Deck', deckSchema);
