# Real-world sync, read-ahead and benchmarks — design

Date: 2026-11-13 · Status: for approval

## Why

The user tested the extension on real YouTube videos and found:

- **Subtitles mode** (box over burned-in subtitles), which is what they actually use:
  - The translated line disappears the moment the source subtitle does, so lines
    that flash up briefly are gone before they can be read.
  - Some subtitles are never translated at all, perhaps because they're too
    small or too quick.
- **Audio mode** (live captions from tab audio):
  - It is slow; lines arrive after the words are spoken.
  - Lines disappear too fast.
  - Lines keep appearing while the video is paused.

They also want the extension proven on **real YouTube videos with benchmarks**,
before and after every change, instead of only on local fixtures.

Main use case (unchanged): Korean League of Legends videos with burned-in
subtitles, translated into English.

## What success looks like

- Every subtitle the video shows gets a translation, and each one stays on screen
  long enough to read. Nothing runs behind the video.
- Audio captions appear when the words are spoken, follow pause/seek/rewind, and
  nothing appears while the video is paused.
- Starting Subtitles mode doesn't require drawing a box: it finds the subtitles.
- Screen Translate remains, clearly separate from the two video modes.
- Each step is measured on real YouTube against the step before, and the numbers
  are recorded.

## Goals

1. Real-YouTube benchmark and a baseline of today's version.
2. Subtitles mode:
   - minimum reading time
   - read-ahead for VP9 as well as AV1
   - fewer missed lines
3. Screen Translate as a separate tool: a card on the main view, a right-click
   item, and a keyboard shortcut.
4. Audio mode:
   - read-ahead from YouTube's buffered audio
   - captions timed to the video
   - a pause-aware live fallback
5. Automatic subtitle detection in Subtitles mode.

Build them in this order. Each step ends with a benchmark run compared against
the previous step.

## Non-goals

- Sites other than YouTube for read-ahead. Elsewhere the live paths carry the
  experience, made pause-aware.
- Copy-protected (EME/DRM) streams; they can't be decoded.
- Removing Screen Translate. The user wants to keep it.
- New translation engines or prompt work.

## Anti-goals (failure even if it "works")

- **A translation that runs behind the video.** For example, an old line still
  lingering while a newer subtitle is on screen, or audio captions for speech
  that ended seconds ago.
- **Captions appearing while the video is paused**, or after a seek, for the
  old position.
- **Read-ahead silently switching off with nobody noticing.** Benchmarks must
  report which path ran (read-ahead or live).
- **Benchmarks that only pass on local fixtures** while real YouTube is
  untested.
- **Weakened assertions or changed thresholds without disclosure.**

## Decided

### Subtitles mode: minimum reading time

- **Minimum time on screen:** each translated line gets
  `max(1.5 s, characters / 15 chars per s)` of the translated text, capped at
  6 s.
- **Ending:** a line stays until the later of
  - the source subtitle disappearing, or
  - its start plus the minimum time.
- **A new subtitle replaces the current line immediately.** The minimum time
  never delays a newer line.
- **The time is counted in video time, not wall time.** Pausing freezes the line
  on screen, and seeking clears it.
- **When a line starts:** the moment its source subtitle appears.
  - With read-ahead the translation is ready by then and gets its full time.
  - On the live path it starts when the translation arrives, but it still ends
    no later than the next subtitle.

### Subtitles mode: read-ahead for VP9

- **Why:** today read-ahead taps only fMP4/AV1. YouTube serves VP9-in-WebM to
  Chrome clients without AV1 decode. Then read-ahead is silently off and the
  live sampler (requestVideoFrameCallback) carries everything. That is the
  leading suspect for the user's slow and missed lines.
- **What to build:** add WebM demuxing (EBML: Clusters and SimpleBlocks,
  CodecPrivate) for the video SourceBuffer and decode VP9 with WebCodecs.
- **What stays the same:** the existing safeguards for frames posted from the
  main world (`readAheadSource.ts` bounds and slots).
- **Reporting:** the extension reports which path is active through the test
  bridge, so benchmarks can record it.

### Subtitles mode: fewer missed lines

- **Measure first.** The benchmark reports missed lines by
  - how long each was on screen (bucketed, e.g. < 0.5 s, 0.5–1 s, 1–2 s, > 2 s)
  - text height in pixels
  - path (read-ahead or live)
- **Then fix the causes the data shows.** Likely levers, for the builder to
  choose by measurement:
  - the change detector's `stableFrames` and threshold
  - the sampling rate on the live path
  - OCR input scaling for small text
  - the `MIN_CONFIDENCE` cutoff
  - the recheck interval

### Screen Translate: a separate tool

- **Popup:** Screen Translate moves out of the main flow into its own outlined
  card at the bottom of the main view (mockup option B). The card has
  - the title "Screen Translate"
  - one line: "Translate any text on this page, not just video"
  - a quiet button, "Select an area"
  - the keyboard shortcut shown underneath
- **Styling:** it reads as a tool, not a third mode.
- **Right-click:** a context-menu item "Translate an area of this page" on any
  page starts the selection (needs the `contextMenus` permission).
- **Keyboard shortcut:** declared under the manifest's `commands`. The suggested
  default is Alt+Shift+T; users can change it at `chrome://extensions/shortcuts`.
- **Behaviour once a box is drawn:** unchanged (themed panel, refresh, close).

### Audio mode: read-ahead and sync (YouTube)

- **Source:** take audio from YouTube's buffered audio SourceBuffer, which is
  WebM/Opus today and possibly AAC in fMP4. Use the same main-world MSE tap,
  widened to audio.
- **Decoding:** demux, decode with WebCodecs `AudioDecoder`, and resample to
  16 kHz mono.
- **Transcription:**
  - Run Whisper ahead of playback.
  - Every caption carries its start and end in **video time**.
  - Segment-level timestamps from Whisper are acceptable.
- **Display follows video time:**
  - A caption appears at its start and stays until its end plus the same
    minimum-reading-time rule.
  - A newer caption replaces an older one; at most two lines are visible.
  - Pause freezes the display. Seek and rewind show the captions for the new
    position, reusing ones already made.
- **Upgrades:** Claude's improved version replaces the fast one in place, before
  display where possible.
- **Two-line roll (my call):** audio captions keep a two-line roll, like
  YouTube's own captions.
  - A newer caption appears at the bottom and pushes the older one up.
  - The older one leaves at its own end plus the minimum time, or when a third
    arrives, whichever is first.
  - Subtitles mode is different: it replaces, because it mirrors one source
    subtitle slot.
- **Tab capture still starts on YouTube (my call).**
  - Audio mode still starts tab capture from the popup click. Capture needs that
    click, so it can't be started later.
  - While read-ahead is healthy, the live transcription path is suppressed;
    capture only keeps the tab audible, as today.
  - If read-ahead stops mid-session (ad, format change, stall), the live path
    takes over without a restart, and the switch is reported to the test
    bridge.
- **Transport:** PCM moves main world → content script → offscreen document.
  The content script treats it as untrusted, like read-ahead frames:
  - It accepts only audio for the buffered range.
  - It enforces rate and size limits.
  - Forged audio could at worst produce wrong captions, never anything else.
- **Turning off:** read-ahead stops when Audio mode stops or the tab navigates.
  It costs no extra network.

### Audio mode: live fallback (non-YouTube, DRM, or tap unavailable)

- **Pause-aware:** the content script tells the pipeline when the video pauses,
  plays or seeks.
  - Segments captured before a pause or seek that haven't been shown are
    dropped.
  - Nothing new is displayed while paused.
- **Display:** captions use the minimum-reading-time rule instead of the fixed
  6 s, in the same two-line roll.
- **Stale lines (my call):** a caption is dropped instead of shown if its
  speech ended more than 5 s ago in video time.
  - On CPU, end-to-end latency is about 2.8 s, so normal lines survive.
  - Backlogs don't surface stale speech.
- **Which video:** if a page has several videos, follow the one that is playing.

### Automatic subtitle detection

- **The popup's Subtitles flow:**
  - The primary button finds the subtitles.
  - "Draw box myself" stays as a secondary action.
  - A saved box per video still wins when present.
- **How detection works:**
  - Over about 3–5 s of video (read-ahead frames when available, otherwise live
    frames), run the existing PP-OCRv5 detection model on downscaled full frames.
  - Choose the region where text appears in a consistent place and **keeps
    changing**. That separates subtitles from HUD text, scores, names and logos,
    which stay put or barely change.
- **Showing the result:** the detected box is drawn on the video with
  "Looks right" and "Redraw" choices. Translation starts straight away in it;
  Redraw switches to manual drawing.
- **When nothing is found:** say so plainly and offer drawing.

### Real-YouTube benchmark

- **Browser:**
  - Installed Chrome, launched without automation flags (existing `launch.ts`
    path), in a **visible window** on the user's screen. The user agreed to this.
  - Persistent test profile under `e2e/.cache/`, never the user's personal
    profile.
  - Also try a profile signed in to a Google account, if the visible window
    alone still hits YouTube's ~40 s automated-playback cutoff. The user signs
    in once, interactively, in `e2e/.cache/profile-youtube` with a throwaway
    account they have; I open the window and they sign in only if the visible
    window alone is blocked.
- **Video set:** fixed, listed in one config file.
  - **Subtitles:**
    - `_zIrbXw-SVs` (has a hand-checked timeline)
    - 2–3 more Korean League videos with burned-in subtitles, including fast
      dialogue and small text
  - **Audio:** 2–3 Korean videos with clear speech that have Korean captions on
    YouTube, used as the timing and text reference. Manual captions are
    preferred; auto-captions are acceptable and labelled as such.
- **Reference timelines for new subtitle videos:**
  - Built semi-automatically from a downloaded copy (dense OCR offline, e.g.
    every frame at ≥ 10 fps).
  - Hand-checked from screenshots.
  - Stored next to the existing timeline in `e2e/fixtures/subtitles/`.
- **Metrics per run:**
  - path used
  - **coverage**: lines translated out of lines shown
  - missed lines by duration and size
  - lead time: how early each translation was ready before its line appeared
  - display offset from source appearance
  - time on screen against the minimum
  - lines shown while paused (must be 0)
  - OCR text error (CER) or, for audio, transcript CER against captions
  - Claude quality score, using the existing `judge` scoring (opt-in, costs
    money)
- **If YouTube blocks long playback anyway:**
  - Run the full-length benchmark on the downloaded copy served through the
    local YouTube-like MSE player (`fixtures:video`).
  - Still run the real-YouTube session for as long as it plays.
  - Report both, labelled. A blocked run is reported, never hidden.
- **Targets (my call):** each step must meet these on the benchmark set, or
  record a ruling explaining why not.
  - **Lines shown while paused:** 0. (Amended during build: counted as stale lines,
    meaning a line that isn't the subtitle on screen at that moment. In Subtitles
    mode, a translation of the subtitle visible in the paused frame may still
    land during a pause.)
  - **Path:** the expected path ran (read-ahead on YouTube).
  - **Subtitles coverage:**
    - ≥ 97% of lines on screen ≥ 0.5 s
    - ≥ 80% of lines on screen < 0.5 s
  - **Read-ahead lead:** ≥ 90% of lines ready before they appear.
  - **Time on screen:** every displayed line gets at least its minimum, unless a
    newer line replaced it.
  - **Audio read-ahead:** caption start within ±0.5 s of the reference caption
    start, for ≥ 90% of lines.
  - **No regressions:** a later step may not lower an earlier step's metric by
    more than noise (2 points), unless a ruling explains it.
  - **What gates `verify`:** the local-fixture E2E tests assert the same targets.
    The real-YouTube project reports and compares, and fails only on paused
    lines or on the wrong path.
- **Where results go:**
  - JSON per run under `e2e/.perf/`
  - a summary table per step in `docs/performance.md`
  - post-worthy wins in `docs/milestones.md`

## Constraints

- **Definition of done:** `npm run verify` green (types, lint, unit, E2E, live).
  The real-YouTube benchmark is an opt-in project like `youtube`, not part of
  `verify`.
- **No manual smoke tests** handed back to the user; every behaviour has an E2E
  test on the local fixtures.
- **Never weaken assertions.** Disclose any changed threshold.
- **Never print or commit API keys.** Never use the user's personal Chrome
  profile.
- **Manifest:** keep the CLAUDE.md gotchas, e.g. no COOP/COEP; Playwright
  Chromium lacks H.264/AAC, so fixtures use VP9/Opus.
- **The main-world tap only runs where it does today** (youtube.com plus
  loopback for tests). Anything it posts is untrusted.

## Left to the builder

- Demuxer and decoder structure, worker placement for audio decode and
  resampling, and how PCM is chunked and transported.
- Whisper segmentation of read-ahead audio, and whether to use VAD or Whisper
  timestamps for caption boundaries.
- Detection scoring details and frame budget; which missed-line levers to pull,
  based on data.
- Exact benchmark harness structure, video IDs (within the criteria above), and
  report format.
- The keyboard shortcut default if Alt+Shift+T clashes.
