# Add DeepL as a Selectable Translation Provider

Date: 2026-08-08
Status: Approved, ready for implementation planning

## Context

The extension currently translates exclusively through the Google Cloud
Translation API v2, via `ApiService.translateText()` in
`src/services/apiService.ts` (added in the
[client-side STT + translation redesign](2026-08-05-client-side-stt-translation-design.md)).
Google Translate's quality is adequate but DeepL is noticeably better for
its supported languages, and the developer wants the option to use either
without giving up Google's broader language coverage.

## Goals

- Support DeepL as a translation provider alongside Google Translate.
- User selects the active provider in the popup; each provider keeps its
  own separately-stored API key so switching providers doesn't require
  re-entering a key.
- `ApiService.translateText()`'s external contract
  (`Promise<TranslationResult>`, 3-string-arg signature) does not change —
  `background.ts` and `realTimeTranslate.ts` (Screen Translate) call it
  exactly as they do today, unaware of which provider is active.
- DeepL's free-tier vs. pro-tier endpoint is auto-detected from the API key
  itself (free keys end in `:fx`), with no extra UI for tier selection.

## Non-goals

- Automatic per-language provider selection (e.g. "use DeepL only for
  languages it supports, fall back to Google otherwise"). v1 is a single
  global provider choice.
- Migrating or validating previously-entered Google keys.
- Any change to the Screen Translate feature's UI or behavior beyond it
  continuing to work through whichever provider is active.

## Decisions

- **Both providers supported, explicit user choice** — not a full
  replacement of Google Translate, not an automatic fallback chain.
- **Endpoint auto-detection** — DeepL API keys ending in `:fx` are free-tier
  and use `https://api-free.deepl.com/v2/translate`; all other keys use
  `https://api.deepl.com/v2/translate`. This matches DeepL's own official
  client library behavior, so no separate Free/Pro toggle is needed.
- **Language code mapping via sensible defaults** — the existing
  lowercase-code language dropdown (`en`, `es`, `pt`, ...) is unchanged.
  Internally, codes are uppercased for DeepL, with `EN` → `EN-US` and
  `PT` → `PT-PT` as the default regional variants DeepL requires but Google
  does not. No new dropdown entries are added for regional variants.

## Architecture

### Settings

`ExtensionSettings` (`src/types/index.ts`) gains:

```ts
translationProvider: 'google' | 'deepl'; // default: 'google'
deeplApiKey: string;                     // default: ''
```

`googleTranslateApiKey` is unchanged and kept alongside `deeplApiKey` — both
keys are always stored, only one is read at translation time based on
`translationProvider`. Defaulting `translationProvider` to `'google'` means
existing users see no behavior change until they explicitly switch
providers in the popup.

### `apiService.ts` provider dispatch

`ApiService.translateText(text, sourceLanguage, targetLanguage)` keeps its
current signature and return type. Internally it now:

1. Reads `translationProvider` from `chrome.storage.sync`.
2. Dispatches to a private `translateWithGoogle()` (today's implementation,
   renamed) or a new `translateWithDeepL()`.
3. Both provider methods are wrapped by the existing `retryRequest()`
   exponential-backoff helper, so retry/timeout behavior is identical
   across providers.

### DeepL request/response mapping

DeepL's v2 REST API differs from Google's in every particular:

- **Endpoint**: chosen per the auto-detection rule above.
- **Auth**: `Authorization: DeepL-Auth-Key <key>` header — not a
  query-string key like Google.
- **Request body**: `{ text: [text], target_lang: 'ES' }`. `text` is an
  array (DeepL supports batch translation; this project always sends a
  single-element array). `source_lang` is omitted entirely for
  auto-detect — DeepL has no `"auto"` sentinel value.
- **Language codes**: uppercase. A `toDeepLTarget(code)` /
  `toDeepLSource(code)` mapping pair uppercases the code and special-cases
  `EN` → `EN-US` and `PT` → `PT-PT` for the target; source codes never need
  a regional suffix.
- **Response**: `{ translations: [{ detected_source_language, text }] }` is
  mapped into the same `TranslationResult { translatedText,
  detectedSourceLanguage }` shape the Google path already returns.
- **Errors**: DeepL returns `403` for an invalid key and `456` for
  quota-exceeded (vs. Google's `401`/`429`). Both are wrapped in the same
  `APIError` class used today. The missing-key check
  (`deeplApiKey`/`googleTranslateApiKey` empty in storage) still throws
  `APIError` client-side before any request is sent, matching the existing
  Google behavior `background.ts.maybeTranslate()` already handles.

### Popup UI

`popup.html` gets a new `<select id="translationProvider">` (options:
Google Translate / DeepL) above the API key section, plus a second
password input `#deeplApiKey` alongside the existing
`#googleTranslateApiKey`. `popup.ts` shows only the key field matching the
currently-selected provider; the hidden field retains its saved value so
toggling providers back and forth never loses either key.

## Testing Approach

`src/services/__tests__/apiService.test.ts` gets a parallel set of DeepL
tests mirroring the existing Google ones:

- Successful translate, asserting the correct endpoint is chosen for a
  `:fx`-suffixed key vs. a plain key.
- `source_lang` omitted from the request body when `sourceLanguage` is
  `'auto'`.
- Retry-on-500-then-succeed, reusing the existing fake-timer backoff test
  pattern.
- `APIError` thrown without calling `fetch` when `deeplApiKey` is empty in
  storage.

No new test infrastructure is needed — the existing
`(global as any).chrome`/`fetch` mocks are reused, parameterized by
`translationProvider: 'deepl'` in the mocked `chrome.storage.sync.get`
response. No popup UI tests are added, matching the existing project
convention (`popup.ts` has no unit tests today).

## Self-Review

**Placeholder scan**: no TBD/TODO markers; every decision above is
concrete enough to implement directly.

**Internal consistency**: `TranslationResult`'s shape is unchanged from the
existing Google-only implementation, so `background.ts`'s
`maybeTranslate()`/`translateText()` and `realTimeTranslate.ts` (Screen
Translate) require no changes — confirmed against the Goals section's
external-contract requirement.

**Scope check**: single focused change (one new provider, one new setting
pair, one UI addition) — no decomposition needed.

**Ambiguity check**: the only judgment call baked into this design is the
`EN`→`EN-US`/`PT`→`PT-PT` default regional mapping, which was made
explicit in the Decisions section rather than left for implementation time
to guess at.
