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
