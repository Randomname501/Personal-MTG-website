// Copy button for the exported decklist. The deck helper swaps the list out after
// adding a card, so the click is handled at the document, not on the button. The
// clipboard API needs HTTPS, so the text is selected first and can still be copied
// by hand.
document.addEventListener('click', async ({ target }) => {
  if (target.id !== 'deck-export-copy') return;
  const box = document.getElementById('deck-export-text');
  box.select();
  try {
    await navigator.clipboard.writeText(box.value);
    target.textContent = 'Copied';
  } catch {
    target.textContent = 'Selected, copy it manually';
  }
});
