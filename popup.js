// Check if we're on colonist.io and update status
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const statusEl = document.getElementById('status');

  if (tab && tab.url && tab.url.includes('colonist.io')) {
    // Check if in a game (URL has # with game id)
    if (tab.url.includes('#')) {
      statusEl.className = 'status active';
      statusEl.textContent = '✓ Tracking active';
    } else {
      statusEl.className = 'status inactive';
      statusEl.textContent = 'On Colonist.io - join a game';
    }
  } else {
    statusEl.className = 'status inactive';
    statusEl.textContent = 'Go to colonist.io to use';
  }
});
