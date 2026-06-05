import express from 'express';
import { User } from '../models/index.js';

const router = express.Router();

// Case-insensitive match so "Bob" logs in as "bob".
const CI_COLLATION = { locale: 'en', strength: 2 };

const isValidUsername = (u) => typeof u === 'string' && u.trim().length >= 3 && u.trim().length <= 50;
const isValidPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 50;

// --- Register ---
router.get('/register', (req, res) => {
  res.render('register', { title: 'Register' });
});

router.post('/register', async (req, res, next) => {
  const username = (req.body.username_input || '').trim();
  const password = req.body.password_input || '';

  const reRender = (registerError) =>
    res.status(400).render('register', {
      title: 'Register',
      hasError: true,
      registerError,
      username,
    });

  if (!isValidUsername(username)) return reRender('Username must be 3–50 characters.');
  if (!isValidPassword(password)) return reRender('Password must be 8–50 characters.');

  try {
    const user = new User({ username });
    await user.setPassword(password);
    await user.save();

    req.session.userId = user._id;
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 11000) return reRender('That username is already taken.');
    if (err.name === 'ValidationError') return reRender('Please check your details and try again.');
    next(err);
  }
});

// --- Login ---
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

router.post('/login', async (req, res, next) => {
  const username = (req.body.username_input || '').trim();
  const password = req.body.password_input || '';

  const reRender = () =>
    res.status(401).render('login', {
      title: 'Login',
      hasError: true,
      loginError: 'Invalid username or password.',
      username,
    });

  try {
    const user = await User.findOne({ username }).collation(CI_COLLATION);
    if (!user || !(await user.verifyPassword(password))) return reRender();

    req.session.userId = user._id;
    res.redirect('/dashboard');
  } catch (err) {
    next(err);
  }
});

// --- Logout ---
// GET shows the confirmation page; POST actually destroys the session.
router.get('/logout', (req, res) => {
  res.render('logout', { title: 'Logout' });
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('AuthenticationState');
    res.redirect('/');
  });
});

export { router as authRouter };
