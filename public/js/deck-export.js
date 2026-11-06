// Copy button for the exported decklist. The clipboard API needs HTTPS, so the text
// is selected first and can still be copied by hand.
const box = document.getElementById('deck-export-text');
const button = document.getElementById('deck-export-copy');

button.addEventListener('click', async () => {
  box.select();
  try {
    await navigator.clipboard.writeText(box.value);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Selected, copy it manually';
  }
});
