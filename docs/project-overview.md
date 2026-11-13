# Project overview: Auto Subtitle Translator

A Chrome extension that translates what you watch, live: it reads subtitles
burned into a video, or listens to its speech, and shows the translation on
the video as it plays. On-device machine learning handles recognition; a
context-aware LLM handles translation; a small hosted service sells it as a
subscription.

This page is the one-stop summary of what the project is, what has been built,
how well it works (with measured numbers), and where it is going. Detailed
evidence lives in the linked documents; every number below comes from an
automated run in a real browser.

- Repository: https://github.com/ElvisOkereke/Auto_Subtitle_Translate_Extension
- Author: Elvis Okereke
- Period: July 2025 – present (active)

## The problem and the vision

Huge amounts of video, such as esports streams, football coverage, anime, TV
dramas and creator content, are only subtitled in their original language,
and the subtitles are often burned into the picture. Platform auto-translate
can't touch burned-in text, and generic machine translation mangles names and
jargon (champion names, player names, slang).

The vision: **watch anything, in any language, as if it had been subtitled for
you.** That breaks down into three goals:

1. **Accurate:** context-aware translation that knows what the video is about
   and keeps names and terms consistent.
2. **On time:** each line is translated before or as it appears, stays up
   long enough to read, and follows pause, seek and rewind.
3. **Private and cheap:** recognition runs on the user's own GPU in the
   browser; only text goes to a translator.

The first target audience is viewers of Korean League of Legends videos.
Testing now also covers football, TV drama and other languages.

## What it does

| Feature | What the user gets |
|---|---|
| **Subtitles mode** | Draw a box around subtitles burned into a video, and the translation appears on top of the original line, in place. On YouTube most lines are translated *before* they appear, by reading the video the player has already buffered. |
| **Audio mode** | Live translated captions from any tab's speech (Whisper speech recognition running locally). |
| **Screen Translate** | Drag a box over text on any web page for a one-shot translation. |
| **Translation engines** | Fast tier (DeepL / Google) and best tier (Claude with video context, topic summary and a learned glossary). The modes are *Fast then best*, *Fast only* and *Best only*. Users bring their own keys or an Anthropic-compatible gateway. |
| **Subscription** | Sign in with an email code and subscribe through Stripe to use the hosted translation service with no API keys. Every request is metered against a monthly budget. |
| **Popup UI** | A caption bar states what's happening in the tab. Main and settings views, light and dark themes, an editable per-video glossary. |

## Engineering highlights (measured)

**Burned-in subtitle translation**
- Subtitle appears to translation on screen in **0.20 s** (median, Chrome +
  GPU), or **0.48 s** including a real DeepL round trip.
- On-device OCR (PaddleOCR PP-OCRv5 via ONNX Runtime Web on WebGPU):
  **2.3% character error rate at 22 ms per frame**, 0 false positives on
  gameplay. Tesseract was benchmarked and rejected (17.4% error).
- **Read-ahead:** the extension taps the YouTube player's Media Source
  Extensions stream, demuxes the buffered fragmented-MP4 video and decodes it
  ahead of playback with WebCodecs. It then OCRs and translates subtitles about
  28 s before they appear: **29 of 29 lines** were ready in time, with zero OCR
  work during steady playback and zero extra network traffic.

**Context-aware translation**
- An engine benchmark on 36 real Korean League lines scored Claude Opus with
  context at **89%**, DeepL with context 65%, DeepL line-by-line 46%, Google
  42%, and local open models at 15% or less.
- With video context, topic summary and glossary, Claude's quality was judged
  **0.93 vs 0.50 for DeepL**, with champion names and slang right in 10–11 of 11
  lines and every name spelled consistently.
- Across domains, in a blind comparison on real subtitles, Claude beat DeepL on
  a LaLiga Clásico (Spanish, 83% of lines), an anime episode (Japanese, 67%) and
  a K-drama (Korean, 77%).
- Cost was measured at **~$0.006 per line (~$3.40 per hour of video)** with
  Claude Opus. This drives subscription pricing (Standard $9.99, Pro $24.99 per
  month), with per-period budgets enforced server-side.

**On-device speech recognition**
- Whisper runs in a browser worker on WebGPU, with a WebAssembly fallback.
  End of speech to translated caption takes **1.05 s**.
- Model download was cut **from 971 MB to 209 MB**, and inference made **5×
  faster** (1.93 s to 0.38 s per clip), with no accuracy loss on the test
  clips.

**Hosted service**
- Node 22, Hono and SQLite (`node:sqlite`), plus Stripe Checkout, the
  customer portal and webhooks.
- Email one-time-code auth: codes and tokens stored hashed, rate limits, and
  lockouts.
- A translation proxy reuses the extension's engine code, with per-plan
  in-flight caps and budgets.
- Docker image on a Compute Engine VM: Caddy for HTTPS, Secret Manager, a
  least-privilege service account, and containers blocked from the metadata
  server. Deployed with a one-command script.

**Verification**
- **371 automated tests** on main, plus 17 Playwright suites.
- Playwright drives a real Chromium or Chrome with the extension loaded. It
  covers captions from real tab audio, OCR on real video frames, real DeepL and
  Claude calls, and real YouTube. Claude itself scores translation quality.
- A single `npm run verify` gate (types, lint, unit, end-to-end, live API) is
  the definition of done; manual testing is not part of the process.

## Architecture

```
YouTube / any <video> page
 ├─ content script ── Subtitles mode controller
 │     frame sampling → change detection → OCR (hidden extension iframe:
 │     PaddleOCR on WebGPU) → per-video timeline → in-place overlay
 │     read-ahead: main-world MSE tap → fMP4 demux → WebCodecs decode
 │                 → box crops ahead of playback (untrusted, bounded)
 ├─ offscreen document ── tab capture → voice activity detection
 │     → Whisper worker (transformers.js) → captions
 └─ service worker ── translation service
       fast tier: DeepL / Google
       best tier: Claude (video context, topic summary, glossary,
                  batching, cooldowns) or the hosted proxy
                         │
                         ▼
       hosted service (server/): accounts, Stripe billing,
       metered translation proxy, SQLite, Docker on GCE
```

- Language: TypeScript throughout.
- Build: webpack, with a separate web-worker compiler for the ML workers.
- Tests: Jest, plus Playwright.
- Code size: about 8,700 lines of product TypeScript (extension and server).
- Design documents, decision records (OCR engine choice, read-ahead source)
  and implementation plans are in `docs/superpowers/`.

## Status (November 2026)

**Done and verified**
- Subtitles mode with read-ahead
- Audio mode
- Screen Translate
- Context-aware Claude translation with glossary
- Hosted subscription service (built and tested locally)
- Redesigned popup with light and dark themes

**In progress: real-world sync and benchmarks**
(spec: `docs/superpowers/specs/2026-11-13-real-world-sync-readahead-design.md`)
- **Real-YouTube benchmark:** a fixed set of 8 videos in 5 subtitle languages
  (Korean, Chinese, Portuguese, Russian, French), covering League, football
  and TV drama. It runs on real YouTube as a sliding window of 30 s pieces
  (YouTube stops automated playback after ~40 s), plus full-length local
  copies. Real DeepL and Claude are used in all three engine modes.
- **Metrics:**
  - lines missed, by duration and text size;
  - share of lines ready before they appear;
  - time on screen against a reading-time minimum;
  - lines shown while paused;
  - OCR error;
  - Claude-judged quality.
- **Baseline findings:**
  - Translated lines left the screen as soon as the source subtitle did, so
    quick lines were hard to read.
  - Read-ahead didn't run for YouTube's VP9/WebM format.
  - Some fast or stylised lines were missed.
  - Best mode (Claude only) was ready as often as Fast mode, with much higher
    quality.
- **Changes under way:**
  - a minimum reading time counted in video time;
  - a WebM/VP9 demuxer so read-ahead works on every YouTube format;
  - fixes for missed lines, driven by the benchmark data.

**Next**
- **Audio mode read-ahead:** transcribe YouTube's buffered audio ahead of
  playback, so captions are timed to the video and follow pause and seek.
- **Automatic subtitle detection,** so no box has to be drawn.
- **Screen Translate as a separate tool:** its own card in the popup, a
  right-click item and a keyboard shortcut.
- **Deploy and publish:** deploy the hosted service and publish on the Chrome
  Web Store.
- **Research:** distil a cheaper open-weight translation model from Claude's
  outputs.

## Development process

- **Spec-driven, test-gated.** Each piece starts from a written design
  (intent, goals, anti-goals, acceptance), then an implementation plan with
  exact interfaces and tests. It is built test-first and closed by an
  independent review of the whole branch, followed by a fix pass.
  Decisions made during the build are recorded with their reasoning.
- **Measured, not assumed.** Model choices (OCR engine, Whisper size and
  precision, translation engine) and the subscription pricing all come from
  benchmarks in the repo (`docs/performance.md`, `docs/pricing.md`).

## Where to look

| Topic | Document |
|---|---|
| Measured results, newest first | [milestones.md](milestones.md) |
| Benchmarks (speech, OCR, translation, latency) | [performance.md](performance.md) |
| Subscription cost model and prices | [pricing.md](pricing.md) |
| Hosted service and deployment | [../server/README.md](../server/README.md) |
| Designs, decisions, plans | [superpowers/](superpowers/) |
| How to build and test | [../README.md](../README.md) |
