import { detBoxes, detInputSize, filterSubtitleBoxes, groupLines, Box } from '../detect';

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
