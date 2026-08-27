# Deserif

A Chrome extension that strips the serif headline fonts every AI-built website ships with
(Playfair Display, Instrument Serif, Fraunces, Cormorant, Lora, DM Serif, Newsreader and the rest)
and renders them in Helvetica instead. It also tells you which serif a page is using, so the
"what font is this" question answers itself.

**Site and install guide:** https://anthonyferrando-debug.github.io/deserif/
**Download:** https://github.com/anthonyferrando-debug/deserif/releases/latest/download/deserif.zip

## Install (unpacked, about a minute)

1. Download `deserif.zip`, unzip it, and keep the `deserif` folder somewhere permanent
   (Chrome reads the folder live; deleting it breaks the extension).
2. Open `chrome://extensions` (`brave://extensions` in Brave, `edge://extensions` in Edge) and
   turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `deserif` folder, the one with `manifest.json` inside.
4. Pin it from the puzzle-piece menu. Reload any tabs that were already open.

Works in Chrome, Brave, Edge, Arc and anything else Chromium-based.

## What it does

- Reads each element's computed `font-family`, walks the stack, and decides whether the first
  font it recognises is a serif. Serif elements get a `data-deserif` attribute; one injected
  stylesheet maps that attribute to the replacement stack with `!important` and a specificity
  nothing on the page will beat.
- Catches `::before` / `::after` decorations, open shadow DOM, iframes, late-loading stylesheets,
  theme toggles, and anything added to the page later. Inline `font-family: X !important` is the
  one thing a stylesheet cannot beat, so those elements get an inline override instead.
- Leaves sans, monospace and icon fonts alone. "Merriweather Sans" stays, "Merriweather" goes.
  Font Awesome, Material Symbols and friends are never touched.
- The badge on the toolbar icon shows how many serif families were replaced on the page.
- No network requests, no analytics, no accounts. Settings live in `chrome.storage.sync`.

## Popup

- **Master switch** and a per-site switch (also `Alt+Shift+D`).
- **Serif fonts on this page**: every serif family found, with element counts. The usual
  LLM picks carry an "AI favorite" tag.
- **All serifs** replaces everything serif, including Georgia and Times. **AI favorites only**
  limits it to the Google Fonts list that vibe-coded sites use, and leaves classic serifs alone.
- **With**: Helvetica (default), System UI, Inter, Arial, or a custom stack.
- **Un-italicize serif headline accents**: the "one *word* in italic serif" headline trick gets
  straightened out too. Only applies inside replaced headings.

## Repo layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` | Scanner, classifier, stylesheet injection, mutation handling |
| `background.js` | Defaults, badge, keyboard shortcut |
| `popup.html` / `popup.js` | Settings UI and the font list |
| `icons/` | Toolbar icons (`python3 test/make_icons.py` regenerates them) |
| `docs/` | The GitHub Pages site |
| `test/` | Headless end-to-end check (`test/run.sh`) and a popup mock |
| `pack.py` | Builds `dist/deserif.zip` for a release |

## Testing

`test/run.sh` serves `test/site` over http, loads the extension into headless Chromium
(`CHROME=/path/to/chrome` to override), and checks 18 cases: Playfair, Tailwind's `font-serif`
stack, Roboto Slab vs Roboto, Merriweather Sans, Plex Mono, a DM Serif pseudo-element next to a
Font Awesome one, unknown brand fonts with serif and sans fallbacks, inline `!important` Georgia,
a body-class theme switch, a late stylesheet, a node injected after load, a shadow-DOM component,
and an italic accent word. It prints `PASS` or what differed.

## Adding a font to the lists

Open `content.js`. `AI_SERIF` is the list that gets the "AI favorite" tag and drives
"AI favorites only" mode. `OTHER_SERIF` is everything else that should be replaced in
"All serifs" mode. `KEEP` is known non-serif families that stop the stack walk. Entries are
regex fragments, lowercase, matched against each family name in the stack.

## License

MIT.
