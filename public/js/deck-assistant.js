// Deck helper chat panel. Talks to POST /decks/:id/assistant (lib/deckAgent.js).
// The conversation lives only in this page: `messages` resets on reload.
// Everything from the server is shown with textContent, never innerHTML,
// because it's model-written text.
document.addEventListener('DOMContentLoaded', () => {
  const panel = document.getElementById('deck-assistant');
  if (!panel) return;

  const deckId = panel.dataset.deckId;
  const log = panel.querySelector('.deck-assistant__log');
  const form = panel.querySelector('.deck-assistant__form');
  const input = form.querySelector('input');
  const askButton = form.querySelector('button');
  let messages = []; // the full transcript, sent back with every question

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  // After an Add, re-fetch this page and swap in the parts that depend on the
  // cards (the list with its count, and the breakdown), leaving the chat alone.
  const refreshDeckSections = async () => {
    const res = await fetch(location.href);
    if (!res.ok) return;
    const fresh = new DOMParser().parseFromString(await res.text(), 'text/html');
    const swap = (selector) => {
      const next = fresh.querySelector(selector);
      const current = document.querySelector(selector);
      if (next && current) current.replaceWith(next);
      else if (next) document.querySelector('main').append(next); // breakdown appears after the first card
    };
    swap('.deck-cards-view');
    swap('.deck-breakdown');
  };

  const say = (who, text) => log.append(el('p', `deck-assistant__msg deck-assistant__msg--${who}`, text));

  // One suggested card: image, details, the reason, and an Add button.
  const tile = (card) => {
    const article = el('article', 'card-tile');
    if (card.imageUrl) {
      const img = el('img');
      img.src = card.imageUrl;
      img.alt = card.name;
      img.loading = 'lazy';
      article.append(img);
    }
    const body = el('div', 'card-tile__body');
    body.append(
      el('span', 'card-tile__name', card.name),
      el('span', 'card-tile__meta', [card.manaCost, card.priceUsd && `$${card.priceUsd}`].filter(Boolean).join(' · ')),
      el('span', 'card-tile__meta', card.reason),
    );
    const add = el('button', 'button', 'Add');
    add.type = 'button';
    add.addEventListener('click', async () => {
      add.disabled = true;
      add.textContent = 'Adding…';
      try {
        // Same endpoint the Manage Cards page uses; the server re-fetches the card.
        const res = await fetch(`/decks/${deckId}/cards`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ scryfall_id: card.scryfallId }),
        });
        if (!res.ok) throw new Error();
        add.textContent = 'Added ✓';
      } catch {
        add.disabled = false;
        add.textContent = 'Add (failed, try again)';
        return;
      }
      // The card is saved either way; a failed redraw only means the list
      // stays stale until a reload.
      refreshDeckSections().catch(() => {});
    });
    body.append(add);
    article.append(body);
    return article;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    say('user', question);
    input.value = '';
    askButton.disabled = true;
    const thinking = el('p', 'deck-assistant__msg deck-assistant__msg--status', 'Thinking…');
    log.append(thinking);

    try {
      const res = await fetch(`/decks/${deckId}/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, messages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');

      messages = data.messages;
      if (data.reply) say('assistant', data.reply);
      if (data.note) say('status', data.note);
      if (data.recommendations.length) {
        const grid = el('div', 'card-grid');
        grid.append(...data.recommendations.map(tile));
        log.append(grid);
      }
    } catch (err) {
      say('status', err.message || 'Something went wrong.');
    } finally {
      thinking.remove();
      askButton.disabled = false;
      input.focus();
    }
  });
});
