# Pricing analysis — hosted translation subscription

What it costs us to translate an hour of video through the hosted proxy, and
what the subscription must cost to cover that. The prices and budgets below are
enforced by `server/src/plans.ts`. Inputs are measured
(`docs/performance.md`, automated runs) or list prices as of 2026-11; change
the budgets in `server/src/plans.ts` if prices move.

## Cost per hour of video

**Lines per hour.** The League test stream has 580 subtitle lines/hour (a
talkative streamer; measured on two 3-minute stretches: 580 and 566).
Calmer videos have fewer; we use **580 (busy)** and **400 (typical)**.

**Claude (best tier)**, measured cost per line incl. topic summary, glossary,
prompt caching and retries (real Claude runs, Chromium):

| Model | $/line | $/hour busy (580) | $/hour typical (400) |
|---|---|---|---|
| Opus 5.5 | $0.0060 | $3.48 | $2.40 |
| Sonnet 5.5 | $0.0027 | $1.57 | $1.08 |
| Haiku 5.5 | $0.00009 | $0.05 | $0.04 |

**DeepL (fast tier)**: DeepL API Pro $25 per million characters (+ $5.49/month
base). Context lines are not billed. Measured line lengths: Korean 13.7,
Japanese 16, Spanish 34 characters → **$0.20–0.49 per busy hour**
(≈ $0.29 at 20 characters/line).

**Per subscriber-hour, both tiers (busy video):**

| Configuration | $/hour busy | $/hour typical |
|---|---|---|
| DeepL + Sonnet 5.5 | **≈ $1.86** | ≈ $1.28 |
| DeepL + Opus 5.5 | **≈ $3.77** | ≈ $2.60 |

Speech recognition and OCR run on the user's machine: no server cost.

## Fixed costs (monthly)

| Item | $/month |
|---|---|
| Cloud Run, 1 always-on small instance (SQLite needs a single instance) | ~$12 |
| DeepL API Pro base fee | $5.49 |
| Email (Resend free tier: 3,000 emails/month) | $0 |
| Domain / misc | ~$2 |
| **Total** | **~$20** → $0.40/subscriber at 50 subscribers, $0.10 at 200 |

Payment processing (Stripe, US cards): **2.9% + $0.30** per charge.

## Plans

Price = budget for translation + Stripe + share of fixed costs + margin.
Target margin 25% at launch scale (50 subscribers).

| Plan | Price/month | Stripe | Fixed share | Margin | **Monthly translation budget** | Default best model | ≈ Hours included (busy / typical) |
|---|---|---|---|---|---|---|---|
| Standard | **$9.99** | $0.59 | $0.40 | $2.50 | **$6.00** | Sonnet 5.5 | 3.2 h / 4.7 h |
| Pro | **$24.99** | $1.02 | $0.40 | $6.25 | **$17.00** | Opus 5.5 | 4.5 h / 6.5 h (Opus) · 9 h / 13 h (Sonnet) |

The budget is enforced in money, not hours, so it holds whatever the video,
model or language: every proxied request records its real cost; at 80 % the
popup warns; at 100 % the proxy refuses further translation for the month
(the popup offers upgrade, or BYOK). Pro users can pick Sonnet to stretch
their budget.

## What this means

- **Claude-quality translation is the cost.** Even Sonnet costs ~$1.9 per busy
  hour; a flat "unlimited" plan isn't viable at these prices.
- **Heavy watchers are better off with BYOK** (their own Anthropic/DeepL keys
  at cost) — keep BYOK prominent.
- **The lever is model cost.** Haiku is ~65× cheaper than Opus but no better
  than DeepL today (judge 0.45 vs 0.48; Opus 0.91–0.93). Distilling Opus-quality
  subtitle translation into a small model (the planned follow-up project) is
  what would make 20–50 included hours, or a lower price, possible.
- Revisit the numbers after launch with real usage (`GET /v1/me` usage data and
  the monthly cost per account in the database).
