import mongoose from 'mongoose';

export const COMMENT_MAX = 1000;

const commentSchema = new mongoose.Schema(
  {
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: COMMENT_MAX },
  },
  { timestamps: true },
);

export const Comment = mongoose.models.Comment ?? mongoose.model('Comment', commentSchema);
