# DeepL Translation Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose DeepL as an alternative translation provider to Google Translate, selected in the popup, with each provider keeping its own separately-stored API key.

**Architecture:** `ApiService.translateText()` keeps its existing external signature and return shape; internally it now reads `translationProvider` from `chrome.storage.sync` and dispatches to a Google-specific or DeepL-specific request/response handler, both wrapped by the existing retry/backoff logic. `background.ts` and `realTimeTranslate.ts` (Screen Translate) are unaware which provider is active. The popup gains a provider dropdown and a second password field, showing only the key input for the currently-selected provider.

**Tech Stack:** TypeScript, Jest + `ts-jest` (existing test setup), DeepL API v2 REST (`https://api-free.deepl.com/v2/translate` / `https://api.deepl.com/v2/translate`), no new dependencies.

## Global Constraints

- `ApiService.translateText(text, sourceLanguage, targetLanguage): Promise<TranslationResult>` signature and `TranslationResult { translatedText, detectedSourceLanguage? }` shape must not change — `background.ts` and `realTimeTranslate.ts` (Screen Translate) depend on this contract unchanged.
- `translationProvider` defaults to `'google'` so existing users see no behavior change until they explicitly switch providers.
- DeepL endpoint (free vs. pro) is auto-detected from the API key's `:fx` suffix — no separate tier toggle in the UI.
- `EN` → `EN-US` and `PT` → `PT-PT` are the fixed default regional mappings for DeepL's target language; no new dropdown entries are added.
- `npm test` and `npm run type-check` must pass by the end of this plan.

---

## File Structure

**Modified files:**
- `src/types/index.ts` — `ExtensionSettings` gains `translationProvider: 'google' | 'deepl'` and `deeplApiKey: string`.
- `src/services/apiService.ts` — provider dispatch added; Google path behavior/shape unchanged, DeepL path added.
- `src/services/__tests__/apiService.test.ts` — new DeepL test suite added alongside the existing (unmodified) Google suite.
- `src/background.ts` — both `ExtensionSettings`-typed default-settings literals updated with the two new fields; the missing-API-key caption message in `maybeTranslate()` is generalized to name whichever provider is actually active.
- `popup.html` — new `#translationProvider` select and `#deeplApiKey` password input, each API-key field wrapped in its own `.setting-group` div so it can be shown/hidden.
- `src/popup.ts` — new elements wired up, provider-based show/hide of the two key fields, load/save extended to the two new settings fields.

---

### Task 1: Add provider settings to `ExtensionSettings`

**Files:**
- Modify: `src/types/index.ts:141-148`

**Interfaces:**
- Produces: `ExtensionSettings.translationProvider: 'google' | 'deepl'`, `ExtensionSettings.deeplApiKey: string`.
- Consumed by: `src/services/apiService.ts` (Task 2), `src/background.ts` (Task 3), `src/popup.ts` (Task 4).

- [ ] **Step 1: Confirm the current clean type-check baseline**

Run: `npm run type-check`
Expected: PASS (0 errors) — this is the last clean baseline before this task's change ripples out.

- [ ] **Step 2: Update `ExtensionSettings`**

Replace lines 141-148 of `src/types/index.ts`:

```ts
export interface ExtensionSettings {
  sourceLanguage: string;
  targetLanguage: string;
  subtitleStyle: SubtitlePosition;
  fontSize: FontSize;
  enabled: boolean;
  googleTranslateApiKey: string;
  translationProvider: 'google' | 'deepl';
  deeplApiKey: string;
}
```

- [ ] **Step 3: Run type-check to confirm the expected downstream breakage**

Run: `npm run type-check`
Expected: FAIL with 3 errors, all "Property 'translationProvider' is missing" (or similar) on object literals explicitly typed `ExtensionSettings`:
- `src/background.ts:29` (`initializeSettings()`'s `defaultSettings`)
- `src/background.ts:65` (the `GET_SETTINGS` case's `defaultSettings`)
- `src/popup.ts:85` (`loadSettings()`'s `defaultSettings`)

These are fixed in Tasks 3 and 4 — do not fix them here.

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add translationProvider and deeplApiKey to ExtensionSettings"
```

---

### Task 2: Add DeepL support to `apiService.ts`

**Files:**
- Modify: `src/services/apiService.ts` (full rewrite)
- Test: `src/services/__tests__/apiService.test.ts` (append new suite)

**Interfaces:**
- Consumes: `APIError` from `src/types/index.ts` (unchanged), `ExtensionSettings.translationProvider`/`deeplApiKey` (Task 1).
- Produces: `ApiService.translateText()` unchanged externally — same signature, same `TranslationResult` shape — now provider-aware internally.
- Consumed by: `src/background.ts` (Task 3, no code changes needed there beyond settings defaults), `src/realTimeTranslate.ts` (already calls `apiService.translateText()`, needs no changes).

- [ ] **Step 1: Write the failing DeepL tests**

Append this new `describe` block to the end of `src/services/__tests__/apiService.test.ts` (after the existing `describe('ApiService.translateText', ...)` block, still inside the same file, same imports):

```ts
describe('ApiService.translateText via DeepL', () => {
  let apiService: ApiService;

  function mockStorage(overrides: Record<string, unknown>) {
    (globalThis as any).chrome = {
      storage: {
        sync: {
          get: jest.fn().mockResolvedValue({ translationProvider: 'deepl', ...overrides })
        }
      }
    };
  }

  beforeEach(() => {
    apiService = new ApiService();
    (globalThis as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses the free-tier endpoint and DeepL auth header for a key ending in :fx', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola', detected_source_language: 'EN' }] })
    });

    const result = await apiService.translateText('Hello', 'en', 'es');

    expect(result).toEqual({ translatedText: 'Hola', detectedSourceLanguage: 'en' });
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.headers.Authorization).toBe('DeepL-Auth-Key abc123:fx');
    expect(JSON.parse(init.body)).toEqual({ text: ['Hello'], target_lang: 'ES', source_lang: 'EN' });
  });

  it('uses the pro-tier endpoint for a key without the :fx suffix', async () => {
    mockStorage({ deeplApiKey: 'abc123' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola' }] })
    });

    await apiService.translateText('Hello', 'en', 'es');

    const [url] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.deepl.com/v2/translate');
  });

  it('maps en/pt target languages to their DeepL regional variants', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hi' }] })
    });

    await apiService.translateText('Ola', 'pt', 'en');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: ['Ola'], target_lang: 'EN-US', source_lang: 'PT' });
  });

  it('omits source_lang when sourceLanguage is "auto"', async () => {
    mockStorage({ deeplApiKey: 'abc123:fx' });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ translations: [{ text: 'Hola' }] })
    });

    await apiService.translateText('Hello', 'auto', 'es');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ text: ['Hello'], target_lang: 'ES' });
  });

  it('retries on failure with exponential backoff, then succeeds', async () => {
    jest.useFakeTimers();
    mockStorage({ deeplApiKey: 'abc123:fx' });
    const fetchMock = globalThis.fetch as jest.Mock;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ translations: [{ text: 'Hola' }] }) });

    const resultPromise = apiService.translateText('Hello', 'en', 'es');
    await jest.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.translatedText).toBe('Hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws an APIError without calling fetch when no DeepL API key is configured', async () => {
    mockStorage({ deeplApiKey: '' });

    await expect(apiService.translateText('Hello', 'en', 'es')).rejects.toThrow(APIError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify the new suite fails while the old one still passes**

Run: `npx jest src/services/__tests__/apiService.test.ts`
Expected: the original `describe('ApiService.translateText', ...)` suite (5 tests) still PASSes; the new `describe('ApiService.translateText via DeepL', ...)` suite FAILs (current `apiService.ts` has no DeepL branch, so requests still go to Google's endpoint).

- [ ] **Step 3: Replace `src/services/apiService.ts` entirely**

```ts
// apiService.ts - Client for the Google Cloud Translation API and the DeepL API
import { APIError } from '../types';

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

// DeepL requires a regional variant for some target languages that Google
// treats as a single generic code.
const DEEPL_TARGET_OVERRIDES: Record<string, string> = {
  en: 'EN-US',
  pt: 'PT-PT'
};

function toDeepLTarget(code: string): string {
  return DEEPL_TARGET_OVERRIDES[code.toLowerCase()] || code.toUpperCase();
}

function toDeepLSource(code: string): string {
  return code.toUpperCase();
}

interface TranslationSettings {
  translationProvider: 'google' | 'deepl';
  googleTranslateApiKey: string;
  deeplApiKey: string;
}

export class ApiService {
  private async getSettings(): Promise<TranslationSettings> {
    const settings = await chrome.storage.sync.get([
      'translationProvider',
      'googleTranslateApiKey',
      'deeplApiKey'
    ]);
    return {
      translationProvider: settings.translationProvider === 'deepl' ? 'deepl' : 'google',
      googleTranslateApiKey: settings.googleTranslateApiKey || '',
      deeplApiKey: settings.deeplApiKey || ''
    };
  }

  async translateText(
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const settings = await this.getSettings();

    if (settings.translationProvider === 'deepl') {
      if (!settings.deeplApiKey) {
        throw new APIError('No DeepL API key configured', 401);
      }
      return this.retryRequest(() =>
        this.executeDeepLTranslate(settings.deeplApiKey, text, sourceLanguage, targetLanguage)
      );
    }

    if (!settings.googleTranslateApiKey) {
      throw new APIError('No Google Translate API key configured', 401);
    }
    const body: Record<string, string> = { q: text, target: targetLanguage, format: 'text' };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source = sourceLanguage;
    }
    return this.retryRequest(() => this.executeGoogleTranslate(settings.googleTranslateApiKey, body));
  }

  private async executeGoogleTranslate(
    apiKey: string,
    body: Record<string, string>
  ): Promise<TranslationResult> {
    return this.withTimeout(async signal => {
      const response = await fetch(`${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
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
    });
  }

  private async executeDeepLTranslate(
    apiKey: string,
    text: string,
    sourceLanguage: string,
    targetLanguage: string
  ): Promise<TranslationResult> {
    const endpoint = apiKey.endsWith(':fx') ? DEEPL_FREE_ENDPOINT : DEEPL_PRO_ENDPOINT;
    const body: Record<string, unknown> = { text: [text], target_lang: toDeepLTarget(targetLanguage) };
    if (sourceLanguage && sourceLanguage !== 'auto') {
      body.source_lang = toDeepLSource(sourceLanguage);
    }

    return this.withTimeout(async signal => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${apiKey}`
        },
        body: JSON.stringify(body),
        signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(`Translation request failed: ${response.status}`, response.status, errorText);
      }

      const json = await response.json();
      const translation = json?.translations?.[0];
      if (!translation) {
        throw new APIError('Malformed translation response', 500, json);
      }

      return {
        translatedText: translation.text,
        detectedSourceLanguage: translation.detected_source_language?.toLowerCase()
      };
    });
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fn(controller.signal);
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

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npx jest src/services/__tests__/apiService.test.ts`
Expected: PASS (11 tests: the original 5 Google tests, unmodified, plus the 6 new DeepL tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/apiService.ts src/services/__tests__/apiService.test.ts
git commit -m "feat: add DeepL as a selectable translation provider in apiService"
```

---

### Task 3: Update `background.ts` default settings and the missing-key message

**Files:**
- Modify: `src/background.ts:29-36` (`initializeSettings()`)
- Modify: `src/background.ts:65-72` (`GET_SETTINGS` handler)
- Modify: `src/background.ts:203-226` (`maybeTranslate()`)

**Interfaces:**
- Consumes: `ExtensionSettings.translationProvider`/`deeplApiKey` (Task 1), `apiService.translateText()` (Task 2, unchanged signature).
- Produces: no new interfaces — this task only fixes the type errors from Task 1 and generalizes user-facing text.

- [ ] **Step 1: Fix the `initializeSettings()` default settings literal**

Replace lines 29-36 of `src/background.ts`:

```ts
    const defaultSettings: ExtensionSettings = {
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      subtitleStyle: 'bottom',
      fontSize: 'medium',
      googleTranslateApiKey: '',
      translationProvider: 'google',
      deeplApiKey: '',
      enabled: false
    };
```

- [ ] **Step 2: Fix the `GET_SETTINGS` handler's default settings literal**

Replace lines 65-72 of `src/background.ts` (inside the `case 'GET_SETTINGS':` block):

```ts
          const defaultSettings: ExtensionSettings = {
            sourceLanguage: 'auto',
            targetLanguage: 'en',
            subtitleStyle: 'bottom',
            fontSize: 'medium',
            googleTranslateApiKey: '',
            translationProvider: 'google',
            deeplApiKey: '',
            enabled: false
          };
```

- [ ] **Step 3: Run type-check to confirm background.ts's errors are gone**

Run: `npm run type-check`
Expected: FAIL with exactly 1 remaining error, at `src/popup.ts:85` (`loadSettings()`'s `defaultSettings` — fixed in Task 4).

- [ ] **Step 4: Generalize the missing-API-key caption message**

Replace lines 203-226 of `src/background.ts` (`maybeTranslate()`):

```ts
  private async maybeTranslate(text: string, tabId: number): Promise<{ text: string; language: string }> {
    const settings = await chrome.storage.sync.get(['sourceLanguage', 'targetLanguage', 'translationProvider']);
    const sourceLanguage = settings.sourceLanguage || 'auto';
    const targetLanguage = settings.targetLanguage || 'en';
    const providerName = settings.translationProvider === 'deepl' ? 'DeepL' : 'Google Translate';

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
          message: `No ${providerName} API key configured. Showing untranslated captions — add a key in the extension popup to enable translation.`
        });
      }
      console.error('Translation failed, falling back to untranslated text:', error);
      return { text, language: sourceLanguage };
    }
  }
```

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS (11 tests from Task 2 — `background.ts` has no unit tests per existing project convention).

- [ ] **Step 6: Commit**

```bash
git add src/background.ts
git commit -m "fix: add translationProvider/deeplApiKey to background.ts defaults, generalize missing-key message"
```

---

### Task 4: Add provider selection UI to the popup

**Files:**
- Modify: `popup.html:215-218`
- Modify: `src/popup.ts` (full rewrite)

**Interfaces:**
- Consumes: `ExtensionSettings.translationProvider`/`deeplApiKey` (Task 1). Still uses `chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', ... })`, unchanged message contract with `background.ts`.
- Produces: a `#translationProvider` select and `#deeplApiKey` password input that `popup.ts` reads/writes via `chrome.storage.sync`, with only the active provider's key field visible at a time.

- [ ] **Step 1: Replace the API key section in `popup.html`**

Replace lines 215-218 of `popup.html`:

```html
        <div class="setting-group">
            <label for="translationProvider">Translation Provider:</label>
            <select id="translationProvider">
                <option value="google">Google Translate</option>
                <option value="deepl">DeepL</option>
            </select>
        </div>

        <div class="setting-group" id="googleApiKeyGroup">
            <label for="googleTranslateApiKey">Google Translate API Key:</label>
            <input type="password" id="googleTranslateApiKey" placeholder="Paste your API key">
        </div>

        <div class="setting-group hidden" id="deeplApiKeyGroup">
            <label for="deeplApiKey">DeepL API Key:</label>
            <input type="password" id="deeplApiKey" placeholder="Paste your API key">
        </div>
```

This reuses the existing `.hidden { display: none; }` CSS rule already defined in `popup.html`'s `<style>` block — no new CSS needed.

- [ ] **Step 2: Replace `src/popup.ts` entirely**

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
  translationProvider: HTMLSelectElement;
  googleTranslateApiKey: HTMLInputElement;
  deeplApiKey: HTMLInputElement;
  googleApiKeyGroup: HTMLDivElement;
  deeplApiKeyGroup: HTMLDivElement;
}

const NON_SETTING_ELEMENT_KEYS = [
  'toggleButton',
  'screenTranslateButton',
  'status',
  'googleApiKeyGroup',
  'deeplApiKeyGroup'
];

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
    const translationProvider = document.getElementById('translationProvider') as HTMLSelectElement | null;
    const googleTranslateApiKey = document.getElementById('googleTranslateApiKey') as HTMLInputElement | null;
    const deeplApiKey = document.getElementById('deeplApiKey') as HTMLInputElement | null;
    const googleApiKeyGroup = document.getElementById('googleApiKeyGroup') as HTMLDivElement | null;
    const deeplApiKeyGroup = document.getElementById('deeplApiKeyGroup') as HTMLDivElement | null;

    if (
      !toggleButton ||
      !screenTranslateButton ||
      !status ||
      !sourceLanguage ||
      !targetLanguage ||
      !subtitleStyle ||
      !fontSize ||
      !translationProvider ||
      !googleTranslateApiKey ||
      !deeplApiKey ||
      !googleApiKeyGroup ||
      !deeplApiKeyGroup
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
      translationProvider,
      googleTranslateApiKey,
      deeplApiKey,
      googleApiKeyGroup,
      deeplApiKeyGroup
    };
  }

  setupEventListeners() {
    this.elements.toggleButton.addEventListener('click', () => {
      this.toggleSubtitles();
    });

    this.elements.screenTranslateButton.addEventListener('click', () => {
      this.toggleScreenTranslation();
    });

    this.elements.translationProvider.addEventListener('change', () => {
      this.updateApiKeyVisibility();
    });

    Object.keys(this.elements).forEach(key => {
      if (!NON_SETTING_ELEMENT_KEYS.includes(key)) {
        (this.elements[key as keyof PopupElements] as HTMLElement).addEventListener('change', () => {
          this.saveSettings();
        });
      }
    });
  }

  private updateApiKeyVisibility() {
    const isDeepL = this.elements.translationProvider.value === 'deepl';
    this.elements.googleApiKeyGroup.classList.toggle('hidden', isDeepL);
    this.elements.deeplApiKeyGroup.classList.toggle('hidden', !isDeepL);
  }

  async loadSettings() {
    try {
      const defaultSettings: ExtensionSettings = {
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        subtitleStyle: 'bottom',
        fontSize: 'medium',
        googleTranslateApiKey: '',
        translationProvider: 'google',
        deeplApiKey: '',
        enabled: false
      };

      const settings = await chrome.storage.sync.get(defaultSettings);

      this.elements.sourceLanguage.value = settings.sourceLanguage;
      this.elements.targetLanguage.value = settings.targetLanguage;
      this.elements.subtitleStyle.value = settings.subtitleStyle;
      this.elements.fontSize.value = settings.fontSize;
      this.elements.translationProvider.value = settings.translationProvider;
      this.elements.googleTranslateApiKey.value = settings.googleTranslateApiKey;
      this.elements.deeplApiKey.value = settings.deeplApiKey;
      this.updateApiKeyVisibility();

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
    this.elements.translationProvider.value = 'google';
    this.elements.googleTranslateApiKey.value = '';
    this.elements.deeplApiKey.value = '';
    this.updateApiKeyVisibility();
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
        translationProvider: this.elements.translationProvider.value,
        googleTranslateApiKey: this.elements.googleTranslateApiKey.value,
        deeplApiKey: this.elements.deeplApiKey.value,
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

- [ ] **Step 3: Run the full verification sequence**

Run: `npm run type-check`
Expected: PASS (0 errors).

Run: `npm test`
Expected: PASS (11 tests, unaffected — `popup.ts` has no unit tests per existing project convention).

Run: `npm run build:dev`
Expected: PASS. Confirm `dist/popup.html` and `dist/popup.js` were rebuilt (check the file timestamps or just that the command exits 0 — no new webpack entries or files are introduced by this plan).

- [ ] **Step 4: Commit**

```bash
git add popup.html src/popup.ts
git commit -m "feat: add DeepL/Google provider selection to the popup UI"
```

---

## Self-Review

**Spec coverage:**
- Both providers supported, user picks one in settings → Task 1 (settings shape), Task 4 (popup UI).
- `ApiService.translateText()` external contract unchanged → Task 2 (verified: signature and `TranslationResult` shape identical; existing Google tests pass unmodified).
- Endpoint auto-detection from `:fx` key suffix → Task 2's `executeDeepLTranslate()`, tested by the "free-tier endpoint" and "pro-tier endpoint" tests.
- Language code mapping with `EN`→`EN-US`/`PT`→`PT-PT` defaults → Task 2's `toDeepLTarget()`, tested by the "maps en/pt target languages" test.
- Missing-key handling generalized across providers → Task 3's `maybeTranslate()` update.
- Screen Translate preserved unchanged → no task modifies `realTimeTranslate.ts`; it continues calling `apiService.translateText()` with no awareness of the provider change.

**Placeholder scan:** no "TBD"/"TODO"/"handle appropriately" markers; every step has literal code.

**Type consistency:** `TranslationSettings` (internal to `apiService.ts`) and `ExtensionSettings.translationProvider`/`deeplApiKey` (Task 1) use identical field names and the same `'google' | 'deepl'` union throughout Tasks 1-4. `PopupElements` in Task 4 names its new fields (`translationProvider`, `deeplApiKey`, `googleApiKeyGroup`, `deeplApiKeyGroup`) consistently between the interface declaration, `initializeElements()`, and `loadSettings()`/`saveSettings()`.
