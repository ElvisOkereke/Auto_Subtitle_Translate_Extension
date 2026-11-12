import { contentRect, boxToPage, pageToBox, boxToSource } from '../videoGeometry';

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
