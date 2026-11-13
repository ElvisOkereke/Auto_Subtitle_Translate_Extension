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

## Highlights

The vision: watch anything, in any language, as if it had been subtitled for
you. Every number below comes from an automated run in a real browser.

**Burned-in subtitle translation**
- **0.20 s** from a subtitle appearing to its translation on screen, or
  0.48 s including a real DeepL round trip.
- On-device OCR: PaddleOCR on WebGPU via ONNX Runtime Web, at **2.3%
  character error and 22 ms per frame**. Tesseract was benchmarked and
  rejected at 17.4% error.
- **Read-ahead:** the extension taps the YouTube player's Media Source stream
  and decodes the buffered video ahead of playback with WebCodecs. **29 of 29
  lines** were translated before they appeared, about 28 s early, with no
  extra network traffic.

**Context-aware translation**
- Claude with video context, topic summary and a learned glossary was judged
  **0.93 vs 0.50 for DeepL** on Korean League of Legends subtitles, with names
  and slang kept consistent.
- In a blind comparison on real subtitles, Claude beat DeepL on Spanish
  football, Japanese anime and a Korean drama.

**On-device speech recognition**
- Whisper runs in the browser: **1.05 s** from end of speech to translated
  caption.
- The model download was cut **from 971 MB to 209 MB**, and inference made
  **5× faster**.

**Hosted subscription service**
- Built with Node, Hono and SQLite: email-code auth, Stripe billing, and a
  metered translation proxy with per-plan budgets.
- Priced from measured cost: **~$3.40 per hour of video** with Claude Opus.
- Docker on Google Cloud with least-privilege service accounts.

**Verification:** 371 automated tests and 17 Playwright suites, which drive a
real Chrome with the extension loaded. They cover real tab audio, real video
frames, real DeepL and Claude calls, and real YouTube; Claude scores the
translation quality.

**Stack:** TypeScript, Chrome MV3 (service worker, offscreen document,
content scripts), WebGPU, WebCodecs and Media Source Extensions, ONNX Runtime
Web, transformers.js, the Claude API, DeepL, Node, Hono, SQLite, Stripe,
Docker, GCP, Playwright and Jest.

## Status and roadmap

- **Done:**
  - Subtitles mode with read-ahead
  - Audio mode
  - Screen Translate
  - Context-aware Claude translation with glossary
  - Hosted subscription service
  - Redesigned light and dark UI
- **In progress:** a real-world benchmark on 8 YouTube videos in 5 subtitle
  languages (League, football, TV drama), running in all three engine modes.
  The fixes it drives:
  - a minimum reading time;
  - read-ahead for YouTube's VP9 format;
  - fewer missed lines.
- **Next:**
  - audio read-ahead timed to the video;
  - automatic subtitle detection;
  - deploying the service and publishing on the Chrome Web Store.

More detail: [project overview](docs/project-overview.md) (vision,
architecture, full status) and [milestones](docs/milestones.md) (measured
wins, newest first).

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
