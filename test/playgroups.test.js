import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { app } from '../app.js';
import { connectMongo } from '../config/db.js';
import { Deck, GameRecord, Playgroup, User } from '../models/index.js';
import * as pg from '../lib/playgroups.js';
import { getPlayerLeaderboard, getDeckLeaderboard, maskHiddenDecks } from '../lib/leaderboards.js';

// One isolated cookie jar + request helper per client, as in profiles.test.js.
const makeClient = () => {
  const cookies = new Map();
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  };
  const request = async (method, path, form) => {
    const headers = {};
    if (cookies.size) headers.cookie = cookieHeader();
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) {
        if (Array.isArray(value)) for (const v of value) params.append(key, v);
        else params.append(key, value);
      }
      body = params.toString();
    }
    const res = await fetch(baseUrl + path, { method, headers, body, redirect: 'manual' });
    store(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  };
  return { request };
};

let baseUrl;
let server;

const registerClient = async (username) => {
  const c = makeClient();
  await c.request('POST', '/register', { username_input: username, password_input: 'hunter2hunter' });
  return c;
};

// Users created straight in the DB, for lib-level tests.
const mkUser = async (username) => {
  const u = new User({ username });
  await u.setPassword('hunter2hunter');
  return u.save();
};

const befriend = (a, b) =>
  Promise.all([
    User.updateOne({ _id: a._id }, { $addToSet: { friends: b._id } }),
    User.updateOne({ _id: b._id }, { $addToSet: { friends: a._id } }),
  ]);

const mkGame = (user, deck, extra = {}) =>
  GameRecord.create({ user: user._id, deck: deck._id, result: 'win', opponents: [{ name: 'Zed', deck: 'Goblins' }], ...extra });

before(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/mtg_tracker_playgroups_test';
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

// --- Task 1: filtered leaderboards ---

test('leaderboards filtered by playgroup count only tagged games; unfiltered count all', async () => {
  const a = await mkUser('LbAnn');
  const b = await mkUser('LbBen');
  const da = await Deck.create({ name: 'LbDeckA', format: 'Modern', owner: a._id });
  const db = await Deck.create({ name: 'LbDeckB', format: 'Modern', owner: b._id });
  const dUntagged = await Deck.create({ name: 'LbDeckC', format: 'Modern', owner: b._id });
  const g = await Playgroup.create({ name: 'LbPod', owner: a._id, members: [a._id, b._id] });
  await mkGame(a, da, { playgroup: g._id });
  await mkGame(a, da);
  await mkGame(b, db, { playgroup: g._id });
  await mkGame(b, dUntagged);

  const players = await getPlayerLeaderboard({ playgroup: g._id });
  assert.deepEqual(players.map((r) => r.username).sort(), ['LbAnn', 'LbBen']);
  for (const r of players) assert.equal(r.wins + r.losses + r.draws, 1);

  const all = await getPlayerLeaderboard();
  assert.equal(all.find((r) => r.username === 'LbAnn').wins, 2);

  const decks = await getDeckLeaderboard({ playgroup: g._id });
  assert.deepEqual(decks.map((r) => r.deckName).sort(), ['LbDeckA', 'LbDeckB']);
});

test('maskHiddenDecks hides a private deck from a non-owner', () => {
  const owner = new mongoose.Types.ObjectId();
  const viewer = { _id: new mongoose.Types.ObjectId(), friends: [] };
  const [row] = maskHiddenDecks([{ deckName: 'Secret', ownerId: owner, visibility: 'private', wins: 1 }], viewer);
  assert.equal(row.hidden, true);
  assert.equal('deckName' in row, false);
  assert.equal(row.wins, 1);
});

// --- Task 2: membership operations ---

const reload = (g) => Playgroup.findById(g._id).lean();
const ids = (list) => list.map(String);
// The full viewer shape invite() expects (friends loaded).
const asViewer = (u) => User.findById(u._id).lean();

test('cleanName trims and enforces 1–60 chars', () => {
  assert.equal(pg.cleanName('  '), null);
  assert.equal(pg.cleanName('x'.repeat(61)), null);
  assert.equal(pg.cleanName('  Pod  '), 'Pod');
  assert.equal(pg.cleanName(undefined), null);
});

test('invite: friends get invited (any case), everyone else gets a reason', async () => {
  const owner = await mkUser('InvOwner');
  const bob = await mkUser('InvBob');
  const stranger = await mkUser('InvStranger');
  const oneSided = await mkUser('InvOneSided');
  await befriend(owner, bob);
  await User.updateOne({ _id: owner._id }, { $addToSet: { friends: oneSided._id } });
  const g = await pg.createPlaygroup(owner._id, 'InvPod');
  const viewer = await asViewer(owner);

  assert.equal(await pg.invite(g, viewer, 'invbob'), null);
  assert.deepEqual(ids((await reload(g)).invites), [String(bob._id)]);
  assert.equal(await pg.invite(g, viewer, 'InvBob'), 'InvBob has already been invited.');
  assert.equal(await pg.invite(g, viewer, 'Nobody'), 'No player named "Nobody".');
  assert.equal(await pg.invite(g, viewer, 'InvStranger'), 'You can only invite your friends.');
  assert.equal(await pg.invite(g, viewer, 'InvOneSided'), 'You can only invite your friends.');
  await befriend(owner, stranger);
  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { members: stranger._id } });
  assert.equal(await pg.invite(g, await asViewer(owner), 'invstranger'), 'InvStranger is already in this playgroup.');
});

test('acceptInvite moves an invitee into members; a non-invitee changes nothing', async () => {
  const owner = await mkUser('AccOwner');
  const inv = await mkUser('AccInvitee');
  const other = await mkUser('AccOther');
  const g = await pg.createPlaygroup(owner._id, 'AccPod');
  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { invites: inv._id } });

  await pg.acceptInvite(g._id, other._id);
  assert.deepEqual(ids((await reload(g)).members), [String(owner._id)]);
  await pg.acceptInvite(g._id, inv._id);
  const after1 = await reload(g);
  assert.deepEqual(ids(after1.members), [String(owner._id), String(inv._id)]);
  assert.deepEqual(after1.invites, []);

  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { invites: other._id } });
  await pg.declineInvite(g._id, other._id);
  assert.deepEqual((await reload(g)).invites, []);
});

test('leave and removeMember never take out the owner', async () => {
  const owner = await mkUser('LvOwner');
  const m1 = await mkUser('LvM1');
  const m2 = await mkUser('LvM2');
  const g = await pg.createPlaygroup(owner._id, 'LvPod');
  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { members: { $each: [m1._id, m2._id] } } });

  await pg.leave(g._id, owner._id);
  assert.equal((await reload(g)).members.length, 3);
  await pg.leave(g._id, m1._id);
  assert.deepEqual(ids((await reload(g)).members), [String(owner._id), String(m2._id)]);

  await pg.removeMember(g._id, owner._id, owner._id);
  await pg.removeMember(g._id, m2._id, owner._id);
  assert.equal((await reload(g)).members.length, 2);
  await pg.removeMember(g._id, owner._id, m2._id);
  assert.deepEqual(ids((await reload(g)).members), [String(owner._id)]);
});

test('rename and deletePlaygroup are owner-only; delete untags games', async () => {
  const owner = await mkUser('DelOwner');
  const m = await mkUser('DelMember');
  const deck = await Deck.create({ name: 'DelDeck', format: 'Modern', owner: m._id });
  const g = await pg.createPlaygroup(owner._id, 'DelPod');
  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { members: m._id } });
  const game = await mkGame(m, deck, { playgroup: g._id });

  await pg.rename(g._id, m._id, 'Hijacked');
  assert.equal((await reload(g)).name, 'DelPod');
  await pg.rename(g._id, owner._id, 'Renamed');
  assert.equal((await reload(g)).name, 'Renamed');

  await pg.deletePlaygroup(g._id, m._id);
  assert.ok(await reload(g));
  await pg.deletePlaygroup(g._id, owner._id);
  assert.equal(await reload(g), null);
  const left = await GameRecord.findById(game._id).lean();
  assert.ok(left);
  assert.equal(left.playgroup, undefined);
});

test('findMemberGroup is null for a malformed id, a missing group, or a non-member', async () => {
  const owner = await mkUser('FmOwner');
  const out = await mkUser('FmOut');
  const g = await pg.createPlaygroup(owner._id, 'FmPod');
  assert.equal((await pg.findMemberGroup(g._id, owner._id)).name, 'FmPod');
  assert.equal(await pg.findMemberGroup(g._id, out._id), null);
  assert.equal(await pg.findMemberGroup('not-an-id', owner._id), null);
  assert.equal(await pg.findMemberGroup(new mongoose.Types.ObjectId(), owner._id), null);
});
