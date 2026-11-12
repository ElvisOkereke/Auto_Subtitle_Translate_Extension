# Auto Subtitle Translator — working notes

Chrome MV3 extension: live captions for tab audio (tabCapture → offscreen VAD →
Whisper via transformers.js in a worker → DeepL/Google translation → on-page
overlay) plus "Screen Translate" (drag a box over page text → translated overlay).

## Definition of done

Work is done only when `npm run verify` passes. It runs:

| step | command | what it covers |
|---|---|---|
| types | `npm run type-check` | `tsc --noEmit` |
| lint | `npm run lint` | 0 errors required (warnings are `any`s) |
| unit | `npm test` | jest + jsdom, `src/**/__tests__` |
| e2e | `npm run test:e2e` | builds `dist/`, then Playwright drives real Chromium with the extension loaded |
| live | `playwright test --project=live` | real DeepL API using `DEEPL_API_KEY` from `.env` (skips if unset) |

Never hand a "manual smoke test" back to the user — add or extend an E2E test instead.
Look at screenshots the E2E tests write (`test.info().outputPath(...)`) when changing UI.

## E2E harness (`e2e/`)

- `helpers/extension.ts` — Playwright fixtures. Each test gets a fresh Chromium
  profile with `dist/` loaded. Key fixtures: `openPopup(page)` (opens
  `popup.html?tabId=N`, bound to that tab), `configure(settings)`
  (writes `chrome.storage.sync`), `translationCalls` (requests seen by the
  mock APIs), `fixtureURL`.
- `--allowlisted-extension-id` lets `chrome.tabCapture` work without a real
  toolbar click, so the caption pipeline is fully automatable.
- Translation APIs are mocked by the local fixture server (`/mock/deepl`,
  `/mock/google`); the extension is pointed there through
  `chrome.storage.local.devEndpointOverrides` (loopback URLs only — see
  `apiService.ts`). Playwright's `context.route` does NOT reliably intercept
  extension service-worker fetches; don't go back to it.
- Projects: `ui` (fast, parallel), `captions` (real Whisper), `subtitles` (real
  OCR; subtitle mode live path, overlay, read-ahead) — both with persistent
  profiles in `e2e/.cache/` so models download once — `perf` (benchmarks,
  spikes), `live` (real DeepL), `youtube` (real YouTube, opt-in), `judge`
  (Claude scoring, opt-in, `E2E_JUDGE=1`).
- Subtitle-mode internals are reached through the content-script test bridge
  (`src/subtitle/testBridge.ts`, `e2e/helpers/bridge.ts`), enabled only by
  `chrome.storage.local.devExposeInternals` (the harness sets it).
- Video fixtures: `npm run fixtures:video` (yt-dlp + ffmpeg in `e2e/.cache/venv`);
  ground truth in `e2e/fixtures/subtitles/_zIrbXw-SVs.timeline.json`.
- `E2E_PRINT_LOGS=1` prints page/console logs for failing tests; `HEADED=1` shows the browser.
- Audio fixtures come from Windows TTS: `npm run audio:fixtures`.
- `npm run build` wipes and rebuilds `dist/` — don't rebuild while a Playwright run is using it.
- Playwright wipes `e2e/.results/` at the start of every run; keep anything durable elsewhere.

## Performance

`npm run perf:stt` benchmarks Whisper model/device/precision choices
(results in `e2e/.perf/`, summary in `docs/performance.md`). Model defaults
live in `src/utils/modelConfig.ts`.

## Gotchas learned the hard way

- `chrome.runtime.onMessage` listeners must `return true` and call
  `sendResponse` for async replies; an `async` listener returns a Promise and the
  caller gets `undefined`.
- `chrome.runtime.sendMessage` from a content script never reaches other
  content scripts — only extension pages / the service worker.
- The Whisper worker is built by a separate webpack compiler with
  `target: 'webworker'`; ONNX Runtime files are copied to `dist/ort/` and loaded
  from the extension origin (extension CSP blocks the CDN default).
- MV3 service worker state is lost after ~30s idle — persist anything the caption
  pipeline needs in `chrome.storage.session`.
- Do NOT add `cross_origin_embedder_policy` / COOP to the manifest. It would
  enable multithreaded wasm (CPU Whisper ~2.4x faster, measured), but any COEP
  value (`require-corp` or `credentialless`) makes the tab-capture
  `getUserMedia` in the offscreen document fail ("Error starting tab capture"),
  and COEP applies to every extension page, so capture and inference can't be split.
- Playwright adds `--mute-audio` to headless launches; a muted tab captures as
  silence. `launch.ts` removes it via `ignoreDefaultArgs`.
- transformers.js caches the first `InferenceSession.create` promise per worker:
  after a failed WebGPU load every later load in that worker fails too. Recovery
  = new worker with `device: 'wasm'` (offscreen.ts `restartWorkerOnCpu`).
- Playwright's Chromium on Windows lacks the D3D12 shader compiler, so WebGPU
  device creation fails there (exercises the CPU fallback). Use
  `E2E_BROWSER=chrome` to run against installed Google Chrome (real WebGPU).
- Persistent test profiles keep running a cached service-worker script until
  the extension version changes: global setup bumps `dist/manifest.json` to
  `<base>.<run>` every run; Chrome mode also deletes
  `Default/Service Worker/{Database,ScriptCache}` before launch. Never use
  `chrome.runtime.reload()` for this (it disabled the command-line extension).
- Content scripts' IndexedDB/localStorage belong to the *website's* origin.
  Anything the site mustn't read lives in the extension origin (subtitle
  timelines are served by the OCR iframe).
- `ocr-frame.html` is web-accessible: the frame only accepts a port that comes
  with a nonce sent via `chrome.runtime.sendMessage` from our content script in
  the same tab.
- ONNX Runtime sessions can't run concurrently ("Session already started"): the
  OCR worker serializes requests; only session-creation failures mean "GPU unusable".
- Read-ahead frames come from the page's main world via `window.postMessage`
  (the page can forge them): `readAheadSource.ts` bounds them to the buffered
  range and one per 1/8 s slot.
- YouTube stops automated playback after ~40 s in every automated Chrome tried;
  the `youtube` project evaluates what played and fails with that message.
- Playwright's Chromium lacks H.264/AAC; fixtures use VP9/Opus. MSE fixtures
  need one SourceBuffer per track and per-SourceBuffer buffer throttling.
