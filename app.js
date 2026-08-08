import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import { engine } from 'express-handlebars';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes/index.js';
import { connectMongo } from './config/db.js';
import { attachUser } from './middleware/auth.js';
import { percent, eq, formatDate, formatOpponents } from './lib/viewHelpers.js';

const app = express();

// Resolve asset directories against this file, not process.cwd(). Under a
// serverless runtime the working directory is the bundle root (/var/task), which
// is not where the source lives — relative paths silently look in the wrong place.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Vercel terminates TLS at its proxy, so without this Express sees http and
// refuses to set a secure cookie.
app.set('trust proxy', 1);

const sessionSecret = () => {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Missing SESSION_SECRET.');
  }
  return 'dev-only-insecure-secret';
};

// Built on first request rather than at import, so the store reads MONGODB_URI at
// call time — the same reason connectMongo() does, and what lets the tests point
// at a throwaway database after importing this module.
let sessionMiddleware;
const buildSessionMiddleware = () =>
  session({
    name: 'AuthenticationState',
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 86400000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
    // Sessions have to outlive any single process: a serverless deployment runs
    // many short-lived instances, so an in-memory store signs users out whenever
    // a request lands on a different one. Reuses the Mongoose pool.
    store: MongoStore.create({
      clientPromise: connectMongo().then((conn) => conn.getClient()),
      collectionName: 'sessions',
    }),
  });

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
app.engine('handlebars', engine({ defaultLayout: 'main', helpers: { percent, eq, formatDate, formatOpponents } }));
app.set('view engine', 'handlebars');
app.set('views', path.join(rootDir, 'views'));

app.use(express.static(path.join(rootDir, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure a database connection before anything downstream touches a model. Under
// a serverless runtime nothing runs at "startup", so this is where connecting
// actually happens; connectMongo() is cached, so warm requests just fall through.
app.use(async (req, res, next) => {
  try {
    await connectMongo();
    next();
  } catch (err) {
    next(err);
  }
});

app.use((req, res, next) => {
  if (!sessionMiddleware) {
    sessionMiddleware = buildSessionMiddleware();
  }
  return sessionMiddleware(req, res, next);
});
app.use(rewriteUnsupportedBrowserMethods);
app.use(cors());
// Load the session user (if any) and build the nav before any route renders.
app.use(attachUser);
app.use(router);

export { app };

// Vercel resolves this file as the function entrypoint (package.json "main") and
// invokes the default export as (req, res). An Express app is already that shape.
export default app;

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
