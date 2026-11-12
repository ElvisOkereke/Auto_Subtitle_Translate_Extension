# Accounts, subscription and hosted translation proxy — design

Piece 4 of 4. Spec date 2026-11-12. The user skipped the design questions
("we can deal with these after"); every choice below not quoted from the user
is my call and is marked as such.

## Intent (from the user)

- Two ways to get translation: **BYOK** (exists — the user's own DeepL/Google
  and Anthropic keys or gateway) and a **hosted proxy** that works out of the
  box for users with a **subscription flag** on their account.
- The flag is set **via Stripe, or manually**.
- The price must **cover the cost of running the service**, based on a cost
  analysis.

## Goals

1. **Accounts.** Sign in from the popup with an email address and a one-time
   6-digit code (my call: no passwords, no OAuth client registration needed).
   The extension holds a revocable session token (stored in
   `chrome.storage.local`, like keys). Sign out revokes it.
2. **Subscription flag.** `accounts.plan` (`'free' | 'standard' | 'pro'`) and
   `subscription_status`. Set by Stripe webhooks (Checkout →
   `checkout.session.completed`, `customer.subscription.updated/deleted`,
   `invoice.payment_failed`) or manually by an admin command
   (`npm run admin -- set-plan <email> <plan>`) / admin HTTP endpoint guarded by
   an admin token.
3. **Hosted proxy.** The server implements the extension's engine interface
   (`translateBatch`, `summarizeTopic`, single-line fast translation) with the
   service's own DeepL and Anthropic keys, reusing `src/translation/` (the
   engine layer was written browser-independent for this). Only subscribers
   (active `standard`/`pro`) can use it.
4. **Usage metering and budgets.** Every proxied request records tokens/chars
   and cost per account per month. Each plan has a monthly cost budget; when it
   is used up, the proxy stops the Claude tier (fast tier keeps working up to
   its own cap) and the popup says so. Prevents cost runaway — the measured
   heavy case is ~$3.5/hour with Opus.
5. **Extension integration.** A third Claude access option, **Subscription
   (signed in)**, plus a fast-tier option **Subscription**: the extension's
   TranslationService uses proxy engines instead of BYOK engines. Popup shows
   the account (email, plan, usage this month, "Subscribe"/"Manage" buttons
   opening Stripe Checkout / Customer Portal).
6. **Pricing analysis** in `docs/pricing.md` from measured costs (performance.md)
   with a recommended price per plan and the monthly budgets enforced in code.

## Non-goals

- Production deployment and real billing: needs the user's Stripe, Anthropic,
  DeepL, email-provider and Google Cloud accounts. Delivered: a deployable
  container + Cloud Run deploy script + a step-by-step checklist; everything
  verified locally (Stripe test-mode flows simulated with signed webhook
  payloads, mocks for Anthropic/DeepL/email).
- Teams, invoices UI, refunds UI (Stripe dashboard covers them).
- Model distillation (separate later project).

## Anti-goals

- The service's API keys ever reaching the extension or the browser.
- A non-subscriber (or a stolen/expired token) getting translations on the
  service's bill.
- One account running up unbounded cost.
- Breaking BYOK: users with their own keys keep working with no account.
- Storing secrets or codes in plain text: session tokens and login codes are
  stored hashed; login attempts are rate-limited.

## Constraints / decisions (my calls)

- **Server:** `server/` in this repo, Node 22 + TypeScript, Hono on
  `@hono/node-server`, SQLite via built-in `node:sqlite` behind a small
  repository module (swappable for Postgres later), `stripe` SDK for Checkout,
  Portal and webhook signature verification. Email via Resend's HTTP API
  (`RESEND_API_KEY`), with a dev/test outbox instead when unset.
- **Hosting:** Docker image, `server/deploy/cloudrun.sh` for Google Cloud Run
  (the user deployed to GCP before). SQLite on Cloud Run needs a single
  instance with a mounted volume (Cloud Storage FUSE / Filestore) — documented;
  Postgres (Cloud SQL) is the scale-up path behind the repository interface.
- **Auth:** `POST /v1/auth/start {email}` → code emailed (10 min, 5 attempts,
  per-email and per-IP rate limits); `POST /v1/auth/verify {email, code}` →
  `{token}`; `Authorization: Bearer <token>` on every other call; tokens
  stored as SHA-256; `POST /v1/auth/signout`.
- **API:** `GET /v1/me` (email, plan, status, usage, budget),
  `POST /v1/translate/fast {text, sourceLang, targetLang, previousLines, nextLines}`,
  `POST /v1/translate/batch` (TranslateBatchRequest), `POST /v1/translate/topic`,
  `POST /v1/billing/checkout {plan}` → Stripe Checkout URL,
  `POST /v1/billing/portal` → Customer Portal URL, `POST /v1/stripe/webhook`,
  `POST /v1/admin/plan` (admin token). Request bodies size-limited and validated
  (lines ≤ 16 per batch, text ≤ 500 chars, glossary ≤ 200).
- **Plans and budgets** (from the pricing analysis; adjustable via env):
  `standard` and `pro` with monthly Claude cost budgets and fast-tier character
  caps; model by plan (standard → Sonnet 5.5 default, pro → Opus 5.5 default).
- **Extension:** server base URL setting (default: the production URL once
  deployed; dev override must be loopback like other dev overrides); proxy
  engines in `src/translation/engines/proxy.ts` implementing the same
  interfaces; 402/429 from the proxy (budget exhausted / not subscribed) map
  to clear popup messages and fast-tier fallback.

## Acceptance (automated)

- Server unit/integration tests (Jest, in-process `app.request`): sign-in flow
  incl. expiry/attempt limits/rate limits; token revocation; non-subscriber gets
  402; subscriber gets translations (mock Anthropic/DeepL); usage recorded and
  budget enforced (Claude tier refused with 402 `budget_exhausted`, fast still
  works); Stripe webhook signature required; checkout.session.completed /
  subscription.deleted / payment_failed change the flag; admin endpoint needs
  the admin token; manual `admin set-plan` works.
- E2E (Playwright): the extension signs in against a locally started server
  (code read from the dev outbox), shows plan/usage, and translates subtitles
  through the proxy (mock upstreams) with no API keys in the extension; a
  non-subscriber sees "Subscribe" and gets the fast fallback message.
- `docs/pricing.md` with the cost model and the recommended prices; the budgets
  in code match it.
- Deploy artefacts build (`docker build` if Docker is available; otherwise the
  server's production build runs).
