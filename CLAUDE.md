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
- Projects: `ui` (fast, parallel), `captions` (real Whisper; persistent profile in
  `e2e/.cache/` so the model downloads once), `perf`, `live`.
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
