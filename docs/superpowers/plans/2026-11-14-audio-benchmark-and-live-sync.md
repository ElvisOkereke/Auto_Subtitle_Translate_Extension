# Audio Benchmark and Live-Path Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure Audio mode on real YouTube (baseline first), then make
live-path captions follow the video:
- nothing appears while paused;
- stale and after-seek captions are dropped;
- captions stay up for their reading time, counted in video time.

**Architecture:** The real-YouTube benchmark (youtube-bench) gains Audio
videos. Reference timing and text come from each video's YouTube captions.

- The overlay recorder captures audio caption lines: source text, shown/hidden
  video time, pause state.
- The offscreen segmenter stamps each speech segment's end with `Date.now()`.
  The content script keeps a wall-clock → video-time map (play, pause, seek,
  rate), so every caption knows when its speech ended in video time.
- Display is driven by video time: drops, the reading time and the two-line
  roll.

**Tech Stack:** TypeScript, Chrome MV3 (tabCapture, offscreen, content script),
Whisper (transformers.js), Playwright (installed Chrome), yt-dlp (captions),
Jest.

**Spec:** `docs/superpowers/specs/2026-11-13-real-world-sync-readahead-design.md`
— the Audio part of step 4, first half (the live fallback, plus the benchmark).
Audio read-ahead is the next plan.

## Global Constraints

- **Definition of done:** `npm run verify` green. The live and local benchmarks
  are opt-in (`bench:youtube`, `bench:local`).
- **Audio live fallback (spec):**
  - The content script tells the pipeline about pause, play and seek.
  - Segments captured before a pause or seek that haven't been shown are
    dropped. Nothing new is displayed while paused.
  - A caption is dropped if its speech ended more than 5 s ago in video time.
  - Captions use the reading-time rule instead of the fixed 6 s, in a two-line
    roll. The older line leaves at its own end plus the minimum, or when a third
    arrives.
  - Minimum reading time: `max(1.5 s, characters / 15 per s)`, capped at 6 s
    (same as `src/subtitle/displayPolicy.ts`). For audio, "its own end" is when
    the caption appeared, since its speech has already ended.
- **Benchmark rules (from the subtitle plan):**
  - Real engines (DeepL key from `.env`, Claude via the relay).
  - Every run starts from a clean translation state.
  - Two live samples per measurement.
  - Never weaken assertions.
  - Never print or commit keys.
  - Never use the user's personal profile.
- **Audio benchmark videos:** 3–4 videos with clear speech and YouTube captions
  as the reference (manual preferred; auto-captions labelled `auto`). They are:
  - Korean League casting;
  - football commentary in Spanish or Portuguese;
  - one Japanese video.

## Review Focus

1. **Pause while a segment is being transcribed or translated:** the caption
   never appears while paused, and it doesn't pop up after resume if its speech
   is now more than 5 s behind. (Task 5 test.)
2. **Seek while captions are in flight:** nothing from before the seek appears
   after it. (Task 5 test.)
3. **Playback rate ≠ 1 and ads:** the clock map uses the playback rate. During
   an ad (`.ad-showing`), captions are dropped like a pause. (Task 5 test.)
4. **Several `<video>` elements on a page:** the map follows the video that is
   playing (the largest playing one). (Task 5 test.)
5. **Captions arriving out of order** (concurrent translations): a caption
   whose speech ended before the newest shown caption's speech is dropped,
   never shown under a newer line. (Task 5 test.)

---

### Task 1: Captions carry source text and speech-end time; the recorder sees them

**Files:**
- Modify:
  - `src/utils/vad.ts` or `src/offscreen.ts` (segment end stamped with
    `Date.now()`)
  - `src/background.ts` (`DISPLAY_SUBTITLE` gains `source` and `speechEndedAt`)
  - `src/types/index.ts`
  - `src/content.ts` (`line.dataset.source`, `line.dataset.speechEndedAt`)
  - `e2e/helpers/subtitles.ts` (recorder for `.subtitle-text` lines:
    `{ captionId, shownAt, hiddenAt, text, source, quality, pausedAtShow }`)
- Test: `src/__tests__/content.test.ts` (or the existing content test file),
  `src/__tests__/background*.test.ts`

**Interfaces:**
- Produces:
  - `DisplaySubtitleMessage` gains `source?: string` and `speechEndedAt?: number`
    (epoch ms).
  - Caption DOM: `.subtitle-text[data-caption-id][data-source][data-speech-ended-at]`.
  - The e2e `recordCaptions(page)` / `shownCaptions(page)` return `ShownRecord`
    with `lineStart` = the speech-end video time (when the map exists; else
    `shownAt`) and `text` = the shown translation; `source` is a new field.

- [ ] **Step 1:** Failing tests:
  - background: `'DISPLAY_SUBTITLE carries the source text and when the speech ended'`;
  - content: `'caption lines keep their source text and speech-end time as data attributes'`.
- [ ] **Step 2:** Run `npx jest src/__tests__`. Expected: FAIL.
- [ ] **Step 3:** Implement. The offscreen result already carries timing; add
  `speechEndedAt: Date.now()` at segment end (the segmenter's
  end-of-segment frame).
- [ ] **Step 4:** Run `npx jest`. Expected: PASS. Then `npm run type-check`.
- [ ] **Step 5:** Commit: `feat(audio): captions carry their source text and speech-end time`.

### Task 2: Audio benchmark videos and caption references

**Files:**
- Create: `e2e/scripts/fetch_caption_reference.py`
- Modify:
  - `e2e/bench/videos.json` (audio entries)
  - `e2e/scripts/fetch_video_fixtures.py` (cut `b` copies for audio videos too)
  - `e2e/bench/videos.ts` (`referenceLines` for audio videos)
- Output: `e2e/fixtures/subtitles/<id>.captions.json`, shaped
  `{ video, lang, kind: 'manual' | 'auto', lines: [{ start, end, text }] }`
  in absolute seconds.

- [ ] **Step 1:** Find candidates with `yt-dlp "ytsearch20:<query>"` and
  `--list-subs`. Keep videos that have captions in their spoken language (manual
  preferred), clear speech and a 120 s window with steady talk. Record each
  video's `id`, `lang`, `start`, `duration` and `notes` in `videos.json` with
  `mode: 'audio'`.
- [ ] **Step 2:** `fetch_caption_reference.py <id> <lang>`:
  - download captions with yt-dlp (`--write-subs`, falling back to
    `--write-auto-subs`; `--sub-format json3`);
  - for auto captions, merge word segments into lines at gaps > 0.6 s or after
    ~40 characters; drop music and other bracketed cues;
  - write the JSON.
- [ ] **Step 3:** Sanity check by eye: print 15 lines per video and compare a
  few against the audio (listen in the clip, or check by ear in the preview).
  Fix nothing that can't be verified; label `kind`.
- [ ] **Step 4:** Commit: `test(bench): audio benchmark videos and caption references`.

### Task 3: Audio metrics and the audio benchmark runs

**Files:**
- Modify:
  - `e2e/bench/metrics.ts` (audio metrics)
  - `e2e/bench/__tests__/metrics.test.ts`
  - `e2e/tests/youtube-bench.spec.ts` (audio runs: live sliding window and local
    copies)

**Interfaces:**
- Produces (in `metrics.ts`):
  - `transcriptCer(ref: RefLine[], shown: ShownRecord[], window: [number, number]): number`.
    Alignment-free: CER of the concatenated shown sources against the
    concatenated reference text inside the window.
  - `captionDelays(ref, shown): { fromSpeechEndP50: number; fromSpeechEndP90: number; matched: number }`.
    Each shown caption is matched to the reference line with the most character
    overlap with its source; the delay is shownAt − ref.end.
  - `wordsCovered(ref, shown): number`: the share of reference characters
    present in some shown source within ±3 s.
  - It reuses `timeOnScreen`, `shownWhilePaused` (for audio, any caption
    appearing while paused counts) and `judge`.

- [ ] **Step 1:** Unit tests, with exact values:
  - `'transcript CER over a window'`: ref `['안녕하세요', '반갑습니다']`, shown
    sources `['안녕하세요 반갑', '습니다']` → 0.
  - `'caption delay from speech end'`: ref `{start: 10, end: 12}`, shown at 13.1
    with the same text → P50 1.1.
  - `'words covered'`: half the reference characters shown → 0.5.
- [ ] **Step 2:** Run `npx jest e2e/bench`. Expected: FAIL, then implement, then
  PASS.
- [ ] **Step 3:** In `youtube-bench.spec.ts`, audio tests per audio video:
  - **Live** (sliding window): each piece starts Audio mode with
    `TOGGLE_SUBTITLES` sent from the service worker to the tab;
    `recordCaptions`; pause 5 s at +60.
  - **Local copies:** same, through `video-subs.html` (it carries the Opus
    audio track).
  - The report holds:
    - transcript CER and words covered;
    - delays P50/P90;
    - time on screen against the reading time;
    - shown while paused;
    - the judge score;
    - path `live` (no read-ahead yet).
  - Hard assertion: none (baseline). Recorded only.
- [ ] **Step 4:** `npm run fixtures:video` (audio cuts), then
  `BENCH_LABEL=audio-baseline` for `bench:youtube` (two samples) and
  `bench:local`, filtered to audio tests (test titles start with `audio`).
- [ ] **Step 5:** Write the Audio baseline table into `docs/performance.md`
  (`node e2e/scripts/bench-table.mjs`, extended for audio columns).
- [ ] **Step 6:** Commit: `test(bench): audio benchmark; baseline`.

### Task 4: Clock map (wall clock → video time)

**Files:**
- Create:
  - `src/audio/videoClock.ts`
  - `src/audio/__tests__/videoClock.test.ts`

**Interfaces:**
- Produces: `class VideoClock`:
  - `observe(video: HTMLVideoElement): void`, listening to `play`, `pause`,
    `seeking`, `seeked`, `ratechange` and `timeupdate`;
  - `videoTimeAt(epochMs: number): number | null`, returning null if a seek or
    a pause/ad boundary lies between `epochMs` and now in a way that makes it
    unknowable;
  - `get paused(): boolean`;
  - `seekedSince(epochMs: number): boolean`;
  - `pausedSince(epochMs: number): boolean`.
- Pure core: `VideoClock.fromEvents(events)` for tests.

- [ ] **Step 1:** Tests:
  - `'maps a wall time to video time while playing'` (rate 1, then rate 2);
  - `'a pause freezes video time'`;
  - `'a seek after epoch t makes t unknowable (null) and seekedSince(t) true'`;
  - `'ads count as paused'`.
- [ ] **Step 2:** Run `npx jest src/audio`. Expected: FAIL, then implement, then
  PASS.
- [ ] **Step 3:** Commit: `feat(audio): video clock maps wall time to video time`.

### Task 5: Live-path captions follow the video

**Files:**
- Create:
  - `src/audio/captionPolicy.ts`
  - `src/audio/__tests__/captionPolicy.test.ts`
- Modify:
  - `src/content.ts` (use `VideoClock` and `CaptionPolicy`; replace the fixed
    6 s timer and the push-out with policy ticks on `timeupdate` and a 250 ms
    interval while playing)
- Test: content unit tests; `e2e/tests/captions.spec.ts`

**Interfaces:**
- Consumes: `VideoClock` (Task 4), `minDisplaySeconds` from
  `src/subtitle/displayPolicy.ts`.
- Produces: `class CaptionPolicy`:
  - `offer(caption: { id; text; speechEndVideo: number | null }, now: { videoTime; paused; seekedSinceSpeech; adShowing }): 'show' | 'drop'`;
  - `tick(videoTime): string[]`, returning the ids to remove;
  - `upgrade(id, text): boolean`.
- Rules:
  - drop if paused or ad;
  - drop if `seekedSinceSpeech`;
  - drop if `videoTime − speechEndVideo > 5`;
  - drop if `speechEndVideo` is before the newest shown caption's
    `speechEndVideo`;
  - show at most two lines; a third removes the oldest;
  - each line is removed at `shownAt + minDisplaySeconds(text)`, in video time.

- [ ] **Step 1:** `captionPolicy.test.ts`, one test per rule plus Review
  Focus 1–5 (pause during transcription; seek in flight; rate 2 and ad; two
  videos; out of order).
- [ ] **Step 2:** Run `npx jest src/audio`. Expected: FAIL, then implement, then
  PASS.
- [ ] **Step 3:** Wire into `content.ts`. Content tests:
  `'a caption arriving while the video is paused is not shown'`,
  `'captions stay for their reading time and freeze while paused'`.
- [ ] **Step 4:** E2E in `captions.spec.ts`: pause the fixture audio page for
  3 s mid-speech; assert no caption appears while paused and none from before
  the pause appears after resume more than 5 s late. Keep the existing latency
  gate.
- [ ] **Step 5:** Run `npm run build` and `npx playwright test --project=captions`.
  Expected: PASS.
- [ ] **Step 6:** Commit: `feat(audio): live captions follow the video - pause, seek, stale drop, reading time`.

### Task 6: After-run, docs, verify

- [ ] **Step 1:** `BENCH_LABEL=audio-step1` live (two samples) and local, audio
  tests. Add the comparison to `docs/performance.md`:
  - shown while paused 0;
  - stale shown 0;
  - time-on-screen too-short 0;
  - delays and CER recorded.

  Each unmet target gets a ledger `Ruling:`.
- [ ] **Step 2:** README (Audio mode: pause/seek behaviour) and a milestone
  entry if the numbers moved.
- [ ] **Step 3:** Run `npm run verify`. Expected: exit 0.
- [ ] **Step 4:** Commit: `docs: audio step 1 results`.
