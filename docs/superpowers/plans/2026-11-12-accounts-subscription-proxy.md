# Accounts, Subscription and Hosted Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email-code accounts, a subscription flag (Stripe or manual), and a hosted translation proxy that subscribers use from the extension with no API keys, within a per-plan monthly cost budget.

**Architecture:** `server/` — a Hono app (`createApp(deps)`) over a SQLite repository, reusing the extension's browser-independent engines (`src/translation/engines/*`) with the service's own keys; Stripe for Checkout/Portal/webhooks; built with esbuild into one file and shipped as a Docker image for Cloud Run. The extension gets a proxy engine and an account section in the popup.

**Tech Stack:** Node 22, TypeScript, Hono + @hono/node-server, `node:sqlite`, `stripe`, esbuild, Jest (node env for server tests), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-accounts-subscription-proxy-design.md` (pricing inputs: `docs/pricing.md`)

## Global Constraints

- Plans (server/src/plans.ts, from docs/pricing.md): `standard` $9.99/month, budget $6.00, default best model `claude-sonnet-5-5`; `pro` $24.99/month, budget $17.00, default `claude-opus-5-5`. Budget covers all proxied cost (Claude via `costUsd`, DeepL at $25 per 1M characters). Warn at 80 %, refuse at 100 %.
- Login code: 6 digits, valid 10 minutes, 5 verify attempts, ≤ 3 codes per email per 15 min and ≤ 20 per IP per hour; codes and session tokens stored as SHA-256 hex; session tokens 32 random bytes (base64url).
- API paths exactly as in the spec (`/v1/auth/start|verify|signout`, `/v1/me`, `/v1/translate/fast|batch|topic`, `/v1/billing/checkout|portal`, `/v1/stripe/webhook`, `/v1/admin/plan`, plus `/health`).
- Request limits: batch ≤ 16 lines, each text ≤ 500 chars, previous/next ≤ 4 lines each, glossary ≤ 200 entries, body ≤ 64 KB → 400 otherwise, before any upstream call.
- Errors: 401 `unauthorized`, 402 `not_subscribed` / `budget_exhausted`, 429 `rate_limited`, 400 `bad_request`; JSON `{ error: code, message }`.
- The service's keys (Anthropic, DeepL, Stripe, Resend, admin token) only in server env; never in responses, logs or the extension.
- Extension: account token is a secret (`SECRET_KEYS` gains `accountToken`); server URL setting `serverUrl` (default `https://api.autosubtitle.app` placeholder until deployed — ruling), dev override `devEndpointOverrides.server` loopback-only.
- BYOK unchanged: users with keys and no account keep working.

## Review Focus

1. Stolen/expired/revoked token, or a plan that just lapsed (Stripe `customer.subscription.deleted` / `invoice.payment_failed` → status not active) → 401/402 on the very next request. Test: Task 2 (revoked), Task 4 (lapsed).
2. Concurrent requests at the budget edge → spend may exceed the budget by at most the requests already in flight; a new month starts at zero. Test: Task 3.
3. Forged or replayed Stripe webhooks → signature required; the same event id is applied once. Test: Task 4.
4. Login abuse (guessing codes, email bombing, reusing a code) → 5 attempts then the code is dead; rate limits; a code works once. Test: Task 2.
5. Oversized or malformed translate bodies → 400 with no upstream call (no spend). Test: Task 3.

---

### Task 1: Server skeleton — config, repository, plans, health, build

**Files:** Create `server/src/{config.ts,db.ts,plans.ts,app.ts,main.ts}`, `server/tsconfig.json`, `server/src/__tests__/db.test.ts`, `server/src/__tests__/app.test.ts`; modify root `package.json` (deps `hono`, `@hono/node-server`, `stripe`; dev `esbuild`; scripts `server:build`, `server:dev`, `server:test`), `jest.config.js` (roots include `server/src`), root `tsconfig.json` (exclude `server`).

**Interfaces — Produces:**
```ts
// config.ts
interface ServerConfig { port: number; dbPath: string; publicUrl: string; adminToken: string; anthropic: { baseURL: string; apiKey?: string; authToken?: string }; deepl: { apiKey: string; endpoint?: string }; stripe: { secretKey: string; webhookSecret: string; prices: { standard: string; pro: string } }; mail: { resendApiKey?: string; from: string }; devOutbox: boolean }
function loadConfig(env: NodeJS.ProcessEnv): ServerConfig
// plans.ts
type Plan = 'free' | 'standard' | 'pro'; const PLANS: Record<'standard'|'pro', { priceUsd: number; budgetUsd: number; bestModel: ClaudeModel }>; const DEEPL_USD_PER_CHAR = 25 / 1_000_000; function isActive(status: string | null): boolean // 'active' | 'trialing'
// db.ts — class Repo(path: string) over node:sqlite, tables: accounts(id, email UNIQUE, plan, subscription_status, stripe_customer_id, created_at), login_codes(email, code_hash, expires_at, attempts, used), sessions(token_hash PK, account_id, created_at, revoked), usage(account_id, month 'YYYY-MM', cost_usd, claude_requests, fast_chars, PK(account_id, month)), stripe_events(id PK), rate_events(key, at)
//   upsertAccount(email): Account; accountByEmail/ById; setPlan(id, plan, status, customerId?); accountByCustomer(customerId)
//   addCode/latestCode/markCodeAttempt/markCodeUsed; addSession(hash, accountId)/sessionAccount(hash)/revokeSession(hash)
//   addUsage(accountId, month, {costUsd, claudeRequests, fastChars}); usageFor(accountId, month)
//   recordStripeEvent(id): boolean (false if seen); countRateEvents(key, sinceMs)/addRateEvent(key)
// app.ts
function createApp(deps: AppDeps): Hono  // AppDeps: { config, repo, mailer, stripe, fetch?, clock? }
```
- [ ] **Step 1: tests** — `db.test.ts`: `accounts are created once per email (case-insensitive)`, `usage accumulates per account and month`, `a stripe event id is recorded once`. `app.test.ts`: `GET /health returns ok`.
- [ ] **Step 2: run** `npm run server:test` → FAIL (modules missing).
- [ ] **Step 3: implement**; emails lower-cased/trimmed; `month = new Date(clock()).toISOString().slice(0,7)`.
- [ ] **Step 4: run** `npm run server:test && npm run server:build` → PASS, `server/dist/main.js` exists.
- [ ] **Step 5: commit** `feat(server): skeleton - config, SQLite repository, plans, health, build`.

### Task 2: Accounts — email code sign-in, sessions, /v1/me

**Files:** Create `server/src/{auth.ts,mailer.ts}`, `server/src/__tests__/auth.test.ts`; modify `app.ts`.

**Interfaces — Produces:** `interface Mailer { send(to: string, subject: string, text: string): Promise<void> }`; `class OutboxMailer implements Mailer { readonly sent: {to,subject,text}[] }` (also exposed at `GET /dev/outbox?email=` only when `devOutbox`); `class ResendMailer`; `requireAccount` middleware setting `c.var.account`; `GET /v1/me` → `{ email, plan, status, active, month, usageUsd, budgetUsd, warn: boolean, exhausted: boolean }`.
- [ ] **Step 1: tests** — `sign-in: start emails a 6-digit code, verify returns a token that authenticates /v1/me`; `a code works once and expires after 10 minutes`; `5 wrong attempts kill the code`; `more than 3 codes per email per 15 minutes is rate limited (429)`; `signout revokes the token (401 after)`; `tokens and codes are stored hashed` (repo rows don't contain the raw values); `/v1/me without or with a bad token is 401`.
- [ ] **Step 2–4:** RED → implement (constant-time compare via `crypto.timingSafeEqual` on hashes) → GREEN.
- [ ] **Step 5: commit** `feat(server): email-code accounts and sessions`.

### Task 3: Translation proxy — gating, validation, metering, budget

**Files:** Create `server/src/translate.ts`, `server/src/__tests__/translate.test.ts`; modify `app.ts`.

**Interfaces — Consumes:** `ClaudeEngine`, `DeepLEngine`, `costUsd` from `src/translation/*`; Task 1/2 repo and middleware. **Produces:** routes `POST /v1/translate/fast` → `{ text }`, `/v1/translate/batch` → `TranslateBatchResult` (without usage), `/v1/translate/topic` → `TopicResult` (without usage). Model: `body.model` if it is one of the three Claude models and allowed for the plan (standard: Sonnet/Haiku; pro: all), else the plan's default.
- [ ] **Step 1: tests** (fake upstream `fetch`): `a non-subscriber gets 402 not_subscribed`; `a subscriber gets translations and the cost is recorded` (usage row increases by costUsd of the fake usage); `fast translation meters DeepL characters`; `at 100 % of the budget the Claude tier and fast tier return 402 budget_exhausted; /v1/me reports exhausted`; `a new month starts with an empty budget`; `oversized or malformed bodies are 400 and never reach upstream` (17 lines, 600-char text, glossary 201, non-JSON); `standard cannot select Opus (falls back to Sonnet)`.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: commit** `feat(server): subscriber translation proxy with metering and budgets`.

### Task 4: Billing — Stripe Checkout/Portal/webhooks, manual flag

**Files:** Create `server/src/billing.ts`, `server/src/admin.ts` (CLI: `node server/dist/admin.js set-plan <email> <plan> [status]`), `server/src/__tests__/billing.test.ts`; modify `app.ts`, `package.json` (`admin` script).

**Interfaces — Produces:** `interface StripeLike { checkout: { sessions: { create(p): Promise<{ url }> } }; billingPortal: { sessions: { create(p): Promise<{ url }> } }; webhooks: { constructEvent(body, sig, secret): Stripe.Event } }` (real `Stripe` satisfies it); routes `POST /v1/billing/checkout {plan}` → `{ url }` (Checkout `mode: 'subscription'`, `client_reference_id: account.id`, `customer_email`), `POST /v1/billing/portal` → `{ url }`, `POST /v1/stripe/webhook`, `POST /v1/admin/plan {email, plan, status}` (header `x-admin-token`).
- [ ] **Step 1: tests** (real `stripe.webhooks.generateTestHeaderString` for signatures; fake checkout/portal): `checkout returns the Stripe URL for the chosen plan's price`; `checkout.session.completed activates the plan for client_reference_id`; `customer.subscription.updated/deleted and invoice.payment_failed update or lapse the flag`; `a webhook without a valid signature is 400 and changes nothing`; `the same event delivered twice is applied once`; `admin endpoint requires the admin token and sets the plan`; `admin CLI set-plan sets the plan` (runs the function, not a subprocess).
- [ ] **Step 2–4:** RED → implement (plan from the price id in the subscription item; status from the subscription) → GREEN.
- [ ] **Step 5: commit** `feat(server): Stripe billing and manual plan management`.

### Task 5: Deploy artefacts

**Files:** Create `server/Dockerfile` (node:22-slim, copies `server/dist`, `CMD node main.js`, `DB_PATH=/data/app.db`), `server/deploy/cloudrun.sh` (build + `gcloud run deploy` with `--max-instances 1`, secrets from Secret Manager, volume mount for /data), `server/README.md` (env vars, Stripe products/prices/webhook setup, Resend, deploy checklist, admin CLI), `server/src/__tests__/smoke.test.ts`.
- [ ] **Step 1: test** `smoke: the built server starts and answers /health` (spawns `node server/dist/main.js` on a free port with a temp DB and `DEV_OUTBOX=1`).
- [ ] **Step 2–4:** RED (before build script handles it) → implement → GREEN; `docker build` if Docker exists (ledger otherwise).
- [ ] **Step 5: commit** `chore(server): Docker image, Cloud Run deploy script, operator guide`.

### Task 6: Extension — subscription engines and account messages

**Files:** Create `src/translation/engines/proxy.ts`, `src/translation/__tests__/proxy.test.ts`; modify `src/settings.ts` (secret `accountToken`, setting `serverUrl`, `claudeAccess: 'subscription'` and `translationProvider: 'subscription'`), `src/types/index.ts`, `src/translation/translationService.ts` (engines from subscription), `src/services/apiService.ts` (fast engine for 'subscription'; override `server`), `src/background.ts` (messages `ACCOUNT_START`, `ACCOUNT_VERIFY`, `ACCOUNT_SIGNOUT`, `ACCOUNT_STATUS`, `BILLING_OPEN {plan?}` → opens Checkout/Portal URL in a new tab).

**Interfaces — Produces:** `class ProxyClient { constructor(cfg: { baseURL: string; token: string; fetch?: typeof fetch }); start(email); verify(email, code): Promise<string>; signout(); me(); translateBatch(req, model); summarizeTopic(video, firstLines, src, tgt, model); translateOne(text, src, tgt, options) }`; `ProxyClaudeEngine` (ClaudeLike) and `ProxyFastEngine` (FastLike) wrappers; errors carry `status` and `code` (402 → `budget_exhausted`/`not_subscribed`).
- [ ] **Step 1: tests** — `proxy.test.ts`: `sends the bearer token and maps 402 budget_exhausted to an error with status 402`; `translateBatch/summarizeTopic/translateOne call the proxy paths`. `translationService.test.ts`: `subscription access uses the proxy engines and needs only a token` (plan best:true with token, false without); `a 402 from the proxy puts Claude in config-error state until settings change` (reuses the cooldown rules).
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: commit** `feat: extension subscription engines and account messages`.

### Task 7: Popup account section + end-to-end through a real local server

**Files:** Modify `popup.html`, `src/popup.ts` (account section: email field, "Send code", code field, "Sign in", signed-in view with plan, usage bar, "Subscribe"/"Manage subscription", "Sign out"; Claude access option "Subscription (signed in)"; fast provider option "Subscription"), `e2e/helpers/extension.ts` (fixture `proxy`: starts `createApp` in the Playwright worker on a free port with temp DB, dev outbox, upstreams pointed at the fixture server's mocks; sets `devEndpointOverrides.server`), `e2e/tests/account.spec.ts` (ui project), `e2e/tests/subtitle-claude.spec.ts` (one subscription test).
- [ ] **Step 1: tests** — `account.spec.ts`: `sign in with the emailed code, see the plan and usage, sign out`; `a free account sees Subscribe, and translations fall back to the fast tier with a clear message`; `Subscribe opens Stripe Checkout` (fake stripe in the proxy fixture returns a fixture URL; new tab URL asserted). `subtitle-claude.spec.ts`: `a subscriber gets Claude subtitles through the proxy with no API keys in the extension` (storage.local has no deepl/anthropic keys; overlay shows `[CLAUDE] …`; usage in /v1/me increased).
- [ ] **Step 2–4:** RED → implement → GREEN; look at the popup screenshot.
- [ ] **Step 5: commit** `feat: popup account and subscription; E2E through the local proxy`.

### Task 8: Docs

**Files:** Modify `README.md` (Subscription option, server folder, deploy pointer), `docs/milestones.md`, `CLAUDE.md` (server commands, proxy fixture), `docs/pricing.md` (link budgets to `server/src/plans.ts`).
- [ ] **Step 1:** write; **Step 2:** `npm run verify` green; **Step 3:** commit `docs: subscription, server and deploy`.
