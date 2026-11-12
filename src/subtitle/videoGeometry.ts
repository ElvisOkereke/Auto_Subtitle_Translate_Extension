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
