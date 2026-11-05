import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPair } from '../lib/commanderPair.js';

// Rules-text lines as Scryfall prints them.
const card = (name, oracleText, typeLine = 'Legendary Creature — Human') => ({ name, oracleText, typeLine });

const KODAMA = card('Kodama of the East Tree', 'Reach\nWhenever another permanent you control enters, you may put a permanent card from your hand onto the battlefield.\nPartner (You can have two commanders if both have partner.)');
const KEDISS = card('Kediss, Emberclaw Familiar', 'Whenever a commander you control deals combat damage to an opponent, it deals that much damage to each other opponent.\nPartner (You can have two commanders if both have partner.)');
const AKROMA = card('Akroma, Vision of Ixidor', 'Flying, first strike, vigilance, trample\nPartner');
const ATRAXA = card("Atraxa, Praetors' Voice", 'Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate.');
const PIR = card('Pir, Imaginative Rascal', 'Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand from their library, then shuffle.)\nIf one or more counters would be put on a permanent your team controls, that many plus one are put on it instead.');
const TOOTHY = card('Toothy, Imaginary Friend', 'Partner with Pir, Imaginative Rascal (When this creature enters, target player may put Pir into their hand from their library, then shuffle.)\nWhenever you draw a card, put a +1/+1 counter on Toothy.');
const ABBY = card('Abby, Merciless Soldier', 'Partner—Survivors (You can have two commanders if both have this ability.)');
const ELLIE = card('Ellie, Survivor', 'Partner—Survivors (You can have two commanders if both have this ability.)');
const BJORNA = card('Bjorna, Nightfall Alchemist', 'Partner—Friends forever (You can have two commanders if both have this ability.)');
const CECILY = card('Cecily, Haunted Mage', 'Partner—Friends forever (You can have two commanders if both have this ability.)');
const APRIL = card("April O'Neil, Live on the Scene", 'Partner—Character select');
const WILSON = card('Wilson, Refined Grizzly', 'Choose a Background (You can have a Background as a second commander.)');
const HERMIT = card('Cloakwood Hermit', 'Commander creatures you own have an ability.', 'Legendary Enchantment — Background');
const ROSE = card('Rose Tyler', "Doctor's companion (You can have two commanders if the other is the Doctor.)");
const AMY = card('Amy Pond', "Partner with Rory Williams (When this creature enters, target player may put Rory into their hand from their library, then shuffle.)\nDoctor's companion (You can have two commanders if the other is the Doctor.)");
const RORY = card('Rory Williams', "Partner with Amy Pond (When this creature enters, target player may put Amy into their hand from their library, then shuffle.)\nDoctor's companion (You can have two commanders if the other is the Doctor.)");
const TENTH = card('The Tenth Doctor', 'Allons-y!', 'Legendary Creature — Time Lord Doctor');
const TIME_LORD = card('A Time Lord', '', 'Legendary Creature — Time Lord Rogue');
const DOCTOR_WIZARD = card('A Doctor Wizard', '', 'Legendary Creature — Time Lord Doctor Wizard');

const cases = [
  ['two plain Partner cards', KODAMA, KEDISS, true],
  ['plain Partner printed without reminder text', KODAMA, AKROMA, true],
  ['Partner with naming each other', PIR, TOOTHY, true],
  ['Partner with and a plain Partner card', PIR, KODAMA, false],
  ['Partner with and a card naming someone else', PIR, card('Other', 'Partner with Somebody Else (reminder)'), false],
  ['the same named Partner variant', ABBY, ELLIE, true],
  ['Friends forever', BJORNA, CECILY, true],
  ['different named Partner variants', ABBY, BJORNA, false],
  ['a named variant and plain Partner', ABBY, KODAMA, false],
  ['a named variant without reminder text and plain Partner', APRIL, KODAMA, false],
  ['Choose a Background and a Background', WILSON, HERMIT, true],
  ['Choose a Background and a creature', WILSON, KODAMA, false],
  ['plain Partner and a Background', KODAMA, HERMIT, false],
  ["Doctor's companion and a Doctor", ROSE, TENTH, true],
  ["Doctor's companion and a non-Doctor", ROSE, KODAMA, false],
  ["Doctor's companion and a Time Lord who isn't a Doctor", ROSE, TIME_LORD, false],
  ["Doctor's companion and a Doctor with another creature type", ROSE, DOCTOR_WIZARD, false],
  ['a card with two abilities pairing through Partner with', AMY, RORY, true],
  ["a card with two abilities pairing through Doctor's companion", AMY, TENTH, true],
  ['a card with two abilities and a card fitting neither', AMY, KODAMA, false],
  ['a card with no pairing ability and a Partner card', ATRAXA, KODAMA, false],
  ['two cards with no pairing ability', ATRAXA, TENTH, false],
];

for (const [label, a, b, want] of cases) {
  test(`canPair: ${label} -> ${want}`, () => {
    assert.equal(canPair(a, b), want);
    assert.equal(canPair(b, a), want); // order must not matter
  });
}

test('canPair: a commander cannot pair with a second copy of itself', () => {
  assert.equal(canPair(KODAMA, { ...KODAMA }), false);
});

test('canPair: Partner on a double-faced card counts', () => {
  const dfc = card('Front // Back', 'Partner (You can have two commanders if both have partner.)\n//\nBack face text');
  assert.equal(canPair(dfc, KODAMA), true);
});
