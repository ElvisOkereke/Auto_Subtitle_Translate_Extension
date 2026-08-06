# Client-Side STT + Cheap Translation API Redesign

Date: 2026-08-05
Status: Approved, ready for implementation planning

## Context

The extension currently sends captured tab audio to a self-hosted Whisper
backend (`SpeechToTextLLMServer/`) running `large-v3` on a GPU-backed GKE
cluster with Redis and nginx. This is expensive to keep running and adds real
ops burden for a project used by one developer and a few friends. The last
commit describes the prototype as "working but very slow," likely due in
part to the network round-trip to a remote model per audio chunk.

Separately, `background.ts`'s `AudioProcessor` calls `window.AudioContext`
directly inside the MV3 service worker. Service workers have no `window` or
DOM, so this code cannot actually run as written — audio capture/processing
needs a context that has one.

## Goals

- Transcription runs fully client-side (in the user's browser), eliminating
  the GPU backend and its cost/ops burden.
- Translation uses a cheap/free hosted API rather than a self-hosted service.
- Captioning feels near-instant, with the explicit exception that non-English
  audio may lag a bit more in exchange for materially better accuracy.
- Cheap and easy to run, for both the developer and users (currently: just
  the developer and friends).
- Fix the service-worker/`AudioContext` bug as part of this work, since the
  new architecture requires solving the same underlying problem anyway.

## Existing feature carried forward unchanged: Screen Translate

The extension has a second, separate translation feature independent of the
audio-captioning pipeline: "Screen Translate" (`popup.ts` /
`realTimeTranslate.ts`). The user toggles it, then either selects text or
drags a box on the page; the extension reads the DOM text at that location
(no OCR, no audio involved) and shows a translated overlay via
`TRANSLATE_SELECTED_TEXT` → `background.translateText()` →
`apiService.translateText()`.

This feature is **out of scope for changes** but must keep working: it
already calls the same `apiService.translateText()` method this redesign
repoints at the Google Cloud Translation API, so it is carried forward
automatically as part of the `apiService.ts` rework and requires no
dedicated implementation work of its own. It should be included in manual
verification (see Testing Approach) to confirm it still works once
`apiService.ts` no longer talks to the self-hosted backend.

## Non-goals (v1)

- Supporting more than one actively-captioning tab at a time.
- Keeping the self-hosted Whisper backend as a live fallback option.
- Publishing to the Chrome/Opera add-on stores (still "load unpacked" for
  now).

## Decisions

- **Site scope**: stays broad (`<all_urls>`, matching current manifest).
  Primary use case is YouTube/Twitch, but nothing narrows the extension to
  those sites specifically.
- **Languages**: multiple source/target language combinations must be
  supported (not just one fixed pair), since different friends want
  different pairs.
- **STT engine**: `@huggingface/transformers` (transformers.js) running the
  `Xenova/whisper-small` multilingual ONNX model. Chosen over a manual
  whisper.cpp/WASM build (more integration/build work, less mature WebGPU
  support in-browser) and over the native Web Speech API (a cloud
  round-trip to Google's servers, not actually local, and not designed for
  arbitrary `tabCapture` streams).
- **Accuracy vs. speed**: prioritize accuracy for non-English audio. Use the
  `small` multilingual model rather than `tiny`/`base`, accepting more
  latency on foreign-language audio in exchange for materially better
  transcription quality.
- **Acceleration**: prefer WebGPU execution, fall back to WASM automatically
  when WebGPU isn't available (`navigator.gpu` undefined). This keeps
  compatibility with any machine while getting a large speed win on the
  developer's and most friends' hardware.
- **Translation API**: Google Cloud Translation API. The developer already
  has a Google Cloud account/billing set up (from the GKE deployment), and
  the free tier (~500k characters/month) comfortably covers personal-scale
  caption usage.
- **API key handling**: the user's own API key, entered once in the
  extension's popup settings and stored via `chrome.storage.sync` — never
  committed to source or baked into the build. Each person who runs the
  extension (developer or friend) supplies their own key, so usage and
  quota are per-person rather than all funneling through one account.
- **Old backend disposition**: remove the extension's runtime dependency on
  the self-hosted Whisper backend entirely (delete the `whisperServiceUrl`
  setting and the transcription methods in `apiService.ts`). Leave
  `SpeechToTextLLMServer/` and its GKE/Docker deployment scripts untouched
  in the repo, unused, in case a self-hosted option is wanted again later.
  Stop running/paying for the GKE cluster.

## Architecture & Components

The core structural change: audio capture, VAD chunking, and model inference
move out of the service worker (which cannot host them) and into a Chrome
**offscreen document**, with model inference further isolated into a Web
Worker so it doesn't block message handling.

1. **`background.ts` (service worker)** — orchestration only. Handles
   start/stop messages from the popup, creates/tears down the offscreen
   document, requests the tab's audio stream ID via
   `chrome.tabCapture.getMediaStreamId()`, calls the translation API, and
   forwards finished captions to the content script. No audio or model code
   lives here anymore.

2. **`offscreen.ts` + `offscreen.html` (new)** — hidden document that
   receives the stream ID from background, opens the tab's `MediaStream` via
   `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', ... } } })`,
   runs an `AudioContext` and energy-based VAD (evolved from the existing
   `detectSpeech` logic) to segment speech into chunks aligned to pauses
   rather than fixed time-slices, resamples to 16kHz mono PCM, and posts
   segments to the Whisper worker.

3. **`whisper.worker.ts` (new)** — loads the `Xenova/whisper-small`
   transformers.js pipeline once (WebGPU execution provider preferred, WASM
   fallback), receives PCM segments, returns `{ text, detectedLanguage }`.

4. **`content.ts`** — unchanged: renders the subtitle overlay from
   `DISPLAY_SUBTITLE` messages.

5. **`apiService.ts`** — repurposed to a translation-only client: drop all
   transcription/`whisperServiceUrl` methods, keep a `translateText()` call
   against the Google Cloud Translation API using the stored user key, with
   the existing retry/backoff pattern.

6. **`manifest.json`** — needs an `"offscreen"` permission (new API surface
   not currently used), and a `host_permissions`/CSP allowance for wherever
   the model weights are fetched from (the transformers.js default model
   CDN) so the browser doesn't block the download.

## Data Flow

1. User clicks "Start Subtitles" in the popup → message to `background.ts`.
2. Background ensures the (singleton) offscreen document exists.
3. Background gets a tab audio stream ID via
   `chrome.tabCapture.getMediaStreamId({ targetTabId })` and sends it to the
   offscreen document.
4. Offscreen document opens the stream, runs VAD-based chunking to slice
   speech into segments (skipping silence, avoiding mid-word cuts).
5. Each segment is posted to `whisper.worker.ts`, which returns
   `{ text, detectedLanguage }`.
6. Offscreen document forwards the result to `background.ts`.
7. Background compares detected source language to the user's target
   language setting: if they match, skip translation; otherwise call the
   Google Cloud Translation API with the stored key.
8. Background sends `DISPLAY_SUBTITLE` (final text + language) to the
   content script in the original tab, which renders it via the existing
   overlay.

Known consequence: because chunking waits for natural pauses rather than a
fixed interval, caption latency varies with speaking cadence. This is an
accepted trade-off for word-boundary correctness over perfectly uniform
timing.

## Error Handling & Scope Limits

- **Model loading**: first run downloads the quantized `whisper-small`
  model (a few hundred MB); the browser caches it afterward (Cache Storage)
  so this only happens once. Popup shows a "Loading model... (first time
  only)" indicator during download, and a clear error if it fails (e.g.
  offline) rather than doing nothing silently.
- **WebGPU fallback**: detected at worker startup; if unavailable, WASM is
  used automatically and the popup shows a "running in CPU mode, may be
  slower" note so degraded performance isn't a silent mystery.
- **Single active tab (v1)**: only one offscreen document exists at a time,
  so only one tab can be actively captioned at once. Starting capture on a
  second tab while one is active stops the first (or is clearly rejected) —
  not a silent failure. Multi-tab concurrency is explicitly out of scope.
- **Offscreen/worker teardown**: capture stopping, or the captioned tab
  closing/navigating, tears down the offscreen document and worker so the
  loaded model doesn't stay resident in memory indefinitely. This extends
  the existing `handleTabUpdate`/`handleTabRemoved` cleanup in
  `background.ts`.
- **Translation failures**: existing retry-with-backoff stays. On exhausted
  retries (bad key, quota exceeded, network down), fall back to displaying
  the untranslated transcript with a small indicator rather than showing
  nothing.
- **Missing API key**: if source ≠ target language and no key is configured,
  show a one-time popup prompt to add one, rather than failing silently on
  every chunk.

## Testing Approach

**Unit tests** (bundled with fixing the existing broken `jest-environment-jsdom`
setup, since it's already broken and this work touches adjacent code):
- VAD/chunking logic against synthetic audio buffers — verify segment
  boundaries land on silence, not mid-speech.
- `apiService.translateText()` against a mocked `fetch` — success, retry
  backoff, exhausted-retry fallback path.
- Settings management — defaults, and migration away from the removed
  `whisperServiceUrl` key.

**Not realistically unit-testable**: real WASM/WebGPU model loading and
inference, real `tabCapture`/`getUserMedia` behavior, offscreen document
lifecycle. These are manual-verification territory.

**Manual verification checklist** (in Opera GX, the actual target browser):
- Load unpacked, open a non-English YouTube/Twitch stream, start captions,
  confirm near-real-time and reasonably accurate output.
- Confirm translated output matches the target language setting; toggle
  target language mid-session.
- Stop captions / close tab / navigate away — confirm the offscreen document
  and worker actually tear down, not just that captions stop visually.
- Start capture on a second tab while one is already active — confirm the
  defined behavior (stop first, or clear rejection), not a silent crash.
- No API key configured + foreign-language audio — confirm the one-time
  prompt appears instead of failing silently per chunk.
- Invalid/expired API key — confirm fallback to untranslated transcript with
  the indicator, not a blank screen.
- No WebGPU (disable via `chrome://flags` or test on older hardware) —
  confirm WASM fallback still produces captions, slower, with the CPU-mode
  note visible.
- Screen Translate (existing, unrelated feature): toggle it, select text or
  drag a box on a page, confirm the translated overlay still appears now
  that `apiService.ts` talks to Google Translate instead of the old
  self-hosted backend.
