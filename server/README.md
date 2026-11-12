# Hosted translation proxy (subscriptions)

Lets signed-in subscribers use context-aware translation from the extension
without their own API keys. It reuses the extension's engine code
(`src/translation/`) with the service's DeepL and Anthropic keys, meters every
request against the plan's monthly budget (`src/plans.ts`, derived in
[docs/pricing.md](../docs/pricing.md)), and takes payments with Stripe.

```bash
npm run server:test     # unit/integration tests (in-process, fakes for Stripe/Anthropic/DeepL/email)
npm run server:build    # bundles server/dist/main.js and server/dist/admin.js
DEV_OUTBOX=1 ADMIN_TOKEN=dev npm run server:dev   # local server on :8080, login codes at /dev/outbox?email=...
```

## API (all JSON)

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/start {email}` | — | email a 6-digit code (10 min; 3 codes/15 min per email, 20/hour per IP) |
| `POST /v1/auth/verify {email, code}` | — | `{ token }` (bearer, 90 days) |
| `POST /v1/auth/signout`, `/v1/auth/signout-all` | bearer | revoke this / every session |
| `GET /v1/me` | bearer | plan, status, month usage and budget, `warn`/`exhausted` |
| `POST /v1/translate/fast` | bearer + subscription | DeepL, one line with neighbouring lines |
| `POST /v1/translate/batch` | bearer + subscription | Claude, ≤ 16 lines with video context, topic, glossary |
| `POST /v1/translate/topic` | bearer + subscription | Claude topic summary + starting glossary |
| `POST /v1/billing/checkout {plan}` | bearer | Stripe Checkout URL (`standard` / `pro`) |
| `POST /v1/billing/portal` | bearer | Stripe Customer Portal URL |
| `POST /v1/stripe/webhook` | Stripe signature | sets the subscription flag |
| `POST /v1/admin/plan {email, plan, status?}` | `x-admin-token` | set the flag by hand |

Errors: `401 unauthorized`, `402 not_subscribed | budget_exhausted`,
`429 rate_limited`, `400 bad_request`, `413` (body > 64 KB), `502 upstream`.

## Environment

| Variable | Required | |
|---|---|---|
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` for a gateway) | yes | Claude |
| `DEEPL_API_KEY` (`DEEPL_ENDPOINT` optional) | yes | fast tier |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PRO` | for billing | |
| `RESEND_API_KEY`, `MAIL_FROM` | for login email | without them codes stay in memory (dev only) |
| `ADMIN_TOKEN` | to use `/v1/admin/plan` | empty = endpoint disabled |
| `PUBLIC_URL` | yes | https URL of this server (Stripe return pages) |
| `TRUST_PROXY_HOPS` | yes behind a proxy | `1` on Cloud Run; client IPs for rate limits |
| `DB_PATH`, `PORT` | | default `app.db`, `8080` |
| `DEV_OUTBOX=1` | dev/test only | serves `/dev/outbox` — never in production |

## Manual subscription flag

```bash
DB_PATH=/data/app.db node server/dist/admin.js set-plan friend@example.com pro      # or: free | standard
curl -X POST "$PUBLIC_URL/v1/admin/plan" -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"friend@example.com","plan":"pro"}'
```

## Deploy (Google Cloud Run) — checklist

1. **Stripe** (test mode first): create a product with two monthly prices
   ($9.99 standard, $24.99 pro); note the price ids. Enable the Customer Portal.
   Add a webhook endpoint `https://<your domain>/v1/stripe/webhook` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`; note the signing secret.
2. **Resend**: verify the sending domain; create an API key.
3. **Anthropic / DeepL**: service API keys (DeepL API Pro for the per-character price).
4. **Secrets** (Secret Manager): `ast-anthropic-key`, `ast-deepl-key`,
   `ast-stripe-secret`, `ast-stripe-webhook`, `ast-stripe-price-standard`,
   `ast-stripe-price-pro`, `ast-resend-key`, `ast-admin-token` — e.g.
   `printf %s "$VALUE" | gcloud secrets create ast-deepl-key --data-file=-`,
   and grant the Cloud Run service account `roles/secretmanager.secretAccessor`.
5. **Deploy**: `PROJECT=… REGION=… PUBLIC_URL=https://… server/deploy/cloudrun.sh`
   (one instance, SQLite on a Cloud Storage volume at `/data`). Map your domain
   to the service.
6. **Extension**: set `SERVER_URL` in `src/settings.ts` (`DEFAULT_SERVER_URL`)
   to the public URL and rebuild/publish.
7. **Check**: sign in from the popup, subscribe with a Stripe test card
   (4242 4242 4242 4242), translate a video, see usage in the popup.

Scaling past one instance: move the repository (`src/db.ts`) to Postgres
(Cloud SQL) and the rate-limit/in-flight counters to the database or Redis.
