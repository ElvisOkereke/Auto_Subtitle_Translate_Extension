# Real-YouTube Benchmark and Subtitle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the extension on real YouTube (baseline first), then make
Subtitles mode give every subtitle a readable translation: minimum reading time,
read-ahead for VP9-in-WebM, and fewer missed lines.

**Architecture:**
- A real-YouTube benchmark project drives installed Chrome in a visible window
  over a fixed video set, with pure metric functions shared with the
  local-fixture tests.
- Subtitles mode gets a display policy counted in video time, so lines linger by
  reading time, are replaced immediately by newer lines, freeze on pause and
  clear on seek.
- The MAIN-world MSE tap gains a WebM demuxer, so VP9 streams read ahead like
  AV1 ones.

**Tech Stack:** TypeScript, Chrome MV3, WebCodecs VideoDecoder, Playwright
(installed Chrome via CDP), Jest, yt-dlp + ffmpeg (`e2e/.cache/venv`).

**Spec:** `docs/superpowers/specs/2026-11-13-real-world-sync-readahead-design.md`
(steps 1–2). Steps 3–5 get their own plans after this one's measurements.

## Global Constraints

- **Definition of done:** `npm run verify` green. The real-YouTube project is
  opt-in (`npm run e2e:youtube`), not part of `verify`.
- **Minimum time on screen:** `max(1.5 s, characters / 15 chars per s)` of the
  translated text, capped at 6 s.
- **When a line ends:**
  - It stays until the later of the source disappearing and start plus the
    minimum.
  - A newer line replaces it immediately.
  - Time is counted in video time: pause freezes, seek clears.
- **Targets:**
  - Lines shown while paused: 0.
  - The expected path ran.
  - Coverage: ≥ 97% of lines on screen ≥ 0.5 s, and ≥ 80% of lines on screen
    < 0.5 s.
  - Read-ahead lead: ≥ 90% of lines ready before they appear.
  - Every displayed line gets at least its minimum time unless replaced.
- **What gates what:**
  - Local-fixture E2E tests assert the targets.
  - The real-YouTube project reports and compares; it fails only on paused lines
    or the wrong path.
- **Browser and secrets:**
  - Installed Chrome, no automation flags, in a visible window.
  - Persistent profile `e2e/.cache/profile-youtube`. If a visible window is
    still blocked at ~40 s, the user signs in once with a throwaway Google
    account in that profile (ask them then).
  - Never use the user's personal profile. Never print or commit API keys.
- **Assertions:** never weaken one. Disclose any changed threshold in the commit
  message and the ledger.
- **Results:**
  - JSON per run under `e2e/.perf/`
  - summary tables in `docs/performance.md`
  - wins in `docs/milestones.md`

## Review Focus

1. **Seek while a lingering line is on screen:** the line clears at once; no
   stale line at the new position. (Task 5 test.)
2. **Ad starts while a line lingers:** cleared like a seek. (Task 5 test.)
3. **Very long translation (> 90 chars):** minimum capped at 6 s; never blocks
   the next line. (Task 5 test.)
4. **WebM elements split across `appendBuffer` calls:** the parser handles
   Clusters and SimpleBlocks cut at any byte. (Task 6 test.)
5. **`codecs="vp9"` (short form) from YouTube:** mapped to a WebCodecs string.
   If the decoder rejects it, read-ahead stays off and stats report the live
   path, with no errors thrown into the page. (Task 6 test.)

---

### Task 1: Report which path ran, and record display timing

**Files:**
- Modify:
  - `src/subtitle/subtitleMode.ts` (counters, `stats()`)
  - `src/subtitle/readAhead/readAheadSource.ts` (frames-accepted counter)
  - `src/subtitle/index.ts` (`mode.stats` handler)
  - `e2e/helpers/subtitles.ts` (`recordOverlay`, `ModeStats`)
- Test:
  - `src/subtitle/__tests__/subtitleMode.test.ts`
  - `src/subtitle/readAhead/__tests__/readAheadSource.test.ts`

**Interfaces:**
- Produces:
  - `ReadAheadSource.framesAccepted: number` (readonly).
  - `mode.stats` result gains:
    - `readAheadFrames: number`
    - `linesFromReadAhead: number`: lines first shown from a timeline entry
      created by read-ahead
    - `linesFromLive: number`
  - The e2e `ModeStats` type mirrors these.
  - `recordOverlay(page)` records
    `{ shownAt, hiddenAt: number | null, lineStart, text, pausedAtShow: boolean, wallShownAt, wallHiddenAt }`.
    Times are video seconds; `wall*` values are `performance.now()`.
  - `shownRecords(page)` returns them.

- [ ] **Step 1:** Failing tests:
  - `readAheadSource.test.ts`: `'counts accepted frames and not rejected ones'`.
    Post 3 plausible frames and 2 implausible ones (outside buffered + 1 s);
    expect `framesAccepted === 3`.
  - `subtitleMode.test.ts`: `'stats say which path showed each line'`. One line
    reaches the overlay from a read-ahead entry and one from live OCR; expect
    `{ linesFromReadAhead: 1, linesFromLive: 1 }`.
- [ ] **Step 2:** Run
  `npx jest src/subtitle/__tests__/subtitleMode.test.ts src/subtitle/readAhead/__tests__/readAheadSource.test.ts`.
  Expected: FAIL (properties undefined).
- [ ] **Step 3:** Implement:
  - the counters;
  - mark timeline entries with their origin. Add `origin: 'read-ahead' | 'live'`
    to `TimelineLine` as an optional field so saved timelines still load;
  - extend `recordOverlay`'s MutationObserver to stamp `hiddenAt` when the
    overlay goes `display: none` or its text changes, and `pausedAtShow` from
    `video.paused`.
- [ ] **Step 4:** Run the same jest command. Expected: PASS. Then
  `npx tsc --noEmit`, which must be clean.
- [ ] **Step 5:** Commit:
  `feat(subtitle): report read-ahead vs live path and record display timing`.

### Task 2: Benchmark metrics (pure) and the video set

**Files:**
- Create:
  - `e2e/bench/metrics.ts`
  - `e2e/bench/videos.json`
  - `e2e/bench/__tests__/metrics.test.ts`
- Modify: `jest.config.js` (add an `e2e/bench` test root to the `extension`
  project; node environment is fine).

**Interfaces:**
- Consumes:
  - `TimelineFixtureLine` (`e2e/helpers/subtitles.ts`)
  - `charErrorRate` (`e2e/helpers/cer.ts`)
- Produces (all in `e2e/bench/metrics.ts`):
  - `type ShownRecord` = the Task 1 record.
  - `type RefLine = { start: number; end: number; ko: string; en?: string; h?: number }`.
    `h` is text height in px at 1080p, when known.
  - `matchLines(ref: RefLine[], shown: ShownRecord[], opts?: { early?: number; maxCer?: number }): Array<{ ref: RefLine; shown: ShownRecord | null; cer: number | null }>`.
    Defaults: `early = 0.6`, `maxCer = 0.5`. These are the existing rules
    (`lineStart` in `[start - early, end]`, CER/length ≤ maxCer, after stripping
    `[EN-US] `).
  - `coverageByDuration(matches): { long: { lines: number; matched: number; ratio: number }; short: { lines: number; matched: number; ratio: number } }`.
    `long` is on screen ≥ 0.5 s, `short` is < 0.5 s.
  - `missBuckets(matches): Record<'<0.5' | '0.5-1' | '1-2' | '>2', number>`, plus
    `missesBySize: Record<'<24px' | '24-40px' | '>40px' | 'unknown', number>`.
  - `minDisplaySeconds(text: string): number`. Re-exported from
    `src/subtitle/displayPolicy.ts` (Task 5) once it exists; until then defined
    here and moved in Task 5.
  - `timeOnScreen(shown: ShownRecord[]): { checked: number; tooShort: number }`.
    A record is too short when `hiddenAt - shownAt < minDisplaySeconds(text) - 0.05`
    and the next record didn't start at `hiddenAt` (± 0.05), i.e. it wasn't
    replaced.
  - `shownWhilePaused(shown): number`: count of `pausedAtShow`.
  - `readyBeforeShown(timeline: Array<{ start: number; translatedAt: number | null }>, ref: RefLine[]): number`
    (ratio).
- `e2e/bench/videos.json` entries:
  `{ id, mode: 'subtitles' | 'audio', lang: 'ko', start, duration, box?: NormalizedBox, reference?: string /* path under e2e/fixtures/subtitles */, notes }`.
  It starts with `_zIrbXw-SVs` (start 540, duration 120, reference
  `_zIrbXw-SVs.timeline.json` stretch s2). Task 3 adds the others.

- [ ] **Step 1:** `metrics.test.ts`, with cases using these exact values:
  - `'matches a line shown inside its window'`: ref `{start: 10, end: 12, ko: '안녕'}`,
    shown `{lineStart: 9.5, text: '[EN-US] 안녕', ...}` → matched, cer 0.
  - `'buckets misses by on-screen duration'`: refs lasting 0.3, 0.7, 1.5 and
    3 s, none shown → `{'<0.5': 1, '0.5-1': 1, '1-2': 1, '>2': 1}`.
  - `'coverage splits at 0.5 s'`: 2 long refs (1 matched) and 1 short ref
    (matched) → `long.ratio 0.5`, `short.ratio 1`.
  - `'minimum display time'`:
    - `minDisplaySeconds('Hi') === 1.5`
    - `minDisplaySeconds('x'.repeat(45)) === 3`
    - `minDisplaySeconds('x'.repeat(200)) === 6`
  - `'a replaced line is not too short'`: a record shown 0.4 s and replaced at
    its `hiddenAt` → `tooShort 0`. The same record not replaced → `tooShort 1`.
  - `'counts lines shown while paused'`.
- [ ] **Step 2:** Run `npx jest e2e/bench`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `e2e/bench/metrics.ts` and `videos.json`. Update
  `jest.config.js`.
- [ ] **Step 4:** Run `npx jest e2e/bench`. Expected: PASS. Then
  `npm run type-check` and `npm run lint`, both with 0 errors.
- [ ] **Step 5:** Commit: `test(bench): metric functions and the benchmark video set`.

### Task 3: Reference timelines for new subtitle videos

**Files:**
- Create:
  - `e2e/scripts/make_reference.py`
  - `e2e/tests/perf-reference.spec.ts` (`perf` project)
- Modify:
  - `e2e/scripts/fetch_video_fixtures.py` (read `e2e/bench/videos.json`;
    download each subtitles video as VP9 + Opus WebM; also write
    `<id>.<stretch>.video.webm` via `-map 0:v -c copy -f webm`, beside the
    existing `.video.mp4`)
  - `e2e/bench/videos.json`
- Output: `e2e/fixtures/subtitles/<id>.timeline.json` (same schema as
  `_zIrbXw-SVs.timeline.json`, plus `h` per line and
  `labelledBy: "extension OCR at 10 fps, hand-checked"`)

**Interfaces:**
- Consumes:
  - the bridge command `ocr {bitmapUrl, lang}`
  - `timelineFixture` schema
- Produces: reference files that `videos.json` points at.

**Video choice (executor):** 2–3 Korean League of Legends videos with burned-in
Korean subtitles, found with `yt-dlp "ytsearch20:<query>"`. Confirm burned-in
subtitles by extracting 5 frames and looking at them. At least one video must
have fast dialogue (lines < 1 s) and one smaller-than-usual text. Record the
IDs, the 120 s window (`start`), and the subtitle `box` in `videos.json`.

- [ ] **Step 1:** `make_reference.py <id> <start> <duration> <box>`:
  - ffmpeg-crops the box at 10 fps into PNGs;
  - segments with a frame-difference threshold (mean abs diff over a 64×16
    grey thumbnail > 0.04, matching `LineTracker`'s threshold, and stable for
    ≥ 1 frame);
  - writes `segments.json` (`start`, `end`, middle-frame path) and a contact
    sheet PNG per 20 segments.
- [ ] **Step 2:** `perf-reference.spec.ts`:
  - for each segment, OCR the middle frame through the bridge, and record `ko`
    and the det box height `h` scaled to 1080p;
  - drop segments with blank text;
  - write the candidate `<id>.timeline.json`.

  Expected: a file with ≥ 20 lines per video.
- [ ] **Step 3:** Hand-check:
  - Open each contact sheet with the Read tool and compare against the
    candidate text.
  - Fix wrong `ko`, merge split lines and delete false lines in the JSON.
  - Note the number of corrections in `labelledBy`.
- [ ] **Step 4:** Commit:
  `test(bench): reference timelines for <ids> (extension OCR at 10 fps, hand-checked)`.

### Task 4: The real-YouTube benchmark and the baseline

**Files:**
- Create: `e2e/tests/youtube-bench.spec.ts` (matched by the `youtube`
  project; add `youtube-bench` to its `testMatch`)
- Modify:
  - `playwright.config.ts`
  - `package.json` (script `bench:youtube`: `build:prod` +
    `E2E_BROWSER=chrome playwright test --project=youtube youtube-bench`)
  - `docs/performance.md`

**Interfaces:**
- Consumes:
  - Task 1 (`recordOverlay`, `mode.stats`)
  - Task 2 (`metrics.ts`, `videos.json`)
  - Task 3 (references)
  - existing helpers `waitOutAds`, `dragBox`, `startViaPopup`
- Produces: `e2e/.perf/youtube-bench/<runLabel>/<id>.json` with
  `{ id, runLabel, path: 'read-ahead' | 'live' | 'mixed', format, played, blocked, coverage, missBuckets, missesBySize, readyBeforeShown, medianLead, displayOffsetP50, timeOnScreen, shownWhilePaused, ocrCer }`.
  - `format` is the video SourceBuffer mime.
  - `path` is from `linesFromReadAhead` / `linesFromLive`: mixed when both are
    > 10%.
  - `runLabel` comes from `BENCH_LABEL` (default: git short SHA).
  - With `E2E_JUDGE=1`, it adds a Claude quality score for the shown
    translations, using the existing `judge` scoring (opt-in, costs money).
  - Audio videos join `videos.json` in the Audio plan (spec step 4).

- [ ] **Step 1:** Write `youtube-bench.spec.ts`, one test per `subtitles` video
  in `videos.json`:
  - visible window: no `--window-position` off-screen arg, `headed: true`;
  - profile `e2e/.cache/profile-youtube`;
  - set 1080p, seek to `start`, wait out ads;
  - start Subtitles mode with the video's `box`;
  - play `duration` s;
  - **pause for 5 s at `start + 60`**, then resume;
  - stop on `.ytp-error`, recording `blocked` and `played`;
  - score with `metrics.ts`;
  - log the SourceBuffer mime: read `__fixture`-style from the page, via
    `page.evaluate` over `document.querySelector('video')`'s MediaSource
    SourceBuffers; if that isn't reachable, use the tap's
    `window.__astTapStats` plus a new `codec` field.
  - Hard assertions: `shownWhilePaused === 0`. If `!blocked`, `path` must not be
    `'live'` whenever `format` is a tapped container.
  - Everything else is recorded, not asserted.
- [ ] **Step 2:** Run `npm run bench:youtube` with `BENCH_LABEL=baseline`.
  Expected: runs complete or are reported `blocked` with `played` seconds.
  - **If `blocked` at ≤ 60 s in the visible window:** stop and ask the user to
    sign in once in the window you open on `e2e/.cache/profile-youtube`. Re-run.
  - **If still blocked:** run the same videos full-length on the local copies,
    as the step 3 fallback, and label them.
- [ ] **Step 3:** Local full-length fallback (always run, so a full-length
  number exists):
  - generalize `video-subs.html` to take `v=<id>&stretch=<s>&container=mp4|webm`;
  - run the same scoring in a test `youtube-bench-local` (also in the `youtube`
    project, Chromium-compatible) against each video's local copy.
- [ ] **Step 4:** Write the baseline table to `docs/performance.md`, under
  "Real-YouTube benchmark", with one row per video:
  - path and format
  - played or blocked
  - coverage long/short
  - misses by bucket
  - ready-before-shown
  - time on screen too-short count
  - shown while paused
- [ ] **Step 5:** Commit: `test(bench): real-YouTube benchmark; baseline results`.

### Task 5: Minimum reading time (display policy)

**Files:**
- Create:
  - `src/subtitle/displayPolicy.ts`
  - `src/subtitle/__tests__/displayPolicy.test.ts`
- Modify:
  - `src/subtitle/subtitleMode.ts`: route every place that clears the overlay
    because the source ended (blank OCR at :401-408, `end` reached at :267-270,
    the read-ahead-covers clear at :247-266) through the policy. Seek
    (`onSeeking`), ad (`syncAdState`) and stop still clear immediately.
  - `e2e/bench/metrics.ts`: re-export `minDisplaySeconds`.
- Test:
  - `src/subtitle/__tests__/subtitleMode.test.ts`
  - `e2e/tests/subtitle-mode.spec.ts`

**Interfaces:**
- Produces:
  - `minDisplaySeconds(text: string): number`, equal to
    `Math.min(6, Math.max(1.5, [...text].length / 15))`.
  - `class LineDisplay`:
    - `show(text: string, at: number): void`
    - `sourceEnded(at: number): void`
    - `replace(text: string, at: number): void`
    - `tick(at: number): 'keep' | 'clear'`
    - `reset(): void`

    All times are video seconds. `tick` returns `'clear'` once
    `at >= max(sourceEnd, shownAt + minDisplaySeconds(text))` after
    `sourceEnded` was called. `replace` restarts the timing for the new text.

- [ ] **Step 1:** `displayPolicy.test.ts`:
  - `'a line whose source lasted 0.4 s stays 1.5 s'`: `show('Hi', 10)`,
    `sourceEnded(10.4)`, `tick(11.4) === 'keep'`, `tick(11.5) === 'clear'`.
  - `'a long source keeps the line until it ends'`: `show('Hi', 10)`,
    `tick(14) === 'keep'`, `sourceEnded(15)`, `tick(15) === 'clear'`.
  - `'a newer line replaces at once'`: `show('A', 10)`, `replace('B', 10.3)`.
    The current text is `B`, and the timing restarts at 10.3.
  - `'very long text is capped at 6 s'`: `show('x'.repeat(200), 0)`,
    `sourceEnded(0.5)`, `tick(5.9) === 'keep'`, `tick(6) === 'clear'`.
- [ ] **Step 2:** `subtitleMode.test.ts`:
  - `'a short subtitle lingers for its reading time, in video time'`.
    Simulate frames: the line appears at 20.0, blank OCR at 20.4, and frames at
    20.5…21.6. Expect the overlay still shown at 21.4 and cleared at 21.5.
    With the video paused at 20.6 and no frames for 3 s of wall time, it is
    still shown.
  - `'seek clears a lingering line'`: linger in progress, then `onSeeking` →
    overlay cleared immediately.
  - `'an ad clears a lingering line'`: the same via `syncAdState`.
- [ ] **Step 3:** Run
  `npx jest src/subtitle/__tests__/displayPolicy.test.ts src/subtitle/__tests__/subtitleMode.test.ts`.
  Expected: FAIL.
- [ ] **Step 4:** Implement `displayPolicy.ts` and wire it into
  `subtitleMode.ts`. `onFrame` calls `tick(t)` on every sampled frame; the
  250 ms `recheck` interval also ticks when not paused. Then move
  `minDisplaySeconds` out of `metrics.ts`.
- [ ] **Step 5:** Run the jest command again. Expected: PASS.
- [ ] **Step 6:** E2E in `subtitle-mode.spec.ts`:
  `'short subtitles stay on screen for their reading time'`. Play stretch s1 of
  the fixture with `recordOverlay`, then assert
  `timeOnScreen(shownRecords).tooShort === 0` and
  `shownWhilePaused(records) === 0`. Pause for 2 s mid-run.
- [ ] **Step 7:** Run `npm run build` and
  `npx playwright test --project=subtitles subtitle-mode`. Expected: all pass,
  including the existing coverage and latency gates.
- [ ] **Step 8:** Commit: `feat(subtitle): translated lines stay for their reading time (video time)`.

### Task 6: Read-ahead for VP9 in WebM

**Files:**
- Create:
  - `src/subtitle/readAhead/webm.ts`
  - `src/subtitle/readAhead/__tests__/webm.test.ts`
  - `src/subtitle/readAhead/__tests__/fixtures/tiny-vp9.webm` (≤ 30 KB,
    ffmpeg: 2 s, 160×90, VP9, 2 clusters)
- Modify:
  - `src/subtitle/readAhead/mseTap.main.ts` (filter `/^video\/(mp4|webm)/i`;
    choose the parser by container; map the codec)
  - `src/subtitle/readAhead/trackRegistry.ts` (`parser: MediaParser`)
  - `e2e/fixtures/pages/video-subs.html` (`container=webm` uses
    `.video.webm` with `video/webm; codecs="vp9"`)
  - `e2e/tests/subtitle-readahead.spec.ts` (run for both containers)

**Interfaces:**
- Consumes: `Fmp4Init`, `Fmp4Fragment`, `Fmp4Sample` (`fmp4.ts`); `TapTrack`.
- Produces:
  - `interface MediaParser { reset(): void; push(bytes: Uint8Array, timestampOffset?: number): { init?: Fmp4Init; fragments: Fmp4Fragment[] } }`.
    `Fmp4Parser` already satisfies it.
  - `class WebmParser implements MediaParser`. One fragment per Cluster. Sample
    `time` is `(clusterTimecode + blockRelative) * timecodeScale / 1e9 + timestampOffset`.
    `key` comes from the SimpleBlock flag `0x80`, or from a BlockGroup without
    ReferenceBlock. Duration is the delta to the next block (the last block
    repeats the previous delta).
  - `init.configBox = null`; `description` is CodecPrivate or null.
  - `webCodecsVideoCodec(mimeCodec: string): string`:
    - `'vp9'` → `'vp09.00.10.08'`
    - `'vp8'` → `'vp8'`
    - `'av01…'` and `'vp09…'` → unchanged
- `mode.stats.readAheadFrames > 0` is the path signal (Task 1).

- [ ] **Step 1:** `webm.test.ts`:
  - `'parses tracks and clusters from a VP9 file'`: push the whole fixture.
    Expect `init` with width 160 and height 90, ≥ 2 fragments, the first sample
    `key === true`, and sample times increasing, starting at 0 (± 0.001).
  - `'handles elements split at every byte boundary'`: push the fixture one
    byte at a time. The fragments and sample count equal the whole-file push.
  - `'applies timestampOffset'`: push with offset 100. The first sample time is
    100 ± 0.001.
  - `'maps short codec names'`: `webCodecsVideoCodec('vp9') === 'vp09.00.10.08'`.
- [ ] **Step 2:** Run `npx jest src/subtitle/readAhead`. Expected: FAIL.
- [ ] **Step 3:** Implement `WebmParser` (an EBML reader with variable-length
  IDs and sizes, unknown-size Segment and Cluster, and pending bytes capped at
  `MAX_PENDING_BYTES`). Wire it into `mseTap.main.ts`. If
  `VideoDecoder.isConfigSupported` rejects the codec, skip the track and keep
  read-ahead off; never throw into the page.
- [ ] **Step 4:** Run `npx jest src/subtitle/readAhead`. Expected: PASS.
- [ ] **Step 5:** E2E: parametrize `subtitle-readahead.spec.ts` over
  `container` in `['mp4', 'webm']`. Both must reach the existing gates
  (`readyBeforeShownRatio ≥ 0.9`, `claudeReadyBeforeShownRatio ≥ 0.9`) and
  `readAheadFrames > 0`. Add `'an unsupported codec leaves read-ahead off and
  the live path running'`: a page with `codecs="vp9"` and `VideoDecoder`
  stubbed to reject. It asserts `readAheadFrames === 0`, live lines are
  displayed, and there are no page errors.
- [ ] **Step 6:** Run `npm run fixtures:video` (now produces `.video.webm`),
  `npm run build`, and `npx playwright test --project=subtitles subtitle-readahead`.
  Expected: pass for both containers.
- [ ] **Step 7:** Commit: `feat(subtitle): read-ahead for VP9 in WebM`.

### Task 7: Fewer missed lines

**Files:**
- Modify: chosen by data. Candidates:
  - `subtitleMode.ts` constants and `LineTracker` options
  - `FrameSampler` `maxFps`
  - `READ_AHEAD_FPS`
  - OCR crop scaling in `src/ocr/ocr.worker.ts`
  - `MIN_CONFIDENCE`
- Test:
  - `e2e/tests/subtitle-misses.spec.ts` (`subtitles` project; add it to that
    project's `testMatch`)
  - unit tests beside each change

**Interfaces:**
- Consumes: the benchmark misses from Task 4, re-run after Tasks 5–6.

- [ ] **Step 1:** Run `BENCH_LABEL=after-vp9 npm run bench:youtube` and the
  local fallback. List each missed reference line with its duration, `h`, path
  and what the extension saw:
  - no read
  - blank OCR
  - low confidence (log confidence)
  - read but too far off (CER)
  - shown outside the window

  Write this into the ledger.
- [ ] **Step 2:** For each cause with ≥ 2 misses, cut a 20 s clip containing
  them from the local copy (ffmpeg stream copy, VP9 WebM, same split as the
  fixtures) into `e2e/.cache/videos/<id>.miss<N>.*`. Add a case to
  `subtitle-misses.spec.ts`. Each case asserts that every reference line in the
  clip is matched (`matchLines`).
- [ ] **Step 3:** Run it. Expected: FAIL on those lines.
- [ ] **Step 4:** Change the smallest lever that addresses the cause, one at a
  time, with a unit test where the lever is code (e.g.
  `'LineTracker accepts a change stable for one frame at ≥ 8 fps'`).
- [ ] **Step 5:** Run `subtitle-misses` and the full `subtitles` project.
  Expected:
  - the clip cases pass;
  - existing gates still pass (live coverage, OCR CER ≤ 0.1, latency P50
    ≤ 0.7 s, read-ahead ratios);
  - OCR calls do not grow by more than 25% in `subtitle-readahead` stats.
    Otherwise record a ruling.
- [ ] **Step 6:** Commit per lever: `fix(subtitle): <lever> so <cause> lines are read`.

### Task 8: After-run, docs and verify

**Files:**
- Modify: `docs/performance.md`, `docs/milestones.md`, `README.md` (the reading
  time rule, in Use → Subtitles mode)

- [ ] **Step 1:** Run `BENCH_LABEL=step2 npm run bench:youtube` and the local
  fallback. Add a "Step 2" column next to the baseline in `docs/performance.md`.
  - Targets met: coverage ≥ 97% long and ≥ 80% short, ready-before-shown
    ≥ 90%, tooShort 0, paused 0, read-ahead path on.
  - Each unmet target gets a ledger `Ruling:` with the reason.
- [ ] **Step 2:** Add a milestone entry with the before/after numbers.
- [ ] **Step 3:** Run `npm run verify`. Expected: exit 0.
- [ ] **Step 4:** Commit: `docs: step 2 benchmark results; milestone`.
