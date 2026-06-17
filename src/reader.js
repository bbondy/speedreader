/* SpeedReader — reader page.
 *
 * Runs at chrome-extension://…/reader.html?url=<original>. It fetches the
 * original HTML itself, distills it (Brave's Rust distiller via WASM when
 * available, else bundled Mozilla Readability), rebuilds Brave's exact distilled
 * DOM, and renders it with Brave's verbatim CSS. The original page is never
 * loaded in a real renderer, so its scripts/trackers never run (privacy), there
 * is no flash of original content, and normal tabs stay light on memory.
 */

(() => {
  'use strict';

  // IDs hardcoded in Brave's extractor.rs (referenced by reader.css + here).
  const SHOW_ORIGINAL_ID = 'c93e2206-2f31-4ddc-9828-2bb8e8ed940e';
  const READ_TIME_ID = 'da24e4ef-db57-4b9f-9fa5-548924fc9c32';
  const META_DATA_ID = '3bafd2b4-a87d-4471-8134-7a9cca092000';
  const CONTENT_ID = '7c08a417-bf02-4241-a55e-ad5b8dc88f69';

  const WORDS_PER_MINUTE = 265;
  const MIN_READ_TEXT = 'min. read';
  const SHOW_ORIGINAL_TEXT = 'View original';

  const DEFAULT_SETTINGS = {
    'data-theme': 'light',
    'data-font-family': 'sans',
    'data-font-size': '100',
    'data-column-width': 'narrow',
    'data-content-style': 'default'
  };
  const SETTINGS_KEY = 'speedreader-settings';
  const ENGINE_KEY = 'speedreader-engine'; // 'wasm' (Brave) | 'readability' (Mozilla)

  const originalUrl = new URLSearchParams(location.search).get('url') || '';

  let settings = { ...DEFAULT_SETTINGS };
  let engine = 'wasm';
  let tts = null;
  let toolbarBar = null;
  let toolbarApi = null;

  // ── Settings ────────────────────────────────────────────────────────────────
  const getSettings = () => new Promise((resolve) => {
    chrome.storage.sync.get([SETTINGS_KEY], (data) => {
      resolve(Object.assign({}, DEFAULT_SETTINGS, data[SETTINGS_KEY] || {}));
    });
  });
  const saveSettings = () => chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  const getEngine = () => new Promise((resolve) => {
    chrome.storage.sync.get([ENGINE_KEY], (d) => {
      resolve(d[ENGINE_KEY] === 'readability' ? 'readability' : 'wasm');
    });
  });

  function applySettings() {
    const html = document.documentElement;
    for (const [k, v] of Object.entries(settings)) {
      if (k === 'data-theme' && v === 'system') html.removeAttribute(k);
      else html.setAttribute(k, v);
    }
  }

  // Navigate the tab back to the original article. First tell the service worker
  // not to auto-reopen this page in the reader, otherwise automatic mode would
  // instantly send us right back here. A fail-safe timer guarantees we navigate
  // even if the message stalls, so returning to the page is never blocked.
  function restore() {
    if (!originalUrl) { history.back(); return; }
    let navigated = false;
    const go = () => { if (!navigated) { navigated = true; location.href = originalUrl; } };
    try {
      chrome.runtime.sendMessage({ type: 'speedreader-suppress-auto', url: originalUrl }, () => {
        void chrome.runtime.lastError; // ignore "message port closed"
        go();
      });
    } catch (e) { go(); }
    setTimeout(go, 300);
  }

  // ── Distillers (engine chosen in Options) ────────────────────────────────────
  // Both engines ship in every build; the user picks one in Options (ENGINE_KEY):
  //   • 'wasm'        — Brave's Rust distiller (WASM): byte-identical to Brave.
  //   • 'readability' — Mozilla Readability (JS): lighter, NOT identical to Brave.
  // The choice is an explicit, labeled setting — never a silent fallback.

  let wasmPromise;
  function loadWasm() {
    if (wasmPromise !== undefined) return wasmPromise;
    wasmPromise = (async () => {
      const mod = await import(chrome.runtime.getURL('vendor/wasm/speedreader_wasm.js'));
      await mod.default();
      return mod;
    })();
    return wasmPromise;
  }

  // Brave's Rust distiller (WASM): byte-identical extraction to Brave.
  async function distillWasm(htmlText, url) {
    let wasm;
    try {
      wasm = await loadWasm();
    } catch (e) {
      throw new Error('The SpeedReader distiller (WASM) failed to load — run `make wasm`, ' +
        'or switch the engine to Mozilla Readability in Options. ' + (e && e.message || e));
    }
    const out = wasm.distill(htmlText, url);
    if (!out) return null;
    const doc = new DOMParser().parseFromString(out, 'text/html');
    // Brave puts id="article" on <body hidden> and unhides it after adopting
    // styles. We instead lift its children into a div#article (dropping `hidden`,
    // avoiding an invalid nested <body>).
    const srcRoot = doc.getElementById('article') || doc.body;
    if (!srcRoot || !srcRoot.childNodes.length) return null;
    const root = document.createElement('div');
    root.id = 'article';
    const dir = srcRoot.getAttribute && srcRoot.getAttribute('dir');
    if (dir) root.setAttribute('dir', dir);
    const imported = document.importNode(srcRoot, true);
    while (imported.firstChild) root.appendChild(imported.firstChild);
    return { root, title: doc.title || '' };
  }

  // Mozilla Readability is a plain-JS library, loaded on demand only when chosen.
  let readabilityPromise;
  function loadReadability() {
    if (readabilityPromise !== undefined) return readabilityPromise;
    readabilityPromise = new Promise((resolve, reject) => {
      if (typeof Readability !== 'undefined') { resolve(); return; }
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('vendor/Readability.js');
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Readability.js failed to load'));
      (document.head || document.documentElement).appendChild(s);
    });
    return readabilityPromise;
  }

  const trimDescription = (text) => {
    if (!text) return null;
    if ([...text].length <= 200) return text;
    const m = text.match(/[.!?](\s|$)/);
    return m ? text.slice(0, m.index + 1) : text;
  };

  // Build Brave's #article structure from a Readability result (matches extractor.rs),
  // including the four hardcoded IDs so read-time / "View original" / TTS still wire up.
  function buildArticleRoot(article) {
    const root = document.createElement('div');
    root.id = 'article';
    if (article.dir === 'rtl') root.setAttribute('dir', 'rtl');

    const meta = document.createElement('div');
    meta.id = META_DATA_ID;
    if (article.title) {
      const h1 = document.createElement('h1');
      h1.className = 'title metadata';
      h1.textContent = article.title;
      meta.appendChild(h1);
    }
    const desc = trimDescription(article.excerpt);
    if (desc) {
      const p = document.createElement('p');
      p.className = 'subhead metadata';
      p.textContent = desc;
      meta.appendChild(p);
    }
    if (article.byline) meta.appendChild(document.createElement('hr'));

    const row = document.createElement('div');
    row.className = 'metadata';
    if (article.byline) {
      const author = document.createElement('p');
      author.className = 'author';
      const b = article.byline.trim();
      author.textContent = /^by\s/i.test(b) ? b : `By ${b}`;
      row.appendChild(author);
    }
    const readtime = document.createElement('div');
    readtime.className = 'readtime';
    readtime.id = READ_TIME_ID;
    row.appendChild(readtime);
    const showOriginal = document.createElement('div');
    showOriginal.className = 'show_original';
    showOriginal.id = SHOW_ORIGINAL_ID;
    row.appendChild(showOriginal);
    meta.appendChild(row);
    if (article.title || desc || article.byline) meta.appendChild(document.createElement('hr'));

    root.appendChild(meta);

    const content = document.createElement('div');
    content.id = CONTENT_ID;
    content.innerHTML = article.content;
    root.appendChild(content);
    return root;
  }

  // Mozilla Readability path: lighter, but NOT byte-identical to Brave.
  async function distillReadability(htmlText, url) {
    await loadReadability();
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const base = doc.createElement('base');
    base.href = url;
    doc.head.insertBefore(base, doc.head.firstChild);
    const article = new Readability(doc, { keepClasses: true }).parse();
    if (!article || !article.content) return null;
    return { root: buildArticleRoot(article), title: article.title || '' };
  }

  // Returns { root, title } or null when no readable article was found.
  function distill(htmlText, url) {
    return engine === 'readability'
      ? distillReadability(htmlText, url)
      : distillWasm(htmlText, url);
  }

  // ── Shared render helpers (ported from Brave's speedreader-desktop.js) ───────
  function initShowOriginal() {
    const link = document.getElementById(SHOW_ORIGINAL_ID);
    if (link) {
      if (!link.textContent.trim()) link.textContent = SHOW_ORIGINAL_TEXT;
      link.style.cursor = 'pointer';
      link.addEventListener('click', restore);
    }
  }

  function calculateReadtime() {
    const el = document.getElementById(READ_TIME_ID);
    if (!el) return;
    const words = document.body.innerText.trim().split(/\s+/).length;
    el.textContent = `${Math.ceil(words / WORDS_PER_MINUTE)} ${MIN_READ_TEXT}`;
  }

  // ── Text-to-speech (Web Speech API port of Brave's TTS) ──────────────────────
  class TtsController {
    constructor() {
      this.paragraphs = [];
      this.index = -1;
      this.reading = false;
      this.rate = 1.0;
      this.synth = window.speechSynthesis;
    }
    getText(el) {
      const t = (el && (el.innerText || el.textContent) || '').replace(/\n|\r +/g, ' ').trim();
      return t.length ? t : null;
    }
    init() {
      if (!this.synth) return;
      const content = document.getElementById(CONTENT_ID);
      if (!content) return;
      let idx = 0;
      const tag = (el) => {
        if (!el) return false;
        if (this.getText(el)) { el.setAttribute('tts-paragraph-index', idx++); return true; }
        return false;
      };
      const meta = document.getElementById(META_DATA_ID);
      tag(meta && meta.querySelector('.title'));
      tag(meta && meta.querySelector('.subhead'));
      const isChildOf = (node, parent) => {
        while (node) { if (node === parent) return true; node = node.parentNode; }
        return false;
      };
      const it = document.createNodeIterator(content, NodeFilter.SHOW_TEXT,
        { acceptNode: () => NodeFilter.FILTER_ACCEPT });
      let parent = null, list = [], n;
      while ((n = it.nextNode())) {
        if (n === it.root || isChildOf(n, parent) || !this.getText(n)) continue;
        parent = n.parentNode;
        list = list.filter((p) => !isChildOf(p, parent));
        list.push(n.parentElement);
      }
      list.forEach((p) => { if (tag(p)) this.addPlayer(p); });
      this.paragraphs = Array.from(document.querySelectorAll('[tts-paragraph-index]'));
      const underline = document.createElement('div');
      underline.className = 'tts-underline';
      document.body.appendChild(underline);
    }
    addPlayer(p) {
      const player = document.createElement('span');
      player.className = 'tts-paragraph-player';
      const circle = document.createElement('span');
      circle.className = 'tts-circle';
      const btn = document.createElement('span');
      btn.className = 'tts-paragraph-player-button tts-play-icon';
      btn.title = 'Play / Pause';
      const onClick = () => this.playPause(parseInt(p.getAttribute('tts-paragraph-index'), 10));
      btn.onclick = circle.onclick = onClick;
      player.appendChild(circle);
      player.appendChild(btn);
      p.insertAdjacentElement('afterbegin', player);
    }
    setIcon(el, icon) {
      const b = el && el.querySelector('.tts-paragraph-player-button');
      if (b) { b.classList.remove('tts-play-icon', 'tts-pause-icon'); b.classList.add(icon); }
    }
    playPause(index) {
      if (this.reading && this.index === index) { this.stop(); return; }
      this.speakFrom(index);
    }
    speakFrom(index) {
      if (!this.synth) return;
      this.synth.cancel();
      this.index = index;
      const p = this.paragraphs[index];
      if (!p) { this.stop(); return; }
      this.reading = true;
      document.documentElement.setAttribute('data-toolbar-button', 'tts');
      this.highlightParagraph(index);
      if (toolbarApi) toolbarApi.sync();
      const u = new SpeechSynthesisUtterance(this.getText(p) || '');
      u.rate = this.rate;
      u.onboundary = (e) => {
        if (e.name === 'word' || e.charLength) {
          this.highlightWord(p, e.charIndex, e.charIndex + (e.charLength || 1));
        }
      };
      u.onend = () => {
        if (!this.reading) return;
        if (index + 1 < this.paragraphs.length) this.speakFrom(index + 1);
        else this.stop();
      };
      this.synth.speak(u);
    }
    stop() {
      this.reading = false;
      if (this.synth) this.synth.cancel();
      this.paragraphs.forEach((p) => {
        p.classList.remove('tts-highlighted');
        this.setIcon(p, 'tts-play-icon');
      });
      this.highlightWord(null, 0, 0);
      if (!toolbarBar || !toolbarBar.classList.contains('show-tts')) {
        document.documentElement.removeAttribute('data-toolbar-button');
      }
      if (toolbarApi) toolbarApi.sync();
    }
    skip(delta) {
      const next = Math.min(this.paragraphs.length - 1,
        Math.max(0, (this.index < 0 ? 0 : this.index) + delta));
      this.speakFrom(next);
    }
    changeSpeed(deltaPct) {
      this.rate = Math.min(2.0, Math.max(0.5, this.rate + deltaPct / 100));
      if (this.reading) this.speakFrom(this.index);
    }
    highlightParagraph(index) {
      this.paragraphs.forEach((p, i) => {
        const on = i === index;
        p.classList.toggle('tts-highlighted', on);
        this.setIcon(p, on ? 'tts-pause-icon' : 'tts-play-icon');
      });
    }
    highlightWord(paragraph, start, end) {
      const underline = document.querySelector('.tts-underline');
      if (!paragraph || start >= end) {
        if (CSS.highlights) CSS.highlights.clear();
        if (underline) {
          underline.classList.remove('tts-underline-visible');
          underline.setAttribute('data-top', 0);
        }
        return;
      }
      const it = document.createNodeIterator(paragraph, NodeFilter.SHOW_TEXT,
        { acceptNode: () => NodeFilter.FILTER_ACCEPT });
      const range = new Range();
      let startNode = null, endNode = null, node;
      while ((node = it.nextNode())) {
        if (!startNode && start < node.textContent.length) {
          startNode = node; range.setStart(node, Math.max(0, start));
        }
        if (!startNode) start -= node.textContent.length;
        if (!endNode && end <= node.textContent.length) {
          endNode = node; range.setEnd(node, end);
        }
        if (!endNode) end -= node.textContent.length;
      }
      if (!startNode || !endNode) return;
      const bodyRect = document.body.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      const top = r.bottom - bodyRect.top;
      const left = r.left - bodyRect.left;
      const width = r.width + 2;
      underline.classList.toggle('tts-underline-newline', underline.getAttribute('data-top') != top);
      underline.classList.toggle('tts-underline-decrease', underline.getAttribute('data-width') < width);
      underline.classList.add('tts-underline-visible');
      underline.setAttribute('data-top', top);
      underline.setAttribute('data-width', width);
      underline.style.setProperty('--tts-underline-top', top + 'px');
      underline.style.setProperty('--tts-underline-left', left + 'px');
      underline.style.setProperty('--tts-underline-width', width + 'px');
      if (CSS.highlights) CSS.highlights.set('tts-highlighted-word', new Highlight(range));
    }
    toggleArticle() {
      if (this.reading) this.stop();
      else this.speakFrom(this.index >= 0 ? this.index : 0);
    }
  }

  // ── Toolbar (recreates Brave's native SpeedReader toolbar) ───────────────────
  const ico = (name) => `<span class="sr-ico sr-ico-${name}"></span>`;

  function buildToolbar() {
    const set = (attr, val) => {
      settings[attr] = val;
      applySettings();
      saveSettings();
      sync();
    };
    const bar = document.createElement('div');
    bar.id = 'speedreader-toolbar';
    bar.innerHTML = `
      <div class="sr-inner">
        <div class="sr-main">
          <button class="sr-mbtn" data-panel="appearance" title="Appearance">${ico('characters')}</button>
          <button class="sr-mbtn" data-panel="tts" title="Text to speech">${ico('headphones')}</button>
        </div>
        <div class="sr-rest">
          <div class="sr-caption">${ico('speedreader')}<span>Speedreader</span></div>
          <div class="sr-panel sr-panel-appearance">
            <div class="sr-themes">
              <button class="sr-chip is-light" data-theme="light" title="Light"></button>
              <button class="sr-chip is-sepia" data-theme="sepia" title="Sepia"></button>
              <button class="sr-chip is-dark" data-theme="dark" title="Dark"></button>
              <button class="sr-chip is-system" data-theme="system" title="System"></button>
            </div>
            <div class="sr-group">
              <button class="sr-gbtn" data-family="sans" title="Sans">${ico('sans')}</button>
              <button class="sr-gbtn" data-family="serif" title="Serif">${ico('serif')}</button>
              <button class="sr-gbtn" data-family="mono" title="Mono">${ico('mono')}</button>
              <button class="sr-gbtn" data-family="dyslexic" title="Dyslexic">${ico('dyslexic')}</button>
            </div>
            <div class="sr-group">
              <button class="sr-gbtn" data-width="narrow" title="Narrow column">${ico('col-narrow')}</button>
              <button class="sr-gbtn" data-width="wide" title="Wide column">${ico('col-wide')}</button>
            </div>
            <div class="sr-group">
              <button class="sr-gbtn" data-font="dec" title="Decrease font size">${ico('minus')}</button>
              <span class="sr-indicator">${ico('fontsize')}<span class="sr-fontval">100%</span></span>
              <button class="sr-gbtn" data-font="inc" title="Increase font size">${ico('plus')}</button>
            </div>
            <button class="sr-text-close" data-close-panel="1">Close</button>
          </div>
          <div class="sr-panel sr-panel-tts">
            <div class="sr-group">
              <button class="sr-gbtn" data-tts="rewind" title="Previous paragraph">${ico('rewind')}</button>
              <button class="sr-gbtn sr-playpause" data-tts="playpause" title="Play / Pause">${ico('play')}</button>
              <button class="sr-gbtn" data-tts="forward" title="Next paragraph">${ico('forward')}</button>
            </div>
            <div class="sr-group">
              <button class="sr-gbtn" data-speed="dec" title="Slower">${ico('minus')}</button>
              <span class="sr-indicator">${ico('speed')}<span class="sr-speedval">100%</span></span>
              <button class="sr-gbtn" data-speed="inc" title="Faster">${ico('plus')}</button>
            </div>
            <button class="sr-text-close" data-close-panel="1">Close</button>
          </div>
          <button class="sr-close" title="Show original page (Esc)">${ico('close')}</button>
        </div>
      </div>`;

    const openPanel = (panel) => {
      bar.classList.toggle('show-appearance', panel === 'appearance');
      bar.classList.toggle('show-tts', panel === 'tts');
      bar.querySelectorAll('.sr-mbtn').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-panel') === panel));
      if (panel === 'tts') document.documentElement.setAttribute('data-toolbar-button', 'tts');
      else if (!tts || !tts.reading) document.documentElement.removeAttribute('data-toolbar-button');
    };
    const closePanels = () => openPanel(null);

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const panel = btn.getAttribute('data-panel');
      if (panel) {
        return bar.classList.contains('show-' + panel) ? closePanels() : openPanel(panel);
      }
      if (btn.getAttribute('data-close-panel')) return closePanels();
      if (btn.classList.contains('sr-close')) return restore();

      const theme = btn.getAttribute('data-theme');
      if (theme) return set('data-theme', theme);
      const family = btn.getAttribute('data-family');
      if (family) return set('data-font-family', family);
      const width = btn.getAttribute('data-width');
      if (width) return set('data-column-width', width);
      const font = btn.getAttribute('data-font');
      if (font) {
        const cur = parseInt(settings['data-font-size'], 10);
        const next = Math.min(150, Math.max(50, cur + (font === 'inc' ? 10 : -10)));
        return set('data-font-size', String(next));
      }
      const speed = btn.getAttribute('data-speed');
      if (speed && tts) { tts.changeSpeed(speed === 'inc' ? 10 : -10); return sync(); }
      const ttsAct = btn.getAttribute('data-tts');
      if (ttsAct && tts) {
        if (ttsAct === 'playpause') tts.toggleArticle();
        else if (ttsAct === 'forward') tts.skip(1);
        else if (ttsAct === 'rewind') tts.skip(-1);
        return sync();
      }
    });

    function sync() {
      bar.querySelectorAll('[data-theme]').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-theme') === settings['data-theme']));
      bar.querySelectorAll('[data-family]').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-family') === settings['data-font-family']));
      bar.querySelectorAll('[data-width]').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-width') === settings['data-column-width']));
      const fv = bar.querySelector('.sr-fontval');
      if (fv) fv.textContent = settings['data-font-size'] + '%';
      const sv = bar.querySelector('.sr-speedval');
      if (sv && tts) sv.textContent = Math.round(tts.rate * 100) + '%';
      const pp = bar.querySelector('.sr-playpause .sr-ico');
      if (pp) pp.className = 'sr-ico ' + (tts && tts.reading ? 'sr-ico-pause' : 'sr-ico-play');
    }

    document.body.appendChild(bar);
    toolbarBar = bar;
    toolbarApi = { sync, closePanels };
    sync();
  }

  function showMessage(title, message) {
    document.title = 'SpeedReader';
    document.body.replaceChildren();
    const box = document.createElement('div');
    box.id = 'article';
    box.innerHTML =
      `<h1 class="title metadata">${title}</h1>` +
      (message ? `<p class="subhead metadata">${message}</p>` : '') +
      (originalUrl ? `<p><a href="${originalUrl}">Go to the original page →</a></p>` : '');
    document.body.appendChild(box);
  }
  const showError = (message) => showMessage('Couldn’t open this page in SpeedReader', message);

  // ── Boot ─────────────────────────────────────────────────────────────────────
  // Surface any failure on the page itself so it's never a blank screen.
  window.addEventListener('error', (e) => {
    console.error('[SpeedReader] error', e.error || e.message);
    showError('JavaScript error: ' + (e.message || e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[SpeedReader] unhandled rejection', e.reason);
    showError('Error: ' + ((e.reason && e.reason.message) || e.reason));
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.altKey && !event.shiftKey &&
      !event.metaKey && !event.ctrlKey) {
      const panelOpen = toolbarBar &&
        (toolbarBar.classList.contains('show-appearance') || toolbarBar.classList.contains('show-tts'));
      if (panelOpen && toolbarApi) toolbarApi.closePanels();
      else restore();
      event.preventDefault();
    }
  });

  async function boot() {
    settings = await getSettings();
    engine = await getEngine();
    applySettings();
    document.documentElement.classList.add('sr-has-toolbar');

    if (!originalUrl) { showError('No page URL was provided.'); return; }
    showMessage('Loading…', originalUrl);

    // Resolve relative links/images in the distilled article against the source.
    const base = document.createElement('base');
    base.href = originalUrl;
    document.head.appendChild(base);

    let htmlText;
    try {
      const resp = await fetch(originalUrl);
      console.log('[SpeedReader] fetch', resp.status, resp.headers.get('content-type'));
      if (!resp.ok) { showError(`Fetch returned HTTP ${resp.status}.`); return; }
      htmlText = await resp.text();
      console.log('[SpeedReader] fetched', htmlText.length, 'chars');
    } catch (e) {
      console.error('[SpeedReader] fetch failed', e);
      showError('The page could not be fetched: ' + (e && e.message || e));
      return;
    }

    let result;
    try {
      result = await distill(htmlText, originalUrl);
    } catch (e) {
      console.error('[SpeedReader] distill threw', e);
      showError('Distillation failed: ' + (e && e.message || e));
      return;
    }
    if (!result) { showError('No readable article was found on this page.'); return; }

    document.body.replaceChildren();
    document.body.appendChild(result.root);
    document.title = result.title || 'SpeedReader';

    initShowOriginal();
    calculateReadtime();
    buildToolbar();
    tts = new TtsController();
    tts.init();
    console.log('[SpeedReader] rendered:', result.title);
  }

  boot().catch((err) => {
    console.error('[SpeedReader] boot failed', err);
    showError('Error: ' + (err && err.message || err));
  });
})();
