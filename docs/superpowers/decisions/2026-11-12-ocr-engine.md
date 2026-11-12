# Decision: OCR engine for subtitle mode

Date: 2026-11-12 · Plan: `docs/superpowers/plans/2026-11-12-burned-in-subtitle-translation.md` (Task 2)

## Decision

**PaddleOCR PP-OCRv5 (mobile) via ONNX Runtime Web** — text detection
followed by per-region recognition with greedy CTC decoding — with a
**box-relative size filter** that keeps only subtitle-sized text.

Single tier: it meets the live latency budget on CPU alone (~50 ms per crop),
so the "fast/accurate pair" fallback in the spec is not needed. A heavier
`PP-OCRv5_server_rec` (84 MB) exists for Chinese/Japanese and can become an
accurate read-ahead tier later if those languages need it.

## Measured (58 subtitle crops + 18 no-subtitle crops from the test video)

Box `{x:.2, y:.75, w:.6, h:.14}` of 1080p frames (1152×151 px). CER = Levenshtein
over whitespace-stripped text / reference length. CPU = onnxruntime 1.31 /
Tesseract 5.3 on a Ryzen 7 9800X3D (WebGPU latency is asserted in the E2E suite).
Script: `e2e/bench/ocr_bench.py`; raw results: `e2e/.perf/perf-ocr.json`.

| Engine | CER | False positives (no-subtitle) | CPU median / p90 per crop |
|---|---|---|---|
| **PaddleOCR v5 mobile, Korean, box filter** | **2.3%** | **0 / 18** | 49 / 65 ms |
| PaddleOCR v5 mobile, Korean, no filter | 34.9% | 1 / 18 | 54 / 67 ms |
| Tesseract `kor` (tessdata_best), binarized | 17.4% | 17 / 18 | 74 / 97 ms |
| Tesseract `kor`, raw | 86.4% | 16 / 18 | 124 / 183 ms |

Not benchmarked: transformer OCR via transformers.js. The only Korean-capable
option (PaddleOCR-VL, ~0.9B params, ~1 GB) cannot meet the 250 ms/crop budget,
and PaddleOCR's residual errors are already single characters (뽀→뿐, 빡→빠, 줘→쥐).

The unfiltered error is almost entirely *other* on-screen text inside the box:
the League client's "스킬 보기" button and HUD notices such as "스킬이 아직
준비되지 않았습니다". Subtitle text boxes measured 66–83 px tall; every other
text box in the crops was ≤ 40 px.

## Pipeline parameters (Task 3 implements exactly these)

- **Models** (`https://huggingface.co/PaddlePaddle/<repo>/resolve/main/inference.onnx`):

  | Language | Detection | Recognition repo | Size |
  |---|---|---|---|
  | all | `PP-OCRv5_mobile_det_onnx` | — | 4.8 MB |
  | `ko` | | `korean_PP-OCRv5_mobile_rec_onnx` | 13.4 MB |
  | `ja`, `zh-Hans`, `zh-Hant` | | `PP-OCRv5_mobile_rec_onnx` | 16.5 MB |
  | `es`, `fr`, `de`, `pt` | | `latin_PP-OCRv5_mobile_rec_onnx` | 8.0 MB |
  | `ru` | | `cyrillic_PP-OCRv5_mobile_rec_onnx` | 8.0 MB |

  Character sets come from each repo's `inference.yml`
  (`PostProcess.character_dict`); they are extracted once into committed JSON
  (`src/ocr/charsets/*.json`) so the extension needs no YAML parser. CTC
  classes = `[blank] + character_dict + [' ']`.
- **Detection:** input BGR, resize so the long side ≤ 960 and both sides are
  multiples of 32 (min 32), normalize with mean `[0.485, 0.456, 0.406]`, std
  `[0.229, 0.224, 0.225]` (applied in BGR channel order, as PaddleOCR does),
  NCHW. Probability map threshold **0.3**; connected components (≥ 10 px);
  keep if mean probability inside the component ≥ **0.6**; axis-aligned box
  expanded by `d = area × 1.5 / perimeter` (DB unclip, rectangle form).
- **Subtitle filter:** keep a text box only if its height ≥ **35% of the
  drawn box's height** *and* ≥ **60% of the tallest kept box**. (On the test
  video subtitles fill 44–55% of the box; UI text ≤ 26%.)
- **Recognition:** crop each kept box from the original pixels, BGR, resize to
  height **48** keeping aspect (width ≤ 3200), normalize `(x/255 − 0.5)/0.5`,
  NCHW. Greedy CTC: argmax per step, drop blanks (index 0) and repeats;
  confidence = mean max-probability of emitted steps.
- **Lines:** sort boxes by vertical center, group boxes whose vertical overlap
  is > 50% of the box height into one line, order left→right, join with
  spaces; lines joined with spaces. Empty result → "no subtitle".
- **Device:** WebGPU with wasm fallback (same restart-on-wasm pattern as the
  Whisper worker).
