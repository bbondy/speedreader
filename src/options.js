const box = document.getElementById('auto');
chrome.storage.sync.get(['speedreader-auto'], (d) => {
  box.checked = !!d['speedreader-auto'];
});
box.addEventListener('change', () => {
  chrome.storage.sync.set({ 'speedreader-auto': box.checked });
});

const engine = document.getElementById('engine');
chrome.storage.sync.get(['speedreader-engine'], (d) => {
  engine.value = d['speedreader-engine'] === 'readability' ? 'readability' : 'wasm';
});
engine.addEventListener('change', () => {
  chrome.storage.sync.set({ 'speedreader-engine': engine.value });
});
