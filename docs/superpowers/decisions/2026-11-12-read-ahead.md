# Decision: read-ahead source for subtitle mode

Date: 2026-11-12 · Plan: `docs/superpowers/plans/2026-11-12-burned-in-subtitle-translation.md` (Task 8)

## Decision

**(b) Tap the player's own media stream.** A main-world script wraps
`SourceBuffer.prototype.appendBuffer` for the video SourceBuffer, demuxes the
appended fragmented-MP4 segments, decodes them with WebCodecs `VideoDecoder`
ahead of playback, and hands box crops (≥ 4 per second of video) to the same
change-detection → OCR → translation pipeline at `priority: 'readahead'`.

Not chosen: **(a) hidden second player** — on real YouTube the off-screen
embed never started playing (0×0, `currentTime` stuck at 0), and it would
double network use and bring its own ads/consent.

## Measured (installed Chrome 157, real YouTube, `e2e/tests/spike-readahead.spec.ts`)

- YouTube serves the video track as **fragmented MP4, AV1**
  (`video/mp4; codecs="av01.0.04M.08"`) in its own SourceBuffer, appended in
  ~20 KB pieces; audio is a separate WebM/Opus SourceBuffer.
- YouTube keeps **23–38 s** buffered ahead of `currentTime`
  (`e2e/.perf/readahead-spike-youtube.json`).
- The tap prototype (`e2e/fixtures/spike/mse-tap.js`) demuxed and decoded
  **1,150 AV1 frames within the first 3 s** with no decoder errors — orders of
  magnitude above the 4 box-frames/s needed — so lead is bounded by YouTube's
  buffer, not by decoding. Zero extra network bytes.
- Caveats: the run was confounded by a pre-roll ad (separate media in the same
  `<video>`) and by YouTube stopping automated playback after ~35 s
  ("Something went wrong") — the same cutoff seen during design recon, a
  test-environment limit, not something users hit. Sustained lead is
  therefore measured on the local fixture in Task 9, which is changed to serve
  the same format as YouTube (fMP4/AV1 video + WebM/Opus audio).

## Consequences for Task 9

- Container support: **fMP4** (YouTube's format here). VP9-in-WebM, which
  YouTube serves to clients without AV1 decode, is not tapped in this piece:
  read-ahead is then simply off and the live path (unchanged) carries the
  experience. Recorded as follow-up.
- Presentation time = sample decode time / timescale + the SourceBuffer's
  `timestampOffset` at append time.
- Ads: segments appended while `.ad-showing` belong to the ad and are ignored;
  a new `moov` (init segment) re-configures the decoder.
- Discontinuities (seeks): when a segment's start time doesn't follow the
  previous one, reset the decoder and wait for the next keyframe.
- The tap runs in the page's main world (manifest content script with
  `"world": "MAIN"` on YouTube); crops go to the isolated-world content script
  through `postMessage` with transferable `ImageBitmap`s.
