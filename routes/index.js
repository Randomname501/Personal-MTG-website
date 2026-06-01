import express from 'express';

const router = express.Router();

// Shared nav links for the layout header
const navLink = [
  { link: '/', text: 'Home' },
  { link: '/leaderboard', text: 'Leaderboard' },
  { link: '/login', text: 'Login' },
];

router.get('/', (req, res) => {
  res.render('home', {
    title: 'Home',
    headerTitle: 'MTG Tracker',
    navLink,
  });
});

export { router };
