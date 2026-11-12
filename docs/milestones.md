# Milestones

Wins worth sharing, newest first. Each has the headline, the proof (a number
or what was shown working), and where the evidence lives. Numbers come from
automated runs in a real browser (details: [performance.md](performance.md)).

## 2026-11-12 — Translating burned-in subtitles before they appear

- **Read-ahead:** the extension reads the video YouTube has already buffered
  (~30 s ahead), OCRs and translates the subtitles in it, so **29 of 29
  subtitle lines were translated before they appeared on screen**, ~28 s
  early, with zero OCR work during steady playback.
- Works on a real YouTube video (Korean League of Legends stream): 12/12 lines
  shown with 1.8% OCR error within the window YouTube allows automated playback.

## 2026-11-12 — Live burned-in subtitle translation (Subtitles mode)

- Draw a box around the subtitles burned into a video → the English sits right
  on top of the original line, in place, as the video plays.
- **Subtitle appears → English on screen in 0.20 s** (median, Chrome + GPU);
  **0.48 s including a real DeepL round trip**. 29/29 lines shown.
- On-device OCR (PaddleOCR in the browser, WebGPU): **2.3% character error
  rate, 22 ms per frame**, 0 false positives on gameplay frames. Beat Tesseract
  (17.4% error, 17/18 false positives) in our benchmark.

## 2026-11-12 — Translation engine benchmark

- 36 real Korean League subtitle lines, scored against fan-quality references:
  **Claude Opus 5.5 with context 89%**, Sonnet 5.5 82%, DeepL with context 65%,
  DeepL line-by-line 46%, Google 42%, local open models ≤ 15%.
- Finding: giving the translator the neighbouring lines is the single biggest
  quality gain. Context-aware Claude translation is the next piece.

## 2026-11-11 — Live captions for any tab's audio, fully on-device speech recognition

- Whisper runs locally in the browser (no server, no key): **end of speech →
  translated caption in 1.05 s** on GPU.
- Speech model download cut from **971 MB to 209 MB** and inference **5× faster**
  (1.93 s → 0.38 s per clip) with no accuracy loss on the test clips.

## 2026-11-11 — Everything verified by machines, not by hand

- Every feature is tested end to end by an automated real browser with the
  extension loaded: captions from real tab audio, OCR on real video frames,
  real DeepL calls, real YouTube, and Claude grading the translations.
