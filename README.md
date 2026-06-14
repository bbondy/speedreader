# SpeedReader (Chrome extension)

A faithful recreation of Brave's **SpeedReader** reading experience as a
Manifest V3 Chrome extension.

The idea: distill articles in a **dedicated in-extension reader page** rather
than mutating the live page. The original page is fetched and distilled without
ever being committed to a renderer, so its scripts/trackers never run (privacy),
there is no flash of original content, and normal tabs stay light on memory.

## Build & install

```sh
make           # builds dist/
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the generated **`dist/`** folder

## Status

Early work in progress.
