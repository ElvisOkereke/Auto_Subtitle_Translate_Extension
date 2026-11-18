// Mapping between page coordinates, the video's rendered picture, and source pixels.
import type { NormalizedBox } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the picture sits inside the <video> element (object-fit: contain), relative to the element. */
export function contentRect(el: { clientWidth: number; clientHeight: number; videoWidth: number; videoHeight: number }): Rect {
  if (!el.videoWidth || !el.videoHeight) return { x: 0, y: 0, width: el.clientWidth, height: el.clientHeight };
  const scale = Math.min(el.clientWidth / el.videoWidth, el.clientHeight / el.videoHeight);
  const width = el.videoWidth * scale;
  const height = el.videoHeight * scale;
  return { x: (el.clientWidth - width) / 2, y: (el.clientHeight - height) / 2, width, height };
}

/** Normalized box -> page (viewport) rect, given the element's viewport rect and its content rect. */
export function boxToPage(box: NormalizedBox, element: Rect, content: Rect): Rect {
  return {
    x: element.x + content.x + box.x * content.width,
    y: element.y + content.y + box.y * content.height,
    width: box.w * content.width,
    height: box.h * content.height,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Page (viewport) rect -> normalized box of the picture, clamped to [0, 1]. */
export function pageToBox(rect: Rect, element: Rect, content: Rect): NormalizedBox {
  const x1 = clamp01((rect.x - element.x - content.x) / content.width);
  const y1 = clamp01((rect.y - element.y - content.y) / content.height);
  const x2 = clamp01((rect.x + rect.width - element.x - content.x) / content.width);
  const y2 = clamp01((rect.y + rect.height - element.y - content.y) / content.height);
  return { x: round6(x1), y: round6(y1), w: round6(x2 - x1), h: round6(y2 - y1) };
}

/** Normalized box -> integer source-pixel rect for drawImage(video, sx, sy, sw, sh, ...). */
export function boxToSource(box: NormalizedBox, videoWidth: number, videoHeight: number): { sx: number; sy: number; sw: number; sh: number } {
  return {
    sx: Math.round(box.x * videoWidth),
    sy: Math.round(box.y * videoHeight),
    sw: Math.max(1, Math.round(box.w * videoWidth)),
    sh: Math.max(1, Math.round(box.h * videoHeight)),
  };
}

/**
 * The box widened around its centre to `width` (at most 90% of the video, never
 * narrower than the box), kept inside the video: room for a translation that
 * is too long for a narrow subtitle box (English often needs more width than
 * the original's characters).
 */
export function widenAround(box: Rect, video: Rect, width: number): Rect {
  const w = Math.max(box.width, Math.min(width, video.width * 0.9));
  if (w === box.width) return box;
  const centre = box.x + box.width / 2;
  const x = Math.min(Math.max(centre - w / 2, video.x), video.x + video.width - w);
  return { x, y: box.y, width: w, height: box.height };
}

/** OCR reads this much around the drawn box (fraction of its size, each side): text the box cuts off is read whole. */
export const OCR_MARGIN = 0.75;

/** The part of the video OCR reads for a drawn box: the box grown by OCR_MARGIN on every side, inside the video. */
export function ocrRegion(box: NormalizedBox): NormalizedBox {
  const x1 = clamp01(box.x - OCR_MARGIN * box.w);
  const y1 = clamp01(box.y - OCR_MARGIN * box.h);
  const x2 = clamp01(box.x + box.w + OCR_MARGIN * box.w);
  const y2 = clamp01(box.y + box.h + OCR_MARGIN * box.h);
  return { x: round6(x1), y: round6(y1), w: round6(x2 - x1), h: round6(y2 - y1) };
}

/** The drawn box inside a width x height crop of `region`, in integer crop pixels (at least 1x1). */
export function boxInRegion(box: NormalizedBox, region: NormalizedBox, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(width - 1, Math.round(((box.x - region.x) / region.w) * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(((box.y - region.y) / region.h) * height)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, Math.round((box.w / region.w) * width))),
    h: Math.max(1, Math.min(height - y, Math.round((box.h / region.h) * height))),
  };
}
