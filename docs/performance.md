# Performance

Measured on the developer machine (Ryzen 7 9800X3D, 16 threads, RTX 3070,
Windows 10). Numbers are optimistic for typical laptops; CPU-only rows are the
better proxy for low-end machines. Reproduce with the commands listed per section.

## Live captions (audio mode)

### Speech-to-text models — `npm run perf:stt` (`E2E_BROWSER=chrome` for real WebGPU)

TTS clips of 6.9 s and 13 s; "per clip" = median inference once warm.

| Config | Download | Per clip (7 s / 13 s) | WER |
|---|---|---|---|
| Original: whisper-small fp32, WebGPU | 971 MB | 1.93 s / 2.66 s | 0 |
| whisper-small, fp32 enc + q4 dec, WebGPU | 589 MB | 0.56 s / 0.76 s | 0 |
| **Default: whisper-base, fp32 enc + q4 dec, WebGPU** | **209 MB** | **0.38 s / 0.49 s** | 0 |
| **CPU fallback: whisper-base q8, wasm** | **80 MB** | 2.7 s / 3.0 s | 0 |
| whisper-tiny q8, wasm | 44 MB | 1.3 s / 1.4 s | 0 |

The TTS clips are too clean to separate models on accuracy; speed and size are solid.
Whisper always encodes a padded 30 s window, so per-caption cost is roughly fixed.

### End to end — `npm run test:e2e` (captions project)

End of speech → caption on screen, mock translation: **1.05 s** in Chrome
with WebGPU, **~2.8 s** on the wasm fallback.

Cross-origin isolation would make wasm ~2.4× faster (multithreaded), but any
COEP value breaks tab capture in the offscreen document — see CLAUDE.md.

## Translation engines (36 real Korean League subtitle lines)

Scored 0/1/2 per line against League-aware reference translations.
Scripts: `e2e/.recon/translate-bench.mjs`, `e2e/.recon/claude-bench.mjs` (research, not committed).

| Engine | Quality | Median latency |
|---|---|---|
| Claude Opus 5.5, neighbouring lines as context, low effort | 89% | 2.2 s |
| Claude Sonnet 5.5, context | 82% | 1.0 s |
| DeepL, context | 65% | 0.28 s |
| DeepL, line by line | 46% | 0.27 s |
| Claude Haiku 5.5, context | 58% | 0.79 s |
| Google (unofficial free endpoint) | 42% | 1.1 s |
| Local opus-mt-ko-en / NLLB-600M | ≤ 15% | 0.1 / 1.0 s (CPU) |

Neighbouring-line context is the single largest quality gain.

## Subtitle mode (burned-in subtitles)

### OCR — `e2e/.cache/venv/Scripts/python -I e2e/bench/ocr_bench.py`

58 subtitle crops + 18 no-subtitle crops from the test video; details in
`docs/superpowers/decisions/2026-11-12-ocr-engine.md`.

| Engine | CER | False positives | CPU median |
|---|---|---|---|
| **PaddleOCR PP-OCRv5 mobile + box-relative size filter** | **2.3%** | **0 / 18** | 49 ms |
| PaddleOCR, no size filter | 34.9% | 1 / 18 | 54 ms |
| Tesseract kor (best), binarized | 17.4% | 17 / 18 | 74 ms |

In the extension (E2E, `e2e/tests/subtitle-ocr.spec.ts`): same 2.3% CER and
0 false positives through the real content-script → iframe → worker path;
median **22 ms per crop in Chrome with WebGPU**, 88 ms on the wasm fallback.

### Live path — `e2e/tests/subtitle-mode.spec.ts` (stretch s1, 29 lines, read-ahead off)

| Browser | Lines shown in time | OCR CER | Latency p50 / p90 (subtitle appears → English shown) |
|---|---|---|---|
| Chrome 157, WebGPU | 29 / 29 | 2.0% | **0.20 s / 0.32 s** (mock translation) |
| Chromium, wasm | 29 / 29 | 2.0% | 0.25 s / 0.37 s (mock translation) |
| Chrome, **real DeepL** (`live-subtitles.spec.ts`) | 29 / 29 | — | **0.48 s / 0.74 s** including the DeepL round trip |
| Chromium, **real DeepL** | 29 / 29 | — | 0.54 s / 0.65 s |

Every measurement starts from an empty timeline store (the E2E helpers clear
it), so no line is replayed from an earlier run.

### Read-ahead — `e2e/tests/subtitle-readahead.spec.ts` (stretch s2, 29 lines)

Fixture buffers ~30 s ahead like YouTube.

| Browser | Translated before they appear | Median lead | Live OCR calls in steady playback |
|---|---|---|---|
| Chrome 157 | **29 / 29** | 27.9 s | 0 |
| Chromium | **29 / 29** | 27.9 s | 0 |
| Read-ahead disabled (same test) | 0 / 29 | 0 s | 204 |

### Real YouTube — `npm run e2e:youtube`

Installed Chrome, test profile, AV1 stream. YouTube stops automated playback
after ~40 s ("Something went wrong") in every automated configuration tried
(headless, headed off-screen); within that window: **12/12 lines shown, OCR
CER 1.8%, read-ahead lead 28 s, 14/15 lines translated before they appeared**.
Report and a stitched run video: `e2e/.perf/youtube/`.

### Context-aware translation (Claude, fast then best) — `npm run test:live`, `npm run e2e:judge`

Stretch s1 (29 lines, starts at 0:00 and plays immediately), real DeepL + real
Claude through the test relay, read-ahead on, Chromium.

| Engine | Judge score (0–1) | Key League terms | Names consistent | Claude version before the line appears | Cost / line | Cost / hour of this video |
|---|---|---|---|---|---|---|
| DeepL only (before) | 0.48–0.50 | 9 / 11 | — | — | DeepL quota | DeepL quota |
| **Claude Opus 5.5 (default)** | **0.91–0.93** | **10–11 / 11** | yes | **90–93%** of all lines, **100% after the first 8 s** (the first 2–3 lines arrive while OCR and Claude warm up) | $0.0059–0.0061 | **$3.40–3.52** |
| Claude Sonnet 5.5 | 0.72 | 10 / 11 | yes | 90% | $0.0027 | $1.56 |
| Claude Haiku 5.5 | 0.45 | 8 / 11 | no (learned 탑 → "Top lane") | 97% | $0.00009 | $0.05 |

Judge scores are from two judge runs (ranges where they differed). Cost per
hour = cost per line × this stretch's line rate (580 lines/hour); slower-talking
videos cost less. Haiku is ~65× cheaper than Opus but no better than DeepL here
— the case for distilling Opus quality into a cheap model later.

Every line ends on Claude's version. Cold-start latency (first line, play at
0:00): Claude's version on screen at 2.9 s — down from 11.5 s before the topic
summary stopped blocking lines (bounded 1.5 s wait, summary started when
subtitle mode starts, separate request lanes for Claude, lines due within 10 s
sent unbatched).

**Other domains** (`e2e/tests/domain-bench.spec.ts`): 35 real subtitle lines per
video, DeepL (neighbouring lines) vs Claude Opus 5.5 (video context + topic +
glossary), blind pairwise judge:

| Domain | Subtitles | Claude better | Tie | DeepL better | Claude win rate |
|---|---|---|---|---|---|
| Football — LaLiga Clásico summary (Spanish) | human-made | 26 | 6 | 3 | **0.83** |
| Anime — 銀河特急 ミルキー☆サブウェイ ep. 1 (Japanese) | human-made | 21 | 5 | 9 | **0.67** |
| K-drama — 선재 업고 튀어 highlight (Korean) | automatic captions | 25 | 4 | 6 | **0.77** |

### Translation quality end to end (real DeepL, default configuration)

All 29 lines translated; key terms present in 9/11 lines that have them
(82%). Both misses start as OCR slips DeepL can't recover from (뽀삐 → "뿐 삐",
렙차 → 럽차). Claude-as-judge score of the displayed translations: **0.60**
(`npm run e2e:judge`) — consistent with the translation benchmark above; the
translation-engine piece (Claude with context) targets this.

## Real-world benchmark (subtitle mode) — `npm run bench:youtube`, `npm run bench:local`

Eight YouTube videos with burned-in subtitles in five languages (Korean League
of Legends ×4, Chinese football commentary, Portuguese-subtitled football
interview, Russian-subtitled football interview, French-subtitled Japanese TV
drama), 120 s each, set in `e2e/bench/videos.json`. Reference subtitles were
OCR'd at 10 fps, hand-checked against the frames and re-timed per frame
(`e2e/fixtures/subtitles/`). Real DeepL and Claude Opus 5.5, scored on the
source text each shown line was read from; Claude judges translation quality
(0–1). Each run pauses for 5 s at +60 s.

- **youtube**: real YouTube in installed Chrome. YouTube stops automated
  playback after ~40 s of a page's playback, so each run is a sliding window of
  four 30 s pieces in side-by-side windows (the next one prepared while the
  current plays).
- **local-mp4 / local-webm**: the same 120 s cut played through the local
  YouTube-like MSE page, video as fMP4 (read-ahead taps it) or as WebM/VP9.

### Baseline (2026-11-13, before the fixes)

Columns: path that showed the lines; coverage of reference lines on screen
≥ 0.5 s and < 0.5 s; share translated before they appeared; lines that left the
screen before their reading time (`tooShort/lines`); lines not on screen that
appeared while paused; OCR character error; judge score.

| run | mode | video | path | played | coverage ≥0.5 s | < 0.5 s | ready | too short | stale while paused | OCR CER | judge |
|---|---|---|---|---|---|---|---|---|---|---|---|
| youtube | fast-then-best | _zIrbXw-SVs (ko) | read-ahead | 120 s | 94% (17/18) | 100% (1/1) | 95% | 13/19 | 0 | 3.3% | – |
| youtube | fast-then-best | ug5IsDJ9bhs (ko) | read-ahead | 120 s | 100% (10/10) | – | 90% | 9/11 | – | 1.4% | 0.90 |
| youtube | fast-then-best | x8YWHt8giVY (ko) | read-ahead | 120 s | 88% (30/34) | – | 91% | 10/33 | 0 | 1.1% | 0.93 |
| youtube | fast-then-best | w3RZwfzYEcs (ko) | read-ahead | 120 s | 95% (35/37) | 100% (4/4) | 95% | 21/42 | – | 14.6% | 0.72 |
| youtube | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | read-ahead | 120 s | 59% (29/49) | – | 59% | 8/39 | – | 7.5% | 0.83 |
| youtube | fast-then-best | dcbt04jp7B8 (pt) | read-ahead | 120 s | 80% (32/40) | 0% (0/1) | 85% | 8/52 | – | 13.4% | 0.77 |
| youtube | fast-then-best | IM-v1aW_AtI (ru) | read-ahead | 120 s | 75% (21/28) | – | 82% | 7/36 | – | 1.6% | 0.90 |
| youtube | fast-then-best | N5BAtJ2qMXo (fr) | read-ahead | 120 s | 100% (27/27) | – | 89% | 7/27 | – | 0.7% | 0.96 |
| youtube | best | _zIrbXw-SVs (ko) | read-ahead | 120 s | 94% (17/18) | 100% (1/1) | 95% | 13/19 | 0 | 4.1% | 0.97 |
| youtube | best | ug5IsDJ9bhs (ko) | read-ahead | 120 s | 100% (10/10) | – | 100% | 7/10 | – | 1.4% | 0.90 |
| youtube | best | x8YWHt8giVY (ko) | read-ahead | 120 s | 76% (26/34) | – | 91% | 8/29 | 0 | 0.5% | 0.98 |
| youtube | best | w3RZwfzYEcs (ko) | read-ahead | 120 s | 89% (33/37) | 100% (4/4) | 90% | 19/40 | – | 14.8% | 0.78 |
| youtube | best | Ac-5H_Wgk7I (zh-Hans) | read-ahead | 116 s | 60% (28/47) | – | 62% | 8/32 | – | 7.1% | 0.79 |
| youtube | best | dcbt04jp7B8 (pt) | read-ahead | 120 s | 78% (31/40) | 0% (0/1) | 83% | 8/47 | – | 13.8% | 0.76 |
| youtube | best | IM-v1aW_AtI (ru) | read-ahead | 120 s | 75% (21/28) | – | 75% | 10/35 | – | 1.6% | 0.90 |
| youtube | best | N5BAtJ2qMXo (fr) | read-ahead | 120 s | 96% (26/27) | – | 96% | 7/27 | – | 0.7% | 0.96 |
| local-mp4 | fast-then-best | _zIrbXw-SVs (ko) | read-ahead | 120 s | 100% (18/18) | 100% (1/1) | 100% | 12/20 | – | 3.1% | 0.87 |
| local-mp4 | fast-then-best | ug5IsDJ9bhs (ko) | read-ahead | 120 s | 100% (9/9) | 100% (1/1) | 100% | 7/10 | – | 1.4% | 0.95 |
| local-mp4 | fast-then-best | x8YWHt8giVY (ko) | read-ahead | 120 s | 91% (31/34) | – | 94% | 10/33 | – | 1.3% | 0.95 |
| local-mp4 | fast-then-best | w3RZwfzYEcs (ko) | read-ahead | 120 s | 84% (32/38) | 33% (1/3) | 85% | 24/45 | – | 11.9% | 0.79 |
| local-mp4 | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | read-ahead | 120 s | 57% (28/49) | – | 55% | 11/38 | – | 5.6% | 0.77 |
| local-mp4 | fast-then-best | dcbt04jp7B8 (pt) | mixed | 120 s | 83% (33/40) | 0% (0/1) | 68% | 6/59 | – | 8.5% | 0.85 |
| local-mp4 | fast-then-best | IM-v1aW_AtI (ru) | mixed | 120 s | 89% (25/28) | – | 68% | 9/33 | – | 0.7% | 0.92 |
| local-mp4 | fast-then-best | N5BAtJ2qMXo (fr) | mixed | 120 s | 96% (26/27) | – | 70% | 9/27 | – | 1.0% | 0.96 |
| local-mp4 | best | _zIrbXw-SVs (ko) | read-ahead | 120 s | 100% (18/18) | 100% (1/1) | 100% | 12/20 | – | 3.1% | 0.87 |
| local-mp4 | best | ug5IsDJ9bhs (ko) | read-ahead | 120 s | 100% (9/9) | 100% (1/1) | 100% | 7/10 | – | 1.4% | 0.95 |
| local-mp4 | best | x8YWHt8giVY (ko) | read-ahead | 120 s | 91% (31/34) | – | 94% | 10/33 | – | 1.3% | 0.87 |
| local-mp4 | best | w3RZwfzYEcs (ko) | read-ahead | 120 s | 79% (30/38) | 33% (1/3) | 85% | 21/42 | – | 11.3% | 0.74 |
| local-mp4 | best | Ac-5H_Wgk7I (zh-Hans) | read-ahead | 120 s | 55% (27/49) | – | 55% | 10/37 | – | 4.7% | 0.76 |
| local-mp4 | best | dcbt04jp7B8 (pt) | read-ahead | 120 s | 65% (26/40) | 0% (0/1) | 71% | 7/46 | – | 7.4% | 0.83 |
| local-mp4 | best | IM-v1aW_AtI (ru) | mixed | 120 s | 89% (25/28) | – | 64% | 9/30 | – | 0.6% | 0.94 |
| local-mp4 | best | N5BAtJ2qMXo (fr) | mixed | 120 s | 93% (25/27) | – | 70% | 8/26 | – | 1.0% | 0.98 |
| local-webm | fast-then-best | _zIrbXw-SVs (ko) | live | 120 s | 100% (18/18) | 0% (0/1) | 0% | 12/19 | – | 3.3% | 0.92 |
| local-webm | fast-then-best | ug5IsDJ9bhs (ko) | live | 120 s | 100% (9/9) | 100% (1/1) | 0% | 7/10 | – | 1.4% | 0.95 |
| local-webm | fast-then-best | x8YWHt8giVY (ko) | live | 120 s | 94% (32/34) | – | 0% | 11/34 | – | 0.7% | 0.95 |
| local-webm | fast-then-best | w3RZwfzYEcs (ko) | live | 120 s | 89% (34/38) | 33% (1/3) | 20% | 29/48 | – | 10.7% | 0.70 |
| local-webm | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | live | 120 s | 82% (40/49) | – | 4% | 18/55 | – | 3.6% | 0.78 |
| local-webm | fast-then-best | dcbt04jp7B8 (pt) | live | 120 s | 83% (33/40) | 0% (0/1) | 12% | 5/63 | – | 8.6% | 0.80 |
| local-webm | fast-then-best | IM-v1aW_AtI (ru) | live | 120 s | 89% (25/28) | – | 0% | 11/37 | – | 0.7% | 0.98 |
| local-webm | fast-then-best | N5BAtJ2qMXo (fr) | live | 120 s | 96% (26/27) | – | 0% | 10/26 | – | 1.1% | 0.98 |
| local-webm | best | _zIrbXw-SVs (ko) | live | 120 s | 22% (4/18) | 0% (0/1) | 0% | 4/5 | – | 0.0% | 0.50 |
| local-webm | best | ug5IsDJ9bhs (ko) | live | 120 s | 11% (1/9) | 0% (0/1) | 0% | 1/1 | – | 0.0% | 1.00 |
| local-webm | best | x8YWHt8giVY (ko) | live | 120 s | 35% (12/34) | – | 0% | 4/12 | – | 0.5% | 0.96 |
| local-webm | best | w3RZwfzYEcs (ko) | live | 120 s | 5% (2/38) | 0% (0/3) | 0% | 4/5 | – | 0.0% | 1.00 |
| local-webm | best | Ac-5H_Wgk7I (zh-Hans) | live | 120 s | 43% (21/49) | – | 0% | 9/23 | – | 1.7% | 0.76 |
| local-webm | best | dcbt04jp7B8 (pt) | live | 120 s | 55% (22/40) | 0% (0/1) | 0% | 7/28 | – | 9.3% | 0.75 |
| local-webm | best | IM-v1aW_AtI (ru) | live | 120 s | 82% (23/28) | – | 0% | 12/27 | – | 0.4% | 1.00 |
| local-webm | best | N5BAtJ2qMXo (fr) | live | 120 s | 52% (14/27) | – | 0% | 8/14 | – | 1.3% | 1.00 |

What it shows:
- **Lines vanish before they can be read**: a third to a half of the lines
  leave the screen before their reading time on every video (the translation is
  tied to the source subtitle's exact span).
- **No read-ahead for WebM/VP9**: `local-webm` runs on the live path only;
  nothing is ready before it appears.
- **Best mode without read-ahead loses most lines** (e.g. 4/18, 2/38): a Claude
  answer (~1.7 s) for a subtitle that has already changed is dropped. Fast then
  best keeps them (DeepL ~0.5 s).
- **Misses concentrate where text is small, fast or busy**: Chinese football
  compilation 60–62% on real YouTube, Russian two-line subtitles 75–82%,
  Portuguese clip with a match clock inside the box 78–85%.
- **Engine modes with read-ahead**: Best (Claude only) is ready as often as
  Fast then best, with the same quality; Fast only (DeepL) judged 0.25–0.63
  against 0.67–0.98 for Claude (40 s runs).
- Real YouTube served AV1 (fMP4) for the League videos and H.264 for one, so
  read-ahead ran there.
- Earlier runs counted any line appearing while paused; the `stale` column
  (added later) counts only lines that weren't on screen — "–" where a run
  predates it.
