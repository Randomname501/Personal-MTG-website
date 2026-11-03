import mongoose from 'mongoose';
import { GameRecord, Playgroup, PLAYGROUP_NAME_MAX } from '../models/index.js';
import { findUserByName, mutualFriends } from './friends.js';

const has = (list, id) => (list ?? []).some((x) => String(x) === String(id));

// Trimmed name, or null when empty or too long.
export const cleanName = (raw) => {
  const name = String(raw ?? '').trim();
  return name && name.length <= PLAYGROUP_NAME_MAX ? name : null;
};

// The group, only if userId is a member; null for a bad id, missing group or outsider.
export const findMemberGroup = (id, userId) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return Playgroup.findOne({ _id: id, members: userId }).lean();
};

// Groups the user belongs to, for the game forms' playgroup select.
export const listMemberGroups = (userId) =>
  Playgroup.find({ members: userId }).select('name').sort({ name: 1 }).lean();

export const createPlaygroup = (ownerId, name) =>
  Playgroup.create({ name, owner: ownerId, members: [ownerId] });

// Invite a mutual friend of the inviter by username. Returns an error message, or null.
export const invite = async (group, inviter, username) => {
  const target = await findUserByName(String(username ?? '').trim());
  if (!target) return `No player named "${String(username ?? '').trim()}".`;
  if (!has(await mutualFriends(inviter), target._id)) return 'You can only invite your friends.';
  const fresh = await Playgroup.findById(group._id, 'members invites').lean();
  if (has(fresh?.members, target._id)) return `${target.username} is already in this playgroup.`;
  if (has(fresh?.invites, target._id)) return `${target.username} has already been invited.`;
  // Re-check both sides in the write itself: the inviter must still be a member
  // and the target must not have become one since the read above.
  await Playgroup.updateOne(
    { _id: group._id, members: { $all: [inviter._id], $ne: target._id } },
    { $addToSet: { invites: target._id } },
  );
  return null;
};

// Filtered on the invite, so it applies at most once.
export const acceptInvite = (groupId, userId) =>
  Playgroup.updateOne(
    { _id: groupId, invites: userId },
    { $pull: { invites: userId }, $addToSet: { members: userId } },
  );

export const declineInvite = (groupId, userId) =>
  Playgroup.updateOne({ _id: groupId }, { $pull: { invites: userId } });

// Any member can take back a pending invite.
export const cancelInvite = (groupId, memberId, inviteeId) =>
  Playgroup.updateOne({ _id: groupId, members: memberId }, { $pull: { invites: inviteeId } });

// The owner can't leave; they delete the group instead.
export const leave = (groupId, userId) =>
  Playgroup.updateOne({ _id: groupId, owner: { $ne: userId } }, { $pull: { members: userId } });

export const removeMember = async (groupId, ownerId, memberId) => {
  if (String(ownerId) === String(memberId)) return;
  // Drop any stray invite too, so a removed member can't accept their way back in.
  await Playgroup.updateOne({ _id: groupId, owner: ownerId }, { $pull: { members: memberId, invites: memberId } });
};

export const rename = (groupId, ownerId, name) =>
  Playgroup.updateOne({ _id: groupId, owner: ownerId }, { $set: { name } });

// Games stay; they just lose the tag.
export const deletePlaygroup = async (groupId, ownerId) => {
  // Delete first so no new tag can be approved, then untag.
  const { deletedCount } = await Playgroup.deleteOne({ _id: groupId, owner: ownerId });
  if (deletedCount) await GameRecord.updateMany({ playgroup: groupId }, { $unset: { playgroup: 1 } });
};
