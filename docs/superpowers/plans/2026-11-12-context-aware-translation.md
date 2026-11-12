# Context-Aware Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude translates subtitles and captions with video context and a learned glossary, DeepL first then Claude ("fast then best"), behind an engine layer the piece-4 proxy can implement.

**Architecture:** A new `src/translation/` layer: pure, Node-runnable pieces (types, Claude prompt builder/parser, engines with injected config, glossary rules, cost table) plus a service-worker `TranslationService` that reads settings, batches Claude requests by priority, falls back to the fast engine, stores glossaries in `chrome.storage.local` and meters usage. Subtitle mode asks for a `fast` and/or `best` tier per line (timeline ranking already keeps the better one); audio captions get an in-place upgrade message. The popup gains engine/model/access settings and a glossary editor.

**Tech Stack:** TypeScript, Chrome MV3, `@anthropic-ai/sdk` (already a devDependency → move to dependencies; browser access enabled), Jest + jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-context-aware-translation-design.md`

## Global Constraints

- Models: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5`; every request `output_config: { effort: 'low' }` (Opus thinking can't be disabled).
- Prices per MTok (input / output / cache read / 5-min cache write): Opus 5.5 4 / 20 / 0.20 / 5; Sonnet 5.5 2 / 10 / 0.10 / 2.5; Haiku 5.5 0.10 / 0.50 / 0.01 / 0.125.
- Engine modes (setting `translationEngineMode`): `'fast-then-best'` (default) | `'fast'` | `'best'`. Fast engine = existing `translationProvider` (DeepL or Google).
- Claude access (setting `claudeAccess`): `'key'` (Anthropic key → `https://api.anthropic.com`) | `'gateway'` (`claudeGatewayUrl` + token, `claudeGatewayAuth`: `'x-api-key'` | `'bearer'`). Gateway URL: `https:` any host, or `http:` only for `127.0.0.1`/`localhost`.
- Secrets live only in `chrome.storage.local`: `deeplApiKey`, `googleTranslateApiKey`, `anthropicApiKey`, `claudeGatewayToken` — never `storage.sync`, logs, or the bundle. One-time migration moves existing keys out of sync.
- Always set explicit `cache_control: { type: 'ephemeral' }` breakpoints (system prefix and last user block) — some gateways require them.
- Live lines never wait for Claude in fast-then-best; Claude requests use the existing `PriorityRunner` (live before read-ahead).
- Claude never gets replaced by a fast translation (timeline `setTranslation` ranking); a line already on screen swaps at most once per glossary correction.
- Glossary entries: source ≤ 40 chars, target ≤ 80 chars, ≤ 200 entries per scope, newest wins on conflict.
- Test mocks: Anthropic mock at `/mock/anthropic` on the fixture server, reached via `devEndpointOverrides.anthropic` (loopback only, like DeepL). Real-Claude tests go through a fixture-server relay (`/relay/anthropic`) that adds credentials from the environment (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`); the extension never holds them.
- The manifest already has `host_permissions: ["https://*/*", "http://*/*"]`, so a gateway host needs no new permission (ruling vs. the spec's "optional host permission": nothing to request; record in ledger).

## Review Focus

1. Claude returns malformed JSON, missing/extra ids, or fewer translations than lines → each missing line falls back to the fast engine (or stays untranslated without one); nothing throws past the service. Test: Task 2 parser + Task 5 service.
2. Subtitle or description text that tries to steer the model ("ignore previous instructions…") → still translated as text; ids not in the request are ignored; output per line bounded (≤ 4× source length + 200 chars). Test: Task 2.
3. Misconfigured Claude access (gateway `http://example.com`, missing scheme, empty token; 401 from Claude) → popup rejects bad URLs; a 401 shows one error and falls back. Test: Task 8 (popup) + Task 5 (401).
4. Navigation or stop while a Claude batch is in flight → results for the old video never land on the new video's timeline or overlay. Test: Task 6.
5. Glossary poisoning/growth: conflicting entries (same source, two targets), huge entries, hundreds of terms → newest wins, bounded sizes, at most 200 sent. Test: Task 4.

---

### Task 1: Secrets move to `chrome.storage.local`

**Files:**
- Modify: `src/settings.ts`, `src/types/index.ts` (ExtensionSettings), `src/services/apiService.ts` (read keys via `getSecrets`), `src/popup.ts` (save/load keys to local), `src/background.ts` (`initializeSettings` runs the migration)
- Modify: `e2e/helpers/extension.ts` (`configure` routes secret keys to `storage.local`)
- Test: `src/__tests__/settings.test.ts`, `e2e/tests/popup.spec.ts`

**Interfaces:**
- Produces: `SECRET_KEYS: readonly ['deeplApiKey','googleTranslateApiKey','anthropicApiKey','claudeGatewayToken']`; `getSecrets(): Promise<Secrets>`; `setSecrets(p: Partial<Secrets>): Promise<void>`; `migrateSecretsFromSync(): Promise<void>`; new sync settings in `DEFAULT_SETTINGS`: `translationEngineMode: 'fast-then-best'`, `claudeModel: 'claude-opus-5-5'`, `claudeAccess: 'key'`, `claudeGatewayUrl: ''`, `claudeGatewayAuth: 'bearer'`.

- [ ] **Step 1: Write failing tests** — `settings.test.ts` with a chrome.storage fake (sync + local maps):
  - `migrateSecretsFromSync moves keys from sync to local and deletes them from sync` (sync `{deeplApiKey:'k:fx', targetLanguage:'en'}` → local has `deeplApiKey:'k:fx'`, sync has no `deeplApiKey`, `targetLanguage` stays).
  - `migration never overwrites a key already in local`.
  - `getSettings() contains no secret keys` and `getSecrets() reads local only`.
  - E2E `popup.spec.ts`: `API keys are saved to local storage, never sync` (fill DeepL key, save; `sw.evaluate` → `storage.sync.get(null)` has none of SECRET_KEYS, `storage.local` has `deeplApiKey`).
- [ ] **Step 2: Run** `npx jest src/__tests__/settings.test.ts` → FAIL (exports missing).
- [ ] **Step 3: Implement** the functions above; `getSettings()` returns only non-secret sync settings; apiService/popup use `getSecrets`/`setSecrets`; `initializeSettings` awaits `migrateSecretsFromSync()` first. `configure()` in the harness writes SECRET_KEYS to local, the rest to sync.
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=ui` → all pass.
- [ ] **Step 5: Commit** `feat: API keys live only in local storage (migrated from sync)`.

### Task 2: Translation core — types, Claude prompt builder/parser, costs (pure)

**Files:**
- Create: `src/translation/types.ts`, `src/translation/claudePrompt.ts`, `src/translation/costs.ts`
- Test: `src/translation/__tests__/claudePrompt.test.ts`, `src/translation/__tests__/costs.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  type ClaudeModel = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5';
  interface VideoContext { videoId: string | null; url: string; title: string; channel: string; description: string }
  interface GlossaryEntry { source: string; target: string; note?: string }
  interface LineRequest { id: string; text: string; previous: string[]; next: string[] }
  interface TranslateBatchRequest { sourceLang: string; targetLang: string; lines: LineRequest[]; video: VideoContext; topic: string | null; glossary: GlossaryEntry[] }
  interface Usage { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  interface TranslateBatchResult { translations: { id: string; text: string }[]; glossaryUpdates: GlossaryEntry[]; usage?: Usage }
  interface TopicResult { topic: string; topicKey: string; glossary: GlossaryEntry[]; usage?: Usage }
  interface TranslationEngine { readonly id: 'deepl' | 'google' | 'claude'; translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResult> }
  ```
- Produces (claudePrompt.ts): `buildTranslateMessages(req): { system: TextBlockParam[]; messages: MessageParam[] }`, `parseTranslateResponse(text: string, req: TranslateBatchRequest): { translations; glossaryUpdates }`, `buildTopicMessages(video: VideoContext, firstLines: string[], sourceLang: string, targetLang: string)`, `parseTopicResponse(text: string): Omit<TopicResult,'usage'>`, `normalizeTopicKey(s: string): string`.
- Produces (costs.ts): `PRICES: Record<ClaudeModel, {input, output, cacheRead, cacheWrite}>` (USD per MTok, Global Constraints values), `costUsd(u: Usage): number`.
- Response format (my call, spec leaves it open): the model replies with one JSON object `{"translations":[{"id":"L1","text":"…"}],"glossary":[{"source":"뽀삐","target":"Poppy","note":"champion"}]}`; topic call replies `{"topic":"…","topicKey":"…","glossary":[…]}`. Untrusted page text (title, description, lines) sits inside `<video_context>`/`<lines>` tags with an instruction that it is data to translate, never instructions.

- [ ] **Step 1: Write failing tests** (`claudePrompt.test.ts`):
  - `system prompt carries video context, topic and glossary, with a cache breakpoint on the last system block` (asserts title/description/`뽀삐 → Poppy` appear; last system block has `cache_control.type === 'ephemeral'`; last user block too).
  - `each line is sent with its id and neighbouring lines`.
  - `parses translations and glossary updates; tolerates prose or code fences around the JSON`.
  - `ignores ids that were not requested and caps each translation at 4x source + 200 chars`.
  - `returns only the ids it found when the reply is truncated or not JSON` (garbage → `translations: []`).
  - `normalizeTopicKey('League of Legends (KR)!') === 'league-of-legends-kr'`, max 40 chars.
  - `costs.test.ts`: `costUsd` for Opus `{in:1_000_000,out:0}` = 4, cache read 1M = 0.2; Haiku output 1M = 0.5.
- [ ] **Step 2: Run** `npx jest src/translation` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules (no `chrome.*`, no DOM — must run in Node).
- [ ] **Step 4: Run** `npx jest src/translation` → PASS.
- [ ] **Step 5: Commit** `feat: translation core types, Claude prompt builder/parser, cost table`.

### Task 3: Engines — Claude (key or gateway), DeepL, Google; Anthropic mock

**Files:**
- Create: `src/translation/engines/claude.ts`, `src/translation/engines/deepl.ts`, `src/translation/engines/google.ts`
- Modify: `src/services/apiService.ts` (DeepL/Google HTTP moves into the engines; `apiService.translateText` stays for Screen Translate and becomes a thin wrapper over the fast engine), `package.json` (`@anthropic-ai/sdk` → dependencies), `e2e/helpers/server.ts` (`/mock/anthropic/v1/messages`), `e2e/helpers/extension.ts` (`devEndpointOverrides.anthropic`)
- Test: `src/translation/__tests__/engines.test.ts`

**Interfaces:**
- Consumes: Task 2 types, `buildTranslateMessages`, `parseTranslateResponse`, `buildTopicMessages`, `parseTopicResponse`.
- Produces:
  ```ts
  interface ClaudeConfig { model: ClaudeModel; baseURL: string; auth: { kind: 'x-api-key' | 'bearer'; token: string }; fetch?: typeof fetch }
  class ClaudeEngine implements TranslationEngine { constructor(cfg: ClaudeConfig); translateBatch(req): Promise<TranslateBatchResult>; summarizeTopic(video: VideoContext, firstLines: string[], sourceLang: string, targetLang: string): Promise<TopicResult> }
  class DeepLEngine implements TranslationEngine { constructor(cfg: { apiKey: string; endpoint?: string; fetch?: typeof fetch }) }
  class GoogleEngine implements TranslationEngine { constructor(cfg: { apiKey: string; endpoint?: string; fetch?: typeof fetch }) }
  function validateGatewayUrl(url: string): string | null   // normalized URL or null
  ```
  ClaudeEngine uses `new Anthropic({ baseURL, apiKey | authToken, dangerouslyAllowBrowser: true, fetch, maxRetries: 2 })`, `max_tokens: 2000`, `output_config: { effort: 'low' }`; `usage` mapped from the response. DeepL/Google engines translate each line with its neighbours (DeepL `context`), keeping today's language-code mapping and retry rules.
- Mock (server.ts): `POST /mock/anthropic/v1/messages` records `{provider:'anthropic', model, system, messages, authorization, xApiKey}` in `translationCalls`, waits 400 ms, and replies with a Messages-API JSON body whose text is `{"translations":[{id, text:"[CLAUDE] <line text>"}…],"glossary":[…]}` — glossary `{"source":"뽀삐","target":"Poppy"}` whenever a line contains 뽀삐; for topic requests (system mentions `topicKey`) `{"topic":"League of Legends stream","topicKey":"league-of-legends","glossary":[{"source":"렙차","target":"level gap"}]}`. `?status=429` style switch: `server.setAnthropicFailure(status | null)`.

- [ ] **Step 1: Write failing tests** (`engines.test.ts`, fake `fetch`):
  - `ClaudeEngine sends x-api-key for key access and Authorization Bearer for bearer gateways, to the configured base URL`.
  - `ClaudeEngine parses translations, glossary and usage`.
  - `ClaudeEngine.summarizeTopic returns topic, normalized topicKey and glossary`.
  - `DeepLEngine sends neighbouring lines as context and maps zh-Hans source to ZH` (port of existing apiService cases).
  - `validateGatewayUrl` accepts `https://gw.example/v1` and `http://127.0.0.1:8787`, rejects `http://example.com`, `gw.example`, `javascript:alert(1)`, `''`.
- [ ] **Step 2: Run** `npx jest src/translation src/services` → FAIL.
- [ ] **Step 3: Implement** engines, mock route and override; existing `apiService.test.ts` cases keep passing (move the DeepL/Google ones to `engines.test.ts` where they now belong).
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=ui` → PASS.
- [ ] **Step 5: Commit** `feat: translation engines (Claude key/gateway, DeepL, Google) + Anthropic mock`.

### Task 4: Glossary store and topics

**Files:**
- Create: `src/translation/glossary.ts`
- Test: `src/translation/__tests__/glossary.test.ts`

**Interfaces:**
- Consumes: `GlossaryEntry`, `normalizeTopicKey`.
- Produces:
  ```ts
  interface StorageArea { get(keys: string | string[]): Promise<Record<string, any>>; set(items: Record<string, any>): Promise<void> }
  class GlossaryStore {
    constructor(area: StorageArea)                       // chrome.storage.local in the extension
    getVideoMeta(videoKey: string): Promise<{ topic: string; topicKey: string; version: number } | null>
    setVideoMeta(videoKey: string, meta: { topic: string; topicKey: string }): Promise<void>
    effective(videoKey: string): Promise<GlossaryEntry[]>  // topic ∪ video, video wins, ≤ 200, newest first
    learn(videoKey: string, entries: GlossaryEntry[]): Promise<void>   // into video + topic scopes
    edit(videoKey: string, source: string, target: string | null): Promise<number>  // user correction/delete → new version
    list(videoKey: string): Promise<{ topic: string | null; entries: (GlossaryEntry & { scope: 'video' | 'topic' })[]; version: number }>
  }
  ```
  Storage keys: `glossary:video:<videoKey>`, `glossary:topic:<topicKey>`, `glossary:meta:<videoKey>`. `videoKey` = site-scoped video id from `videoIdFrom` or the page URL.

- [ ] **Step 1: Write failing tests** with an in-memory StorageArea:
  - `learned terms are shared with the next video on the same topic`.
  - `video entries win over topic entries; newest wins on conflicting targets`.
  - `entries are bounded (source ≤ 40, target ≤ 80 chars; oversized dropped) and at most 200 are returned`.
  - `edit() bumps the version; edit(target=null) deletes from both scopes`.
- [ ] **Step 2: Run** `npx jest src/translation/__tests__/glossary.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: per-video and per-topic glossary store`.

### Task 5: TranslationService (service worker)

**Files:**
- Create: `src/translation/translationService.ts`, `src/translation/claudeBatcher.ts`
- Modify: `src/background.ts` (`TRANSLATE_SUBTITLE_LINE` → service; new `GET_TRANSLATION_PLAN`, `GET_GLOSSARY`, `EDIT_GLOSSARY_ENTRY`; usage persisted), `src/types/index.ts` (message types)
- Test: `src/translation/__tests__/translationService.test.ts`, `src/translation/__tests__/claudeBatcher.test.ts`

**Interfaces:**
- Consumes: engines (Task 3), GlossaryStore (Task 4), `PriorityRunner`, `getSettings`/`getSecrets` (Task 1), `costUsd`.
- Produces:
  ```ts
  type Tier = 'fast' | 'best';
  interface TranslationPlan { fast: boolean; best: boolean }
  interface LineTranslateRequest { tier: Tier; text: string; sourceLang: string; previousLines: string[]; nextLines: string[]; priority: 'live' | 'readahead'; video: VideoContext }
  interface LineTranslateResponse { success: boolean; translatedText?: string; quality?: 'fast' | 'better'; engine?: 'deepl' | 'google' | 'claude'; error?: string }
  class TranslationService {
    constructor(deps: { settings(): Promise<…>; secrets(): Promise<Secrets>; glossary: GlossaryStore; makeClaude(cfg: ClaudeConfig): ClaudeEngine; makeFast(…): TranslationEngine; usage: UsageMeter })
    plan(): Promise<TranslationPlan>
    translateLine(req: LineTranslateRequest): Promise<LineTranslateResponse>
  }
  class ClaudeBatcher { constructor(opts: { maxLines: 8; windowMs: 150; run(batch): Promise<…> }); add(line, priority): Promise<string | null> }
  interface UsageMeter { record(u: Usage): Promise<void>; totals(): Promise<{ lines: number; costUsd: number; byModel: Record<string, Usage & { costUsd: number }> }> }  // chrome.storage.local 'translationUsage'
  ```
  Rules: `plan()` = mode `fast` → {fast:true,best:false}; `best` → {fast:false,best:hasClaude}; `fast-then-best` → {fast:true,best:hasClaude}; hasClaude = key access with `anthropicApiKey`, or gateway with valid URL + token. First `best` request for a video runs `summarizeTopic` once (concurrent callers share it), stores meta, learns its glossary. Live best lines are sent immediately (alone); read-ahead lines batch (≤ 8 lines or 150 ms). Results' glossary updates go to `learn()`. Claude failure for a line → fast engine if it has a key (`quality:'fast'`), else `{success:false}`. Claude 401 → error message "Claude rejected the key" returned once per session in `error`, then quiet fallback.

- [ ] **Step 1: Write failing tests** (fake engines, in-memory storage):
  - `plan reflects mode and configured Claude access` (four cases incl. gateway without token → best:false).
  - `fast tier uses the fast engine; best tier uses Claude with topic and glossary`.
  - `the topic is summarised once per video even with concurrent requests`.
  - `read-ahead lines are batched; a live line is not held for the batch window`.
  - `Claude failure falls back to the fast engine; with no fast key the line fails`.
  - `missing translations in a Claude reply fall back per line`.
  - `glossary updates from replies are learned and sent with the next request`.
  - `usage is recorded with cost`.
- [ ] **Step 2: Run** `npx jest src/translation` → FAIL.
- [ ] **Step 3: Implement**; wire into `background.ts` (Claude/fast engines built from settings + secrets + `devEndpointOverrides`); keep the language-equal short-circuit.
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=ui` → PASS.
- [ ] **Step 5: Commit** `feat: translation service - fast/best tiers, batching, topic, glossary, fallback, usage`.

### Task 6: Subtitle mode — fast then best, video context, glossary corrections

**Files:**
- Create: `src/subtitle/videoContext.ts` (+ test)
- Modify: `src/subtitle/subtitleMode.ts`, `src/subtitle/index.ts`, `e2e/fixtures/pages/video-subs.html` (League title/description meta), `e2e/tests/subtitle-mode.spec.ts` or new `e2e/tests/subtitle-claude.spec.ts`
- Test: `src/subtitle/__tests__/videoContext.test.ts`, `src/subtitle/__tests__/subtitleMode.test.ts` (extend)

**Interfaces:**
- Consumes: `TranslationPlan`, `LineTranslateRequest/Response`, message `GLOSSARY_CHANGED { terms: string[] }` (sent by Task 8's edit path through the background).
- Produces: `readVideoContext(doc: Document, url: string): VideoContext` (YouTube: title without " - YouTube", channel from `ytd-channel-name a` / `[itemprop=author] [itemprop=name]`, description from `meta[name=description]`; others: `document.title`, `meta[name=description]`, `og:site_name`; description ≤ 1000 chars); `SubtitleModeDeps.plan: TranslationPlan`; `TranslateRequest` gains `tier` and `video`; `SubtitleMode.onGlossaryChanged(terms: string[]): void`.
  Behaviour: per new line, request `fast` if plan.fast and `best` if plan.best, concurrently; each response → `timeline.setTranslation(start, text, quality)`; overlay updates only if the line is current/not yet shown and the stored translation changed. `onGlossaryChanged`: lines whose source contains any term get a new `best` request; the result replaces the stored translation even at equal rank (`setTranslation(..., 'better', { force: true })`).

- [ ] **Step 1: Write failing tests**:
  - `videoContext.test.ts`: `reads YouTube title, channel and description`; `falls back to document title and meta description elsewhere`; `caps description at 1000 chars`.
  - `subtitleMode.test.ts`: `fast then best: the fast translation shows first, then Claude's replaces it once`; `best only shows nothing until Claude answers`; `a best answer arriving after stop() or for the previous video is dropped` (Review Focus 4); `a glossary correction re-translates matching lines and swaps the one on screen once`.
  - E2E `subtitle-claude.spec.ts` (subtitles project, mock Claude + mock DeepL, read-ahead off): `overlay shows DeepL then Claude's version` (overlay text goes `[EN-US] …` → `[CLAUDE] …`); `Claude requests carry the page title and the learned glossary` (a later anthropic call's system text contains `Poppy` after a 뽀삐 line); `Claude 429 keeps DeepL translations on screen`.
  - E2E (read-ahead on, mock Claude): `with read-ahead, ≥ 90% of lines have Claude's translation before they appear`.
- [ ] **Step 2: Run** jest (FAIL) and, after `npm run build`, the new E2E spec (FAIL).
- [ ] **Step 3: Implement**; `index.ts` asks `GET_TRANSLATION_PLAN` at start, reads `readVideoContext(document, location.href)` per start/navigation, forwards `GLOSSARY_CHANGED` to the running mode.
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=subtitles` → PASS (existing subtitle tests unchanged: they configure DeepL only, so plan = fast only).
- [ ] **Step 5: Commit** `feat: subtitle mode uses fast-then-best translation with video context and glossary`.

### Task 7: Audio mode — fast then best captions

**Files:**
- Modify: `src/background.ts` (`maybeTranslate` → TranslationService with previous captions as context; sends `DISPLAY_SUBTITLE { captionId }` then `UPGRADE_SUBTITLE { captionId, text }`), `src/content.ts` (caption lines keep `data-caption-id`; upgrade replaces text only if the line is still displayed), `src/types/index.ts`
- Test: `src/__tests__/content.test.ts` (extend), `e2e/tests/captions.spec.ts` (or the existing captions spec)

**Interfaces:**
- Consumes: `TranslationService.translateLine`, `readVideoContext` (via `GET_VIDEO_CONTEXT` message answered by `subtitle.js`).
- Produces: messages `DISPLAY_SUBTITLE { text, captionId: string }`, `UPGRADE_SUBTITLE { captionId, text }`. Background keeps the last 3 captions per tab (source + best-or-fast translation) in `chrome.storage.session` as `previousLines`.

- [ ] **Step 1: Write failing tests**: `content.test.ts` — `an upgrade replaces a displayed caption's text` and `an upgrade for a caption no longer shown is ignored`; E2E captions (mock DeepL + mock Claude) — `a spoken caption is shown with DeepL then upgraded to Claude's text`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=captions` → PASS.
- [ ] **Step 5: Commit** `feat: audio captions upgrade to Claude's context-aware translation`.

### Task 8: Popup — engine settings, Claude access, glossary editor

**Files:**
- Modify: `popup.html`, `src/popup.ts` (`ELEMENT_IDS` table), `src/background.ts` (`GET_GLOSSARY { tabId }`, `EDIT_GLOSSARY_ENTRY { tabId, source, target|null }` → `GlossaryStore.edit` → `GLOSSARY_CHANGED` to the tab)
- Test: `src/__tests__/popup.test.ts`, `e2e/tests/popup.spec.ts`

**Interfaces:**
- Consumes: settings/secrets (Task 1), `validateGatewayUrl` (Task 3), GlossaryStore list/edit (Task 4).
- Produces UI ids: `#engineMode` (select: Fast then best / Fast only / Best only), `#claudeModel` (Opus 5.5 / Sonnet 5.5 / Haiku 5.5), `#claudeAccess` (radio key/gateway), `#anthropicApiKey`, `#claudeGatewayUrl`, `#claudeGatewayToken`, `#claudeGatewayAuth` (select x-api-key/bearer), `#claudeStatus` (error text), `#glossaryList` (rows: source, editable target, delete), `#glossaryTopic`. Without Claude access, `Fast then best`/`Best only` options show "(needs Claude access)" and the plan falls back to fast.

- [ ] **Step 1: Write failing tests**: unit — `rejects an http gateway URL that is not loopback with a visible message`; E2E — `engine and Claude settings persist (secrets to local, the rest to sync)`; `gateway mode sends the token with the chosen auth style to the gateway` (mock as gateway: `claudeGatewayUrl = <server>/mock/anthropic`, auth bearer → recorded `authorization: Bearer <token>`); `glossary editor lists learned terms and a correction re-translates the line on screen` (subtitles project: after a 뽀삐 line, edit Poppy → "Poppy (champ)" in the popup; overlay/timeline line gets the re-translation request).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest && npm run build && npx playwright test --project=ui --project=subtitles` → PASS. Look at the popup screenshot the test writes.
- [ ] **Step 5: Commit** `feat: popup engine settings, Claude key/gateway access, glossary editor`.

### Task 9: Real Claude end to end (live) + cost

**Files:**
- Modify: `e2e/helpers/server.ts` (`/relay/anthropic/*` → `ANTHROPIC_BASE_URL` with env credentials; 404 when unset), `e2e/tests/live-subtitles.spec.ts` (new tests), `e2e/tests/judge-subtitles.spec.ts` (scores the Claude run too), `docs/performance.md`, `docs/milestones.md`, `README.md`
- Test: `e2e/tests/live-subtitles.spec.ts`

**Interfaces:**
- Consumes: everything above. Extension configured in gateway mode at `<server>/relay/anthropic` (token `relay`, auth bearer), DeepL real key from `.env`, default mode fast-then-best, model Opus 5.5.

- [ ] **Step 1: Write the tests** (skip unless DeepL key and Anthropic env credentials exist): `real Claude: default configuration translates stretch s1 with League terms` — writes `e2e/.perf/subtitle-quality-claude-<browser>.json` (pairs ko/en/reference + per-line quality + engine), asserts every line shown in time, key terms right in ≥ 10/11 lines, ≥ 90% of lines had Claude's translation before they appeared, one spelling per name across lines (glossary consistency: for each glossary source term, all lines containing it use the same target); `cost per line and per hour is reported` (reads `translationUsage`, writes cost/line and cost/hour at the stretch's line rate).
  Judge (`E2E_JUDGE=1`): scores the Claude file; asserts `translationJudgeScore ≥ 0.80`.
- [ ] **Step 2: Run** `npx playwright test --project=live` → expect FAIL before the relay exists (or first real-run failures to fix).
- [ ] **Step 3: Implement** the relay; fix what the real run shows (prompt wording, batching).
- [ ] **Step 4: Run** `npm run test:live && E2E_JUDGE=1 npx playwright test --project=judge` (Chromium, and Chrome via `E2E_BROWSER=chrome`) → PASS; record numbers in `docs/performance.md` (quality, latency to Claude version, cost/line and /hour per model — run Sonnet and Haiku once each via the same test with `CLAUDE_MODEL` env) and a milestone.
- [ ] **Step 5: Commit** `test: real Claude end to end - quality, consistency, cost`.

### Task 10: Generality benchmark (non-gaming domains)

**Files:**
- Create: `e2e/scripts/fetch_domain_lines.py` (yt-dlp human-made subtitle tracks → JSON), `e2e/fixtures/domains/{football-es,anime-ja,drama-ko}.json` (`{title, description, channel, sourceLang, url, lines: string[]}`, 30–40 consecutive real lines each), `e2e/tests/domain-bench.spec.ts` (judge project)
- Modify: `docs/performance.md`, `docs/milestones.md`

**Interfaces:**
- Consumes: `ClaudeEngine` (Node, credentials from env), `DeepLEngine` (key from `.env`), `buildTranslateMessages` etc. — run directly in Node, no browser (this also proves the engine layer is server-capable for piece 4).

- [ ] **Step 1: Write the test** `context-aware Claude beats DeepL in every domain`: for each domain, translate all lines with DeepL (neighbouring context) and Claude (video context + neighbours + glossary learned along the way, batches of 8); a blind pairwise judge (`claude-opus-5-5`, effort low, A/B order randomized per line with a fixed seed, reference-free: "which English subtitle is more accurate and natural for this video?") → per-domain Claude win rate; asserts > 0.5 in every domain; writes `e2e/.perf/domain-bench.json`.
- [ ] **Step 2: Run** `E2E_JUDGE=1 npx playwright test --project=judge -g domain` → FAIL until fixtures exist.
- [ ] **Step 3: Fetch fixtures** with the script (videos with human-made subtitle tracks in es/ja/ko; record URLs in the JSON); commit the JSON.
- [ ] **Step 4: Run** → PASS; add per-domain numbers to `docs/performance.md` and a milestone.
- [ ] **Step 5: Commit** `test: cross-domain translation benchmark (football, anime, drama)`.
