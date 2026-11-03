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

// --- Task 3: routes and pages ---

const idFrom = (location) => location.split('/').pop();

test('create a playgroup, see it; empty names are refused', async () => {
  const c = await registerClient('RtCreator');
  const res = await c.request('POST', '/playgroups', { name: 'Friday Pod' });
  assert.equal(res.status, 302);
  assert.match(res.location, /^\/playgroups\/[0-9a-f]{24}$/);
  const page = await c.request('GET', res.location);
  assert.equal(page.status, 200);
  assert.match(page.text, /Friday Pod/);
  assert.match((await c.request('GET', '/playgroups')).text, /Friday Pod/);

  const bad = await c.request('POST', '/playgroups', { name: '  ' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Playgroup names must be 1–60 characters\./);
});

test('non-members and bad ids get 404 without the name; anonymous goes to login', async () => {
  const owner = await registerClient('RtOwner404');
  const out = await registerClient('RtOutsider');
  const { location } = await owner.request('POST', '/playgroups', { name: 'Secret Pod' });
  const res = await out.request('GET', location);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /Secret Pod/);
  assert.equal((await makeClient().request('GET', location)).location, '/login');
  assert.equal((await owner.request('GET', '/playgroups/not-an-id')).status, 404);
  for (const action of ['invite', 'accept', 'decline', 'leave', 'remove', 'rename', 'delete']) {
    const r = await owner.request('POST', `/playgroups/not-an-id/${action}`, { username: 'x', name: 'x' });
    assert.notEqual(r.status, 500, action);
  }
  const outsiderInvite = await out.request('POST', `${location}/invite`, { username: 'RtOwner404' });
  assert.equal(outsiderInvite.status, 404);
});

test('invite, accept, and the invite errors over HTTP', async () => {
  const owner = await registerClient('RtHost');
  const friend = await registerClient('RtGuest');
  await registerClient('RtNobodyFriend');
  await owner.request('POST', '/users/RtGuest/friend');
  await friend.request('POST', '/users/RtHost/accept');
  const { location } = await owner.request('POST', '/playgroups', { name: 'Guest Pod' });

  const inv = await owner.request('POST', `${location}/invite`, { username: 'rtguest' });
  assert.equal(inv.status, 302);
  assert.match((await friend.request('GET', '/playgroups')).text, /Guest Pod/);
  assert.equal((await friend.request('GET', location)).status, 404);
  await friend.request('POST', `${location}/accept`);
  const page = await friend.request('GET', location);
  assert.equal(page.status, 200);
  assert.match(page.text, /RtHost/);

  const refused = await owner.request('POST', `${location}/invite`, { username: 'RtNobodyFriend' });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /You can only invite your friends\./);
});

test('leave, remove, rename, delete over HTTP', async () => {
  const owner = await registerClient('RtBoss');
  const m = await registerClient('RtCrew');
  const mUser = await User.findOne({ username: 'RtCrew' });
  const { location } = await owner.request('POST', '/playgroups', { name: 'Crew Pod' });
  const id = idFrom(location);
  await Playgroup.updateOne({ _id: id }, { $addToSet: { members: mUser._id } });

  assert.equal((await m.request('POST', `${location}/leave`)).location, '/playgroups');
  assert.equal((await m.request('GET', location)).status, 404);
  await Playgroup.updateOne({ _id: id }, { $addToSet: { members: mUser._id } });
  await owner.request('POST', `${location}/remove`, { username: 'RtCrew' });
  assert.equal((await Playgroup.findById(id)).members.length, 1);

  assert.equal((await owner.request('POST', `${location}/rename`, { name: '' })).status, 400);
  await owner.request('POST', `${location}/rename`, { name: 'Boss Pod' });
  assert.match((await owner.request('GET', location)).text, /Boss Pod/);

  assert.equal((await owner.request('POST', `${location}/delete`)).location, '/playgroups');
  assert.equal(await Playgroup.findById(id), null);
});

test('nav links to playgroups when logged in', async () => {
  const c = await registerClient('RtNav');
  assert.match((await c.request('GET', '/dashboard')).text, /href="\/playgroups"/);
});

// --- Task 4: group leaderboard and recent games ---

test('group page shows only tagged games, ranks players, and hides private decks', async () => {
  const owner = await registerClient('GpOwner');
  const m = await registerClient('GpMember');
  const ownerUser = await User.findOne({ username: 'GpOwner' });
  const mUser = await User.findOne({ username: 'GpMember' });
  const { location } = await owner.request('POST', '/playgroups', { name: 'Gp Pod' });
  const id = idFrom(location);
  await Playgroup.updateOne({ _id: id }, { $addToSet: { members: mUser._id } });

  const ownerDeck = await Deck.create({ name: 'GpOwnerDeck', format: 'Modern', owner: ownerUser._id });
  const secret = await Deck.create({ name: 'GpSecretDeck', format: 'Modern', owner: mUser._id, visibility: 'private' });
  const vs = (name) => ({ opponents: [{ name, deck: 'Elves' }] });
  await mkGame(ownerUser, ownerDeck, { playgroup: id, ...vs('TaggedOppA') });
  await mkGame(ownerUser, ownerDeck, { playgroup: id, ...vs('TaggedOppB') });
  await mkGame(mUser, secret, { playgroup: id, ...vs('TaggedOppC') });
  await mkGame(ownerUser, ownerDeck, vs('UntaggedOpp'));

  const page = (await owner.request('GET', location)).text;
  assert.match(page, /TaggedOppA/);
  assert.doesNotMatch(page, /UntaggedOpp/);
  const standings = page.slice(page.indexOf('id="group-players"'));
  assert.ok(standings.indexOf('GpOwner') < standings.indexOf('GpMember'), 'owner (2 wins) ranks above member (1 win)');
  assert.match(page, /Hidden deck/);
  assert.doesNotMatch(page, /GpSecretDeck/);

  assert.match((await m.request('GET', location)).text, /GpSecretDeck/);
});

// --- Task 5: tagging games ---

test('games can be tagged with my playgroup, never with someone else’s', async () => {
  const c = await registerClient('TgPlayer');
  const outsider = await registerClient('TgOutsider');
  const me = await User.findOne({ username: 'TgPlayer' });
  const deck = await Deck.create({ name: 'TgDeck', format: 'Modern', owner: me._id });
  const mine = idFrom((await c.request('POST', '/playgroups', { name: 'Tg Mine' })).location);
  const theirs = idFrom((await outsider.request('POST', '/playgroups', { name: 'Tg Theirs' })).location);
  const game = (extra) => ({
    deck_id: String(deck._id), result: 'win',
    'opponents[0][name]': 'Ann', 'opponents[0][deck]': 'Elves', ...extra,
  });

  assert.match((await c.request('GET', '/dashboard')).text, /name="playgroup_id"/);
  const loner = await registerClient('TgLoner');
  assert.doesNotMatch((await loner.request('GET', '/dashboard')).text, /name="playgroup_id"/);

  await c.request('POST', '/game-records', game({ playgroup_id: mine }));
  const tagged = await GameRecord.findOne({ user: me._id });
  assert.equal(String(tagged.playgroup), mine);

  // A stale or foreign group (e.g. just removed) must not lose the game: it saves untagged.
  await c.request('POST', '/game-records', game({ playgroup_id: theirs }));
  assert.equal(await GameRecord.countDocuments({ user: me._id }), 2);
  assert.equal(await GameRecord.countDocuments({ user: me._id, playgroup: theirs }), 0);

  const put = (extra) => c.request('POST', `/game-records/${tagged._id}`, { _method: 'PUT', ...game(extra) });
  assert.equal((await put({ playgroup_id: theirs })).status, 400);
  assert.equal((await put({ playgroup_id: '' })).status, 302);
  assert.equal((await GameRecord.findById(tagged._id)).playgroup, undefined);
});

test('an unchanged tag survives editing after leaving the group', async () => {
  const owner = await registerClient('TgHost');
  const c = await registerClient('TgLeaver');
  const me = await User.findOne({ username: 'TgLeaver' });
  const deck = await Deck.create({ name: 'TgLeaverDeck', format: 'Modern', owner: me._id });
  const { location } = await owner.request('POST', '/playgroups', { name: 'Tg Left' });
  const gid = idFrom(location);
  await Playgroup.updateOne({ _id: gid }, { $addToSet: { members: me._id } });
  const rec = await mkGame(me, deck, { playgroup: gid });
  await c.request('POST', `${location}/leave`);

  const edit = await c.request('GET', `/game-records/${rec._id}/edit`);
  assert.match(edit.text, /Tg Left/);
  const res = await c.request('POST', `/game-records/${rec._id}`, {
    _method: 'PUT', deck_id: String(deck._id), result: 'loss',
    'opponents[0][name]': 'Ann', 'opponents[0][deck]': 'Elves', playgroup_id: gid,
  });
  assert.equal(res.status, 302);
  const after1 = await GameRecord.findById(rec._id);
  assert.equal(String(after1.playgroup), gid);
  assert.equal(after1.result, 'loss');
});

// --- Review fixes: stray invites must never let a removed member back in ---

test('removing a member also drops any pending invite they hold', async () => {
  const owner = await mkUser('RmOwner');
  const m = await mkUser('RmMember');
  const g = await pg.createPlaygroup(owner._id, 'RmPod');
  // The state an invite/accept race can leave behind: both a member and invited.
  await Playgroup.updateOne({ _id: g._id }, { $addToSet: { members: m._id, invites: m._id } });

  await pg.removeMember(g._id, owner._id, m._id);
  await pg.acceptInvite(g._id, m._id);
  const after1 = await reload(g);
  assert.deepEqual(ids(after1.members), [String(owner._id)]);
  assert.deepEqual(after1.invites, []);
});

test('invite writes nothing once the inviter is no longer a member', async () => {
  const owner = await mkUser('IrOwner');
  const inviter = await mkUser('IrInviter');
  const friend = await mkUser('IrFriend');
  await befriend(inviter, friend);
  const g = await pg.createPlaygroup(owner._id, 'IrPod');
  // inviter loaded the page as a member, then got removed before submitting.
  await pg.invite(g, await asViewer(inviter), 'IrFriend');
  assert.deepEqual((await reload(g)).invites, []);
});

test('invite writes nothing if the target joins between the check and the write', async () => {
  const owner = await mkUser('IjOwner');
  const friend = await mkUser('IjFriend');
  await befriend(owner, friend);
  const g = await pg.createPlaygroup(owner._id, 'IjPod');
  // Let invite() read the group, then have the target join (as an accept of an
  // earlier invite would) before invite() writes.
  const original = Playgroup.findById;
  Playgroup.findById = function (...args) {
    const query = original.apply(this, args);
    return {
      lean: async () => {
        const doc = await query.lean();
        await Playgroup.updateOne({ _id: g._id }, { $addToSet: { members: friend._id } });
        return doc;
      },
    };
  };
  try {
    assert.equal(await pg.invite(g, await asViewer(owner), 'IjFriend'), null);
  } finally {
    Playgroup.findById = original;
  }
  const after1 = await reload(g);
  assert.ok(ids(after1.members).includes(String(friend._id)));
  assert.deepEqual(after1.invites, []);
});
