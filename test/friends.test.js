import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectMongo } from '../config/db.js';
import { User } from '../models/index.js';
import { relation, sendRequest, acceptRequest, declineRequest, cancelRequest, unfriend } from '../lib/friends.js';

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_friends_unit_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
});
after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let n = 0;
const mk = () => User.create({ username: `fu${++n}`, passwordHash: 'x' });
const get = (u) => User.findById(u._id).lean();

test('relation covers every state', () => {
  const A = new mongoose.Types.ObjectId();
  const B = new mongoose.Types.ObjectId();
  const t = { _id: A, friends: [], friendRequests: [] };
  assert.equal(relation(undefined, t), 'anon');
  assert.equal(relation({ _id: A }, t), 'self');
  assert.equal(relation({ _id: B, friends: [A] }, t), 'friends');
  assert.equal(relation({ _id: B, friends: [], friendRequests: [A] }, t), 'received');
  assert.equal(relation({ _id: B, friends: [], friendRequests: [] }, { ...t, friendRequests: [B] }), 'sent');
  assert.equal(relation({ _id: B, friends: [], friendRequests: [] }, t), 'none');
});

test('send then accept makes both sides friends and clears the request', async () => {
  const [a, b] = [await mk(), await mk()];
  await sendRequest(a._id, b._id);
  assert.equal((await get(b)).friendRequests.length, 1);
  await acceptRequest(b._id, a._id);
  const [ra, rb] = [await get(a), await get(b)];
  assert.equal(rb.friendRequests.length, 0);
  assert.deepEqual(ra.friends.map(String), [String(b._id)]);
  assert.deepEqual(rb.friends.map(String), [String(a._id)]);
});

test('crossing requests become a friendship immediately', async () => {
  const [a, b] = [await mk(), await mk()];
  await sendRequest(a._id, b._id);
  await sendRequest(b._id, a._id);
  const [ra, rb] = [await get(a), await get(b)];
  assert.equal(ra.friends.length, 1);
  assert.equal(rb.friends.length, 1);
  assert.equal(ra.friendRequests.length + rb.friendRequests.length, 0);
});

test('decline and cancel remove the pending request only', async () => {
  const [a, b, c] = [await mk(), await mk(), await mk()];
  await sendRequest(a._id, b._id);
  await declineRequest(b._id, a._id);
  assert.equal((await get(b)).friendRequests.length, 0);
  await sendRequest(a._id, c._id);
  await cancelRequest(a._id, c._id);
  assert.equal((await get(c)).friendRequests.length, 0);
  assert.equal((await get(a)).friends.length + (await get(b)).friends.length, 0);
});

test('unfriend removes both sides', async () => {
  const [a, b] = [await mk(), await mk()];
  await sendRequest(a._id, b._id);
  await acceptRequest(b._id, a._id);
  await unfriend(a._id, b._id);
  assert.equal((await get(a)).friends.length + (await get(b)).friends.length, 0);
});

test('friend actions ignore self, duplicates and missing requests', async () => {
  const [a, b, c] = [await mk(), await mk(), await mk()];
  await sendRequest(a._id, a._id);
  assert.equal((await get(a)).friendRequests.length, 0);
  await sendRequest(a._id, b._id);
  await sendRequest(a._id, b._id);
  assert.equal((await get(b)).friendRequests.length, 1);
  await acceptRequest(b._id, c._id);
  assert.equal((await get(b)).friends.length + (await get(c)).friends.length, 0);
});
