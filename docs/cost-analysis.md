# Cost analysis: the paid plan (Claude Opus 5.5, "Best only")

Measured 2026-11-21 through the extension's real translation code
(`e2e/bench/cost-run.ts`): the same batching, video context, topic summary,
glossary and prompt caching a subscriber gets, Claude Opus 5.5 through the
enterprise gateway. The workload is 411 hand-labelled lines from 11 videos in
5 languages (Korean League of Legends, Spanish football, Chinese, Russian,
French) plus 3 audio videos, fed the way read-ahead feeds them.

Results are in **tokens**, which don't depend on price. Dollar figures below
use list-style prices ($5 input, $6.25 cache write, $0.50 cache read, $25
output per million tokens, the basis of `docs/pricing.md`) for illustration;
**`docs/cost-calculator.html`** (open it in a browser, nothing leaves the
computer) takes your own rates.

## Run windows (to match against the usage dashboard)

| Run | Configuration | UTC window | Requests |
|---|---|---|---|
| Smoke test (key sent the wrong way: rejected, no tokens) | 12 lines | 01:59:42 – 02:00:07 | 3 rejected |
| Smoke test | 12 lines | 02:01:00 – 02:01:27 | 12 |
| baseline | before (150 ms batching, original caching) | 02:02:02 – 02:10:26 | 372 |
| window5s | 5 s batching, original caching | 02:10:29 – 02:16:00 | 192 |
| window10s | 10 s batching, original caching | 02:16:03 – 02:21:48 | 142 |
| context1 | 150 ms batching, 1 neighbouring line | 02:21:51 – 02:30:04 | 371 |
| baseline (fixed caching) | 150 ms batching | 02:34:02 – 02:42:48 | 369 |
| window10s (fixed caching) | 10 s batching | 02:42:51 – 02:48:33 | 140 |
| window10s (glossary next to lines) | 10 s batching | 02:50:18 – 02:56:01 | 142 |
| **product** | **8 s batching, final caching (shipped)** | **02:59:09 – 03:04:50** | **171** |

All on 2026-11-21. Every run translated 411 of 411 lines with no failures.
Exact per-request usage: `e2e/.perf/cost/*.json`.

## What changed, and what it saved

Two problems showed up in the measurements, both fixed in this change:

1. **Prompt caching wrote more than it read.** A cache breakpoint sat on the
   lines being translated, which are new in every request, so each request
   paid to write a cache entry nobody read (writes cost 1.25× input). The
   glossary, which Claude extends in most requests, sat inside the cached
   block too, so it kept invalidating it. Now only what stays the same for
   the whole video (instructions, video context, topic) is cached; the
   glossary and lines go after it, uncached.
2. **Batching didn't batch.** Lines arrive at playback pace, a few seconds
   apart, and the batcher waited 150 ms: 1.14 lines per request, so every
   line re-sent the whole prompt. Read-ahead lines have ~28 s of slack, so
   they now wait up to 8 s (16 lines max): 2.57 lines per request. Lines due
   within 14 s still go out at once.

| Per line (tokens) | Requests | Input | Cache write | Cache read | Output | $ per busy hour* |
|---|---|---|---|---|---|---|
| Before | 372 | 4 | 741 | 474 | 62 | **$3.79** |
| **Now (shipped)** | **171** | 232 | 206 | 150 | 47 | **$2.21 (−42%)** |
| Experiment: 10 s batching | 142 | 194 | 186 | 110 | 43 | $1.94 (−49%) |

\* 580 lines/hour (a talkative stream) plus 3 topic summaries (20-minute
videos), list-style prices. One neighbouring line instead of two saved about
5% of cache writes and nothing else: not worth the context it removes.

Topic summary, once per video watched: 808 input + 609 output tokens.

## Per hour and per subscriber (shipped configuration)

| Tokens per hour of video | Input | Cache write | Cache read | Output |
|---|---|---|---|---|
| Busy (580 lines) | 137,068 | 119,345 | 87,271 | 29,212 |
| Typical (400 lines) | 95,282 | 82,307 | 60,187 | 20,713 |

Cost per subscriber-month = tokens per hour × watch hours × your prices.
At list-style prices: **$2.21 per busy hour, $1.54 per typical hour.** A
$24.99 plan (after card fees) breaks even at **~11 busy or ~16 typical hours**
of watching a month. Output is about a third of the cost (25× the cache-read
price), cache writes about a third, input about a third.

## Many subscribers

Translation cost scales with **hours watched**, not with sign-ups: with no
sharing between subscribers, 1,000 subscribers watching 10 hours each cost
1,000× one subscriber. The hosted server itself is small:

| Subscribers (10 h/month each) | Hours / month | Avg. viewers at once | Peak (~4×) | Requests/s at peak | Tokens/min at peak |
|---|---|---|---|---|---|
| 10 | 100 | 0.1 | 1 | 0.1 | ~6k |
| 100 | 1,000 | 1.4 | 6 | 0.4 | ~37k |
| 1,000 | 10,000 | 14 | 55 | 3.5 | ~340k |
| 10,000 | 100,000 | 137 | 550 | 35 | ~3.4M |

(~229 requests and ~373k tokens per viewer-hour, busy videos.) One small VM
handles 35 requests/s of proxying easily; what to check at 1,000+ subscribers
is the **gateway's rate limits** (tokens per minute), not the server.

## Next savings, by expected size

1. **Shared translation cache on the server** (not built). When several
   subscribers watch the same video, translate each line once: cost falls by
   the share of viewing that overlaps. For a few popular streamers this could
   be large; it needs real usage data to size. Key: video id + normalised
   line text + target language + model. The calculator's "shared" field
   models it.
2. **Batching in Audio mode** (not built). Audio captions go out one request
   each (the "before" cost, ~$3.79/busy hour). Read-ahead captions arrive well
   ahead and can batch like subtitles: roughly −40% for Audio mode.
3. **A 10 s batching window** with lines due within 16 s sent at once: a
   further ~12% (measured $1.94 vs $2.21), at slightly more risk of a late line.
4. **Smaller output.** Output is a third of the cost; the JSON reply format
   repeats keys for every line. A compact format (one line per translation)
   could cut output by an estimated 20–30%; needs a quality check.
5. **Shared topic summary** per video across subscribers: about 3% of cost.
6. **Cheaper model for easy lines** (Sonnet for short, plain lines): needs a
   quality evaluation first.

## How to reproduce

```bash
npx tsx e2e/bench/cost-run.ts --variant product        # the shipped configuration
npx tsx e2e/bench/cost-run.ts --variant baseline       # before; also window5s, window10s, context1
npx tsx e2e/bench/cost-run.ts --dry                    # no API calls: checks the harness
```

Needs `ANTHROPIC_API_KEY` in `.env` (a gateway key is sent as a Bearer token
to the shell's `ANTHROPIC_BASE_URL`).
