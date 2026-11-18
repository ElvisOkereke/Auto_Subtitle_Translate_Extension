// Pure post-processing for PaddleOCR text detection (DB) and subtitle filtering.
// Parameters: docs/superpowers/decisions/2026-11-12-ocr-engine.md.

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Detector input size: long side <= maxSide, both sides multiples of 32 (min 32), never upscaled. */
export function detInputSize(width: number, height: number, maxSide = 960): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const round32 = (v: number) => Math.max(32, Math.round((v * scale) / 32) * 32);
  return { width: round32(width), height: round32(height) };
}

/**
 * Connected regions of the probability map above `thresh`, kept if their mean
 * probability >= boxThresh and they have >= minArea pixels, expanded by the DB
 * unclip distance (rectangle form) and clamped to the map. Map-pixel coordinates.
 */
export function detBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  opts: { thresh?: number; boxThresh?: number; unclip?: number; minArea?: number } = {}
): Box[] {
  const { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minArea = 10 } = opts;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const boxes: Box[] = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start] <= thresh) continue;
    seen[start] = 1;
    stack.push(start);
    let count = 0;
    let sum = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      count++;
      sum += prob[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
      for (const n of neighbours) {
        if (n >= 0 && !seen[n] && prob[n] > thresh) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (count < minArea || sum / count < boxThresh) continue;
    const bw = maxX + 1 - minX;
    const bh = maxY + 1 - minY;
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    boxes.push({
      x1: Math.max(0, minX - d),
      y1: Math.max(0, minY - d),
      x2: Math.min(width, maxX + 1 + d),
      y2: Math.min(height, maxY + 1 + d),
    });
  }
  return boxes;
}

/**
 * Keep subtitle-sized text only: height >= minRelBoxHeight of the crop (the
 * user-drawn box) and >= minRelTallest of the tallest such box. Drops small UI
 * text (buttons, HUD notices) that shares the box with the subtitle.
 */
export function filterSubtitleBoxes(
  boxes: Box[],
  cropHeight: number,
  opts: { minRelBoxHeight?: number; minRelTallest?: number } = {}
): Box[] {
  const { minRelBoxHeight = 0.35, minRelTallest = 0.6 } = opts;
  const tallEnough = boxes.filter(b => b.y2 - b.y1 >= minRelBoxHeight * cropHeight);
  if (!tallEnough.length) return [];
  const tallest = Math.max(...tallEnough.map(b => b.y2 - b.y1));
  return tallEnough.filter(b => b.y2 - b.y1 >= minRelTallest * tallest);
}

/** Group boxes into lines (vertical overlap > 50% of a box's height), top line first, each left to right. */
export function groupLines(boxes: Box[]): Box[][] {
  const sorted = [...boxes].sort((a, b) => (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2 || a.x1 - b.x1);
  const lines: Box[][] = [];
  for (const box of sorted) {
    const line = lines[lines.length - 1];
    const ref = line?.[line.length - 1];
    if (ref && Math.min(box.y2, ref.y2) - Math.max(box.y1, ref.y1) > 0.5 * (box.y2 - box.y1)) {
      line.push(box);
    } else {
      lines.push([box]);
    }
  }
  return lines.map(line => line.sort((a, b) => a.x1 - b.x1));
}

/** Normalized (0..1) rectangle of the video frame. */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a crop came from: the region it shows and the box the user drew (both normalized frame coordinates). */
export interface CropGeometry {
  region: FrameRect;
  box: FrameRect;
  /** This video's subtitle text height (fraction of the frame), once the caller has learned it. */
  textHeight?: number;
}

export interface SubtitlePick {
  boxes: Box[];
  /** Height of the picked text (median box height of its main line), fraction of the frame; 0 if none. */
  height: number;
  /** A text height was expected and only text of another size was found. */
  offSize: boolean;
}

// Measured on 8 hand-labelled videos x 8 box shapes (e2e/bench/box_robustness.py).
const MIN_TEXT_OF_FRAME = 0.03; // subtitle text is >= 3% of the frame height...
const MIN_TEXT_OF_BOX = 0.35; // ...or fills a snug box drawn around smaller text
const SPAN_GAP = 1.5; // a horizontal gap wider than 1.5 text heights separates unrelated text
const CENTRE_BAND = 0.12; // subtitles reach into the middle +-12% of the video (chat, logos, HUD sit at the sides)
const MIN_INSIDE_BOX = 0.1; // a span must be at least 10% inside the drawn box (the margin only completes cut text)
const SIMILAR_HEIGHT = 0.7; // the lines of one subtitle have similar heights
const LINE_GAP = 0.8; // ...and follow each other closely
const MAX_LINES = 3;
/** Text within this factor of the expected height is the subtitle's size. */
export const SIZE_BAND = [0.7, 1.45];

interface Span {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Median box height. */
  h: number;
  /** Tallest box. */
  tallest: number;
  boxes: Box[];
}

function toSpan(boxes: Box[]): Span {
  const heights = boxes.map(b => b.y2 - b.y1).sort((a, b) => a - b);
  const mid = heights.length >> 1;
  return {
    x1: Math.min(...boxes.map(b => b.x1)),
    y1: Math.min(...boxes.map(b => b.y1)),
    x2: Math.max(...boxes.map(b => b.x2)),
    y2: Math.max(...boxes.map(b => b.y2)),
    h: heights.length % 2 ? heights[mid] : (heights[mid - 1] + heights[mid]) / 2,
    tallest: heights[heights.length - 1],
    boxes,
  };
}

/**
 * The text boxes that make up the subtitle in a crop of `region`, wherever the
 * user drew the box: loose, the whole lower half, cutting the text. Other text
 * in the crop - stream chat, watermarks, logos, scorebugs, game HUD - is left out.
 *
 * Boxes are in crop pixels. Text smaller than 3% of the frame is dropped
 * (unless it fills a snug box); each line is split into spans at wide gaps;
 * candidate spans reach into the middle of the video and lie at least partly
 * inside the drawn box. The subtitle is the candidate with the largest
 * width x height (long lines beat big short logos), plus up to two similar
 * candidate lines directly above or below it; smaller text inside those spans
 * (a scorebug behind the subtitle) is dropped.
 */
export function selectSubtitleBoxes(boxes: Box[], cropWidth: number, cropHeight: number, geo: CropGeometry): SubtitlePick {
  const fw = cropWidth / geo.region.w;
  const fh = cropHeight / geo.region.h;
  const ox = geo.region.x * fw;
  const oy = geo.region.y * fh;
  const user = { x1: geo.box.x * fw - ox, y1: geo.box.y * fh - oy, x2: (geo.box.x + geo.box.w) * fw - ox, y2: (geo.box.y + geo.box.h) * fh - oy };
  const floor = Math.min(MIN_TEXT_OF_FRAME * fh, MIN_TEXT_OF_BOX * (user.y2 - user.y1));
  const spans: Span[] = [];
  for (const line of groupLines(boxes.filter(b => b.y2 - b.y1 >= floor))) {
    let current = [line[0]];
    for (const b of line.slice(1)) {
      const prev = current[current.length - 1];
      if (b.x1 - prev.x2 > SPAN_GAP * Math.max(b.y2 - b.y1, prev.y2 - prev.y1)) {
        spans.push(toSpan(current));
        current = [b];
      } else {
        current.push(b);
      }
    }
    spans.push(toSpan(current));
  }
  const mid = fw / 2 - ox;
  const candidates = spans.filter(
    s =>
      s.x1 < mid + CENTRE_BAND * fw &&
      s.x2 > mid - CENTRE_BAND * fw &&
      Math.min(s.y2, user.y2) - Math.max(s.y1, user.y1) >= MIN_INSIDE_BOX * (s.y2 - s.y1) &&
      Math.min(s.x2, user.x2) > Math.max(s.x1, user.x1)
  );
  if (!candidates.length) return { boxes: [], height: 0, offSize: false };
  // Once the subtitle size is known, text of another size (game notices, overlays) only counts if nothing else is there.
  const expected = geo.textHeight ? geo.textHeight * fh : 0;
  const sized = expected ? candidates.filter(s => s.h >= SIZE_BAND[0] * expected && s.h <= SIZE_BAND[1] * expected) : candidates;
  const offSize = expected > 0 && !sized.length;
  const pool = sized.length ? sized : candidates;
  const anchor = pool.reduce((best, s) => ((s.x2 - s.x1) * s.tallest > (best.x2 - best.x1) * best.tallest ? s : best));
  const block = [anchor];
  const similar = pool.filter(s => s !== anchor && s.h >= SIMILAR_HEIGHT * anchor.h && s.h <= anchor.h / SIMILAR_HEIGHT);
  for (let grew = true; grew && block.length < MAX_LINES; ) {
    grew = false;
    const top = Math.min(...block.map(s => s.y1));
    const bottom = Math.max(...block.map(s => s.y2));
    const next = similar.find(
      s =>
        !block.includes(s) &&
        ((s.y2 <= top && top - s.y2 <= LINE_GAP * anchor.h) || (s.y1 >= bottom && s.y1 - bottom <= LINE_GAP * anchor.h) || (s.y1 < bottom && s.y2 > top))
    );
    if (next) {
      block.push(next);
      grew = true;
    }
  }
  const kept = block
    .flatMap(s => s.boxes)
    .filter(b => b.y2 - b.y1 >= SIMILAR_HEIGHT * anchor.tallest)
    .sort((a, b) => (a.y1 + a.y2) / 2 - (b.y1 + b.y2) / 2 || a.x1 - b.x1);
  return { boxes: kept, height: anchor.h / fh, offSize };
}

/** True if the text has at least one letter (any script): numbers alone are HUD values, scores or clocks. */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}
