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
  await Playgroup.updateOne({ _id: group._id }, { $addToSet: { invites: target._id } });
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

// The owner can't leave; they delete the group instead.
export const leave = (groupId, userId) =>
  Playgroup.updateOne({ _id: groupId, owner: { $ne: userId } }, { $pull: { members: userId } });

export const removeMember = async (groupId, ownerId, memberId) => {
  if (String(ownerId) === String(memberId)) return;
  await Playgroup.updateOne({ _id: groupId, owner: ownerId }, { $pull: { members: memberId } });
};

export const rename = (groupId, ownerId, name) =>
  Playgroup.updateOne({ _id: groupId, owner: ownerId }, { $set: { name } });

// Games stay; they just lose the tag.
export const deletePlaygroup = async (groupId, ownerId) => {
  if (!(await Playgroup.exists({ _id: groupId, owner: ownerId }))) return;
  await GameRecord.updateMany({ playgroup: groupId }, { $unset: { playgroup: 1 } });
  await Playgroup.deleteOne({ _id: groupId });
};
