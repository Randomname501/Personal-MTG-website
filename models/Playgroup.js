import mongoose from 'mongoose';

export const PLAYGROUP_NAME_MAX = 60;

const playgroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: PLAYGROUP_NAME_MAX },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Includes the owner.
    members: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], index: true },
    // Pending invitees.
    invites: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], index: true },
  },
  { timestamps: true },
);

export const Playgroup = mongoose.models.Playgroup ?? mongoose.model('Playgroup', playgroupSchema);
