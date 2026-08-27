# Deserif

A Chrome extension that strips the serif headline fonts every AI-built website ships with
(Playfair Display, Instrument Serif, Fraunces, Cormorant, Lora, DM Serif, Newsreader and the rest)
and renders them in Helvetica instead. It also tells you which serif a page is using, so the
"what font is this" question answers itself. On Facebook it hides the images Meta itself has
labeled as made with AI behind a grey "AI SLOP" card that you can click to reveal.

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
- No network requests, no analytics, no accounts, no API keys. Settings live in
  `chrome.storage.sync`.

## AI images on Facebook

Meta puts a small "AI info" label on posts and comments that were made with AI, either because
the poster said so or because the file carried AI-generator metadata. Deserif looks for that label
and swaps every content image inside the labeled post or comment (avatars, emoji and icons are
skipped) for a grey card with a red prohibition sign and the words AI SLOP. The card is the same
size as the image, so nothing on the page moves. Click the card and the original comes back; the
popup has Show all and Hide again for the whole page.

- Only what Facebook labels gets hidden. If Meta missed one, so does Deserif. Content Meta marks
  as merely "edited with AI" keeps its label inside the post menu, where the extension cannot
  see it.
- The label is the same one you see next to the post, in any of the languages Facebook shows it
  in that we know of. Comments are judged on their own label, not the post's.
- Images that scroll in later, labels that render late, posts that lose their label, and `<img>`
  elements Facebook recycles for a different picture are all handled.
- The badge turns red with the number of hidden images. Turning the extension off for
  facebook.com (`Alt+Shift+D`) restores every hidden image on the page.
- Nothing getting hidden on a page that clearly has the label? Click **Diagnose** in the popup on that
  tab, copy the report and paste it into an issue. It lists what the script sees (post containers,
  qualifying images, every short piece of text mentioning AI and whether it matched) so the matcher
  can be extended for markup we have not seen.

## Popup

- **Master switch** and a per-site switch (also `Alt+Shift+D`).
- **Serif fonts on this page**: every serif family found, with element counts. The usual
  LLM picks carry an "AI favorite" tag.
- **All serifs** replaces everything serif, including Georgia and Times. **AI favorites only**
  limits it to the Google Fonts list that vibe-coded sites use, and leaves classic serifs alone.
- **With**: Helvetica (default), System UI, Inter, Arial, or a custom stack.
- **Un-italicize serif headline accents**: the "one *word* in italic serif" headline trick gets
  straightened out too. Only applies inside replaced headings.
- **AI images on Facebook**: on/off, and on a Facebook tab the labeled and hidden counts with
  Show all, Hide again, Recheck and Diagnose.

## Repo layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` | Scanner, classifier, stylesheet injection, mutation handling |
| `slop.js` | Facebook only: finds Meta's AI label, swaps the images in that post for the card, click to reveal |
| `background.js` | Defaults, badge, keyboard shortcut |
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

`test/slop/run.sh` checks the Facebook blocker. facebook.com is HSTS-preloaded, so it serves a
fake feed over TLS on a fixed port with a throwaway self-signed certificate, maps `*.fbcdn.net` to
the same server, and drives Chromium over CDP. The feed has labels in the post header, overlaid on
the photo, on an icon-only button's aria-label, inside a comment, arriving late, and removed later,
plus a comment that merely mentions "AI info" in a sentence, avatars, emoji, an off-site image and
a recycled `<img>`. It covers hidden vs left alone, the box keeping its size, a real click
revealing the image without opening the photo viewer, revealed images staying revealed through
re-renders, Show all / Hide again, and off and on again. Needs `openssl` and python3 with
websocket-client.

## Adding a font to the lists

Open `content.js`. `AI_SERIF` is the list that gets the "AI favorite" tag and drives
"AI favorites only" mode. `OTHER_SERIF` is everything else that should be replaced in
"All serifs" mode. `KEEP` is known non-serif families that stop the stack walk. Entries are
regex fragments, lowercase, matched against each family name in the stack.

## License

MIT.
