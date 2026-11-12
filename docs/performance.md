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
