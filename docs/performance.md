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
| **Claude Opus 5.5 (default)** | **0.91–0.93** | **11 / 11** | yes | **93%** (the first two lines, 1.4 s and 2.9 s after play, are late) | $0.0059 | **$3.40** |
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
