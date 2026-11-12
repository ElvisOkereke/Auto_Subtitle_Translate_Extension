# Auto Subtitle Translator

A Chrome (MV3) extension that translates what you watch, live:

- **Subtitles mode** — draw a box around subtitles that are *burned into* a
  video (e.g. Korean subtitles on a League of Legends stream) and the English
  appears on top of them, in place, as the video plays. Works on YouTube and
  other `<video>` pages.
- **Audio mode** — live captions from the tab's speech, translated.
- **Screen Translate** — drag a box over text on any page for a one-shot
  translation.

Speech recognition and OCR run **locally in your browser** (no key, no server).
Translation uses DeepL or Google Cloud Translation with your own API key.

## Install (developer build)

```bash
npm install
npm run build          # dev build into dist/   (npm run build:prod for minified)
```

Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
select `dist/`. Open the popup and paste a DeepL (free keys end in `:fx`) or
Google Translate API key.

## Use

**Subtitles mode** — on the video page open the popup → **Subtitles** →
pick the subtitle language → **Draw subtitle box** → drag a box around where
the subtitles appear. The box is remembered per video (**Start (saved box)**
next time). The English sits on a see-through tint over the original line and
updates as the subtitles change; nothing is shown when there's no subtitle.

**Audio mode** — popup → **Audio** → **Start Subtitles**. The first run
downloads the speech model (~209 MB on GPUs with WebGPU, 80 MB otherwise).

Only one mode runs at a time. Position/size settings in the popup apply to
audio captions.

## How it works

| Piece | Where |
|---|---|
| Subtitle mode controller: frame sampling → change detection → OCR → translation → per-video timeline → overlay | `src/subtitle/` |
| Read-ahead: taps the player's MSE stream (main world), decodes buffered video ahead of playback with WebCodecs, so most subtitles are translated before they appear | `src/subtitle/readAhead/` |
| OCR: PaddleOCR PP-OCRv5 (ONNX Runtime Web, WebGPU → wasm fallback) in a worker inside a hidden extension iframe; saved timelines live in that extension-origin iframe | `src/ocr/` |
| Live captions: tab capture → offscreen VAD → Whisper (transformers.js) worker | `src/offscreen.ts`, `src/whisper.worker.ts` |
| Translation (DeepL / Google, neighbouring-line context, live-before-read-ahead priority) | `src/services/apiService.ts`, `src/background.ts` |
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
| `npm test` | Jest unit tests |
| `npm run test:e2e` | Browser tests: popup, Screen Translate, live captions, subtitle mode (OCR, overlay, live path, read-ahead) |
| `npm run test:live` | Real DeepL (needs `DEEPL_API_KEY` in `.env`) |
| `npm run e2e:youtube` | Subtitle mode on real YouTube (installed Chrome, opt-in) |
| `npm run e2e:judge` | Claude scores displayed translations (opt-in, Anthropic credentials) |
| `npm run perf:stt` | Speech-model benchmark |

Test pages, audio and the frame-labelled subtitle timeline are in
`e2e/fixtures/`; reports land in `e2e/.perf/`. See `CLAUDE.md` for harness
details and gotchas.
