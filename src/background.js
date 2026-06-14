/* SpeedReader extension — service worker.
 *
 * Drives the Option-A architecture: instead of distilling in-page, it navigates
 * the tab to the in-extension reader page (reader.html?url=…). Because the
 * original page is never committed to a renderer, its scripts/trackers never
 * run — the privacy / no-FOUC / low-memory win that an in-page content script
 * can't get.
 */

const READER = chrome.runtime.getURL('reader.html');

// Per-tab original URL that automatic mode must NOT reopen in the reader. It is
// set whenever the user deliberately returns to the original page (toolbar ✕ /
// Esc / "View original" / the action icon). Without it, automatic mode would
// instantly send them straight back into the reader, making the original page
// impossible to view.
const autoSuppressed = new Map(); // tabId -> original url

function openReader(tabId, url) {
  chrome.tabs.update(tabId, { url: READER + '?url=' + encodeURIComponent(url) });
  chrome.action.setBadgeText({ tabId, text: 'ON' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#5B5CF1' });
  chrome.action.setTitle({ tabId, title: 'Show original page' });
}

function showOriginal(tabId, readerUrl) {
  const orig = new URL(readerUrl).searchParams.get('url');
  if (orig) {
    autoSuppressed.set(tabId, orig);
    chrome.tabs.update(tabId, { url: orig });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => autoSuppressed.delete(tabId));

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.url) return;
  if (tab.url.startsWith(READER)) showOriginal(tab.id, tab.url);
  else if (/^https?:/.test(tab.url)) openReader(tab.id, tab.url);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return;

  if (msg.type === 'speedreader-suppress-auto') {
    // The reader page is about to navigate back to the original; remember not to
    // auto-reopen it. (The reader navigates itself, so no response is needed.)
    if (msg.url) autoSuppressed.set(tabId, msg.url);
  } else if (msg.type === 'speedreader-open' && sender.tab.url) {
    // Skip the auto-open only for the exact page the user chose to view as
    // original; a different article in the same tab still opens normally.
    if (autoSuppressed.get(tabId) === sender.tab.url) return;
    autoSuppressed.delete(tabId);
    openReader(tabId, sender.tab.url);
  } else if (msg.type === 'speedreader-status') {
    // Subtle dot when a page is distillable; cleared otherwise.
    chrome.action.setBadgeText({ tabId, text: msg.readable ? '•' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#5B5CF1' });
    chrome.action.setTitle({
      tabId,
      title: msg.readable ? 'Open in SpeedReader' : 'SpeedReader (no article detected)'
    });
  }
});
