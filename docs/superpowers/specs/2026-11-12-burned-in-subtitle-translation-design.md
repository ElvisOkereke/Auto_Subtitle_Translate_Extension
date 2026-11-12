# Burned-in Subtitle Translation ("Subtitle mode")

Date: 2026-11-12
Status: Draft for developer approval (builder-checked)

## Why

The main reason this extension exists: the developer watches YouTube videos
(e.g. Korean League of Legends gameplay) whose subtitles are **burned into the
video pixels** in a foreign language, and wants English laid directly over
them, live. Today's Screen Translate reads DOM text only, so it cannot see
burned-in subtitles at all.

Success, in the developer's words: it must feel **live** — "if it can't, there
is honestly no use for it." Translation **quality and speed** are the only
things that matter; nothing else would make them wince. Cost, rate limits and
site terms of service are explicitly not constraints for this feature —
performance is.

This is piece 1 of 4, built in this order:

1. **Subtitle mode** (this document)
2. Translation engine layer (DeepL + Claude, fast-first-then-better, BYOK) — separate design
3. End-to-end tests on real YouTube video (both modes) — built alongside 1 and 2
4. Accounts, subscription flag, hosted translation proxy, pricing — separate design

## What the user experiences

1. On a YouTube video, the user opens the popup, which offers two modes:
   **Audio** (existing live captions from speech) and **Subtitles** (new).
   Only one mode is active at a time.
2. In Subtitles mode they draw **one box** over where the subtitles appear.
   The box stays put for the whole video.
3. From then on, everything inside the box is read and translated
   continuously. When the subtitle changes, the English changes with it.
4. Text outside the box (stream chat overlays, game HUD, rank stats) is ignored.

### The overlay (decided by the developer: style "C")

- A **see-through dark tint** fills exactly the drawn box; the original
  subtitle stays faintly visible underneath.
- English text in a **contrasting color** (yellow-ish, as in the mockup),
  **auto-sized to fill the whole box**.
- Mockup source: `.superpowers/brainstorm/*/content/overlay-style-v2.html`
  (option C), using a real frame from the test video.

Builder's calls (developer did not specify; these are my defaults):

- When the box contains no subtitle, the overlay shows **nothing** (tint and
  text both hidden), not the previous line.
- A line that is still on screen is not re-read or re-translated.
- The overlay stays locked to the box as the player resizes, enters
  fullscreen, or switches to theater mode (box stored relative to the
  `<video>` element's rendered rectangle, not the page).
- The box is **remembered per video ID**, so pausing, scrubbing or reloading
  the same video does not require redrawing. The popup has a "Redraw box" action.

## Languages

Source languages: "the most common languages for now." Interpreted as Korean,
Japanese, Chinese (simplified and traditional), Spanish, French, German,
Portuguese, Russian. OCR language models are downloaded on first use of a
language. **Korean is the first language built and tested end to end**; the
others must work through the same path but are not individually tuned in this
piece. Builder's call: Subtitles mode has its **own subtitle-language picker** in
the popup (it needs a specific OCR model; the global source-language default
is `auto`). It defaults to the last language used, Korean on first run.
Automatic script detection may come later; not required here.

Target language: the existing target-language setting (default English).

## Live + read-ahead (decided: both, working together)

The developer wants the best live experience and explicitly asked for a smart
combination of live reading and pre-generation, not one as a fallback.

- **Live path:** sample the playing video's frames, crop to the box, detect
  that the box content changed, OCR, translate, display. This covers the start
  of playback and every seek, and must be good on its own.
- **Read-ahead path:** YouTube buffers 20-37 s of upcoming video (measured on
  the test video). Read and translate upcoming subtitles from frames that have
  not been shown yet, store them on a per-video timeline, and display them at
  the right `currentTime` with zero visible delay.
- **Fast-then-better:** when a line is first shown via the live path it uses
  the fastest engine; if a better translation of the same line arrives while
  it is still on screen, it replaces the fast one. (Engines themselves are
  piece 2; this piece consumes a translation interface — see below.)

How to obtain future frames is **left to a spike** at the start of the build.
Candidates:

- (a) a hidden, muted second player/`<video>` of the same video running ahead;
- (b) decoding media segments YouTube has already fetched (intercept segment
  fetches, demux, decode with WebCodecs).

The spike picks one by measured coverage, CPU/GPU cost, and robustness. If
neither works reliably, ship live-only and record why; the live path must
already meet its target.

### Per-video memory

Every line read and translated is cached per video ID with its time range,
source text and translation (persisted, e.g. IndexedDB). Rewatching or
scrubbing back is instant and costs no OCR or translation.

## Speed targets (builder's numbers; developer said "as fast as possible")

- **Live path:** English visible within **~0.7 s** of a new subtitle line
  appearing (p50), measured on the test video in installed Chrome with WebGPU.
- **Read-ahead:** during uninterrupted playback, **≥ 90%** of lines are
  translated before they appear.
- Change detection must keep idle cost low: no OCR when the box content is
  unchanged.

How the targets are measured (builder's call):

- The live target is end to end **including a real translation call**. The
  default (mocked-API) suite reports the same metric with translation time
  excluded; the opt-in real runs include DeepL.
- If the most accurate OCR model cannot meet the live target, use **two OCR
  tiers**, mirroring fast-then-better translation: a fast model on the live
  path and the accurate model on read-ahead, with the accurate result
  replacing the fast one if a line is still on screen. Accuracy is not traded
  away globally to hit the live number.

Measured facts this design rests on (from recon on the test video):

- YouTube's `<video>` frames can be drawn to a canvas and read from a content
  script (canvas not tainted), at full 1080p.
- Subtitle style there: large white bold text with black outline, centered
  near the bottom, over busy gameplay and client UI. Lines change roughly
  every 1-2 s and sentences are often split across consecutive lines.
- Translation quality on 36 real lines (0/1/2 scoring vs references):
  Claude Opus 5.5 with context 89% (2.2 s median), Sonnet 5.5 82% (1.0 s),
  DeepL with context 65% (0.28 s), Haiku 5.5 58%, Google free 42%, local
  models ≤15%. Passing neighbouring lines as context is the single biggest
  quality gain — read-ahead also provides the *next* line.

## OCR (builder's call)

OCR runs **locally** (no key, no server). Default plan: a PaddleOCR-family
detection + recognition model run through ONNX Runtime Web (already bundled
for Whisper) on WebGPU with wasm fallback, in a worker. Benchmark against
Tesseract (installed locally) and at least one alternative before committing;
pick by character accuracy on the hand-transcribed Korean lines and latency.
The OCR stage should output the line text plus a confidence, so low-confidence
garbage is not sent for translation.

## Translation interface consumed by this piece

Until piece 2 exists, subtitle mode calls the existing translation path
(`apiService.translateText`, DeepL/Google via the background). It must pass
neighbouring lines as context where available (DeepL supports a `context`
parameter). Piece 2 will replace the internals with engine selection and
fast-then-better; subtitle mode should be written against an interface that
accepts `{ text, previousLines, nextLines, sourceLang, targetLang, priority:
'live' | 'readahead' }` and may deliver more than one result for the same line.

## Relationship to existing features (builder's call)

- **Screen Translate** today: drag a box over page text → one-shot DOM-text
  translation with refresh. Subtitle mode is its successor for video: a box
  drawn over a `<video>` enters continuous OCR mode; a box drawn over normal
  page content keeps the existing one-shot DOM-text behavior. The click guard
  (drawing never toggles video playback) is kept.
- **Audio mode** (existing live captions): unchanged in this piece apart from
  living behind the popup's mode switch. Switching modes stops the other one.

## Testing (developer: no manual testing; tests run by the builder)

Test video: `https://youtu.be/_zIrbXw-SVs` (Korean speech + burned-in Korean
subtitles). A 1080p local copy is cached under `e2e/.cache/videos/`
(gitignored). Hand-transcribed reference lines with timestamps and reference
English: `e2e/fixtures/subtitles/_zIrbXw-SVs.ko.json`.

- **Repeatable run:** the local copy played in a YouTube-like fixture page,
  extension loaded in Chromium/Chrome via the existing Playwright harness.
- **Real YouTube run:** the same flow on youtube.com in installed Chrome
  launched without automation flags (headless/automated playback was blocked
  by YouTube after 1-2 minutes during recon). Opt-in, not part of the default
  suite.
- **Ground truth (builder's call):** the existing 36 sampled lines stay as a
  spot-check set. For timing and coverage the builder also produces
  frame-labelled annotations with start/end times (to the frame) and a
  **complete transcript of at least two unbroken stretches** (the opening
  ~3 minutes, which mixes champion select and gameplay, plus a ~3-minute
  mid-game teamfight stretch), labelled from the 1080p copy and marked as
  builder-labelled.
- **Translation grading (builder's call):** default suite uses key-term and
  similarity checks against the reference English (deterministic, no paid
  API). An opt-in LLM-judge run uses Claude through the developer's Fuelix
  gateway (authorized during design) and is never part of the default suite.
- **Real-YouTube launch (builder's call):** installed Chrome with a dedicated
  test profile, extension loaded via the DevTools protocol
  (`Extensions.loadUnpacked`, as in `e2e/helpers/launch.ts`), not Playwright's
  automation launch and not the developer's personal profile. The run must
  wait out or skip pre-roll ads. If YouTube still blocks playback this way,
  the builder reports back rather than using the personal profile.
- Checks: OCR character accuracy vs the reference lines (threshold), every
  reference line produces an overlay within its on-screen window, translation
  checks against reference meaning, the two speed targets, overlay geometry
  matches the drawn box across resize/fullscreen, and screenshots + a screen
  recording saved as artifacts.

## Non-goals

- Sites other than YouTube (the live path should be generic, but only YouTube
  is tested; read-ahead may be YouTube-specific).
- Accounts, subscriptions, hosted proxy, pricing (piece 4).
- Engine selection UI and BYOK flows beyond what exists (piece 2).
- Native `<track>` captions (not burned in, not in scope here).
- Automatic subtitle-region detection (the user draws the box).

## Anti-goals

- Visible lag that makes the English trail the speech/subtitles noticeably —
  the feature is pointless if it is not live.
- Flicker or re-rendering of a line that has not changed.
- Translating text outside the box.
