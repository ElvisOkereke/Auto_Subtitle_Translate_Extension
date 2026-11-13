// Where an on-page panel goes next to the area the user selected: below it
// when it fits, otherwise above, otherwise pinned to the top (the panel then
// scrolls inside its max-height). Always inside the viewport.

export interface Area { top: number; bottom: number; left: number }
export interface Size { width: number; height: number }

const GAP = 6;
const MARGIN = 8;

export function placePanel(area: Area, size: Size, viewport: Size): { top: number; left: number } {
  const left = Math.max(MARGIN, Math.min(area.left, viewport.width - size.width - MARGIN));
  const below = area.bottom + GAP;
  const above = area.top - GAP - size.height;
  let top: number;
  if (below + size.height <= viewport.height - MARGIN) top = below;
  else if (above >= MARGIN) top = above;
  else top = MARGIN;
  return { top, left };
}
