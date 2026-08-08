// Importing this module registers every Mongoose model exactly once, so app code
// can `import { User, Deck, GameRecord } from './models/index.js'` and rely on all
// refs being resolvable.
export { User } from './User.js';
export { Deck, DECK_FORMATS, MTG_COLORS } from './Deck.js';
export { GameRecord, GAME_RESULTS, MAX_OPPONENTS, opponentList } from './GameRecord.js';
