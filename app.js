import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { engine } from 'express-handlebars';
import { router } from './routes/index.js';

const app = express();

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
app.engine('handlebars', engine({ defaultLayout: 'main' }));
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
  })
);
app.use(rewriteUnsupportedBrowserMethods);
app.use(cors());
app.use(router);

app.listen(3000, () => {
  console.log(`Server running at http://localhost:3000`);
});
