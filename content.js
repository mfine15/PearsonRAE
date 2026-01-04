// Colonist.io Rolls Above Expectation Tracker v2.0
// This content script injects the tracker into the page's main world

(function() {
  'use strict';

  // Inject the tracker script from external file (bypasses CSP)
  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function() {
      this.remove();
      console.log('[PearsonRAE] Script injected into page context');
    };
    script.onerror = function() {
      console.error('[PearsonRAE] Failed to load inject.js');
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Wait for DOM and inject
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectScript);
  } else {
    injectScript();
  }

})();
