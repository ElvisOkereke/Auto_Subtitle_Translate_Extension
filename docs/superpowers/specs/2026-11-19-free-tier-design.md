# Free tier: Chrome's built-in translator

## Intent

An everyday user installs the extension and gets translations with no key, no
account and no cost. Today nothing is translated until a Google, DeepL or
Anthropic key is pasted in, which almost nobody has.

## Decisions (with the owner, 2026-11-19)

- The free tier is **Chrome's built-in Translator API** (on-device, desktop
  Chrome 138+). Measured on the 36-line Korean League benchmark: about 47%,
  level with DeepL line by line (46%) and Google (42%); Claude with context
  89%. Language packs download once (Korean: 15 s); a line then takes ~25 ms.
- **Chrome only for now.** Opera GX (Chromium 155), Edge and Brave expose the
  API but have no language packs ("unavailable"). Their users are told so and
  use their own key or the subscription. Other browsers are revisited after
  launch.

## Behaviour

- New fast provider **Built-in (free, on this computer)**, `builtin`. It is the
  default for new installs, and the fast tier falls back to it whenever the
  chosen provider has no key (or the subscription has no account), so existing
  installs without keys start working too.
- Claude stays the "best" tier on top (fast then best), unchanged.
- Covers every feature: Subtitles mode, Audio captions (live and read-ahead),
  Screen Translate.
- Source language: the subtitle language, or the spoken language; for "Detect
  automatically" Chrome's built-in Language Detector picks it per line.
- Where it runs: the offscreen document (an extension page; the API is not
  available in the service worker). The background asks it per line.
- Language packs need a click to download the first time. The setup page
  downloads them with "Download and prepare" (the packs for the subtitle
  language and the spoken language into the target language, and the
  language detector when the spoken language is "Detect automatically"). The
  downloads start at the click, before anything else, while the click still
  counts.
- When a pack is missing at translation time (a new language), the line is
  not translated and the user is told to prepare it on the setup page.
- In browsers without packs the setup page says free translation needs Google
  Chrome and points to Settings for a key or the subscription; it does not
  block "All set".

## Not in scope

- Free translation in non-Chrome browsers.
- Neighbouring-line context or glossary for the built-in translator (the API
  takes single strings).
