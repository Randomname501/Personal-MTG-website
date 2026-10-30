import { User } from '../models/index.js';

const has = (list, id) => (list ?? []).some((x) => String(x) === String(id));

export const relation = (viewer, target) => {
  if (!viewer) return 'anon';
  if (String(viewer._id) === String(target._id)) return 'self';
  if (has(viewer.friends, target._id)) return 'friends';
  if (has(viewer.friendRequests, target._id)) return 'received';
  if (has(target.friendRequests, viewer._id)) return 'sent';
  return 'none';
};

// Friendship counts only when both users list each other. Accept and unfriend write
// the two users separately, so a race between them can leave a one-sided entry;
// this makes such an entry grant nothing.
export const mutualFriends = (user) =>
  User.find({ _id: { $in: user.friends ?? [] }, friends: user._id }).distinct('_id');

export const acceptRequest = async (userId, fromId) => {
  const r = await User.updateOne(
    { _id: userId, friendRequests: fromId },
    { $pull: { friendRequests: fromId }, $addToSet: { friends: fromId } },
  );
  if (r.modifiedCount === 1) {
    await User.updateOne({ _id: fromId }, { $addToSet: { friends: userId }, $pull: { friendRequests: userId } });
  }
};

export const sendRequest = async (fromId, toId) => {
  if (String(fromId) === String(toId)) return;
  const to = await User.findOne({ _id: toId }, 'friends friendRequests').lean();
  if (!to || has(to.friends, fromId)) return;
  if (await User.exists({ _id: fromId, friendRequests: toId })) return acceptRequest(fromId, toId);
  await User.updateOne({ _id: toId }, { $addToSet: { friendRequests: fromId } });
};

export const declineRequest = (userId, fromId) =>
  User.updateOne({ _id: userId }, { $pull: { friendRequests: fromId } });

export const cancelRequest = (fromId, toId) =>
  User.updateOne({ _id: toId }, { $pull: { friendRequests: fromId } });

export const unfriend = async (aId, bId) => {
  await User.updateOne({ _id: aId }, { $pull: { friends: bId } });
  await User.updateOne({ _id: bId }, { $pull: { friends: aId } });
};
