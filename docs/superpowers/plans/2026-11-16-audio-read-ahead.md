# Audio Read-Ahead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On YouTube (and the loopback MSE fixture), transcribe the buffered audio
ahead of playback, so each caption appears when its words are spoken and follows
video time (pause, seek, two-line roll). Live capture stays as the fallback.

**Architecture:**

- **Main world:** the MSE tap also watches audio SourceBuffers (WebM/Opus). It
  decodes ahead with WebCodecs `AudioDecoder`, downmixes and resamples to 16 kHz
  mono, and posts ~1 s PCM chunks tagged with video time.
- **Content script:** validates chunks (untrusted), forwards them to the offscreen
  document as Int16/base64, and reports read-ahead health.
- **Offscreen:**
  - a timed VAD segmenter cuts the read-ahead stream into segments with video-time
    start/end;
  - Whisper transcribes them nearest-first, one at a time;
  - the live path is suppressed while read-ahead is healthy.
- **Background:** passes `videoStart`/`videoEnd` through to `DISPLAY_SUBTITLE`.
- **Content display:** a timed schedule shows captions by video time.

**Tech stack:** TypeScript, WebCodecs `AudioDecoder`, MSE, transformers.js
Whisper, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-real-world-sync-readahead-design.md`
§ "Audio mode: read-ahead and sync (YouTube)". This builds on branch `audio-sync`
(live fallback).

## Global constraints

- `npm run verify` green.
- No COOP/COEP.
- The tap runs only where it does today (youtube.com and loopback).
- Everything the main world posts is untrusted.
- Fixtures are VP9/Opus (Playwright Chromium lacks AAC; AAC fMP4 audio is out of
  scope and falls back to live capture).
- Never print or commit keys. Never weaken assertions; disclose changed tests.

## Review focus

1. A seek while segments are queued: no caption from the old position appears.
   The new position's captions come from the store if already made.
2. A page posting forged audio chunks: bounded by the buffered range, chunk size
   and rate. It can at worst produce wrong captions.
3. Read-ahead stalling mid-session (format change, ad, buffer stall): the live
   path takes over without a restart, and the switch is visible
   (`data-path` on the overlay).
4. Whisper slower than real time (CPU): nearest-first scheduling. Segments
   already behind the playhead are skipped.
5. A Claude upgrade arriving before or after the caption's start: replaced in the
   store, and in place if on screen.

---

### Task 1: WebM audio track

- **Files:** `src/subtitle/readAhead/webm.ts`; test `__tests__/webm.test.ts`;
  fixture `__tests__/fixtures/tiny-opus.webm` (2 s 440 Hz sine, Opus 48 kHz mono,
  ffmpeg).
- **Produces:**
  - `new WebmParser('audio')` selects TrackType 2.
  - Its `init` carries:
    - `audio: { codec: 'opus', sampleRate, channels }`;
    - `description` (the CodecPrivate OpusHead).
- **Tests:**
  - the opus fixture yields `init.audio = { codec: 'opus', sampleRate: 48000, channels: 1 }`;
  - samples cover ~2 s with increasing times;
  - every sample is `key: true`;
  - byte-by-byte split equals whole.

### Task 2: PCM downmix and resample (pure)

- **Files:** `src/audio/readAhead/pcm.ts`; test `src/audio/__tests__/pcm.test.ts`.
- **Produces:**
  - `class Resampler16k { constructor(inRate: number); push(mono: Float32Array): Float32Array }`:
    streaming low-pass FIR plus fractional step, keeping state across pushes;
  - `downmix(planes: Float32Array[]): Float32Array`;
  - `toInt16Base64(pcm) / fromInt16Base64(s)`.
- **Tests:**
  - a 48 kHz → 16 kHz 1 kHz sine keeps its amplitude (±10%) and frequency;
  - the output length is in/3 (±2) across many small pushes, with no
    discontinuity at chunk joins;
  - an 8 kHz tone at 48 kHz is attenuated below 0.1;
  - a base64 round trip stays within 1/32768.

### Task 3: Main-world audio tap

- **Files:** `src/subtitle/readAhead/mseTap.main.ts`, `trackRegistry.ts` (audio
  tracks: `tappedContainer` returns `'webm'` for `audio/webm`, plus a `kind`).
- **Protocol** (page window messages):
  - in: `{ astAudioTap: 'start' | 'stop' }`;
  - out: `{ astAudio: true, t, pcm }` (Float32Array 16 kHz, ≤ 1 s, transferred);
  - out: `{ astAudioReset: true, t }` on a discontinuity.
  - Decoding stays at most 90 s ahead of `currentTime`. It restarts at the
    playhead after a seek.
- **Tests:** `trackRegistry.test.ts`: audio SourceBuffers register as audio
  tracks, and `active()` / `activeAudio()` keep video and audio apart.
- **E2E:** Task 7.

### Task 4: Content-script audio read-ahead source

- **Files:** `src/audio/readAhead/audioReadAhead.ts`; test
  `src/audio/__tests__/audioReadAhead.test.ts`.
- **Produces:** `class AudioReadAhead { start(onChunk, onReset); stop(); lead; healthy }`.
- **Accepts a chunk only if all of these hold:**
  - `t` is within [currentTime − 2, bufferedEnd + 1];
  - it holds ≤ 1.25 s of samples;
  - it doesn't overlap audio already accepted;
  - total accepted audio ≤ 120 s + 4 × wall seconds since start.
- `healthy` means lead ≥ 2 s.
- **Tests:** each rejection rule; health flips with lead.

### Task 5: Offscreen read-ahead transcription

- **Files:**
  - `src/audio/timedSegmenter.ts` (test `timedSegmenter.test.ts`): the
    SpeechSegmenter logic with video-time start and speech end; max 6 s
    segments; `reset()` on a discontinuity;
  - `src/offscreen.ts`;
  - `src/types/index.ts` (`READ_AHEAD_AUDIO`, `READ_AHEAD_STATE`).
- **Behaviour:**
  - The offscreen accepts read-ahead audio only from the captured tab
    (`sender.tab.id`, passed in `START_OFFSCREEN_CAPTURE`).
  - Segments go to the worker one at a time, nearest to the playhead first.
    Segments that ended before the playhead are skipped.
  - Results go out as `TRANSCRIPTION_RESULT` with timing
    `{ videoStart, videoEnd, readAhead: 1 }`.
  - Live segments are not transcribed while `READ_AHEAD_STATE.healthy`.
- **Tests:** segmenter times on synthetic tone/silence frames: start within one
  frame of the tone onset; end at the tone's end; the 6 s cap.

### Task 6: Timed display

- **Files:**
  - `src/audio/readAheadSchedule.ts` (test `readAheadSchedule.test.ts`);
  - `src/background.ts`: `videoStart`/`videoEnd` in `DISPLAY_SUBTITLE`;
  - `src/content.ts`.
- **Schedule rules:**
  - A caption is visible from its start until `max(end + 0.3, start + minDisplaySeconds(text))`.
  - At most two lines: the newest two that are visible.
  - `upgrade(id, text)` updates the stored text.
  - `clear()` on a video change.
  - At most 1500 stored captions.
- **Content:**
  - Captions with `videoStart` go to the schedule. Rendering runs on the 250 ms
    tick, `timeupdate` and `seeked`.
  - The overlay shows `data-path="read-ahead" | "live"`.
  - Live captions are ignored while read-ahead is healthy.
- **Tests:**
  - appears at its start, not before;
  - leaves at the rule;
  - frozen time leaves the visible set unchanged;
  - a seek back shows the stored caption again;
  - a third pushes the oldest;
  - upgrade before start shows the new text;
  - content: a caption with `videoStart` in the future isn't shown until
    `currentTime` reaches it.

### Task 7: E2E and benchmark

- **E2E** (`e2e/tests/audio-readahead.spec.ts`, `captions` project): on
  `video-subs.html?v=5INsXNUaRdE&file=5INsXNUaRdE&stretch=b&container=webm`,
  start Audio mode. Then:
  - `data-path` becomes `read-ahead`;
  - captions appear within 0.3 s of their `videoStart` (by video time);
  - none appears while paused;
  - after a seek back, a caption seen before is shown again.
- **Bench:**
  - audio reports carry `path`;
  - a start offset against the reference (P50/P90 of |shown start − ref start|,
    spec target ±0.5 s).
- **Runs:**
  - local, then live: final against the live-fallback build;
  - docs (`docs/performance.md`, README, milestone);
  - `npm run verify`;
  - final review, then merge `audio-sync` and `audio-readahead` to main.
