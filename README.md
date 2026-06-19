# Speedreader (Chrome extension)

A faithful recreation of Brave's **Speedreader** reading experience as a
Manifest V3 Chrome extension.

Unlike a typical reader-mode extension, this distills articles in a **dedicated
in-extension reader page** rather than mutating the live page. The original page
is fetched and distilled without ever being committed to a renderer, so its
scripts/trackers never run (privacy), there is no flash of original content, and
normal tabs stay light on memory.

## Build & install

```sh
make           # builds dist/
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the generated **`dist/`** folder
4. Open an article and click the Speedreader toolbar icon.
   Right-click the icon → **Options** to enable automatic mode.

### Make targets

| Target | Does |
|--------|------|
| `make` / `make build` | Assemble `dist/` (copy sources, render icons, build WASM — fails if the WASM toolchain is missing) |
| `make icons` | Render the action/toolbar PNGs from `src/icons/icon-source.svg` |
| `make vendor-rust BRAVE_SRC=/path/to/brave-core` | Copy Brave's `readability` crate into `wasm/vendor-readability` |
| `make wasm` | Compile Brave's distiller to WASM (needs `wasm-pack` + vendored crate) |
| `make clean` | Remove `dist/` |

## Layout

```
src/        authored + vendored extension sources (the input)
  manifest.json  background.js  detect.js        reader.html / reader.js
  options.*      reader.css     toolbar.css       fonts/  icons/  vendor/
wasm/       Rust → WASM wrapper around Brave's readability crate
dist/       BUILT, loadable extension (generated; git-ignored)
Makefile    reproducible build
```

## Using it

- Click the toolbar icon to open the current article in Speedreader.
- The top toolbar (Brave's layout) controls text size, font family
  (Sans / Serif / Mono / OpenDyslexic), theme (Light / Sepia / Dark / System),
  column width, and read-aloud (TTS).
- Press **Esc**, the **✕**, or **View original** to return to the source page.

## Distillation: pick the engine in Options

Both distillers ship in every build, and you choose one in **Options → Distiller
engine** (it is an explicit, labeled setting — never a silent fallback):

- **Brave (exact) — default.** Brave's Rust distiller compiled to WASM (`wasm/`,
  loaded from `vendor/wasm/`). **Byte-identical extraction to Brave.** Building it
  needs `wasm-pack` + the vendored crate (`make vendor-rust BRAVE_SRC=…`).
- **Mozilla Readability — lighter.** Brave's Rust distiller is a port of Mozilla's
  Readability, so this plain-JavaScript library (`vendor/Readability.js`, loaded on
  demand) gives a close result with no Rust toolchain — but it is **not** identical
  to Brave on edge cases (Brave's Rust has since diverged with its own scoring/NLP).

> The small `Readability-readerable.js` helper is also bundled, but only for the
> toolbar's "is this an article?" detection in `detect.js` — it is not a distiller.

## What makes it match Brave

| Piece | How parity is achieved |
|-------|------------------------|
| Architecture | In-extension reader page (Option A): original page never renders → privacy, no FOUC, low per-tab memory |
| Distillation | WASM build of Brave's own Rust distiller (Mozilla Readability selectable in Options) |
| Page structure | Brave's exact distilled DOM — the `#article` / metadata / content layout and the four hardcoded element IDs from `extractor.rs` |
| Look & feel | Brave's **verbatim `speedreader-desktop.css`** + the bundled Atkinson Hyperlegible and OpenDyslexic fonts and Leo toolbar icons |
| Themes / fonts / sizing | The same `<html data-theme / data-font-family / data-font-size / data-column-width>` attributes Brave's CSS keys off |
| Read time & TTS | Ported from Brave's `speedreader-desktop.js` (265 wpm; TTS reuses Brave's highlight/underline CSS via the Web Speech API) |

## Known trade-offs (inherent to an extension)

- The address bar shows the `chrome-extension://…/reader.html?url=…` URL, not
  the article URL (the cost of never rendering the original).
- Client-rendered / SPA / hard-paywalled pages may not distill, since only the
  fetched static HTML is available.

Brave assets (`reader.css`, `fonts/`, Leo icons) are MPL-2.0; Mozilla
Readability is Apache-2.0.
