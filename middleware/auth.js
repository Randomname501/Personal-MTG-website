import { User } from '../models/index.js';

const HEADER_TITLE = 'MTG Tracker';

// Nav links shown when no user is signed in.
const loggedOutNav = [
  { link: '/', text: 'Home' },
  { link: '/leaderboard', text: 'Leaderboard' },
  { link: '/deckLeaderboard', text: 'Deck Leaderboard' },
  { link: '/login', text: 'Login' },
  { link: '/register', text: 'Register' },
];

// Nav links shown when a user is signed in.
const loggedInNav = [
  { link: '/', text: 'Home' },
  { link: '/leaderboard', text: 'Leaderboard' },
  { link: '/deckLeaderboard', text: 'Deck Leaderboard' },
  { link: '/dashboard', text: 'Dashboard' },
  { link: '/game-records', text: 'Match History' },
  { link: '/decks', text: 'Browse Decks' },
  { link: '/logout', text: 'Logout' },
];

// Runs on every request: load the session user (if any) into res.locals and pick
// the matching nav. res.locals is automatically merged into every view's context,
// so routes don't need to pass currentUser/navLink/headerTitle by hand.
export const attachUser = async (req, res, next) => {
  res.locals.headerTitle = HEADER_TITLE;

  try {
    if (req.session.userId) {
      // .lean() returns a plain object so Handlebars can read its fields (its
      // prototype-access guard blocks Mongoose document getters). Drop the hash.
      const user = await User.findById(req.session.userId).select('-passwordHash').lean();
      if (user) {
        req.currentUser = user;
        res.locals.currentUser = user;
        res.locals.navLink = loggedInNav;
        return next();
      }
      // Stale session pointing at a deleted user — clear it.
      req.session.userId = undefined;
    }

    res.locals.navLink = loggedOutNav;
    next();
  } catch (err) {
    next(err);
  }
};

// Guard for routes that require a signed-in user. Redirects to /login otherwise.
export const requireAuth = (req, res, next) => {
  if (!req.currentUser) {
    return res.redirect('/login');
  }
  next();
};
