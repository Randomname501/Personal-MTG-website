import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import memorystore from 'memorystore';
import { engine } from 'express-handlebars';
import { fileURLToPath } from 'node:url';
import { router } from './routes/index.js';
import { connectMongo } from './config/db.js';
import { attachUser } from './middleware/auth.js';
import { percent, eq, formatDate } from './lib/viewHelpers.js';

const app = express();
const MemoryStore = memorystore(session);

const rewriteUnsupportedBrowserMethods = (req, res, next) => {
  // If the user posts to the server with a property called _method, rewrite the request's method
  // To be that method; so if they post _method=PUT you can now allow browsers to POST to a route that gets
  // rewritten in this middleware to a PUT route
  if (req.body && req.body._method) {
    req.method = req.body._method;
    delete req.body._method;
  }

  // let the next middleware run:
  next();
};

// View engine: Handlebars
app.engine('handlebars', engine({ defaultLayout: 'main', helpers: { percent, eq, formatDate } }));
app.set('view engine', 'handlebars');
app.set('views', './views');

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'AuthenticationState',
    secret: 'some secret string!',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 },
    store: new MemoryStore({
      checkPeriod: 86400000,
    }),
  })
);
app.use(rewriteUnsupportedBrowserMethods);
app.use(cors());
// Load the session user (if any) and build the nav before any route renders.
app.use(attachUser);
app.use(router);

export { app };

// Only connect to MongoDB and start listening when this file is run directly
// (not when imported by a test). Fail fast if the database is unreachable.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  connectMongo()
    .then(() => {
      app.listen(3000, () => {
        console.log(`Server running at http://localhost:3000`);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to MongoDB:', err.message);
      process.exit(1);
    });
}
