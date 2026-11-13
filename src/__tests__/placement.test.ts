import { placePanel } from '../ui/placement';

describe('on-page panel placement', () => {
  const viewport = { width: 1000, height: 700 };
  const rect = (top: number, bottom: number, left: number) => ({ top, bottom, left });

  it('goes under the selected area when it fits', () => {
    expect(placePanel(rect(100, 140, 50), { width: 320, height: 120 }, viewport)).toEqual({ top: 146, left: 50 });
  });

  it('goes above the selected area when there is no room below (e.g. a caption at the bottom)', () => {
    expect(placePanel(rect(600, 660, 50), { width: 320, height: 120 }, viewport)).toEqual({ top: 474, left: 50 });
  });

  it('stays inside the viewport horizontally', () => {
    expect(placePanel(rect(100, 140, 900), { width: 320, height: 120 }, viewport).left).toBe(672);
    expect(placePanel(rect(100, 140, -40), { width: 320, height: 120 }, viewport).left).toBe(8);
  });

  it('pins to the top when it fits neither above nor below (the panel scrolls inside)', () => {
    expect(placePanel(rect(300, 400, 50), { width: 320, height: 600 }, viewport).top).toBe(8);
  });
});
