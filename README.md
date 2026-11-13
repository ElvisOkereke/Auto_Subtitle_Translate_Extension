# Auto Subtitle Translator

A Chrome (MV3) extension that translates what you watch, live:

- **Subtitles mode** — draw a box around subtitles that are *burned into* a
  video (e.g. Korean subtitles on a League of Legends stream) and the English
  appears on top of them, in place, as the video plays. Works on YouTube and
  other `<video>` pages; on YouTube most lines are translated before they
  appear (read-ahead).
- **Audio mode** — live captions from the tab's speech, translated.
- **Screen Translate** — drag a box over text on any page for a one-shot
  translation.

Speech recognition and OCR run **locally in your browser** (no key, no server).
Translation is **fast then best**: DeepL (or Google) puts a translation up
immediately, then Claude replaces it with a context-aware one that knows what
the video is about (title, channel, description) and keeps names and jargon
consistent with a learned glossary. Either **bring your own keys** (a
DeepL/Google key and an Anthropic API key, or any Anthropic-compatible gateway)
or **sign in and subscribe** to use the hosted service with no keys at all.

## Install (developer build)

```bash
npm install
npm run build          # dev build into dist/   (npm run build:prod for minified)
```

Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `dist/`. Open the popup, click the gear (**Settings**) and paste a DeepL
(free keys end in `:fx`) or Google Translate API key, and for context-aware
translation an Anthropic API key (or choose **Anthropic-compatible gateway** and
enter its URL and token). Keys are stored only in this browser's local extension
storage.

## Use

The popup opens on what you do every time: the **caption bar** at the top says
what's happening in this tab ("Translating Korean subtitles into English"),
then the two modes, the **Translate into** language and **Screen Translate**.
Setup (keys or subscription, engine, glossary, caption style, theme) lives
behind the gear; the **Engine** and **Account** rows on the main view show the
current choice and open the right settings. **Appearance** switches between
light, dark and *Match system*; the Screen Translate panel on web pages follows
it too.

**Subtitles mode** — on the video page open the popup → **Subtitles** →
pick the subtitle language → **Draw subtitle box** → drag a box around where
the subtitles appear. The box is remembered per video (**Use saved box**
next time). The English sits on a see-through tint over the original line and
updates as the subtitles change; nothing is shown when there's no subtitle.
Each line stays up long enough to read: at least 1.5 s (longer for long lines,
about 15 characters a second, up to 6 s) even when the original flashes by. A
new subtitle replaces it at once, and pausing the video freezes it. On YouTube
both video formats it serves (AV1/MP4 and VP9/WebM) are read ahead.

**Audio mode** — popup → **Audio** → **Start live captions**. The first run
downloads the speech model (~209 MB on GPUs with WebGPU, 80 MB otherwise).

Only one mode runs at a time. Caption position and size (Settings → Live
captions) apply to audio captions.

**Translation engine** (Settings): *Fast then best* (default with Claude access),
*Fast only*, or *Best only*; Claude model Opus 5.5 (default), Sonnet 5.5 or
Haiku 5.5. **Glossary for this video** lists the names and terms Claude fixed
(e.g. 뽀삐 → Poppy); correct or delete an entry and the lines using it are
re-translated. Terms are shared with other videos of the same topic once two
different channels agree (or immediately when you correct them).

## How it works

| Piece | Where |
|---|---|
| Subtitle mode controller: frame sampling → change detection → OCR → translation → per-video timeline → overlay | `src/subtitle/` |
| Read-ahead (YouTube): taps the player's MSE stream (main world), decodes buffered video ahead of playback with WebCodecs, so most subtitles are translated before they appear | `src/subtitle/readAhead/` |
| OCR: PaddleOCR PP-OCRv5 (ONNX Runtime Web, WebGPU → wasm fallback) in a worker inside a hidden extension iframe; saved timelines live in that extension-origin iframe | `src/ocr/` |
| Live captions: tab capture → offscreen VAD → Whisper (transformers.js) worker | `src/offscreen.ts`, `src/whisper.worker.ts` |
| Translation engine layer: fast tier (DeepL / Google) and best tier (Claude with video context, topic summary, glossary, batching), browser-independent engines | `src/translation/`, `src/background.ts` |
| Hosted service for subscribers: email-code accounts, Stripe billing, translation proxy with per-plan budgets (Docker on a Compute Engine VM) | `server/` — see [server/README.md](server/README.md), pricing in [docs/pricing.md](docs/pricing.md) |
| Popup | `popup.html`, `src/popup.ts` |

Design docs and decision records: `docs/superpowers/`. Benchmarks:
[docs/performance.md](docs/performance.md).

## Testing

Everything is verified automatically — Playwright drives a real browser with
the extension loaded (Chromium by default, installed Chrome with
`E2E_BROWSER=chrome` for real WebGPU).

```bash
npm run fixtures:video   # once: downloads the test video + cuts fixtures (Python venv in e2e/.cache)
npm run verify           # types + lint + unit + e2e (ui, captions, subtitles) + live DeepL
```

| Command | What |
|---|---|
| `npm test` | Jest unit tests (extension + server) |
| `npm run server:test` / `npm run server:dev` | Hosted service tests / local server (login codes at `/dev/outbox`) |
| `npm run test:e2e` | Browser tests: popup, Screen Translate, live captions, subtitle mode (OCR, overlay, live path, read-ahead) |
| `npm run test:live` | Real DeepL (`DEEPL_API_KEY` in `.env`) and real Claude through a local relay (`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` or `ANTHROPIC_API_KEY` in the environment; `CLAUDE_MODEL` to pick the model) |
| `npm run e2e:youtube` | Subtitle mode on real YouTube (installed Chrome, opt-in) |
| `npm run e2e:judge` | Claude scores displayed translations, and the cross-domain benchmark (football/anime/drama) — opt-in, Anthropic credentials |
| `npm run perf:stt` | Speech-model benchmark |

Test pages, audio and the frame-labelled subtitle timeline are in
`e2e/fixtures/`; reports land in `e2e/.perf/`. See `CLAUDE.md` for harness
details and gotchas.
