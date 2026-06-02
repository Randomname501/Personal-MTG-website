import express from 'express';

const router = express.Router();

// Shared nav links for the layout header
const navLink = [
  { link: '/', text: 'Home' },
  { link: '/leaderboard', text: 'Leaderboard' },
  { link: '/deckLeaderboard', text: 'Deck Leaderboard' },
  { link: '/login', text: 'Login' },
  { link: '/logout', text: 'Logout' },
];

router.get('/', (req, res) => {
  res.render('home', {
    title: 'Home',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

router.get('/leaderboard', (req, res) => {
  res.render('leaderboard', {
    title: 'Leaderboard',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

router.get('/deckLeaderboard', (req, res) => {
  res.render('deckLeaderboard', {
    title: 'Deck Leaderboard',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

router.get('/login', (req, res) => {
  res.render('login', {
    title: 'Login',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

router.get('/logout', (req, res) => {
  res.render('logout', {
    title: 'Logout',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

export { router };
