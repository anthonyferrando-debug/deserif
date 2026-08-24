# Deserif

A Chrome extension that strips the serif headline fonts every AI-built website ships with
(Playfair Display, Instrument Serif, Fraunces, Cormorant, Lora, DM Serif, Newsreader and the rest)
and renders them in Helvetica instead. It also tells you which serif a page is using, so the
"what font is this" question answers itself. Since 1.1 it also hides AI-generated images in your
Facebook feed behind a grey "AI SLOP" card that you can click to reveal.

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
- The badge on the toolbar icon shows how many serif families were replaced on the page, or, in
  red, how many AI images are hidden on a Facebook page.
- The font part makes no network requests. The Facebook part talks to the Anthropic API with your
  own key and to nothing else (details below). No analytics, no accounts. Settings live in
  `chrome.storage.sync`; the API key stays in `chrome.storage.local` on that one browser.

## AI slop images on Facebook

Every image in the feed or in comments that is big enough to be content (avatars, emoji and icons
are skipped) is downscaled to 768px and sent to Claude with the question "was this made by an AI
image generator?". A yes swaps the picture for a grey card with a red prohibition sign and the words
AI SLOP. The card is the same size as the image, so nothing on the page moves. Click the card and
the original comes back; the popup has Show all and Hide again for the whole page.

- **You need an Anthropic API key.** Create one at https://console.anthropic.com/ and paste it in
  the popup. The key is stored locally in that browser only and is sent to `api.anthropic.com` and
  nowhere else. The Test button makes a one-line request so you know the key works.
- **Cost.** A downscaled feed image is roughly 500 to 900 input tokens. With Claude Opus 5 (the
  default) that is under a cent per new image, with Sonnet 5 or Haiku 4.5 a fraction of that.
  Verdicts are cached by CDN path, so the same picture is never paid for twice, and images are
  only checked when they come within about a screen of the viewport.
- **Sensitivity.** The model returns a verdict and a confidence. "Hide when the model is 60% sure or
  more" is the default; 40% catches more, 80% only hides the obvious. Changing it re-applies the
  cached verdicts instantly.
- **Blur until checked** blurs an image for the second or two it takes to get a verdict, so slop
  does not flash by while it is being classified. Turn it off if you prefer no blur.
- The badge turns red with the number of hidden images. Turning the extension off for
  facebook.com (`Alt+Shift+D`) restores every hidden image on the page.
- Fails open: if the key is missing or rejected, the API is slow, or the model cannot decide,
  the image is shown as normal.

Advanced: `slopApiBase` in `chrome.storage.local` points the requests at another Messages-API
compatible endpoint (a proxy, or the mock server the tests use).

## Popup

- **Master switch** and a per-site switch (also `Alt+Shift+D`).
- **Serif fonts on this page**: every serif family found, with element counts. The usual
  LLM picks carry an "AI favorite" tag.
- **All serifs** replaces everything serif, including Georgia and Times. **AI favorites only**
  limits it to the Google Fonts list that vibe-coded sites use, and leaves classic serifs alone.
- **With**: Helvetica (default), System UI, Inter, Arial, or a custom stack.
- **Un-italicize serif headline accents**: the "one *word* in italic serif" headline trick gets
  straightened out too. Only applies inside replaced headings.
- **AI slop images on Facebook**: on/off, the API key with a Test button, the model, the
  confidence threshold, blur-until-checked, and on a Facebook tab the hidden count with
  Show all, Hide again and Recheck.

## Repo layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` | Scanner, classifier, stylesheet injection, mutation handling |
| `slop.js` | Facebook only: finds feed images, swaps slop for the card, click to reveal |
| `background.js` | Defaults, badge, keyboard shortcut, and the Claude classifier with its verdict cache |
| `popup.html` / `popup.js` | Settings UI and the font list |
| `icons/` | Toolbar icons (`python3 test/make_icons.py` regenerates them) |
| `docs/` | The GitHub Pages site |
| `test/` | Headless end-to-end checks (`test/run.sh`, `test/slop/run.sh`) and a popup mock |
| `pack.py` | Builds `dist/deserif.zip` for a release |

## Testing

`test/run.sh` serves `test/site` over http, loads the extension into headless Chromium
(`CHROME=/path/to/chrome` to override), and checks 18 cases: Playfair, Tailwind's `font-serif`
stack, Roboto Slab vs Roboto, Merriweather Sans, Plex Mono, a DM Serif pseudo-element next to a
Font Awesome one, unknown brand fonts with serif and sans fallbacks, inline `!important` Georgia,
a body-class theme switch, a late stylesheet, a node injected after load, a shadow-DOM component,
and an italic accent word. It prints `PASS` or what differed.

`test/slop/run.sh` checks the Facebook blocker without a real key. facebook.com is HSTS-preloaded,
so it serves a fake feed over TLS on a fixed port with a throwaway self-signed certificate, maps
`*.fbcdn.net` to the same server, points the extension at `mock_api.py` (a stand-in for the Claude
API that fingerprints the images it receives and answers from a table), and drives Chromium over
CDP. It covers: hidden vs left alone, avatars and emoji never sent, duplicate URLs asked once,
images added later and recycled elements, the box keeping its size, a real click revealing the
image without opening the photo viewer, Show all / Hide again, threshold changes, off and on again
from the cache, the exact request shape, the Test button, and a rejected key. Needs `openssl` and
python3 with Pillow and websocket-client.

## Adding a font to the lists

Open `content.js`. `AI_SERIF` is the list that gets the "AI favorite" tag and drives
"AI favorites only" mode. `OTHER_SERIF` is everything else that should be replaced in
"All serifs" mode. `KEEP` is known non-serif families that stop the stack walk. Entries are
regex fragments, lowercase, matched against each family name in the stack.

## License

MIT.
