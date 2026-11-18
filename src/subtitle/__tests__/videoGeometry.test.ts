import { contentRect, boxToPage, pageToBox, boxToSource, widenAround, ocrRegion, boxInRegion } from '../videoGeometry';

describe('videoGeometry', () => {
  it('computes the letterboxed content rect (object-fit: contain)', () => {
    const r = contentRect({ clientWidth: 1280, clientHeight: 720, videoWidth: 1920, videoHeight: 800 });
    expect(r.x).toBe(0);
    expect(r.y).toBeCloseTo(93.33, 2);
    expect(r.width).toBe(1280);
    expect(r.height).toBeCloseTo(533.33, 2);
  });

  it('pillarboxes tall video', () => {
    const r = contentRect({ clientWidth: 1280, clientHeight: 720, videoWidth: 720, videoHeight: 1280 });
    expect(r.height).toBe(720);
    expect(r.width).toBeCloseTo(405, 0);
    expect(r.x).toBeCloseTo(437.5, 1);
  });

  it('round-trips page rect <-> normalized box', () => {
    const element = { x: 24, y: 80, width: 1280, height: 720 };
    const content = contentRect({ clientWidth: 1280, clientHeight: 720, videoWidth: 1920, videoHeight: 1080 });
    const box = { x: 0.2, y: 0.75, w: 0.6, h: 0.14 };
    const back = pageToBox(boxToPage(box, element, content), element, content);
    expect(back.x).toBeCloseTo(box.x, 6);
    expect(back.y).toBeCloseTo(box.y, 6);
    expect(back.w).toBeCloseTo(box.w, 6);
    expect(back.h).toBeCloseTo(box.h, 6);
  });

  it('clamps a page rect that extends past the video to [0, 1]', () => {
    const element = { x: 0, y: 0, width: 1000, height: 500 };
    const content = contentRect({ clientWidth: 1000, clientHeight: 500, videoWidth: 1000, videoHeight: 500 });
    expect(pageToBox({ x: -50, y: 400, width: 600, height: 300 }, element, content)).toEqual({ x: 0, y: 0.8, w: 0.55, h: 0.2 });
  });

  it('maps a normalized box to integer source pixels for drawImage', () => {
    expect(boxToSource({ x: 0.2, y: 0.76, w: 0.6, h: 0.1 }, 1920, 1080)).toEqual({ sx: 384, sy: 821, sw: 1152, sh: 108 });
  });
});

describe('widenAround (a translation too long for a narrow box gets more room)', () => {
  const video = { x: 100, y: 50, width: 1000, height: 562 };

  it('widens around the box centre to the width asked for, at most 90% of the video', () => {
    const box = { x: 500, y: 500, width: 200, height: 60 };
    expect(widenAround(box, video, 600)).toEqual({ x: 300, y: 500, width: 600, height: 60 });
    expect(widenAround(box, video, 5000)).toEqual({ x: 150, y: 500, width: 900, height: 60 });
  });

  it('stays inside the video when the box sits near an edge', () => {
    expect(widenAround({ x: 110, y: 500, width: 100, height: 60 }, video, 500)).toEqual({ x: 100, y: 500, width: 500, height: 60 });
    expect(widenAround({ x: 1000, y: 500, width: 90, height: 60 }, video, 500)).toEqual({ x: 600, y: 500, width: 500, height: 60 });
  });

  it('never narrower than the box', () => {
    const box = { x: 300, y: 500, width: 700, height: 60 };
    expect(widenAround(box, video, 400)).toEqual(box);
  });
});

describe('ocrRegion / boxInRegion (OCR reads around the drawn box; change detection watches the box)', () => {
  it('grows the box by 75% of its size on every side, inside the video', () => {
    const r = ocrRegion({ x: 0.2, y: 0.75, w: 0.6, h: 0.14 });
    expect(r.x).toBe(0);
    expect(r.w).toBe(1);
    expect(r.y).toBeCloseTo(0.645, 6);
    expect(r.h).toBeCloseTo(0.35, 6);
  });

  it('a box in the middle of the video grows evenly', () => {
    const r = ocrRegion({ x: 0.4, y: 0.4, w: 0.2, h: 0.1 });
    expect(r.x).toBeCloseTo(0.25, 6);
    expect(r.y).toBeCloseTo(0.325, 6);
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.h).toBeCloseTo(0.25, 6);
  });

  it('locates the drawn box inside a crop of the region, in crop pixels', () => {
    const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.1 };
    const region = ocrRegion(box);
    expect(boxInRegion(box, region, 500, 250)).toEqual({ x: 150, y: 75, w: 200, h: 100 });
  });
});
