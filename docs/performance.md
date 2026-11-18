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

### Box robustness — `e2e/bench/box_robustness.py` (offline), `e2e/tests/subtitle-readahead-boxes.spec.ts` (browser)

People don't draw snug boxes. Each box shape below is drawn around the
subtitle area a real user would aim at. The browser test plays 60–90 s of
stretch s2; the offline sweep reads every labelled line of the 8 Subtitles-mode
bench videos (ko, zh, pt, ru, fr) plus frames with no subtitle.

| box | browser before (90 s, 17 lines) | browser after (Chrome, 60 s, 15 lines) | offline before (35% rule) | offline after |
|---|---|---|---|---|
| standard | 17/17 | 15/15 | 95% | 93% |
| loose (2× tall, wider) | 0/17 | 15/15 | 13% | 92% |
| lower half of the video | 0/17 | 14/15 | 0% | 89% |
| full width, thin | 17/17 | 15/15 | 78% | 94% |
| too small (cuts the text) | 17/17 | 15/15 | 61% | 91% |
| shifted up (text below the edge) | 0/17 | 15/15 | 26% | 92% |
| shifted down | 17/17 | 15/15 | 72% | 93% |
| tall narrow | 0/17 | 15/15 | 2% | 91% |

Lines not in the labelled timeline (game notices etc. read as subtitles): at
most 1 per box in Chrome. The read-ahead test (stretch s2, 29 lines) went to
29/29 translated before shown, 0 live OCR calls in steady state, 2 extra lines.

What changed: OCR reads the box plus 75% of its size on every side; the
subtitle is the widest text that reaches into the middle of the video and lies
at least 10% inside the drawn box (stream chat, watermarks, logos and
scorebugs sit elsewhere or are shorter); numbers alone are dropped (HUD); the
subtitle text height is learned per video, so game notices of another size
("스킬이 아직 준비되지 않았습니다") aren't read as subtitles; and the box is re-read
every 0.75 s even with nothing on screen (small text in a big box barely moves
the change signature). The size is the height shared by the most different
texts seen, accepted or not, so HUD text read first can't lock it in (a Chrome
run showed exactly that). Offline false positives on no-subtitle frames are
8–18 of 72 per shape (some are unlabelled real subtitles; the offline sweep is
per frame, without the size learning); the browser tests assert false lines ≤ 10%.

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

## Real-world benchmark (subtitle mode) — `npm run bench:youtube` (live), `npm run bench:local`

Two suites. **Live** (`bench:youtube`, real YouTube) is the one to run for every
change. **Local** (`bench:local`, the same windows played from downloaded copies)
is for what live can't show:
- the VP9/WebM path (YouTube serves AV1 to the test Chrome);
- full-length runs without YouTube's ~40 s cutoff, ads or reloads (reproducible
  misses);
- forcing paths such as Best mode without read-ahead.

It runs on demand. The **baseline** is measured once, on the build before a step's
fixes, and kept below as the "before" column.

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

### Step 2 (2026-11-13): reading time, VP9 read-ahead, small-text re-check

The build with the fixes: minimum reading time (video time), WebM/VP9 demuxer
for read-ahead (plus a picker fix: a 3-frame cluster was decoded in a loop),
and read-ahead re-reading an open line every 0.75 s. Before → after; live runs
show two samples (single real-YouTube runs vary a lot).

**Live (real YouTube, sliding window, 2 workers, 15–16 min per sample):**

| run | mode | video | coverage ≥0.5 s | ready | too short | stale while paused | judge |
|---|---|---|---|---|---|---|---|
| youtube | fast-then-best | _zIrbXw-SVs (ko) | 17/18 → 14/18 · 17/18 | 95% → 74% · 100% | 13 → 0 · 0 | 0 · 0 | 0.93 · 0.92 |
| youtube | fast-then-best | ug5IsDJ9bhs (ko) | 10/10 → 10/10 · 9/10 | 90% → 90% · 90% | 9 → 0 · 0 | 0 · 0 | 0.90 · 0.39 |
| youtube | fast-then-best | x8YWHt8giVY (ko) | 30/34 → 29/32 · 28/31 | 91% → 91% · 90% | 10 → 1 · 1 | 0 · 0 | 0.88 · 0.75 |
| youtube | fast-then-best | w3RZwfzYEcs (ko) | 35/37 → 35/37 · 34/37 | 95% → 95% · 90% | 21 → 0 · 0 | 0 · 0 | 0.65 · 0.63 |
| youtube | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | 29/49 → 30/45 · 31/48 | 59% → 96% · 63% | 8 → 0 · 0 | 0 · 0 | 0.83 · 0.87 |
| youtube | fast-then-best | dcbt04jp7B8 (pt) | 32/40 → 34/40 · 19/40 | 85% → 90% · 76% | 8 → 0 · 0 | 0 · 0 | 0.65 · 0.66 |
| youtube | fast-then-best | IM-v1aW_AtI (ru) | 21/28 → 14/28 · 10/27 | 82% → 61% · 52% | 7 → 1 · 0 | 0 · 0 | 0.89 · 0.85 |
| youtube | fast-then-best | N5BAtJ2qMXo (fr) | 27/27 → 14/27 · 18/27 | 89% → 52% · 67% | 7 → 0 · 0 | 0 · 0 | 1.00 · 1.00 |
| youtube | best | _zIrbXw-SVs (ko) | 17/18 → 17/18 · 17/18 | 95% → 100% · 95% | 13 → 0 · 0 | 0 · 0 | 0.92 · 0.94 |
| youtube | best | ug5IsDJ9bhs (ko) | 10/10 → 10/10 · 10/10 | 100% → 70% · 90% | 7 → 0 · 0 | 0 · 0 | 0.85 · 1.00 |
| youtube | best | x8YWHt8giVY (ko) | 26/34 → 29/34 · 28/34 | 91% → 94% · 97% | 8 → 0 · 0 | 0 · 0 | 0.93 · 0.86 |
| youtube | best | w3RZwfzYEcs (ko) | 33/37 → – · 33/37 | 90% → – · 88% | 19 → – · 0 | – · 0 | – · 0.64 |
| youtube | best | Ac-5H_Wgk7I (zh-Hans) | 28/47 → 31/49 · 43/47 | 62% → 94% · 96% | 8 → 0 · 0 | 0 · 0 | 0.73 · 0.79 |
| youtube | best | dcbt04jp7B8 (pt) | 31/40 → 37/40 · 37/40 | 83% → 93% · 95% | 8 → 0 · 0 | 0 · 0 | 0.68 · 0.64 |
| youtube | best | IM-v1aW_AtI (ru) | 21/28 → 19/27 · 23/28 | 75% → 89% · 86% | 10 → 0 · 2 | 0 · 0 | 0.92 · 0.91 |
| youtube | best | N5BAtJ2qMXo (fr) | 26/27 → 24/27 · 26/27 | 96% → 85% · 96% | 7 → 0 · 0 | 0 · 0 | 0.98 · 0.96 |

**Local fMP4 (3 workers, 25 min for all 32 local runs):**

| run | mode | video | coverage ≥0.5 s | ready | too short | stale while paused | judge |
|---|---|---|---|---|---|---|---|
| local-mp4 | fast-then-best | _zIrbXw-SVs (ko) | 18/18 → 18/18 | 100% → 100% | 12 → 0 | 0 | 0.87 |
| local-mp4 | fast-then-best | ug5IsDJ9bhs (ko) | 9/9 → 10/10 | 100% → 100% | 7 → 0 | 0 | 0.90 |
| local-mp4 | fast-then-best | x8YWHt8giVY (ko) | 31/34 → 33/34 | 94% → 97% | 10 → 0 | 0 | 0.89 |
| local-mp4 | fast-then-best | w3RZwfzYEcs (ko) | 32/38 → 33/37 | 85% → 88% | 24 → 0 | 0 | 0.70 |
| local-mp4 | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | 28/49 → 39/49 | 55% → 80% | 11 → 0 | 0 | 0.74 |
| local-mp4 | fast-then-best | dcbt04jp7B8 (pt) | 33/40 → 28/40 | 68% → 71% | 6 → 0 | 0 | 0.79 |
| local-mp4 | fast-then-best | IM-v1aW_AtI (ru) | 25/28 → 26/28 | 68% → 71% | 9 → 0 | 0 | 0.96 |
| local-mp4 | fast-then-best | N5BAtJ2qMXo (fr) | 26/27 → 26/27 | 70% → 70% | 9 → 0 | 0 | 0.96 |
| local-mp4 | best | _zIrbXw-SVs (ko) | 18/18 → 18/18 | 100% → 100% | 12 → 0 | 0 | 0.89 |
| local-mp4 | best | ug5IsDJ9bhs (ko) | 9/9 → 10/10 | 100% → 100% | 7 → 0 | 0 | 0.75 |
| local-mp4 | best | x8YWHt8giVY (ko) | 31/34 → 32/34 | 94% → 94% | 10 → 0 | 0 | 0.78 |
| local-mp4 | best | w3RZwfzYEcs (ko) | 30/38 → 30/37 | 85% → 85% | 21 → 0 | 0 | 0.72 |
| local-mp4 | best | Ac-5H_Wgk7I (zh-Hans) | 27/49 → 38/49 | 55% → 78% | 10 → 0 | 0 | 0.71 |
| local-mp4 | best | dcbt04jp7B8 (pt) | 26/40 → 29/40 | 71% → 68% | 7 → 0 | 0 | 0.79 |
| local-mp4 | best | IM-v1aW_AtI (ru) | 25/28 → 27/28 | 64% → 71% | 9 → 0 | 0 | 0.96 |
| local-mp4 | best | N5BAtJ2qMXo (fr) | 25/27 → 25/27 | 70% → 70% | 8 → 0 | 0 | 0.96 |

**Local WebM/VP9 (what YouTube serves without AV1):**

| run | mode | video | coverage ≥0.5 s | ready | too short | stale while paused | judge |
|---|---|---|---|---|---|---|---|
| local-webm | fast-then-best | _zIrbXw-SVs (ko) | 18/18 → 18/18 | 0% → 100% | 12 → 0 | 0 | 0.79 |
| local-webm | fast-then-best | ug5IsDJ9bhs (ko) | 9/9 → 10/10 | 0% → 100% | 7 → 0 | 0 | 0.90 |
| local-webm | fast-then-best | x8YWHt8giVY (ko) | 32/34 → 33/34 | 0% → 97% | 11 → 0 | 0 | 0.86 |
| local-webm | fast-then-best | w3RZwfzYEcs (ko) | 34/38 → 32/37 | 20% → 85% | 29 → 0 | 0 | 0.78 |
| local-webm | fast-then-best | Ac-5H_Wgk7I (zh-Hans) | 40/49 → 41/49 | 4% → 76% | 18 → 0 | 0 | 0.71 |
| local-webm | fast-then-best | dcbt04jp7B8 (pt) | 33/40 → 33/40 | 12% → 73% | 5 → 0 | 0 | 0.71 |
| local-webm | fast-then-best | IM-v1aW_AtI (ru) | 25/28 → 27/28 | 0% → 79% | 11 → 0 | 0 | 0.96 |
| local-webm | fast-then-best | N5BAtJ2qMXo (fr) | 26/27 → 26/27 | 0% → 70% | 10 → 0 | 0 | 0.96 |
| local-webm | best | _zIrbXw-SVs (ko) | 4/18 → 18/18 | 0% → 100% | 4 → 0 | 0 | 0.89 |
| local-webm | best | ug5IsDJ9bhs (ko) | 1/9 → 10/10 | 0% → 100% | 1 → 0 | 0 | 0.95 |
| local-webm | best | x8YWHt8giVY (ko) | 12/34 → 33/34 | 0% → 97% | 4 → 0 | 0 | 0.89 |
| local-webm | best | w3RZwfzYEcs (ko) | 2/38 → 32/37 | 0% → 83% | 4 → 0 | 0 | 0.69 |
| local-webm | best | Ac-5H_Wgk7I (zh-Hans) | 21/49 → 38/49 | 0% → 78% | 9 → 0 | 0 | 0.71 |
| local-webm | best | dcbt04jp7B8 (pt) | 22/40 → 31/40 | 0% → 63% | 7 → 0 | 0 | 0.77 |
| local-webm | best | IM-v1aW_AtI (ru) | 23/28 → 26/28 | 0% → 71% | 12 → 0 | 0 | 0.96 |
| local-webm | best | N5BAtJ2qMXo (fr) | 14/27 → 25/27 | 0% → 70% | 8 → 0 | 0 | 1.00 |

What changed:
- **Lines stay readable**: lines leaving before their reading time went from
  4–29 per video to 0 (0–2 on real YouTube).
- **VP9 reads ahead**: WebM runs went from 0% of lines ready before they appear
  to 63–100%. Best mode on WebM no longer collapses: 4→18/18, 1→10/10, 2→32/37,
  12→33/34.
- **Small text**: the Chinese football clip went from 27–28 to 38–41 of 49
  locally, and from 28 to 43 of 47 in one live sample (31 in the other).
- **Nothing stale while paused** in any run.

Open:
- **Fast then best, live, full suite**: in both full samples, some runs showed
  lines that were read and translated but never shown (French 14 and 18 of 27,
  Russian 14 and 10 of 28), while Best mode stayed at 24–26 and 19–23.
  Isolated reruns were normal. During heavy runs the Claude gateway answered
  429 "exceeded your allowed request quota" and the extension cooled Claude
  down. That explains some variance, but not why DeepL's version wasn't shown;
  the next step is to log each line's per-tier outcome in the live report.
- **Not yet at the 97% coverage target** on the hardest videos:
  - Chinese compilation (fast cuts): 78–84% locally;
  - Portuguese clip (a match clock inside the subtitle box): 70–85%;
  - Russian two-line subtitles at 720p: 82–96%;
  - stylised captions: 87–89%.

  Each needs a targeted change, such as filtering clock text or grouping
  two-line subtitles.

## Real-world benchmark (audio mode) — `npm run bench:youtube` / `bench:local`, tests `audio …`

Three videos with real speech, 120 s each, in Chrome with WebGPU Whisper and
fast-then-best translation:

- `-ci-Ursh0XQ`: Korean LCK casting, two casters talking over each other;
- `27VKumB17kE`: a Spanish documentary;
- `5INsXNUaRdE`: Japanese football commentary.

How it's measured:

- **Reference:** the video's own YouTube captions (manual for Spanish, YouTube's
  auto captions in the spoken language for Korean and Japanese).
- **Live runs** play the real page in 30 s pieces (sliding window). Each piece
  is captioned from its hand-over, because only one tab captures at a time.
  The original-language audio track is pinned (YouTube may auto-dub).
- **Columns:**
  - captions shown against reference lines;
  - transcript CER: alignment-free character error of the transcribed text
    against the reference. It exceeds 100% when Whisper loops on a phrase;
  - words covered: reference words that appear in a caption on screen from 1 s
    before the line to 8 s after it;
  - on screen while talking: share of the reference's speech time with a
    caption on screen; longest gap: the longest talking stretch with none;
  - delay: from the end of the speech to the caption on screen (live captions);
  - start offset: for read-ahead captions, |caption appears − its words start|
    (P50) and the share within 0.5 s, the spec's target;
  - too short: captions that left before their reading time;
  - shown while paused: captions that appeared while the video was paused.

### Audio before (2026-11-16): live captions trail the speech

The first baseline (before any sync work) showed captions arriving 2–4.5 s
after the speech (up to 11.7 s), 1–5 per run appearing over a paused frame,
some leaving before they could be read, and Whisper looping on music or crowd
noise. Live captions now follow the video (no caption over a paused frame, a
seek clears the screen, the newest line holds until the next), but they still
trail the speech by the transcription time.

### Audio read-ahead (2026-11-16): live captions → read-ahead

On YouTube the extension now reads the audio the player has already buffered,
transcribes it ahead of playback (Whisper with sentence timestamps over a
28 s sliding window) and shows each caption when its words are spoken. Same
day, same harness, one live sample each (`ra-live-final` → `ra-live-readahead`,
`ra-local-final` → `ra-local-readahead`):

| run | video | captions / ref lines | transcript CER | words covered | on screen while talking | longest gap | start offset P50 / within 0.5 s |
|---|---|---|---|---|---|---|---|
| youtube | -ci-Ursh0XQ (ko) | 10/60 → 28/60 | 77% → 54% | 35% → 53% | 52% → 61% | 6.4 s → 6.4 s | 1.8 s / 0% → 0.7 s / 41% |
| youtube | 27VKumB17kE (es) | 12/13 → 19/14 | 45% → 34% | 72% → 83% | 58% → 77% | 21.9 s → 10.6 s | – → 2.4 s / 0% |
| youtube | 5INsXNUaRdE (ja) | 11/14 → 17/14 | 56% → 45% | 33% → 54% | 80% → 65% | 3.0 s → 3.8 s | – → 0.3 s / 50% |
| local | -ci-Ursh0XQ (ko) | 12/63 → 27/63 | 62% → 48% | 47% → 65% | 70% → 96% | 6.3 s → 3.8 s | 1.3 s / 33% → 0.4 s / 52% |
| local | 27VKumB17kE (es) | 14/14 → 19/14 | 28% → 30% | 88% → 94% | 89% → 100% | 5.7 s → 0.0 s | – → 0.9 s / 10% |
| local | 5INsXNUaRdE (ja) | 13/14 → 14/14 | 39% → 41% | 31% → 64% | 45% → 93% | 4.1 s → 1.3 s | 2.5 s / 0% → 0.5 s / 33% |

E2E (`captions-readahead.spec`, local MSE fixture): captions appear 0.02–0.1 s
after their speech starts, on the GPU (Chrome) and the CPU (Chromium).

What it shows:

- **More of what is said reaches the screen**: words covered is up in all six
  runs (Japanese 31–33% → 54–64%), and transcription is as good or better
  (Whisper hears whole sentences instead of 8 s cuts).
- **The screen is rarely empty while someone talks** on the local copies
  (93–100%). Live runs restart capture every 30 s (one tab captures at a time),
  so each window starts cold; live Japanese dropped (80% → 65%).
- **Timing**: half the Korean and Japanese lines start within 0.5 s of the
  reference (auto captions, themselves word-timed). Spanish manual cues are
  6–9 s long and start mid-sentence, so its start offset says little.
- Bugs found on real YouTube and fixed on the way: audio beyond the video
  buffer was rejected (read-ahead fell back mid-piece), the tap re-decoded the
  same audio up to 159 times, 10 s VAD cuts lost words mid-sentence.
- **Left**: Korean casters still lose about half their words (fast, overlapping
  speech); the 2 s lead needed before read-ahead takes over; Whisper still
  mishears names.
