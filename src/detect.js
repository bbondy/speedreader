/* SpeedReader — lightweight per-tab detector.
 *
 * This is the ONLY script injected into normal pages, so it is kept tiny to
 * minimise per-tab memory: it just checks whether the page looks like an
 * article (using the small Readability-readerable helper) and reports that for
 * the toolbar affordance. All heavy work — full Readability / the WASM
 * distiller / DOM building / TTS — happens on demand in reader.html, never here.
 */

(() => {
  'use strict';

  const readable = (() => {
    try {
      return typeof isProbablyReaderable === 'function' &&
        isProbablyReaderable(document, { minContentLength: 140 });
    } catch (e) {
      return false;
    }
  })();

  try {
    chrome.runtime.sendMessage({ type: 'speedreader-status', readable });
  } catch (e) { /* worker asleep */ }

  // Automatic mode: if the user opted in and this is an article, ask the
  // background to open it in the reader page.
  try {
    chrome.storage.sync.get(['speedreader-auto'], (d) => {
      if (d['speedreader-auto'] && readable) {
        chrome.runtime.sendMessage({ type: 'speedreader-open' });
      }
    });
  } catch (e) { /* ignore */ }
})();
