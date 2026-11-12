# Burned-in Subtitle Translation (Subtitle mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user draw one box over a YouTube video's burned-in subtitles and see a live, continuously updated translation laid over that box.

**Architecture:** A content-script controller samples `<video>` frames (`requestVideoFrameCallback`), crops the user's box, detects when the box content changes, and sends crops to an OCR worker hosted in a hidden extension iframe (ImageBitmaps transferred via `postMessage`, WebGPU-capable extension origin). Recognized lines are translated through the background (DeepL with neighbouring-line context), stored on a per-video timeline (IndexedDB), and rendered by an overlay locked to the video. A read-ahead source (chosen by spike) feeds future frames through the same pipeline so most lines are ready before they appear.

**Tech Stack:** TypeScript, Chrome MV3, ONNX Runtime Web (bundled via transformers.js), WebGPU/wasm, IndexedDB, Jest + jsdom, Playwright (Chromium and installed Chrome via `E2E_BROWSER=chrome`), Python venv tooling in `e2e/.cache/venv` (yt-dlp, ffmpeg, Pillow) for fixtures.

**Spec:** `docs/superpowers/specs/2026-11-12-burned-in-subtitle-translation-design.md`

## Global Constraints

- Done = `npm run verify` passes; every task is verified by automated tests. Never weaken an assertion to make a test pass; never hand a manual check to the developer (CLAUDE.md).
- Default test suites are deterministic: mock translation server only, no paid APIs. Real DeepL, Claude-judge and real-YouTube runs are opt-in projects, never in `verify`'s default path except the existing `live` DeepL project.
- Overlay style "C": tint `rgba(0, 0, 0, 0.55)` filling exactly the box; English text `#ffe066`, `font-weight: 800`, `text-shadow: 0 0 4px #000`, auto-sized to fill the box; nothing shown when the box has no subtitle.
- Speed targets: live path p50 ≤ **700 ms** from a line appearing to its English showing; read-ahead ≥ **90%** of lines translated before they appear during uninterrupted playback.
- No OCR when the box content is unchanged; a line still on screen is never re-read or re-translated.
- Box stored per video ID in `chrome.storage.local` as `subtitleBox:<videoId>` = `NormalizedBox` (fractions of the video's rendered content rect).
- Subtitle languages: `ko`, `ja`, `zh-Hans`, `zh-Hant`, `es`, `fr`, `de`, `pt`, `ru`; setting `subtitleLanguage` in `chrome.storage.sync`, default `ko`. Korean is the language tested end to end.
- OCR runs locally (no key); models download on first use of a language and are cached.
- Test video `_zIrbXw-SVs`; local copies live under `e2e/.cache/videos/` (gitignored) and are produced by a script, never committed.
- Don't rebuild `dist/` while a Playwright run uses it; Playwright wipes `e2e/.results/` each run — durable reports go to `e2e/.perf/`.

## Review Focus

1. **Seeking mid-line** (forward or back): the overlay shows the line for the new position (from the timeline or a fresh live read), never the stale one. → test in Task 7.
2. **YouTube ads** (`#movie_player.ad-showing`): the pipeline pauses; nothing read during an ad is written to the video's timeline. → test in Task 7.
3. **SPA navigation to another video** (`yt-navigate-finish`, new `v=`): the old video's pipeline stops, its overlay disappears, and the new video's stored box (if any) is restored. → test in Task 7.
4. **Paused video**: no repeated OCR while paused; the current line stays visible. → test in Task 7.
5. **Box not over a video, or smaller than 24×12 CSS px**: drawing over page text keeps one-shot Screen Translate; a too-small box over a video is rejected with a status message instead of starting subtitle mode. → test in Task 7.

---

### Task 1: Video fixtures and ground-truth timeline

**Files:**
- Create: `e2e/scripts/fetch_video_fixtures.py`, `e2e/scripts/label_timeline.py`
- Create: `e2e/fixtures/subtitles/_zIrbXw-SVs.timeline.json`
- Create: `e2e/fixtures/pages/video-subs.html`
- Modify: `e2e/helpers/server.ts` (serve `/videos/` from `e2e/.cache/videos` with Range support)
- Modify: `package.json` (script `fixtures:video`)
- Test: `e2e/tests/fixtures-sanity.spec.ts` (project `ui`)

**Interfaces:**
- Produces: timeline JSON `{ video: string, stretches: { id: 's1'|'s2', start: number, end: number, file: string }[], lines: { stretch: 's1'|'s2', start: number, end: number, ko: string, en: string, terms: string[] }[] }` with `start`/`end` in seconds **relative to the stretch file** (frame-accurate at 30 fps sampling).
- Produces: fixture page `video-subs.html?v=<id>&stretch=s1|s2` exposing `window.__fixture = { video: HTMLVideoElement, navigate(v: string, stretch: string): void, setAd(on: boolean): void }`; DOM mirrors YouTube: `#movie_player.html5-video-player > .html5-video-container > video.html5-main-video`; playback via MediaSource (WebM appended in 1 MB slices) so it behaves like YouTube's MSE player; `navigate` does `history.pushState` + dispatches `yt-navigate-finish` on `document`.

- [ ] **Step 1:** Write `fetch_video_fixtures.py`: download `https://youtu.be/_zIrbXw-SVs` (VP9 ≤1080p + Opus, WebM) with the venv's yt-dlp + imageio-ffmpeg if `e2e/.cache/videos/_zIrbXw-SVs.webm` is missing, then cut stretches with ffmpeg stream copy re-muxed for MSE: `s1` = 0–180 s, `s2` = 540–720 s → `_zIrbXw-SVs.s1.webm`, `_zIrbXw-SVs.s2.webm`. Idempotent. `npm run fixtures:video` runs it (creating the venv if absent).
- [ ] **Step 2:** Write `label_timeline.py`: extract the subtitle band (crop `1152:184:384:821` at 1080p) at 30 fps for each stretch, compute the outlined-white-text mask (as in `e2e/.recon/segments.py`, HUD rows ≥110 excluded), and emit draft line boundaries (mask IoU change) plus one mid-line crop PNG per draft line into `e2e/.cache/label/`.
- [ ] **Step 3:** Transcribe every draft line of both stretches from the crops into `_zIrbXw-SVs.timeline.json` (merge/split drafts where the boundary detector erred; `en` = reference translation with League context; `terms` = 1–3 unambiguous nouns that a correct translation must contain, e.g. champion/item names; empty when none). Lines of the existing 36-line set that fall in a stretch must match it. Add `"labelledBy": "builder (from frames)"`.
- [ ] **Step 4:** Write the fixture page and the `/videos/` route.
- [ ] **Step 5: Write the failing sanity test** `fixtures-sanity.spec.ts`:

```ts
test('timeline covers both stretches without gaps or overlaps', () => {
  // per stretch: lines sorted, every line end > start, consecutive lines don't overlap,
  // s1 and s2 each have >= 40 lines, all start/end within [0, stretch length]
});
test('fixture page plays a stretch through MSE', async ({ context, fixtureURL }) => {
  // goto video-subs.html?v=_zIrbXw-SVs&stretch=s1; play muted; after 3 s currentTime > 2,
  // video.videoHeight === 1080, MediaSource in use (video.src starts with 'blob:')
});
```

- [ ] **Step 6:** Run `npm run fixtures:video && npx playwright test e2e/tests/fixtures-sanity.spec.ts --project=ui` → PASS.
- [ ] **Step 7: Commit** (scripts, timeline JSON, page, server change, test).

---

### Task 2: OCR engine benchmark and decision

**Files:**
- Create: `e2e/tests/perf-ocr.spec.ts` (project `perf`)
- Create: `e2e/scripts/export_crops.py` (writes box crops for each timeline line, plus 20 "no subtitle" crops, to `e2e/.cache/ocr-crops/<stretch>/<index>.png` + `index.json`)
- Create: `docs/superpowers/decisions/2026-11-12-ocr-engine.md`
- Modify: `docs/performance.md` (create if missing; add an OCR section)

**Interfaces:**
- Consumes: Task 1 timeline JSON and stretch files.
- Produces: decision record naming the engine, model files (URLs + sizes), input preprocessing (target height, normalization, binarization if any), device (WebGPU/wasm), and measured numbers; Task 3 implements exactly that.

- [ ] **Step 1:** Write `export_crops.py`: for each timeline line take the frame at the line's midpoint and crop the box the tests will draw — `NormalizedBox` `{ x: 0.2, y: 0.76, w: 0.6, h: 0.10 }` of the 1920×1080 frame.
- [ ] **Step 2:** Write `perf-ocr.spec.ts`: in an extension page, run each candidate over every crop and report per candidate: CER (whitespace-stripped, Levenshtein / reference length) over subtitle crops, false-positive rate on no-subtitle crops (non-empty text with confidence ≥ the candidate's threshold), median and p90 latency per crop on WebGPU and on wasm, first-load download size. Candidates: (1) PaddleOCR PP-OCR det + Korean rec as ONNX through ONNX Runtime Web (find maintained ONNX exports; record URLs), (2) Tesseract.js `kor`, (3) one transformer OCR model available to transformers.js that supports Korean, if any exists. Results → `e2e/.perf/perf-ocr.json` and stdout table.
- [ ] **Step 3:** Run in installed Chrome: `E2E_BROWSER=chrome npx playwright test --project=perf e2e/tests/perf-ocr.spec.ts`.
- [ ] **Step 4:** Write the decision record. Rule: lowest CER among candidates with median WebGPU latency ≤ 250 ms per crop; if the most accurate exceeds 250 ms, record a fast/accurate pair (spec: two OCR tiers). Update `docs/performance.md`.
- [ ] **Step 5: Commit.**

---

### Task 3: OCR worker in an extension iframe

**Files:**
- Create: `ocr-frame.html`, `src/ocr/ocrFrame.ts`, `src/ocr/ocr.worker.ts`, `src/ocr/ctc.ts`, `src/ocr/models.ts`
- Create: `src/subtitle/ocrClient.ts`, `src/subtitle/types.ts`, `src/subtitle/testBridge.ts`
- Modify: `webpack.config.js` (pages entry `ocrFrame`, worker entry `ocr.worker`; copy `ocr-frame.html`), `manifest.json` (`web_accessible_resources` += `ocr-frame.html`)
- Test: `src/ocr/__tests__/ctc.test.ts`, `src/ocr/__tests__/models.test.ts`, `e2e/tests/subtitle-ocr.spec.ts` (new project `subtitles`, persistent profile `e2e/.cache/profile-subtitles-${browserKind()}`, workers 1)

**Interfaces:**
- Produces (`src/subtitle/types.ts`):
  - `type SubtitleLanguage = 'ko'|'ja'|'zh-Hans'|'zh-Hant'|'es'|'fr'|'de'|'pt'|'ru'`
  - `interface NormalizedBox { x: number; y: number; w: number; h: number }`
  - `interface OcrResult { text: string; confidence: number; ms: number; tier: 'fast'|'accurate' }`
- Produces (`src/subtitle/ocrClient.ts`): `class OcrClient { static attach(): Promise<OcrClient>; recognize(crop: ImageBitmap, lang: SubtitleLanguage, tier?: 'fast'|'accurate'): Promise<OcrResult>; preload(lang: SubtitleLanguage): Promise<void>; detach(): void }` — injects a hidden `ocr-frame.html` iframe (1×1, `aria-hidden`), talks over a `MessageChannel`, transfers the bitmap.
- Produces (`src/subtitle/testBridge.ts`): `installTestBridge(handlers: Record<string, (payload: any) => Promise<any>>): void` — active only when `chrome.storage.local.devExposeInternals === true`. Content scripts run in an isolated world, so tests in the page's main world call `window.postMessage({ astTest: <command>, id, payload }, '*')` and await `{ astTestResult: id, result | error }`. Commands registered by later tasks: `ocr` (Task 3), `overlay.show` / `overlay.clear` / `overlay.rect` (Task 6), `mode.state` / `mode.ocrCalls` / `mode.timeline` (Task 7). E2E helper `e2e/helpers/bridge.ts`: `astTest(page, command, payload)`.
- Produces (`src/ocr/ctc.ts`): `ctcGreedyDecode(logits: Float32Array, steps: number, classes: number, charset: string[], blank = 0): { text: string; confidence: number }` (if the chosen engine is CTC-based; otherwise replace with that engine's pure decode step and its test).
- Produces (`src/ocr/models.ts`): `modelFor(lang: SubtitleLanguage, tier): { det: string; rec: string; charset: string }` per the decision record; empty result (`text: ''`) when detection finds no text box.

- [ ] **Step 1: Write failing unit tests:** `ctcGreedyDecode` collapses repeats and drops blanks (`[a,a,blank,a,b]` → `"aab"`), confidence = mean max-prob of emitted steps; `modelFor` returns a rec model for every `SubtitleLanguage`.
- [ ] **Step 2:** Run `npx jest src/ocr` → FAIL.
- [ ] **Step 3:** Implement `ctc.ts`, `models.ts`, the worker (engine per decision record; WebGPU with wasm fallback, same restart-on-wasm pattern as `offscreen.ts`), the iframe host, and `OcrClient`.
- [ ] **Step 4:** Run `npx jest src/ocr` → PASS.
- [ ] **Step 5: Write the failing E2E** `subtitle-ocr.spec.ts`: on `video-subs.html`, from a content-script-equivalent page context send each exported crop of stretch `s1` (fetched from the fixture server, `createImageBitmap` in the page) through `astTest(page, 'ocr', { bitmap, lang: 'ko' })`, which calls `OcrClient.recognize` in the content script.

```ts
expect(cer).toBeLessThanOrEqual(0.10);            // all s1 subtitle crops, Korean
expect(falsePositives).toBe(0);                    // no-subtitle crops return text ''
expect(medianMs).toBeLessThanOrEqual(250);         // installed Chrome / WebGPU run
```

- [ ] **Step 6:** `npm run build && E2E_BROWSER=chrome npx playwright test --project=subtitles e2e/tests/subtitle-ocr.spec.ts` → PASS (Chromium run asserts CER and false positives only; latency asserted on Chrome).
- [ ] **Step 7: Commit.**

---

### Task 4: Pure pipeline logic

**Files:**
- Create: `src/subtitle/frameSignature.ts`, `src/subtitle/lineTracker.ts`, `src/subtitle/videoGeometry.ts`, `src/subtitle/timeline.ts`
- Test: `src/subtitle/__tests__/frameSignature.test.ts`, `lineTracker.test.ts`, `videoGeometry.test.ts`, `timeline.test.ts`
- Modify: `package.json` (devDependency `fake-indexeddb`)

**Interfaces:**
- `frameSignature(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array` — 64×16 luminance thumbnail; `signatureDistance(a, b): number` in [0, 1] (mean absolute difference / 255).
- `class LineTracker { constructor(opts?: { changeThreshold?: number /* 0.06 */; stableFrames?: number /* 2 */ }); push(sig: Uint8Array, videoTime: number): LineEvent | null }` with `type LineEvent = { type: 'changed'; at: number }` — emitted once when the signature has moved past the threshold from the last accepted signature and then stayed within it for `stableFrames` consecutive frames; `reset()` on seek.
- `contentRect(el: { clientWidth; clientHeight; videoWidth; videoHeight }): { x; y; width; height }` (object-fit: contain letterboxing); `boxToPage(box: NormalizedBox, videoClientRect: DOMRectReadOnly, content): DOMRect`; `pageToBox(rect: DOMRect, videoClientRect, content): NormalizedBox` (clamped to [0,1]); `boxToSource(box, videoWidth, videoHeight): { sx; sy; sw; sh }` (integer pixels for `drawImage`).
- `interface TimelineLine { start: number; end: number | null; source: string; translation: string | null; quality: 'none'|'fast'|'better' }`; `class Timeline { at(t: number): TimelineLine | null; upsert(line: Omit<TimelineLine,'quality'|'translation'>): TimelineLine; setTranslation(start: number, text: string, quality: 'fast'|'better'): void /* never downgrades better→fast */; close(start: number, end: number): void; neighbours(start: number, n: number): { previous: string[]; next: string[] } }`; `class TimelineStore { static open(): Promise<TimelineStore>; load(videoId: string): Promise<Timeline>; save(videoId: string, tl: Timeline): Promise<void> }` (IndexedDB db `ast-subtitles`, store `timelines`).

- [ ] **Step 1: Write failing tests** pinning: identical frames → distance 0; a 10% luminance shift → distance ≈ 0.1; `LineTracker` emits exactly one `changed` per distinct text image (sequence A,A,B,B,B,A → events at the 2nd B and 2nd A), none while frames are identical (paused video), none for a single noisy frame; `contentRect` for 1280×720 element showing 1920×800 video → `{ x: 0, y: 93.33, width: 1280, height: 533.33 }`; `pageToBox(boxToPage(b))` round-trips within 1e-6; `boxToSource({x:.2,y:.76,w:.6,h:.1},1920,1080)` → `{ sx: 384, sy: 821, sw: 1152, sh: 108 }`; `Timeline.at` returns the line covering `t` and null in gaps; `setTranslation(...,'fast')` after `'better'` keeps the better text; `neighbours` returns up to `n` previous/next sources in order; `TimelineStore` save→load round-trips (fake-indexeddb).
- [ ] **Step 2:** Run `npx jest src/subtitle` → FAIL.
- [ ] **Step 3:** Implement the four modules.
- [ ] **Step 4:** Run `npx jest src/subtitle` → PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: Translation with context and priority

**Files:**
- Modify: `src/services/apiService.ts`, `src/background.ts`, `src/types/index.ts`
- Test: `src/services/__tests__/apiService.test.ts`, `e2e/helpers/server.ts` (mock records `context`)

**Interfaces:**
- `apiService.translateText(text, sourceLanguage, targetLanguage, options?: { previousLines?: string[]; nextLines?: string[] }): Promise<TranslationResult>` — DeepL sends `context` = `previousLines` + `nextLines` joined with `\n` (only when non-empty); Google ignores it. Existing three-argument calls unchanged.
- Message `TRANSLATE_SUBTITLE_LINE` `{ text, sourceLang: SubtitleLanguage, previousLines: string[], nextLines: string[], priority: 'live'|'readahead' }` → `{ success: true, translatedText, quality: 'fast'|'better' } | { success: false, error }`. Until piece 2, every result is `quality: 'fast'` from the configured provider; `readahead` requests are processed after `live` ones (two background queues, live first).
- Subtitle source codes map to providers: DeepL `ZH-HANS`/`ZH-HANT` and Google `zh-CN`/`zh-TW` for `zh-Hans`/`zh-Hant`; others pass through.

- [ ] **Step 1: Write failing tests:** DeepL request body has `context: "a\nb"` when `previousLines: ['a'], nextLines: ['b']`; no `context` key when both empty; `zh-Hans` → DeepL `source_lang: 'ZH-HANS'`, Google `source: 'zh-CN'`.
- [ ] **Step 2:** Run `npx jest src/services` → FAIL.
- [ ] **Step 3:** Implement options, language mapping, the message handler and the two-priority queue in `background.ts`.
- [ ] **Step 4:** Run `npx jest` → PASS; `npm run build && npx playwright test --project=ui` → PASS (no regression).
- [ ] **Step 5: Commit.**

---

### Task 6: Overlay renderer

**Files:**
- Create: `src/subtitle/overlay.ts`
- Test: `src/subtitle/__tests__/overlay.test.ts`, `e2e/tests/subtitle-overlay.spec.ts` (project `ui`)

**Interfaces:**
- `class SubtitleOverlay { constructor(video: HTMLVideoElement, box: NormalizedBox); show(text: string, meta?: { lineStart: number; quality: 'fast'|'better' }): void; clear(): void; setBox(box: NormalizedBox): void; destroy(): void; readonly element: HTMLDivElement }` — element `div.ast-subtitle-overlay[data-ast-owned]`, `position: fixed`, `pointer-events: none`, `z-index: 2147483646`, appended to the fullscreen element when one is active (else `document.body`); repositions on `ResizeObserver(video)`, `fullscreenchange`, `scroll` and `resize`; hidden (`display: none`) when cleared. `show` sets `data-line-start`, `data-quality` and `data-shown-at` (`video.currentTime`) for the harness.
- `fitText(el: HTMLElement, maxWidth: number, maxHeight: number, min = 10, max = 200): number` — largest integer font-size (px) at which `el.scrollWidth <= maxWidth && el.scrollHeight <= maxHeight`, by binary search; allows wrapping to at most 2 lines.

- [ ] **Step 1: Write failing jsdom tests:** style C values present (`rgba(0, 0, 0, 0.55)`, `#ffe066`, weight 800); `clear()` hides; `show` sets the data attributes; `destroy` removes the element.
- [ ] **Step 2: Write failing E2E** on `video-subs.html` (driven through the test bridge: `overlay.show` / `overlay.clear` / `overlay.rect` construct and query a `SubtitleOverlay` for the fixture video and box): after `show('It could be top Camille though')` the overlay rect equals `boxToPage(box)` within 1 px; text bounding box lies inside it and is ≥ 70% of its width or height; after resizing the viewport to 900×600 and after `requestFullscreen` on `#movie_player`, the rect still matches within 1 px; screenshot saved.
- [ ] **Step 3:** Run both → FAIL. **Step 4:** Implement. **Step 5:** Run both → PASS. **Step 6: Commit.**

---

### Task 7: Subtitle mode controller, live path, popup

**Files:**
- Create: `src/subtitle/subtitleMode.ts`, `src/subtitle/frameSampler.ts`, `src/subtitle/videoId.ts`
- Modify: `src/realTimeTranslate.ts` (box over a `<video>` → subtitle mode), `src/content.ts` (mode messages), `src/popup.ts`, `popup.html`, `src/types/index.ts`, `src/settings.ts` (`subtitleLanguage: 'ko'`)
- Test: `src/subtitle/__tests__/videoId.test.ts`, `src/__tests__/popup.test.ts`, `e2e/tests/subtitle-mode.spec.ts` (project `subtitles`)

**Interfaces:**
- `videoIdFrom(url: string): string | null` — `youtube.com/watch?v=`, `youtu.be/<id>`, `youtube.com/shorts/<id>`, fixture `?v=`.
- `class FrameSampler { constructor(video: HTMLVideoElement, box: NormalizedBox, onFrame: (crop: ImageBitmap, sig: Uint8Array, videoTime: number) => void, maxFps = 12); start(); stop() }` — uses `requestVideoFrameCallback`; draws only the box's source rect into an `OffscreenCanvas`; skips while `video.paused`, while `#movie_player.ad-showing`, and while the tab is hidden.
- `class SubtitleMode { static start(opts: { video: HTMLVideoElement; videoId: string; box: NormalizedBox; lang: SubtitleLanguage }): Promise<SubtitleMode>; stop(): void; readonly state: 'loading'|'running'|'paused-ad'|'stopped' }` — wires FrameSampler → LineTracker → OcrClient (`tier: 'fast'`) → `TRANSLATE_SUBTITLE_LINE` (`priority: 'live'`, neighbours from Timeline) → Timeline → SubtitleOverlay; on `seeking`/`seeked` resets the tracker and shows `timeline.at(t)` immediately if known; empty OCR text clears the overlay and closes the current line; persists the timeline every 10 s and on stop; on `yt-navigate-finish` or `v=` change stops and, if a box is stored for the new ID, restarts.
- Messages (popup → content): `GET_SUBTITLE_MODE_STATE` → `{ mode: 'audio'|'subtitles'|'off', state, videoId, hasBox }`; `START_SUBTITLE_MODE` / `STOP_SUBTITLE_MODE` / `REDRAW_SUBTITLE_BOX`; starting either mode stops the other.
- Popup: segmented control `#modeAudio` / `#modeSubtitles`; Subtitles panel: `#subtitleLanguage` (the 9 languages, default `ko`), `#drawSubtitleBox` ("Draw subtitle box" / "Redraw box"), `#subtitleModeStatus`; Audio panel: the existing Start/Stop Subtitles button.

- [ ] **Step 1: Write failing unit tests:** `videoIdFrom` for the four URL shapes and a non-video URL (null); popup shows the Subtitles panel and hides the Audio panel when `#modeSubtitles` is chosen, and persists `subtitleLanguage`.
- [ ] **Step 2:** Run `npx jest` → FAIL. **Step 3:** Implement. **Step 4:** Run `npx jest` → PASS.
- [ ] **Step 5: Write failing E2E** `subtitle-mode.spec.ts` (read-ahead disabled via `chrome.storage.local.devSubtitle = { readAhead: false }`; mock DeepL returns `[EN-US] <text>`):

```ts
test('live path translates every line of stretch s1', ...)
// popup: Subtitles, Korean, Draw box; drag over box {x:.2,y:.76,w:.6,h:.1}; play s1 to the end.
// For each timeline line: an overlay show with data-line-start within [line.start - 0.1, line.end] whose text,
// minus the "[EN-US] " prefix, has CER <= 0.15 vs line.ko; lines with no subtitle show nothing.
// liveLatency = data-shown-at - line.start per line; report p50/p90 to e2e/.perf/subtitle-report.json;
// assert p50 <= 0.7 (mock translation) ; OCR calls <= 1.5 * number of lines (no re-reading).
test('seek mid-line shows the right line', ...)         // Review Focus 1: seek back to a line already seen -> its translation shown within 200 ms of seeked, no OCR call
test('ads pause the pipeline', ...)                      // Review Focus 2: __fixture.setAd(true) -> state 'paused-ad', zero OCR calls and zero timeline writes until setAd(false)
test('navigation switches videos', ...)                  // Review Focus 3: __fixture.navigate('otherId','s2') -> overlay gone; back to _zIrbXw-SVs -> stored box restored without redrawing
test('paused video is not re-read', ...)                 // Review Focus 4: pause 3 s -> zero OCR calls, overlay still shows current line
test('box placement rules', ...)                         // Review Focus 5: drag over page text -> one-shot overlay as today; 20x10 px box over video -> status "Box too small" and no subtitle mode
```

- [ ] **Step 6:** Run `npm run build && npx playwright test --project=subtitles e2e/tests/subtitle-mode.spec.ts` (Chromium) and with `E2E_BROWSER=chrome` → PASS; existing `ui` and `captions` projects still PASS.
- [ ] **Step 7: Commit.**

---

### Task 8: Read-ahead spike and decision

**Files:**
- Create: `e2e/tests/spike-readahead.spec.ts` (project `perf`), `docs/superpowers/decisions/2026-11-12-read-ahead.md`
- Create (throwaway, deleted or folded into Task 9): `src/subtitle/readAhead/spike-*.ts`

**Interfaces:**
- Produces: decision record choosing **(a)** hidden muted second player running ahead or **(b)** capturing MSE segments (main-world hook on `SourceBuffer.prototype.appendBuffer`) and decoding future frames with WebCodecs — or **neither**. Recorded per approach: lead time achieved (s ahead of `currentTime`), frames/s delivered for the box, extra CPU/GPU time, extra network bytes, behaviour after seek, behaviour on real YouTube (installed Chrome, test profile).

- [ ] **Step 1:** Prototype both on `video-subs.html` (MSE playback) and on real YouTube.
- [ ] **Step 2:** Measure with `spike-readahead.spec.ts`; write numbers to `e2e/.perf/readahead-spike.json`.
- [ ] **Step 3:** Write the decision record. Rule: choose the approach that sustains ≥ 15 s lead on real YouTube at ≥ 4 box-frames/s with the lower extra resource cost; if neither does, choose neither and record why (spec: ship live-only).
- [ ] **Step 4: Commit.**

---

### Task 9: Read-ahead implementation (skipped if Task 8 chose neither)

**Files:**
- Create: `src/subtitle/readAhead/readAheadSource.ts` (+ the chosen approach's module, e.g. `mseTap.ts` + `mseTap.main.ts` for (b) or `shadowPlayer.ts` for (a))
- Modify: `src/subtitle/subtitleMode.ts`, `manifest.json` (main-world content script if (b)), `webpack.config.js`
- Test: approach-specific unit tests in `src/subtitle/readAhead/__tests__/`, `e2e/tests/subtitle-readahead.spec.ts` (project `subtitles`)

**Interfaces:**
- `interface ReadAheadSource { start(onFrame: (crop: ImageBitmap, sig: Uint8Array, videoTime: number) => void): void; stop(): void; readonly lead: number /* seconds ahead of currentTime */ }`
- SubtitleMode runs a second LineTracker on read-ahead frames, OCRs with `tier: 'accurate'` (or the single engine), translates with `priority: 'readahead'` and next-line context, and writes to the same Timeline; at display time a line already on the timeline is shown at `line.start` with no OCR.

- [ ] **Step 1:** Write failing unit tests for the approach's pure parts (e.g. segment timestamp extraction / lead bookkeeping).
- [ ] **Step 2: Write failing E2E** `subtitle-readahead.spec.ts`: read-ahead on; play stretch `s2` uninterrupted from 0.

```ts
expect(readyBeforeShownRatio).toBeGreaterThanOrEqual(0.90); // lines whose timeline translation existed before currentTime reached line.start
expect(liveOcrCallsDuringSteadyPlayback).toBeLessThanOrEqual(0.10 * lines.length);
```

- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run (Chromium and `E2E_BROWSER=chrome`) → PASS; `subtitle-mode.spec.ts` still PASS with read-ahead off.
- [ ] **Step 6: Commit.**

---

### Task 10: Real-world runs, artifacts, docs

**Files:**
- Create: `e2e/tests/youtube-real.spec.ts` (new opt-in project `youtube`, installed Chrome only, test profile `e2e/.cache/profile-youtube`), `e2e/tests/subtitle-real-translation.spec.ts` (opt-in project `live`)
- Modify: `playwright.config.ts` (projects `subtitles`, `youtube`; `video: 'on'` for `youtube`), `package.json` (`e2e:youtube`, include `subtitles` in `test:e2e`), `README.md`, `docs/performance.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `e2e/.perf/subtitle-report.json` `{ run, browser, ocrCer, liveLatencyP50, liveLatencyP90, readAheadReadyRatio, translationTermHitRate?, screenshots: string[], video?: string }`.

- [ ] **Step 1: Write `subtitle-real-translation.spec.ts`** (real DeepL from `.env`, skipped without a key): stretch `s1` with read-ahead off; assert live p50 ≤ 0.7 s **including translation** and that ≥ 80% of lines whose `terms` is non-empty contain all their terms (case-insensitive).
- [ ] **Step 2: Write `youtube-real.spec.ts`:** open `https://www.youtube.com/watch?v=_zIrbXw-SVs&t=540`, wait out/skip pre-roll ads (`.ytp-ad-skip-button*` or until `.ad-showing` clears, max 60 s), draw the box via the popup flow, play 120 s; assert overlays appear for ≥ 90% of the `s2` lines in that window with OCR CER ≤ 0.15; record video + screenshots. If YouTube blocks playback (`.ytp-error`), fail with a clear message — do not fall back to the personal profile.
- [ ] **Step 3: Write opt-in `subtitle-judge.spec.ts`** (project `judge`, runs only with `E2E_JUDGE=1`): sends each `s1` line's displayed translation, Korean source and reference English to Claude through the Anthropic SDK (credentials from the developer's Fuelix gateway env), asking for a 0/1/2 score per line; writes the mean to the report (`translationJudgeScore`). Reports only — no threshold, since piece 2 owns engine quality.
- [ ] **Step 4:** Run `npm run test:e2e`, `npx playwright test --project=live`, `npm run e2e:youtube` → PASS; inspect the screenshots and recorded video.
- [ ] **Step 5:** Update `README.md` (accurate architecture, modes, setup, `npm run verify`, fixture script), `docs/performance.md` (OCR, live latency, read-ahead results, translation benchmark from recon), `CLAUDE.md` (new projects and gotchas found).
- [ ] **Step 6:** `npm run verify` → PASS. **Step 7: Commit.**
