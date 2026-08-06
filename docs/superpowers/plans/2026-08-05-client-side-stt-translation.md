# Client-Side STT + Cheap Translation API Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the self-hosted GPU Whisper backend with fully client-side transcription (transformers.js + `Xenova/whisper-small`, running in a new Chrome offscreen document + Web Worker) and replace the translation backend with the Google Cloud Translation API, while fixing the pre-existing `window.AudioContext`-in-service-worker bug and preserving the unrelated "Screen Translate" feature unchanged.

**Architecture:** `background.ts` becomes orchestration-only: it owns a single active-tab captioning session, creates/tears down a Chrome offscreen document, and calls the Google Translate API. The offscreen document (`offscreen.ts`) owns the `AudioContext`/`getUserMedia` tab-audio pipeline and VAD-based speech segmentation, handing off finished PCM segments to `whisper.worker.ts`, which loads the Whisper model once (WebGPU preferred, WASM fallback) and returns transcribed text. `content.ts` only renders whatever final (possibly already-translated) text `background.ts` sends it — no more independent re-translation.

**Tech Stack:** TypeScript, Webpack 5, `@huggingface/transformers` (transformers.js v3), Chrome Manifest V3 (`offscreen`, `tabCapture`, `storage` APIs), Google Cloud Translation API v2 (REST), Jest + `ts-jest` + `jest-environment-jsdom`.

## Global Constraints

- Each user (developer or friend) supplies their own Google Translate API key, entered in the popup and stored via `chrome.storage.sync` — never committed to source or baked into the build.
- Transcription must run fully client-side; no audio or transcript ever leaves the browser except the (already-transcribed) text sent to Google's Translation API when source ≠ target language.
- Only one tab can actively caption at a time (v1 limitation) — starting capture on a new tab stops any existing session first, never silently.
- `SpeechToTextLLMServer/` is left completely untouched in the repo; nothing in `src/` may import from or reference it after this work.
- The "Screen Translate" feature (`realTimeTranslate.ts`, ROI/text-selection UI) must keep working unmodified — it depends only on `apiService.translateText()`, whose external contract (`Promise<{ translatedText: string; ... }>` shape used via `background.ts`'s `translateText()` handler) must not change in a way that breaks it.
- Prefer WebGPU (`navigator.gpu`), fall back to WASM automatically — never hard-fail because WebGPU is unavailable.
- `npm test`, `npm run type-check`, and `npm run build:dev` must all pass by the end of this plan.

---

## File Structure

**New files:**
- `src/utils/vad.ts` — pure, unit-testable voice-activity-detection/segmentation logic (no DOM/Web Audio dependency).
- `src/utils/__tests__/vad.test.ts` — unit tests for the above.
- `src/services/__tests__/apiService.test.ts` — unit tests for the Google Translate client, with `fetch` mocked.
- `src/test/setup.ts` — the Jest `setupFilesAfterEnv` file `jest.config.js` already references but that doesn't exist yet.
- `src/utils/__tests__/sanity.test.ts` — trivial smoke test proving the Jest/jsdom environment actually runs.
- `src/whisper.worker.ts` — Web Worker that loads the Whisper pipeline and transcribes PCM segments.
- `offscreen.html` — hidden document shell that loads `offscreen.js`.
- `src/offscreen.ts` — owns `AudioContext`/`getUserMedia`/VAD segmentation and the Whisper worker.

**Modified files:**
- `src/services/apiService.ts` — rewritten as a Google Translate-only client (drops all whisper-backend methods).
- `src/types/index.ts` — new message types for the offscreen/worker pipeline and caption status/error notices; `ExtensionSettings` gets `googleTranslateApiKey`; `PROCESS_AUDIO` removed (confirmed dead code).
- `src/background.ts` — rewritten as pure orchestration (offscreen lifecycle, translation, single-active-tab enforcement).
- `src/content.ts` — dead audio code removed; no more independent re-translation; renders `CAPTION_ERROR`/`CAPTION_STATUS` notices.
- `popup.html` / `src/popup.ts` — `whisperServiceUrl` input replaced with a `googleTranslateApiKey` input; whisper health-check UI removed.
- `manifest.json` — adds `"offscreen"` permission and a `content_security_policy` allowing `'wasm-unsafe-eval'` (required for the WASM Whisper fallback).
- `package.json` — adds `@huggingface/transformers` (runtime) and `jest-environment-jsdom` (dev); removes unused `dotenv`.
- `webpack.config.js` — adds `offscreen` and `whisper.worker` entries, copies `offscreen.html`, removes the now-unused `WHISPER_SERVICE_URL` `DefinePlugin`/`dotenv` wiring, disables `splitChunks` (see Task 9 for why).

**Deleted files:**
- `src/config.ts` — its only remaining purpose (whisper endpoints/audio config) disappears once `apiService.ts` and `audioProcessor.ts` no longer need it.
- `src/utils/audioProcessor.ts` — superseded by `offscreen.ts` + `vad.ts`; this is also where the `window.AudioContext`-in-service-worker bug lived.

---

### Task 1: Fix the broken Jest/jsdom test setup

**Files:**
- Modify: `package.json`
- Create: `src/test/setup.ts`
- Create: `src/utils/__tests__/sanity.test.ts`

**Interfaces:**
- Produces: a working `npm test` command that later tasks' unit tests can rely on.

- [ ] **Step 1: Confirm the current failure**

Run: `npm test`
Expected: FAIL with `Test environment jest-environment-jsdom cannot be found`.

- [ ] **Step 2: Add the missing dependency**

In `package.json`, add to `devDependencies` (alphabetical, next to `jest`):

```json
"jest-environment-jsdom": "^29.7.0",
```

Run: `npm install`

- [ ] **Step 3: Run tests again, confirm the next failure**

Run: `npm test`
Expected: FAIL with something like `Cannot find module '<rootDir>/src/test/setup.ts' from 'jest.config.js'` (the `setupFilesAfterEnv` target still doesn't exist).

- [ ] **Step 4: Create the missing setup file**

Create `src/test/setup.ts`:

```ts
// Jest setupFilesAfterEnv target — required by jest.config.js's testEnvironment: 'jsdom'.
export {};
```

- [ ] **Step 5: Run tests again, confirm "no tests found"**

Run: `npm test`
Expected: FAIL with `No tests found` (the config is now valid, but there are zero test files anywhere in `src/`).

- [ ] **Step 6: Write a smoke test**

Create `src/utils/__tests__/sanity.test.ts`:

```ts
describe('jest environment', () => {
  it('runs in a jsdom environment with window and document available', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });
});
```

- [ ] **Step 7: Run tests, confirm pass**

Run: `npm test`
Expected: PASS (1 test suite, 1 test).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/test/setup.ts src/utils/__tests__/sanity.test.ts
git commit -m "fix: install jest-environment-jsdom and add missing test setup file"
```

---

### Task 2: Extract pure VAD/speech-segmentation logic

**Files:**
- Create: `src/utils/vad.ts`
- Test: `src/utils/__tests__/vad.test.ts`

**Interfaces:**
- Produces: `VadConfig` interface, `DEFAULT_VAD_CONFIG` constant, `computeRmsAmplitude(samples: Float32Array): number`, `isSpeech(samples: Float32Array, config?: VadConfig): boolean`, and class `SpeechSegmenter` with constructor `(frameDurationMs: number, config?: VadConfig)` and method `pushFrame(frame: Float32Array): Float32Array | null` (returns a completed segment when a boundary is reached, else `null`).
- Consumed by: `src/offscreen.ts` (Task 6).

- [ ] **Step 1: Write the failing tests**

Create `src/utils/__tests__/vad.test.ts`:

```ts
import { computeRmsAmplitude, isSpeech, SpeechSegmenter, DEFAULT_VAD_CONFIG, VadConfig } from '../vad';

function makeFrame(amplitude: number, length = 10): Float32Array {
  return new Float32Array(length).fill(amplitude);
}

describe('computeRmsAmplitude', () => {
  it('returns the RMS of the samples', () => {
    const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    expect(computeRmsAmplitude(samples)).toBeCloseTo(0.5);
  });
});

describe('isSpeech', () => {
  it('is true above the threshold and false below it', () => {
    const config: VadConfig = { ...DEFAULT_VAD_CONFIG, silenceThreshold: 0.05 };
    expect(isSpeech(makeFrame(0.1), config)).toBe(true);
    expect(isSpeech(makeFrame(0.01), config)).toBe(false);
  });
});

describe('SpeechSegmenter', () => {
  it('emits a segment once silence persists past the hangover', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 200,
      maxSegmentDurationMs: 5000,
      silenceHangoverMs: 300
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    const segment = segmenter.pushFrame(makeFrame(0.01));

    expect(segment).not.toBeNull();
    expect(segment!.length).toBe(50); // 5 buffered frames of length 10
  });

  it('discards blips shorter than minSpeechDurationMs', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 300,
      maxSegmentDurationMs: 5000,
      silenceHangoverMs: 200
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.01))).toBeNull();
    const result = segmenter.pushFrame(makeFrame(0.01));

    expect(result).toBeNull();
  });

  it('forces a cut when continuous speech exceeds maxSegmentDurationMs', () => {
    const config: VadConfig = {
      silenceThreshold: 0.05,
      minSpeechDurationMs: 100,
      maxSegmentDurationMs: 300,
      silenceHangoverMs: 500
    };
    const segmenter = new SpeechSegmenter(100, config);

    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.2))).toBeNull();
    const segment = segmenter.pushFrame(makeFrame(0.2));

    expect(segment).not.toBeNull();
    expect(segment!.length).toBe(30);
  });

  it('ignores leading silence before any speech has started', () => {
    const segmenter = new SpeechSegmenter(100, DEFAULT_VAD_CONFIG);
    expect(segmenter.pushFrame(makeFrame(0.001))).toBeNull();
    expect(segmenter.pushFrame(makeFrame(0.001))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/utils/__tests__/vad.test.ts`
Expected: FAIL with "Cannot find module '../vad'".

- [ ] **Step 3: Implement `src/utils/vad.ts`**

```ts
// vad.ts - Pure energy-based voice-activity detection and speech segmentation.
// No DOM/Web Audio dependency so this is directly unit-testable.

export interface VadConfig {
  silenceThreshold: number;
  minSpeechDurationMs: number;
  maxSegmentDurationMs: number;
  silenceHangoverMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  silenceThreshold: 0.01,
  minSpeechDurationMs: 250,
  maxSegmentDurationMs: 8000,
  silenceHangoverMs: 400
};

export function computeRmsAmplitude(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function isSpeech(samples: Float32Array, config: VadConfig = DEFAULT_VAD_CONFIG): boolean {
  return computeRmsAmplitude(samples) > config.silenceThreshold;
}

/**
 * Buffers incoming fixed-size audio frames and emits a merged segment once a
 * natural pause (or a max-duration safety cut) is reached, so transcription
 * happens on word/sentence boundaries instead of arbitrary time-slices.
 */
export class SpeechSegmenter {
  private buffer: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;

  constructor(private frameDurationMs: number, private config: VadConfig = DEFAULT_VAD_CONFIG) {}

  pushFrame(frame: Float32Array): Float32Array | null {
    const speech = isSpeech(frame, this.config);

    if (speech) {
      this.buffer.push(frame);
      this.speechMs += this.frameDurationMs;
      this.silenceMs = 0;

      if (this.speechMs >= this.config.maxSegmentDurationMs) {
        return this.flush();
      }
      return null;
    }

    if (this.buffer.length === 0) {
      return null; // leading silence, nothing buffered yet
    }

    this.buffer.push(frame); // keep trailing silence so words aren't clipped
    this.silenceMs += this.frameDurationMs;

    if (this.silenceMs >= this.config.silenceHangoverMs) {
      if (this.speechMs >= this.config.minSpeechDurationMs) {
        return this.flush();
      }
      this.reset(); // too short to count as real speech - discard
      return null;
    }

    return null;
  }

  private reset(): void {
    this.buffer = [];
    this.speechMs = 0;
    this.silenceMs = 0;
  }

  private flush(): Float32Array {
    const totalLength = this.buffer.reduce((sum, f) => sum + f.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const frame of this.buffer) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    this.reset();
    return merged;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/utils/__tests__/vad.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/vad.ts src/utils/__tests__/vad.test.ts
git commit -m "feat: add pure VAD/speech-segmentation utility with unit tests"
```

---

### Task 3: Rewrite `apiService.ts` as a Google Translate client

**Files:**
- Modify: `src/services/apiService.ts` (full rewrite)
- Test: `src/services/__tests__/apiService.test.ts`

**Interfaces:**
- Consumes: `APIError` from `src/types/index.ts` (already exists, unchanged).
- Produces: `export interface TranslationResult { translatedText: string; detectedSourceLanguage?: string }`, `export class ApiService { translateText(text: string, sourceLanguage: string, targetLanguage: string): Promise<TranslationResult> }`, `export const apiService: ApiService`.
- This is the same `apiService.translateText()` entry point `background.ts` (Task 7) and `realTimeTranslate.ts` (Screen Translate, unmodified) already call — the call signature (3 string args) is unchanged from the current implementation, only the return shape's field name changes from `translated_text` to `translatedText`, and the implementation now talks to Google instead of the whisper backend.

- [ ] **Step 1: Write the failing tests**

Create `src/services/__tests__/apiService.test.ts`:

```ts
import { ApiService } from '../apiService';
import { APIError } from '../../types';

describe('ApiService.translateText', () => {
  let apiService: ApiService;

  beforeEach(() => {
    apiService = new ApiService();
    (global as any).chrome = {
      storage: {
        sync: {
          get: jest.fn().mockResolvedValue({ googleTranslateApiKey: 'test-key' })
        }
      }
    };
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns the translated text on a successful request', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { translations: [{ translatedText: 'Hola', detectedSourceLanguage: 'en' }] }
      })
    });

    const result = await apiService.translateText('Hello', 'en', 'es');

    expect(result).toEqual({ translatedText: 'Hola', detectedSourceLanguage: 'en' });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('translation.googleapis.com');
    expect(url).toContain('key=test-key');
    expect(JSON.parse(init.body)).toEqual({ q: 'Hello', target: 'es', format: 'text', source: 'en' });
  });

  it('omits the source field when sourceLanguage is "auto"', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { translations: [{ translatedText: 'Hola' }] } })
    });

    await apiService.translateText('Hello', 'auto', 'es');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ q: 'Hello', target: 'es', format: 'text' });
  });

  it('retries on failure with exponential backoff, then succeeds', async () => {
    jest.useFakeTimers();
    const fetchMock = global.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { translations: [{ translatedText: 'Hola' }] } })
      });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.translatedText).toBe('Hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws an APIError after exhausting retries', async () => {
    jest.useFakeTimers();
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    resultPromise.catch(() => {});
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(4000);

    await expect(resultPromise).rejects.toThrow(APIError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it('throws an APIError without calling fetch when no API key is configured', async () => {
    (global as any).chrome.storage.sync.get = jest.fn().mockResolvedValue({});

    await expect(apiService.translateText('Hello', 'en', 'es')).rejects.toThrow(APIError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/services/__tests__/apiService.test.ts`
Expected: FAIL (current `apiService.ts` has a different shape — `translated_text` not `translatedText`, requires `config.whisperServiceUrl`, etc.).

- [ ] **Step 3: Replace `src/services/apiService.ts` entirely**

```ts
// apiService.ts - Client for the Google Cloud Translation API
import { APIError } from '../types';

const TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

export class ApiService {
  private async getApiKey(): Promise<string> {
    const { googleTranslateApiKey } = await chrome.storage.sync.get(['googleTranslateApiKey']);
    if (!googleTranslateApiKey) {
      throw new APIError('No Google Translate API key configured', 401);
    }
    return googleTranslateApiKey;
  }

  async translateText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const apiKey = await this.getApiKey();
    const body: Record<string, string> = { q: text, target: targetLanguage, format: 'text' };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source = sourceLanguage;
    }

    return this.retryRequest(() => this.executeTranslate(apiKey, body));
  }

  private async executeTranslate(
    apiKey: string,
    body: Record<string, string>
  ): Promise<TranslationResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(`Translation request failed: ${response.status}`, response.status, errorText);
      }

      const json = await response.json();
      const translation = json?.data?.translations?.[0];
      if (!translation) {
        throw new APIError('Malformed translation response', 500, json);
      }

      return {
        translatedText: translation.translatedText,
        detectedSourceLanguage: translation.detectedSourceLanguage
      };
    } catch (error) {
      if (error instanceof APIError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new APIError('Translation request timeout', 408);
      }
      throw new APIError('Network error', 0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async retryRequest<T>(requestFn: () => Promise<T>, maxRetries = MAX_RETRIES): Promise<T> {
    let lastError!: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error as Error;
        if (attempt === maxRetries) break;
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

export const apiService = new ApiService();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/services/__tests__/apiService.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/apiService.ts src/services/__tests__/apiService.test.ts
git commit -m "feat: repurpose apiService.ts as a Google Cloud Translation API client"
```

---

### Task 4: Replace `whisperServiceUrl` with a Google Translate API key setting

**Files:**
- Modify: `src/types/index.ts:105-111` (`ExtensionSettings`)
- Modify: `popup.html:215-218`
- Modify: `src/popup.ts` (full rewrite)

**Interfaces:**
- Produces: `ExtensionSettings.googleTranslateApiKey: string`, and a `#googleTranslateApiKey` password input in `popup.html` that `popup.ts` reads/writes via `chrome.storage.sync`.
- Consumes: nothing new (still uses `chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', ... })`, unchanged message contract with `background.ts`).

- [ ] **Step 1: Update `ExtensionSettings` in `src/types/index.ts`**

Replace lines 105-111:

```ts
export interface ExtensionSettings {
  sourceLanguage: string;
  targetLanguage: string;
  subtitleStyle: SubtitlePosition;
  fontSize: FontSize;
  enabled: boolean;
  googleTranslateApiKey: string;
}
```

- [ ] **Step 2: Replace the settings input in `popup.html`**

Replace lines 215-218:

```html
        <div class="setting-group">
            <label for="googleTranslateApiKey">Google Translate API Key:</label>
            <input type="password" id="googleTranslateApiKey" placeholder="Paste your API key">
        </div>
```

- [ ] **Step 3: Replace `src/popup.ts` entirely**

The whisper `validateConnection()` health-check is removed outright (there's no service to health-check anymore); a missing/invalid key is instead handled at translation time by `background.ts` (Task 7), which falls back to untranslated captions with a one-time on-page notice. Transcription itself needs no key, so nothing should block starting captions.

```ts
// popup.ts - Popup interface logic

import { ExtensionSettings } from './types';

interface PopupElements {
  toggleButton: HTMLButtonElement;
  screenTranslateButton: HTMLButtonElement;
  status: HTMLDivElement;
  sourceLanguage: HTMLSelectElement;
  targetLanguage: HTMLSelectElement;
  subtitleStyle: HTMLSelectElement;
  fontSize: HTMLSelectElement;
  googleTranslateApiKey: HTMLInputElement;
}

class PopupController {
  private isActive: boolean;
  private isScreenTranslating: boolean;
  private elements: PopupElements;

  constructor() {
    this.isActive = false;
    this.isScreenTranslating = false;
    this.elements = {} as PopupElements;
    this.initializeElements();
    this.loadSettings();
    this.setupEventListeners();
  }

  initializeElements() {
    const toggleButton = document.getElementById('toggleButton') as HTMLButtonElement | null;
    const screenTranslateButton = document.getElementById('screenTranslateButton') as HTMLButtonElement | null;
    const status = document.getElementById('status') as HTMLDivElement | null;
    const sourceLanguage = document.getElementById('sourceLanguage') as HTMLSelectElement | null;
    const targetLanguage = document.getElementById('targetLanguage') as HTMLSelectElement | null;
    const subtitleStyle = document.getElementById('subtitleStyle') as HTMLSelectElement | null;
    const fontSize = document.getElementById('fontSize') as HTMLSelectElement | null;
    const googleTranslateApiKey = document.getElementById('googleTranslateApiKey') as HTMLInputElement | null;

    if (
      !toggleButton ||
      !screenTranslateButton ||
      !status ||
      !sourceLanguage ||
      !targetLanguage ||
      !subtitleStyle ||
      !fontSize ||
      !googleTranslateApiKey
    ) {
      throw new Error('One or more popup elements not found in the DOM.');
    }

    this.elements = {
      toggleButton,
      screenTranslateButton,
      status,
      sourceLanguage,
      targetLanguage,
      subtitleStyle,
      fontSize,
      googleTranslateApiKey
    };
  }

  setupEventListeners() {
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    this.elements.screenTranslateButton.addEventListener('click', () => {
      this.toggleScreenTranslation();
    });

    Object.keys(this.elements).forEach(key => {
      if (key !== 'toggleButton' && key !== 'screenTranslateButton' && key !== 'status') {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }

  async loadSettings() {
    try {
      const defaultSettings: ExtensionSettings = {
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        subtitleStyle: 'bottom',
        fontSize: 'medium',
        googleTranslateApiKey: '',
        enabled: false
      };

      const settings = await chrome.storage.sync.get(defaultSettings);

      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.googleTranslateApiKey.value = settings.googleTranslateApiKey;

      this.isActive = settings.enabled;
      this.updateToggleButton();

      this.showStatus('Ready to start subtitles', 'success');
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.showStatus('Failed to load settings', 'error');
      this.setDefaultValues();
    }
  }

  private setDefaultValues() {
    this.elements.sourceLanguage.value = 'auto';
    this.elements.targetLanguage.value = 'en';
    this.elements.subtitleStyle.value = 'bottom';
    this.elements.fontSize.value = 'medium';
    this.elements.googleTranslateApiKey.value = '';
    this.isActive = false;
    this.updateToggleButton();
  }

  async saveSettings() {
    try {
      const settings = {
        sourceLanguage: this.elements.sourceLanguage.value,
        targetLanguage: this.elements.targetLanguage.value,
        subtitleStyle: this.elements.subtitleStyle.value,
        fontSize: this.elements.fontSize.value,
        googleTranslateApiKey: this.elements.googleTranslateApiKey.value,
        enabled: this.isActive
      };

      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: settings
      });

      this.showStatus('Settings saved', 'success');
    } catch (error) {
      console.error('Failed to save settings:', error);
      this.showStatus('Failed to save settings', 'error');
    }
  }

  async toggleSubtitles() {
    try {
      this.isActive = !this.isActive;
      this.updateToggleButton();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SUBTITLES'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      await this.saveSettings();

      this.showStatus(
        this.isActive ? 'Subtitles activated' : 'Subtitles deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle subtitles:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle subtitles: ' + errorMsg, 'error');
      this.isActive = !this.isActive;
      this.updateToggleButton();
    }
  }

  async toggleScreenTranslation() {
    try {
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        throw new Error('No active tab found');
      }

      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SCREEN_TRANSLATION'
        });
      } else {
        throw new Error('Active tab does not have a valid id');
      }

      this.showStatus(
        this.isScreenTranslating ? 'Screen translation activated' : 'Screen translation deactivated',
        'success'
      );

    } catch (error) {
      console.error('Failed to toggle screen translation:', error);
      const errorMsg = (error && typeof error === 'object' && 'message' in error)
        ? (error as Error).message
        : String(error);
      this.showStatus('Failed to toggle screen translation: ' + errorMsg, 'error');
      this.isScreenTranslating = !this.isScreenTranslating;
      this.updateScreenTranslateButton();
    }
  }

  updateToggleButton() {
    const button = this.elements.toggleButton;

    if (this.isActive) {
      button.textContent = 'Stop Subtitles';
      button.classList.add('active');
    } else {
      button.textContent = 'Start Subtitles';
      button.classList.remove('active');
    }
  }

  updateScreenTranslateButton() {
    const button = this.elements.screenTranslateButton;

    if (this.isScreenTranslating) {
      button.textContent = 'Stop Translation';
      button.classList.add('active');
      button.style.background = '#e53e3e';
    } else {
      button.textContent = 'Screen Translate';
      button.classList.remove('active');
      button.style.background = '#38a169';
    }
  }

  showStatus(message: string, type = 'success') {
    const statusElement = this.elements.status;

    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.classList.remove('hidden');

    setTimeout(() => {
      statusElement.classList.add('hidden');
    }, 3000);
  }

  async checkPermissions() {
    try {
      const hasPermissions = await chrome.permissions.contains({
        permissions: ['tabCapture'],
        origins: ['<all_urls>']
      });

      if (!hasPermissions) {
        this.showStatus('Missing required permissions', 'warning');
        return false;
      }

      return true;
    } catch (error) {
      console.error('Permission check failed:', error);
      return false;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
```

- [ ] **Step 4: Verify types compile**

Run: `npm run type-check`
Expected: PASS. (`background.ts` and `config.ts` still reference the old `whisperServiceUrl`-based `ExtensionSettings` shape loosely via untyped `chrome.storage.sync.get` calls, so this shouldn't break yet — they get rewritten in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts popup.html src/popup.ts
git commit -m "feat: replace whisperServiceUrl setting with a Google Translate API key field"
```

---

### Task 5: Add transformers.js and implement the Whisper worker

**Files:**
- Modify: `package.json` (add `dependencies` section)
- Modify: `manifest.json` (CSP for WASM)
- Create: `src/whisper.worker.ts`

**Interfaces:**
- Produces: a worker script (built by webpack in Task 9 to `whisper.worker.js`) that accepts `postMessage({ type: 'load' })` and `postMessage({ type: 'transcribe', audio: Float32Array, language: string })`, and emits `postMessage({ type: 'progress', status: 'downloading' | 'cpu-fallback' | 'ready' })`, `postMessage({ type: 'result', text: string })`, `postMessage({ type: 'error', message: string })`.
- Consumed by: `src/offscreen.ts` (Task 6).

- [ ] **Step 1: Add the runtime dependency**

In `package.json`, add a `dependencies` block after `"description"` (before `"scripts"`):

```json
  "dependencies": {
    "@huggingface/transformers": "^3.0.0"
  },
```

Run: `npm install`

- [ ] **Step 2: Allow WASM compilation in extension pages**

Chrome MV3 blocks `WebAssembly.instantiate` in extension pages unless the CSP explicitly allows it — required for the WASM fallback path (`onnxruntime-web`). In `manifest.json`, add this key after `"host_permissions"` (before `"background"`):

```json
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
```

- [ ] **Step 3: Implement `src/whisper.worker.ts`**

No automated test: model loading/inference requires a real browser WASM/WebGPU runtime and a multi-hundred-MB model download, which the spec's Testing Approach explicitly calls out as manual-verification territory (Task 10 covers this).

```ts
// whisper.worker.ts - Loads the Whisper model off the main thread and transcribes PCM segments.
import { pipeline } from '@huggingface/transformers';

const ctx = self as unknown as Worker;

let transcriberPromise: Promise<any> | null = null;

function hasWebGpu(): boolean {
  return typeof (self as any).navigator !== 'undefined' && !!(self as any).navigator.gpu;
}

async function getTranscriber(): Promise<any> {
  if (!transcriberPromise) {
    const device = hasWebGpu() ? 'webgpu' : 'wasm';
    if (device === 'wasm') {
      ctx.postMessage({ type: 'progress', status: 'cpu-fallback' });
    }
    ctx.postMessage({ type: 'progress', status: 'downloading' });

    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
      device
    }).then((transcriber: any) => {
      ctx.postMessage({ type: 'progress', status: 'ready' });
      return transcriber;
    });
  }
  return transcriberPromise;
}

ctx.onmessage = async (event: MessageEvent) => {
  const { type } = event.data;

  if (type === 'load') {
    try {
      await getTranscriber();
    } catch (error) {
      ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (type === 'transcribe') {
    const { audio, language } = event.data as { audio: Float32Array; language: string };
    try {
      const transcriber = await getTranscriber();
      const result: any = await transcriber(audio, {
        language: language && language !== 'auto' ? language : undefined,
        task: 'transcribe'
      });
      const text = Array.isArray(result) ? (result[0]?.text ?? '') : (result.text ?? '');
      ctx.postMessage({ type: 'result', text });
    } catch (error) {
      ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
};
```

- [ ] **Step 4: Verify types compile**

Run: `npm run type-check`
Expected: PASS. If `@huggingface/transformers`'s published type declarations name the `pipeline()` options or return type differently than assumed here, fix the mismatch now (the `any`-typed `transcriber`/`result` locals are deliberately loose so only the `pipeline()` call itself needs adjusting).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json manifest.json src/whisper.worker.ts
git commit -m "feat: add transformers.js dependency and implement the Whisper transcription worker"
```

---

### Task 6: Add the offscreen document (tab audio capture + VAD + worker relay)

**Files:**
- Modify: `manifest.json` (add `"offscreen"` permission)
- Modify: `src/types/index.ts` (new message types)
- Create: `offscreen.html`
- Create: `src/offscreen.ts`

**Interfaces:**
- Consumes: `SpeechSegmenter`, `DEFAULT_VAD_CONFIG` from `src/utils/vad.ts` (Task 2); `whisper.worker.js` (Task 5) via `new Worker(chrome.runtime.getURL('whisper.worker.js'))`.
- Produces: listens for `{ type: 'START_OFFSCREEN_CAPTURE', streamId: string, sourceLanguage: string }` and `{ type: 'STOP_OFFSCREEN_CAPTURE' }`; sends `{ type: 'TRANSCRIPTION_RESULT', text: string }`, `{ type: 'TRANSCRIPTION_ERROR', message: string }`, `{ type: 'MODEL_LOADING_PROGRESS', status: string }` via `chrome.runtime.sendMessage`.

- [ ] **Step 1: Add the `offscreen` permission**

In `manifest.json`, update the `"permissions"` array (currently `activeTab`, `tabCapture`, `storage`, `scripting`):

```json
  "permissions": [
    "activeTab",
    "tabCapture",
    "storage",
    "scripting",
    "offscreen"
  ],
```

- [ ] **Step 2: Add new message types to `src/types/index.ts`**

Add these variants to the `MessageType` union (after `'SHOW_TRANSLATION_OVERLAY'` on line 23):

```ts
  | 'START_OFFSCREEN_CAPTURE'
  | 'STOP_OFFSCREEN_CAPTURE'
  | 'TRANSCRIPTION_RESULT'
  | 'TRANSCRIPTION_ERROR'
  | 'MODEL_LOADING_PROGRESS';
```

Add the corresponding interfaces after `ShowTranslationOverlayMessage` (after line 102):

```ts
export interface StartOffscreenCaptureMessage extends ExtensionMessage {
  type: 'START_OFFSCREEN_CAPTURE';
  streamId: string;
  sourceLanguage: string;
}

export interface StopOffscreenCaptureMessage extends ExtensionMessage {
  type: 'STOP_OFFSCREEN_CAPTURE';
}

export interface TranscriptionResultMessage extends ExtensionMessage {
  type: 'TRANSCRIPTION_RESULT';
  text: string;
}

export interface TranscriptionErrorMessage extends ExtensionMessage {
  type: 'TRANSCRIPTION_ERROR';
  message: string;
}

export interface ModelLoadingProgressMessage extends ExtensionMessage {
  type: 'MODEL_LOADING_PROGRESS';
  status: 'downloading' | 'cpu-fallback' | 'ready';
}
```

- [ ] **Step 3: Create `offscreen.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Offscreen Audio Processor</title>
</head>
<body>
  <script src="offscreen.js"></script>
</body>
</html>
```

- [ ] **Step 4: Implement `src/offscreen.ts`**

No automated test: real `getUserMedia`/`AudioContext`/offscreen-document behavior isn't something jsdom can exercise; this is manual-verification territory (Task 10).

```ts
// offscreen.ts - Captures tab audio, segments speech via VAD, and relays segments to the Whisper worker.
import { ExtensionMessage } from './types';
import { SpeechSegmenter, DEFAULT_VAD_CONFIG } from './utils/vad';

const FRAME_SIZE = 4096;
const SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = (FRAME_SIZE / SAMPLE_RATE) * 1000;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let worker: Worker | null = null;
let segmenter: SpeechSegmenter | null = null;
let currentSourceLanguage = 'auto';

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(chrome.runtime.getURL('whisper.worker.js'));
    worker.onmessage = handleWorkerMessage;
  }
  return worker;
}

function handleWorkerMessage(event: MessageEvent): void {
  const { type } = event.data;
  if (type === 'result') {
    if (event.data.text && event.data.text.trim()) {
      chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_RESULT', text: event.data.text });
    }
  } else if (type === 'progress') {
    chrome.runtime.sendMessage({ type: 'MODEL_LOADING_PROGRESS', status: event.data.status });
  } else if (type === 'error') {
    chrome.runtime.sendMessage({ type: 'TRANSCRIPTION_ERROR', message: event.data.message });
  }
}

async function startCapture(streamId: string, sourceLanguage: string): Promise<void> {
  currentSourceLanguage = sourceLanguage;
  segmenter = new SpeechSegmenter(FRAME_DURATION_MS, DEFAULT_VAD_CONFIG);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    } as unknown as MediaTrackConstraints,
    video: false
  });

  // Constructing the context at 16kHz makes the browser resample the tab's
  // (typically 48kHz) audio for us, matching what Whisper expects.
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);
  scriptProcessor = audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);

  scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Passthrough so the user still hears the tab while we tap the signal.
    event.outputBuffer.getChannelData(0).set(inputData);

    const frame = new Float32Array(inputData);
    const segment = segmenter!.pushFrame(frame);
    if (segment) {
      getWorker().postMessage(
        { type: 'transcribe', audio: segment, language: currentSourceLanguage },
        [segment.buffer]
      );
    }
  };

  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  getWorker().postMessage({ type: 'load' });
}

function stopCapture(): void {
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor.onaudioprocess = null;
    scriptProcessor = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
  segmenter = null;
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    const { streamId, sourceLanguage } = message as unknown as { streamId: string; sourceLanguage: string };
    startCapture(streamId, sourceLanguage)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'STOP_OFFSCREEN_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
  }
});
```

- [ ] **Step 5: Verify types compile**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add manifest.json src/types/index.ts offscreen.html src/offscreen.ts
git commit -m "feat: add offscreen document for tab audio capture, VAD segmentation, and worker relay"
```

---

### Task 7: Rewrite `background.ts` as pure orchestration

**Files:**
- Modify: `src/types/index.ts` (remove `PROCESS_AUDIO`, add `CAPTION_ERROR`/`CAPTION_STATUS`)
- Modify: `src/background.ts` (full rewrite)
- Delete: `src/utils/audioProcessor.ts`
- Delete: `src/config.ts`

**Interfaces:**
- Consumes: `apiService.translateText()` (Task 3), `START_OFFSCREEN_CAPTURE`/`STOP_OFFSCREEN_CAPTURE`/`TRANSCRIPTION_RESULT`/`TRANSCRIPTION_ERROR`/`MODEL_LOADING_PROGRESS` message types (Task 6).
- Produces: sends `DISPLAY_SUBTITLE { text, language }` (existing contract, now carrying final/already-translated text), and new `CAPTION_ERROR { message }` / `CAPTION_STATUS { message }` messages to the content script — consumed by `src/content.ts` (Task 8).

- [ ] **Step 1: Update `src/types/index.ts`**

Remove `'PROCESS_AUDIO'` from the `MessageType` union (line 10) and delete the `ProcessAudioMessage` interface (lines 33-36) — this message type was never actually sent by any script; `background.ts`'s handler for it was dead code hitting a hardcoded placeholder URL.

Add to the `MessageType` union (alongside the types added in Task 6):

```ts
  | 'CAPTION_ERROR'
  | 'CAPTION_STATUS';
```

Add corresponding interfaces near the other `DISPLAY_SUBTITLE`-adjacent types:

```ts
export interface CaptionErrorMessage extends ExtensionMessage {
  type: 'CAPTION_ERROR';
  message: string;
}

export interface CaptionStatusMessage extends ExtensionMessage {
  type: 'CAPTION_STATUS';
  message: string;
}
```

- [ ] **Step 2: Delete the now-unused files**

```bash
git rm src/utils/audioProcessor.ts src/config.ts
```

- [ ] **Step 3: Replace `src/background.ts` entirely**

```ts
// background.ts - Service Worker: orchestrates the offscreen capture pipeline and translation

import {
  ExtensionMessage,
  ExtensionSettings,
  CaptureResponse,
  APIResponse,
  APIError
} from './types';
import { apiService } from './services/apiService';

class SubtitleService {
  private activeTabId: number | null = null;
  private warnedMissingKeyTabs: Set<number> = new Set();

  constructor() {
    this.setupEventListeners();
    this.initializeSettings();
  }

  private setupEventListeners(): void {
    chrome.runtime.onInstalled.addListener(this.handleInstalled.bind(this));
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
    chrome.tabs.onUpdated.addListener(this.handleTabUpdate.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
  }

  private async initializeSettings(): Promise<void> {
    const defaultSettings: ExtensionSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      subtitleStyle: 'bottom',
      fontSize: 'medium',
      googleTranslateApiKey: '',
      enabled: false
    };

    const existingSettings = await chrome.storage.sync.get(Object.keys(defaultSettings));
    const missingKeys = Object.keys(defaultSettings).filter(key => !(key in existingSettings));
    if (missingKeys.length > 0) {
      await chrome.storage.sync.set({ ...defaultSettings, ...existingSettings });
    }
  }

  private handleInstalled(details: chrome.runtime.InstalledDetails): void {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
  }

  private async handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ): Promise<APIResponse | ExtensionSettings | any> {
    try {
      switch (message.type) {
        case 'START_CAPTURE':
          return await this.startAudioCapture(sender.tab?.id!);

        case 'STOP_CAPTURE':
          return await this.stopAudioCapture(sender.tab?.id!);

        case 'GET_SETTINGS': {
          const defaultSettings: ExtensionSettings = {
            sourceLanguage: 'auto',
            targetLanguage: 'en',
            subtitleStyle: 'bottom',
            fontSize: 'medium',
            googleTranslateApiKey: '',
            enabled: false
          };
          return await chrome.storage.sync.get(defaultSettings);
        }

        case 'UPDATE_SETTINGS':
          return await chrome.storage.sync.set(message.settings);

        case 'TRANSLATE_TEXT':
          return await this.translateText(message.text, message.targetLang);

        case 'TOGGLE_SCREEN_TRANSLATION':
          return { success: true };

        case 'TRANSCRIPTION_RESULT':
          await this.handleTranscriptionResult(message.text);
          return { success: true };

        case 'TRANSCRIPTION_ERROR':
          if (this.activeTabId !== null) {
            await this.safeSendMessage(this.activeTabId, {
              type: 'CAPTION_ERROR',
              message: `Transcription error: ${message.message}`
            });
          }
          return { success: true };

        case 'MODEL_LOADING_PROGRESS':
          await this.handleModelLoadingProgress(message.status);
          return { success: true };

        default:
          console.warn('Unknown message type:', message.type);
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      console.error('Error handling message:', error);
      return { success: false, error: (error as Error).message };
    }
  }

  private async ensureOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture and transcribe tab audio to generate live captions'
    });
  }

  private async closeOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  }

  private async startAudioCapture(tabId: number): Promise<CaptureResponse> {
    try {
      if (this.activeTabId !== null && this.activeTabId !== tabId) {
        await this.stopAudioCapture(this.activeTabId);
      }

      const settings = await chrome.storage.sync.get(['sourceLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';

      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

      await this.ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        type: 'START_OFFSCREEN_CAPTURE',
        streamId,
        sourceLanguage
      });

      this.activeTabId = tabId;

      await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_STARTED', streamId });

      return { success: true, streamId };
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  private async stopAudioCapture(tabId: number): Promise<{ success: boolean }> {
    if (this.activeTabId === tabId) {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_OFFSCREEN_CAPTURE' });
      } catch (error) {
        // offscreen document may already be gone
      }
      await this.closeOffscreenDocument();
      this.activeTabId = null;
      this.warnedMissingKeyTabs.delete(tabId);

      await this.safeSendMessage(tabId, { type: 'CAPTURE_STOPPED' });
    }
    return { success: true };
  }

  private async handleTranscriptionResult(text: string): Promise<void> {
    if (this.activeTabId === null || !text || !text.trim()) return;
    const tabId = this.activeTabId;
    const { text: finalText, language } = await this.maybeTranslate(text, tabId);
    await this.safeSendMessage(tabId, { type: 'DISPLAY_SUBTITLE', text: finalText, language });
  }

  private async handleModelLoadingProgress(status: string): Promise<void> {
    if (this.activeTabId === null) return;
    const statusMessages: Record<string, string> = {
      downloading: 'Loading speech model... (first time only, may take a minute)',
      ready: 'Speech model ready',
      'cpu-fallback': 'WebGPU unavailable — running in CPU mode, captions may be slower'
    };
    await this.safeSendMessage(this.activeTabId, {
      type: 'CAPTION_STATUS',
      message: statusMessages[status] || status
    });
  }

  private async maybeTranslate(text: string, tabId: number): Promise<{ text: string; language: string }> {
    const settings = await chrome.storage.sync.get(['sourceLanguage', 'targetLanguage']);
    const sourceLanguage = settings.sourceLanguage || 'auto';
    const targetLanguage = settings.targetLanguage || 'en';

    if (sourceLanguage === targetLanguage) {
      return { text, language: sourceLanguage };
    }

    try {
      const result = await apiService.translateText(text, sourceLanguage, targetLanguage);
      return { text: result.translatedText, language: targetLanguage };
    } catch (error) {
      if (error instanceof APIError && error.status === 401 && !this.warnedMissingKeyTabs.has(tabId)) {
        this.warnedMissingKeyTabs.add(tabId);
        await this.safeSendMessage(tabId, {
          type: 'CAPTION_ERROR',
          message: 'No Google Translate API key configured. Showing untranslated captions — add a key in the extension popup to enable translation.'
        });
      }
      console.error('Translation failed, falling back to untranslated text:', error);
      return { text, language: sourceLanguage };
    }
  }

  private async safeSendMessage(tabId: number, message: ExtensionMessage): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      // tab might be closed or navigating away; ignore
    }
  }

  async translateText(text: string, targetLang: string) {
    try {
      const settings = await chrome.storage.sync.get(['sourceLanguage']);
      const sourceLanguage = settings.sourceLanguage || 'auto';

      const result = await apiService.translateText(text, sourceLanguage, targetLang);
      return { success: true, translatedText: result.translatedText };
    } catch (error) {
      console.error('Translation failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  handleTabUpdate(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
    if (changeInfo.status === 'loading' && this.activeTabId === tabId) {
      this.stopAudioCapture(tabId);
    }
  }

  handleTabRemoved(tabId: number): void {
    if (this.activeTabId === tabId) {
      this.stopAudioCapture(tabId);
    }
  }
}

// Initialize the service
const subtitleService = new SubtitleService();
```

- [ ] **Step 4: Verify types compile**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (unaffected — `background.ts` has no unit tests per the spec's Testing Approach; this just confirms nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/background.ts
git commit -m "refactor: rewrite background.ts as offscreen-document orchestration"
```

---

### Task 8: Clean up `content.ts` — remove dead audio code and the duplicate translation call

**Files:**
- Modify: `src/content.ts` (full rewrite)

**Interfaces:**
- Consumes: `DISPLAY_SUBTITLE { text, language }` (now final text — no re-translation needed), `CAPTION_ERROR { message }`, `CAPTION_STATUS { message }` from `background.ts` (Task 7).

This fixes a real bug found while reading this file for planning: the previous `displaySubtitle()` → `handleTranslation()` independently re-translated every caption via its own `TRANSLATE_TEXT` message, duplicating the translation `background.ts` already performs before sending `DISPLAY_SUBTITLE`. It also removes `setupAudioProcessing()`/`cleanupAudioProcessing()`, vestigial code that created a `window.AudioContext` and did nothing else (a smaller instance of the same service-worker-side bug this whole redesign fixes, just in the content-script copy).

- [ ] **Step 1: Replace `src/content.ts` entirely**

```ts
// content.ts - Content script for subtitle overlay

import {
  ExtensionMessage,
  CaptureStartedMessage,
  CaptureStoppedMessage,
  DisplaySubtitleMessage,
  UpdateStyleMessage,
  CaptionErrorMessage,
  CaptionStatusMessage
} from './types';

class SubtitleOverlay {
  private isActive: boolean;
  private overlay: HTMLDivElement | null;

  constructor() {
    this.isActive = false;
    this.overlay = null;
    this.setupMessageListener();
    this.detectVideoElements();
  }

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        switch (message.type) {
          case 'TOGGLE_SUBTITLES':
            this.toggleSubtitles();
            break;

          case 'TOGGLE_SCREEN_TRANSLATION':
            // Forwarded to RealTimeTranslator, handled by realTimeTranslate.js
            break;

          case 'CAPTURE_STARTED':
            this.onCaptureStarted((message as CaptureStartedMessage).streamId);
            break;

          case 'CAPTURE_STOPPED':
            this.onCaptureStopped();
            break;

          case 'DISPLAY_SUBTITLE': {
            const displayMsg = message as DisplaySubtitleMessage;
            this.displaySubtitle(displayMsg.text, displayMsg.language);
            break;
          }

          case 'CAPTION_ERROR':
            this.showError((message as CaptionErrorMessage).message);
            break;

          case 'CAPTION_STATUS':
            this.showStatus((message as CaptionStatusMessage).message);
            break;

          case 'UPDATE_STYLE':
            this.updateSubtitleStyle((message as UpdateStyleMessage).style);
            break;
        }
      }
    );
  }

  detectVideoElements() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element;
            const videos = element.tagName === 'VIDEO' ? [element] : element.querySelectorAll('video');
            videos.forEach(video => this.setupVideoListener(video as HTMLVideoElement));
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    document.querySelectorAll('video').forEach(video => {
      this.setupVideoListener(video);
    });
  }

  setupVideoListener(video: HTMLVideoElement) {
    video.addEventListener('play', () => {
      if (this.isActive) {
        this.startAudioCapture();
      }
    });

    video.addEventListener('ended', () => {
      this.stopAudioCapture();
    });
  }

  async toggleSubtitles() {
    this.isActive = !this.isActive;

    if (this.isActive) {
      this.createOverlay();
      await this.startAudioCapture();
    } else {
      this.removeOverlay();
      await this.stopAudioCapture();
    }
  }

  createOverlay() {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.id = 'subtitle-overlay-extension';
    this.overlay.className = 'subtitle-overlay';

    this.overlay.style.cssText = `
      position: fixed;
      bottom: 10%;
      left: 50%;
      transform: translateX(-50%);
      z-index: 999999;
      pointer-events: none;
      max-width: 80%;
      text-align: center;
    `;

    document.body.appendChild(this.overlay);
  }

  removeOverlay() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  async startAudioCapture() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_CAPTURE'
      });

      if (!response.success) {
        console.error('Failed to start capture:', response.error);
        this.showError(response.error);
      }
    } catch (error) {
      console.error('Error starting audio capture:', error);
      this.showError('Failed to start audio capture');
    }
  }

  async stopAudioCapture() {
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_CAPTURE'
      });
    } catch (error) {
      console.error('Error stopping audio capture:', error);
    }
  }

  onCaptureStarted(streamId: string): void {
    this.showStatus('Listening for audio...');
  }

  onCaptureStopped(): void {
    this.showStatus('Audio capture stopped');
  }

  displaySubtitle(text: string, language: string): void {
    if (!this.overlay || !text) return;

    this.overlay.innerHTML = '';

    const subtitleElement = document.createElement('div');
    subtitleElement.className = 'subtitle-text';
    subtitleElement.textContent = text;
    this.overlay.appendChild(subtitleElement);

    setTimeout(() => {
      if (subtitleElement.parentNode) {
        subtitleElement.remove();
      }
    }, 5000);
  }

  updateSubtitleStyle(style: Partial<CSSStyleDeclaration>) {
    if (!this.overlay) return;
    Object.assign(this.overlay.style, style);
  }

  showError(message: string) {
    if (!this.overlay) this.createOverlay();

    const errorElement = document.createElement('div');
    errorElement.className = 'subtitle-error';
    errorElement.textContent = `Error: ${message}`;
    errorElement.style.color = '#ff4444';

    if (this.overlay) {
      this.overlay.appendChild(errorElement);
    }

    setTimeout(() => {
      if (errorElement.parentNode) {
        errorElement.remove();
      }
    }, 3000);
  }

  showStatus(message: string) {
    if (!this.overlay) this.createOverlay();

    const statusElement = document.createElement('div');
    statusElement.className = 'subtitle-status';
    statusElement.textContent = message;
    statusElement.style.opacity = '0.7';

    if (this.overlay) {
      this.overlay.appendChild(statusElement);
    }

    setTimeout(() => {
      if (statusElement.parentNode) {
        statusElement.remove();
      }
    }, 2000);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new SubtitleOverlay();
  });
} else {
  new SubtitleOverlay();
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/content.ts
git commit -m "fix: remove dead audio code and duplicate re-translation from content.ts"
```

---

### Task 9: Wire up webpack and verify the full build

**Files:**
- Modify: `webpack.config.js` (full rewrite)
- Modify: `package.json` (remove unused `dotenv`)

**Interfaces:**
- Produces: a `dist/` build containing `background.js`, `content.js`, `popup.js`, `realTimeTranslate.js`, `offscreen.js`, `whisper.worker.js`, `offscreen.html`, `popup.html`, `manifest.json`, `subtitle-overlay.css`, `icons/` — loadable as an unpacked extension.

While wiring this up, disable `splitChunks`: the existing config extracts shared `node_modules` code into a `vendors.js` chunk, but nothing in `manifest.json`/`popup.html`/`offscreen.html` ever loads a `vendors.js` file — a pre-existing latent bug that happened to never trigger because no two entries previously shared an npm dependency. Now that `whisper.worker.ts` pulls in `@huggingface/transformers`, and workers loaded via `new Worker(url)` must be fully self-contained single files (no runtime chunk loading), every entry needs to produce one standalone bundle.

- [ ] **Step 1: Replace `webpack.config.js` entirely**

```js
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      realTimeTranslate: './src/realTimeTranslate.ts',
      offscreen: './src/offscreen.ts',
      'whisper.worker': './src/whisper.worker.ts'
    },

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true
    },

    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader'
          }
        }
      ]
    },

    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'manifest.json', to: 'manifest.json' },
          { from: 'popup.html', to: 'popup.html' },
          { from: 'offscreen.html', to: 'offscreen.html' },
          { from: 'subtitle-overlay.css', to: 'subtitle-overlay.css' },
          { from: 'icons/', to: 'icons/', noErrorOnMissing: true }
        ]
      })
    ],

    optimization: {
      minimize: isProduction,
      // Every entry (including whisper.worker, loaded via `new Worker(url)`)
      // must be a single self-contained file. Chunk-splitting would extract
      // shared node_modules code into a vendors.js that nothing declares
      // how to load.
      splitChunks: false
    },

    devtool: isProduction ? false : 'source-map',

    resolve: {
      extensions: ['.ts', '.js', '.json']
    }
  };
};
```

- [ ] **Step 2: Remove the now-unused `dotenv` dependency**

In `package.json`, remove this line from `devDependencies`:

```json
    "dotenv": "^16.6.1",
```

Run: `npm install`

- [ ] **Step 3: Run the full verification sequence**

Run: `npm run type-check`
Expected: PASS.

Run: `npm test`
Expected: PASS (all suites from Tasks 1-3).

Run: `npm run build:dev`
Expected: PASS. Confirm `dist/` contains: `background.js`, `content.js`, `popup.js`, `realTimeTranslate.js`, `offscreen.js`, `whisper.worker.js`, `offscreen.html`, `popup.html`, `manifest.json`, `subtitle-overlay.css`, `icons/`.

- [ ] **Step 4: Commit**

```bash
git add webpack.config.js package.json package-lock.json
git commit -m "build: wire up offscreen/whisper.worker entries, disable splitChunks, drop unused dotenv"
```

---

### Task 10: Manual verification in Opera GX

**Files:** none (manual QA pass against the `dist/` build from Task 9).

No automated test covers this — the spec's Testing Approach section explicitly marks real WASM/WebGPU model loading, `tabCapture`/`getUserMedia` behavior, and offscreen document lifecycle as manual-verification territory.

- [ ] **Step 1: Load the unpacked extension**

Open `opera://extensions` in Opera GX → enable Developer mode → "Load unpacked" → select the `dist/` folder produced by `npm run build:dev`.

- [ ] **Step 2: Configure a Google Translate API key**

Open the extension popup, paste a Google Cloud Translation API key into the new field, pick a source/target language pair, close the popup (settings save on change).

- [ ] **Step 3: Verify basic captioning**

Open a non-English YouTube or Twitch stream, click "Start Subtitles". Confirm:
- A "Loading speech model... (first time only...)" status appears in the overlay on first run.
- Captions appear in reasonably near-real-time once the model loads, segmented on natural pauses (not mid-word cuts).
- Reload the page/model a second time — the "Loading model" step should be much faster or skipped (Cache Storage hit).

- [ ] **Step 4: Verify translation**

Confirm displayed captions match the configured target language. Change the target language in the popup mid-session; confirm subsequent captions use the new target.

- [ ] **Step 5: Verify teardown**

Stop captions via the popup — confirm the offscreen document is gone (check `opera://inspect/#other` or `chrome://inspect/#other` — no "offscreen.html" entry should remain). Repeat by closing the tab instead of clicking stop, and by navigating the tab to a new URL instead — confirm teardown happens both ways, not just via the button.

- [ ] **Step 6: Verify single-active-tab enforcement**

Start captions on tab A, then start captions on tab B. Confirm tab A's captioning visibly stops (its overlay shows "Audio capture stopped" or similar) and tab B's begins — not a silent crash or both running simultaneously.

- [ ] **Step 7: Verify missing/invalid API key handling**

Clear the API key field, set source ≠ target language, start captions on foreign-language audio. Confirm a one-time "No Google Translate API key configured..." notice appears in the overlay and captions continue untranslated (not blank). Then set an invalid/garbage key and confirm the same untranslated-fallback behavior (rather than a blank screen) once Google's API rejects the request.

- [ ] **Step 8: Verify WebGPU fallback**

Disable WebGPU (e.g. via `opera://flags` disabling the WebGPU flag, or test on hardware without it) and restart captions. Confirm a "running in CPU mode" status appears and captions still eventually appear (slower).

- [ ] **Step 9: Verify Screen Translate still works**

Click "Screen Translate", select some text or drag a box over text on any page, confirm a translated overlay still appears now that `apiService.ts` talks to Google Translate instead of the old self-hosted backend.

- [ ] **Step 10: Note results**

Record any failures found against this checklist as follow-up issues — do not silently mark this task complete if any step fails.

---

## Self-Review

**Spec coverage:**
- Client-side transcription via transformers.js/`Xenova/whisper-small`, WebGPU-with-WASM-fallback → Tasks 5, 6, 10.
- Google Cloud Translation API with per-user `chrome.storage.sync` key → Tasks 3, 4, 7.
- Old backend removed as a runtime dependency, `SpeechToTextLLMServer/` left untouched → Task 7 deletes the extension-side whisper client code; no task touches `SpeechToTextLLMServer/`.
- Fix `window.AudioContext`-in-service-worker bug → Task 7 deletes `audioProcessor.ts`/`config.ts` entirely; audio now only runs in `offscreen.ts`, which has a real `window`.
- Offscreen document + Web Worker architecture, single-active-tab v1 limit, teardown on stop/tab-close/navigate → Tasks 6, 7.
- Missing-key one-time prompt, translation-failure fallback to untranslated text → Task 7's `maybeTranslate()`.
- Model loading indicator, WebGPU/CPU-mode indicator → Task 7's `handleModelLoadingProgress()` + Task 5/6's `progress` messages.
- Screen Translate preserved unchanged → no task modifies `realTimeTranslate.ts`; Task 3 keeps `apiService.translateText()`'s call signature compatible; Task 10 Step 9 verifies it manually.
- Broken `jest-environment-jsdom` setup fixed → Task 1.
- Unit tests for VAD/chunking and `apiService.translateText()` → Tasks 2, 3. Settings-migration unit tests were in the spec's Testing Approach list, but there is no old-key migration to test: Task 4 simply changes the default-settings shape going forward (existing `whisperServiceUrl` values in a user's `chrome.storage.sync` are just never read again, not actively migrated) — nothing to unit test there beyond what Task 4's type change already enforces at compile time.

**Placeholder scan:** no "TBD"/"TODO"/"handle appropriately" markers; every step has literal code or literal manual actions.

**Type consistency:** `ApiService.translateText()` returns `TranslationResult { translatedText, detectedSourceLanguage? }` consistently across Task 3 (definition + tests), Task 7 (`background.ts`'s `maybeTranslate`/`translateText` both destructure `result.translatedText`). `ExtensionSettings.googleTranslateApiKey` is introduced in Task 4 and consumed identically in Task 7's two `defaultSettings` literals and Task 3's `apiService.getApiKey()`. Message types introduced in Task 6 (`START_OFFSCREEN_CAPTURE` etc.) and Task 7 (`CAPTION_ERROR`/`CAPTION_STATUS`) are each defined in `types/index.ts` before the task that first sends/receives them at runtime.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-05-client-side-stt-translation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
