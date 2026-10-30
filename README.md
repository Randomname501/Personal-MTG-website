# Personal MTG Website

A personal Magic: The Gathering tracker and dashboard built with Node.js, Express, Handlebars, and MongoDB. It helps you manage your decks, log match results, review deck performance, and explore analytics across the cards and decks you play.

## Overview

This project is designed as a private, personal MTG database. You can:

- create and manage your own decks by format and color identity
- add cards to decks using Scryfall metadata snapshots
- track match records with result, opponents, and deck information
- view deck insights such as mana curve, color breakdown, and type distribution
- compare your performance against the community leaderboard
- follow other users' decks from your dashboard

The app is structured as a full-stack Express application with server-rendered Handlebars views and MongoDB persistence.

## Features

### Authentication and user accounts

- register a new account with a unique username
- log in and log out securely with session cookies
- persist session data in MongoDB via `connect-mongo`
- restrict access to authenticated routes

### Deck management

- create decks with a name, format, colors, commander, archetype, and notes
- browse decks by format and ownership
- track other users' decks without owning them
- maintain a card list embedded in each deck record
- search and add cards from Scryfall metadata

### Game record tracking

- log wins, losses, and draws for your deck
- store opponents and their deck names for multiplayer pods
- support multiple opponents up to the configured limit
- filter history by deck and result
- edit or delete prior matches

### Deck analytics and card insights

- calculate deck statistics including total cards and mana curve
- summarize card colors and type distribution
- show deck-level breakdowns for deck detail pages
- render insights visually using Handlebars templates and helpers

### Leaderboards

- leaderboard of players by win/loss record
- leaderboard of decks by aggregate deck performance
- ranked display with ratios and medal tiers

### Dashboard and discovery

- personal dashboard with your decks and tracked decks
- quick overview of recent tracking and match history
- deck browsing and follow workflow for community discovery

## Tech Stack

- Node.js
- Express.js
- Express Handlebars
- MongoDB with Mongoose
- bcryptjs for password hashing
- dotenv for environment variables
- Vercel-ready server deployment settings

## Project Structure

```text
.
├── app.js
├── package.json
├── vercel.json
├── .env.example (recommended to create locally)
├── config/
│   └── db.js
├── docs/
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── lib/
│   ├── cardInsights.js
│   ├── leaderboards.js
│   ├── scryfall.js
│   ├── stats.js
│   └── viewHelpers.js
├── middleware/
│   └── auth.js
├── models/
│   ├── Deck.js
│   ├── GameRecord.js
│   ├── User.js
│   └── index.js
├── public/
│   ├── css/
│   └── js/
├── routes/
│   ├── auth.js
│   ├── dashboard.js
│   ├── decks.js
│   ├── gameRecords.js
│   ├── index.js
│   ├── leaderboards.js
│   └── pages.js
├── test/
│   ├── ...
├── views/
│   ├── layouts/
│   ├── partials/
│   └── ...
└── README.md
```

## Application Workflow

### User flow

1. User registers or logs in.
2. User creates one or more deck records.
3. User adds cards to deck lists from Scryfall.
4. User logs match results from those decks.
5. User views dashboard and deck statistics.
6. User can track other decks and compare performance.

### Data model summary

- User: username, passwordHash, trackedDecks
- Deck: name, format, colors, commander, archetype, description, cards
- GameRecord: user, deck, opponents, result, timestamps

## Prerequisites

- Node.js 18+
- npm
- MongoDB instance or MongoDB Atlas connection string

## Local Setup

1. Clone the repository:

```bash
git clone <your-repo-url>
cd Personal-MTG-website
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/personal-mtg
SESSION_SECRET=replace-with-a-long-random-string
NODE_ENV=development
```

Notes:

- `MONGODB_URI` is required for the app to connect to MongoDB.
- `SESSION_SECRET` is required for user session security.
- For a local development setup, a MongoDB instance running on localhost is sufficient.

4. Start the application:

```bash
npm start
```

5. Run the app in development watch mode:

```bash
npm run dev
```

6. Open the app in your browser:

```text
http://localhost:3000
```

## Available Scripts

```bash
npm start
npm run dev
npm test
```

Scripts:

- `npm start` starts the app normally.
- `npm run dev` runs the app with Node's watch mode.
- `npm test` runs the project test suite.

## Routes and pages

The app exposes these major routes:

### Public pages

- `/` - home page

### Authentication

- `/register` - create an account
- `/login` - sign in
- `/logout` - end a session

### Dashboard

- `/dashboard` - your decks and tracked deck overview

### Decks

- `/decks` - browse decks
- `/decks/new` - create a deck
- `/decks/:id` - deck detail and analytics
- `/decks/:id/cards` - manage cards in a deck
- `/decks/:id/track` and `/decks/:id/untrack` - follow/unfollow decks

### Game records

- `/game-records` - list recent game history
- `/game-records/:id/edit` - update a match
- `/game-records/:id/delete` - confirm deletion
- `/game-records/:id` via method overrides - delete or update record flows

### Leaderboards

- `/leaderboard` - player leaderboard
- `/deckLeaderboard` - deck leaderboard

## Testing

This project includes a Node.js test suite under the `test/` folder.

Run all tests:

```bash
npm test
```

The suite covers areas like:

- deck behavior
- game record validation
- card insights
- leaderboard logic
- stats helpers
- route-level integration flows

## Deployment

The app includes a `vercel.json` file and is designed to run in a serverless-friendly Express deployment environment such as Vercel.

Production deployment requirements:

- set `MONGODB_URI`
- set `SESSION_SECRET`
- set `NODE_ENV=production`
- ensure the hosting platform trusts proxy headers when needed

Because the app runs behind a proxy in some environments, it sets `app.set('trust proxy', 1)` to support secure cookies and session behavior correctly.

## Documentation and design notes

The project includes a `docs/superpowers` folder with planning and design documents covering planned and evolving product functionality, including:

- deck stats analytics
- game session tracking
- card deck browser
- card insights
- social deck discovery tracking
- leaderboard grid and multi-opponent design

These files are useful as product references while extending the app.

## Notes for development

- The app uses a cached MongoDB connection helper to avoid duplicate connection attempts during serverless or warm-start scenarios.
- Deck cards are stored as snapshots of Scryfall data to keep deck views independent of live API calls.
- The game record model preserves legacy `opponentDeck` data while supporting the newer structured `opponents` array.
- Session data is stored in MongoDB so user cookies remain valid across process restarts.

## License

This project is intended for personal and self-hosted use. Adjust the license as needed for your own deployment and distribution requirements.
