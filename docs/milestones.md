# Milestones

Wins worth sharing, newest first. Each has the headline, the proof (a number
or what was shown working), and where the evidence lives. Numbers come from
automated runs in a real browser (details: [performance.md](performance.md)).

## 2026-11-13 — Tested on real YouTube in 5 languages; subtitles you can actually read

- **A real-world benchmark**: 8 YouTube videos with burned-in subtitles in
  Korean, Chinese, Portuguese, Russian and French (League of Legends, football,
  a TV drama), with reference subtitles checked frame by frame. It plays on
  real YouTube by sliding across fresh windows (YouTube stops automated
  playback after ~40 s), using real DeepL and Claude.
- **No more lines vanishing before you can read them**: before the fix, a third
  to a half of the translated lines left the screen early; now none do. Each
  line gets at least 1.5 s, more for long lines, and pausing freezes it.
- **Read-ahead now works on YouTube's other video format (VP9)**: lines ready
  before they appear went from 0% to up to 100% there, and the Claude-only mode
  stopped losing most lines.
- **Small subtitles**: the Chinese football clip went from 28 to 43 of 47 lines
  on real YouTube.
- The benchmark runs 2–3× faster with parallel workers.

## 2026-11-12 — A redesigned popup, in light and dark

- The popup now opens on what you actually do: a subtitle-style **caption bar**
  tells you what's happening in this tab ("Translating Korean subtitles into
  English"), with the two modes, the target language and Screen Translate right
  underneath. Keys, subscription, engine and glossary moved behind one gear.
- **Light and dark mode** (or match the system), including the Screen Translate
  panel drawn on web pages; one bundled, highly legible typeface (Atkinson
  Hyperlegible).
- Every label now says what the button does ("Start live captions", "Use saved
  box", "Translate with: your subscription / your own keys").
- Checked in a real browser by automated tests that screenshot both themes.

## 2026-11-12 — Subscriptions: translation that works out of the box

- Sign in with your email (one-time code) and subscribe — no API keys needed.
  The hosted service runs the same context-aware engine with the project's own
  keys; Stripe handles payment, or a plan can be granted by hand.
- Priced from measured costs: **Standard $9.99/month** (≈ 3–5 hours of
  Claude-quality translation) and **Pro $24.99/month** (Opus, ≈ 4.5–6.5 hours);
  every request is metered against a monthly budget so costs can't run away.
- Bring-your-own-keys still works for heavy watchers.
- Ready to deploy on Google Cloud (Docker image on a small VM with HTTPS, one-command deploy script).

## 2026-11-12 — Context-aware translation: Claude knows what you're watching

- Subtitles are translated **fast then best**: DeepL appears instantly, then
  Claude replaces it with a translation that knows the video (title, channel,
  description) and keeps names consistent with a glossary it learns as it goes.
- League of Legends test: translation quality judged **0.93 vs 0.50 for DeepL**;
  champion names and slang right in **10–11 of 11** lines across runs (DeepL 9/11); every name
  spelled the same way throughout.
- With read-ahead, **93% of lines already had Claude's version before they
  appeared** — on a stream that starts playing at 0:00. First line: 2.9 s
  (was 11.5 s before a latency pass).
- Not just games: Claude beat DeepL on real subtitles of a **LaLiga Clásico
  (Spanish, 83% of lines), an anime episode (Japanese, 67%) and a K-drama
  (Korean, 77%)** in a blind comparison.
- Costs about **$0.006 per subtitle line (~$3.40 per hour of video) with Claude
  Opus 5.5** — the starting point for subscription pricing.

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
