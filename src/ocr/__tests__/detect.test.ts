import { detBoxes, detInputSize, filterSubtitleBoxes, groupLines, hasLetters, selectSubtitleBoxes, Box } from '../detect';

function probMap(width: number, height: number, rects: { x1: number; y1: number; x2: number; y2: number; p: number }[]) {
  const map = new Float32Array(width * height);
  for (const r of rects) {
    for (let y = r.y1; y < r.y2; y++) for (let x = r.x1; x < r.x2; x++) map[y * width + x] = r.p;
  }
  return map;
}

describe('detInputSize', () => {
  it('limits the long side to 960 and rounds both sides to multiples of 32', () => {
    expect(detInputSize(1152, 151)).toEqual({ width: 960, height: 128 });
  });
  it('never goes below 32 and does not upscale small crops', () => {
    expect(detInputSize(300, 20)).toEqual({ width: 288, height: 32 });
  });
});

describe('detBoxes', () => {
  it('finds one box per connected region above threshold and expands it (DB unclip)', () => {
    const map = probMap(100, 40, [{ x1: 10, y1: 10, x2: 30, y2: 20, p: 0.9 }, { x1: 60, y1: 12, x2: 90, y2: 22, p: 0.9 }]);
    const boxes = detBoxes(map, 100, 40);
    expect(boxes).toHaveLength(2);
    // region 20x10: d = 200 * 1.5 / 60 = 5
    expect(boxes[0]).toEqual({ x1: 5, y1: 5, x2: 35, y2: 25 });
  });

  it('drops regions whose mean probability is below the box threshold', () => {
    const map = probMap(50, 20, [{ x1: 5, y1: 5, x2: 25, y2: 15, p: 0.4 }]);
    expect(detBoxes(map, 50, 20)).toEqual([]);
  });

  it('drops specks smaller than 10 pixels and clamps boxes to the map', () => {
    const map = probMap(40, 20, [{ x1: 0, y1: 0, x2: 3, y2: 3, p: 0.9 }, { x1: 0, y1: 0 + 10, x2: 20, y2: 20, p: 0.9 }]);
    const boxes = detBoxes(map, 40, 20);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].x1).toBe(0);
    expect(boxes[0].y2).toBe(20);
  });
});

describe('filterSubtitleBoxes', () => {
  const box = (y1: number, y2: number, x1 = 0): Box => ({ x1, y1, x2: x1 + 100, y2 });

  it('keeps subtitle-sized text and drops small UI text in the same crop', () => {
    const subtitle = box(30, 100); // 70 px in a 151 px crop
    const hud = box(110, 140, 300); // 30 px
    expect(filterSubtitleBoxes([subtitle, hud], 151)).toEqual([subtitle]);
  });

  it('returns nothing when only small text is present', () => {
    expect(filterSubtitleBoxes([box(10, 40), box(100, 125, 200)], 151)).toEqual([]);
  });

  it('drops boxes under 60% of the tallest kept box', () => {
    const tall = box(20, 100); // 80 px
    const medium = box(50, 95, 400); // 45 px: >= 35% of a 120 px crop (42) but < 60% of 80 (48)
    expect(filterSubtitleBoxes([tall, medium], 120)).toEqual([tall]);
  });
});

describe('groupLines', () => {
  it('groups vertically overlapping boxes into left-to-right lines, top line first', () => {
    const a: Box = { x1: 200, y1: 10, x2: 300, y2: 60 };
    const b: Box = { x1: 10, y1: 12, x2: 150, y2: 62 };
    const c: Box = { x1: 50, y1: 80, x2: 200, y2: 130 };
    expect(groupLines([c, a, b])).toEqual([[b, a], [c]]);
  });
});

describe('selectSubtitleBoxes (people draw loose, tight and shifted boxes)', () => {
  // A 1920x1080 frame; the crop is the user's box plus a margin (region).
  const FRAME = { w: 1920, h: 1080 };
  const geo = (region: { x: number; y: number; w: number; h: number }, box = region) => ({ region, box });
  /** A box given in frame pixels, returned in the crop's pixels. */
  const inCrop = (region: { x: number; y: number }, x1: number, y1: number, x2: number, y2: number): Box => ({
    x1: x1 - region.x * FRAME.w,
    y1: y1 - region.y * FRAME.h,
    x2: x2 - region.x * FRAME.w,
    y2: y2 - region.y * FRAME.h,
  });
  const lowerHalf = { x: 0, y: 0.5, w: 1, h: 0.5 };
  const pick = (boxes: Box[], g: ReturnType<typeof geo> & { textHeight?: number }) => selectSubtitleBoxes(boxes, g.region.w * FRAME.w, g.region.h * FRAME.h, g);
  const select = (boxes: Box[], g: ReturnType<typeof geo>) => pick(boxes, g).boxes;

  it('finds a normal-sized subtitle in a box far taller than the text (the old 35%-of-box rule dropped it)', () => {
    const subtitle = inCrop(lowerHalf, 700, 880, 1220, 940); // 60 px = 5.6% of the frame, 11% of the box
    expect(select([subtitle], geo(lowerHalf))).toEqual([subtitle]);
  });

  it('ignores stream chat and watermarks at the sides of the video', () => {
    const subtitle = inCrop(lowerHalf, 700, 880, 1220, 940);
    const chat = inCrop(lowerHalf, 20, 700, 520, 740);
    const watermark = inCrop(lowerHalf, 1600, 1000, 1900, 1050);
    expect(select([chat, subtitle, watermark], geo(lowerHalf))).toEqual([subtitle]);
  });

  it('prefers a long subtitle line over a big short logo behind it', () => {
    const logo = inCrop(lowerHalf, 900, 700, 1020, 780); // taller, but short
    const subtitle = inCrop(lowerHalf, 300, 960, 1620, 1000);
    expect(select([logo, subtitle], geo(lowerHalf))).toEqual([subtitle]);
  });

  it('keeps both lines of a two-line subtitle, top line first', () => {
    const top = inCrop(lowerHalf, 600, 860, 1320, 915);
    const bottom = inCrop(lowerHalf, 650, 925, 1270, 980);
    expect(select([bottom, top], geo(lowerHalf))).toEqual([top, bottom]);
  });

  it('drops smaller text on the same line as the subtitle (a scorebug behind it)', () => {
    const subtitle = inCrop(lowerHalf, 700, 880, 1220, 940);
    const score = inCrop(lowerHalf, 1240, 895, 1400, 925); // 30 px next to a 60 px subtitle
    expect(select([subtitle, score], geo(lowerHalf))).toEqual([subtitle]);
  });

  it('text only in the margin around the box is not read (it completes cut-off text, it does not add lines)', () => {
    const box = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };
    const region = { x: 0, y: 0.645, w: 1, h: 0.35 };
    const above = inCrop(region, 700, 710, 1220, 760); // a subtitle-sized caption above the user's box
    expect(select([above], geo(region, box))).toEqual([]);
    const cutOff = inCrop(region, 700, 790, 1220, 850); // straddles the box's top edge: kept whole
    expect(select([cutOff], geo(region, box))).toEqual([cutOff]);
  });

  it('a box drawn too high still reads a subtitle that mostly sits below its edge', () => {
    // Seen in the browser: box y 0.70-0.82, subtitle y 0.805-0.875 (21% of its height inside the box).
    const box = { x: 0.2, y: 0.7, w: 0.6, h: 0.12 };
    const region = { x: 0, y: 0.61, w: 1, h: 0.3 };
    const subtitle = inCrop(region, 700, 869, 1220, 945);
    expect(select([subtitle], geo(region, box))).toEqual([subtitle]);
  });

  it('reports the height of the text it found, as a fraction of the frame', () => {
    const subtitle = inCrop(lowerHalf, 700, 880, 1220, 940);
    const r = pick([subtitle], geo(lowerHalf));
    expect(r.height).toBeCloseTo(60 / 1080, 6);
    expect(r.offSize).toBe(false);
  });

  it('knowing the subtitle size, a wider game notice of another size loses to the subtitle', () => {
    const notice = inCrop(lowerHalf, 560, 760, 1360, 796); // "skill not ready": 36 px, very wide
    const subtitle = inCrop(lowerHalf, 800, 880, 1120, 950); // 70 px, short
    expect(select([notice, subtitle], geo(lowerHalf))).toEqual([notice]); // without the size, the wider one wins
    expect(pick([notice, subtitle], { ...geo(lowerHalf), textHeight: 70 / 1080 }).boxes).toEqual([subtitle]);
  });

  it('only text of another size: returned, but marked off-size (the caller decides)', () => {
    const notice = inCrop(lowerHalf, 560, 760, 1360, 796);
    const r = pick([notice], { ...geo(lowerHalf), textHeight: 70 / 1080 });
    expect(r.boxes).toEqual([notice]);
    expect(r.offSize).toBe(true);
  });

  it('nothing over the middle of the video: no subtitle', () => {
    expect(select([inCrop(lowerHalf, 20, 900, 400, 950)], geo(lowerHalf))).toEqual([]);
  });

  it('tiny text is ignored, unless the user drew the box snugly around it', () => {
    const small = inCrop(lowerHalf, 800, 900, 1120, 922); // 22 px = 2% of the frame
    expect(select([small], geo(lowerHalf))).toEqual([]);
    const snug = { x: 0.4, y: 0.82, w: 0.2, h: 0.04 };
    const region = { x: 0.25, y: 0.79, w: 0.5, h: 0.1 };
    const s = inCrop(region, 800, 890, 1120, 912);
    expect(select([s], geo(region, snug))).toEqual([s]);
  });
});

describe('hasLetters (numbers alone are HUD, scores or clocks, not subtitles)', () => {
  it('rejects digits and punctuation only', () => {
    expect(hasLetters('2 150 29')).toBe(false);
    expect(hasLetters('185 /628 305 /.305')).toBe(false);
    expect(hasLetters('43:52')).toBe(false);
  });
  it('accepts text in any script, also short and mixed with numbers', () => {
    for (const t of ['아!', 'GG!', '生活', 'Да', '3번 와!']) expect(hasLetters(t)).toBe(true);
  });
});
