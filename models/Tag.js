import mongoose from 'mongoose';

export const TAG_NAME_MAX = 40;

// A player's own label. It holds what it's assigned to, so renaming or deleting a
// tag touches one document. Cards are held by name: a tag on a card applies in every
// one of the owner's decks, and survives re-imports that change the printing.
const tagSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: TAG_NAME_MAX },
    decks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deck' }],
    cards: [{ type: String }],
  },
  { timestamps: true }
);

// One tag per name per player, ignoring case.
tagSchema.index({ owner: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export const Tag = mongoose.model('Tag', tagSchema);
