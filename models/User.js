import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    // Uniqueness is enforced by the case-insensitive collation index below,
    // not by `unique: true` here (which would add a second, case-sensitive index).
    username: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    // Always store a bcrypt hash, never the raw password.
    passwordHash: {
      type: String,
      required: true,
    },
    // Decks this user follows but does not own (the dashboard's "Tracked Decks").
    trackedDecks: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Deck',
      },
    ],
  },
  { timestamps: true }
);

// Case-insensitive uniqueness so "Bob" and "bob" can't both register.
userSchema.index(
  { username: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

// Hash and assign the password. Call before saving a new/updated credential.
userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, SALT_ROUNDS);
};

// Compare a candidate password against the stored hash.
userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

// Never leak the hash when serializing (e.g. res.json or template context).
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
