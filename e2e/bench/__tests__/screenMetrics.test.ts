import { lineTimeline, screenMetrics, type FrameSample } from '../screenMetrics';

const s = (t: number, burned: string | null, overlay: string | null): FrameSample => ({ t, burned, overlay });

describe('lineTimeline: frames -> the lines that were on screen', () => {
  it('merges consecutive frames with the same text (small OCR differences included)', () => {
    const lines = lineTimeline([s(0, '안녕하세요', null), s(0.5, '안녕하세요.', null), s(1, null, null), s(1.5, '반갑습니다', null)], 'burned');
    expect(lines).toEqual([
      { text: '안녕하세요', from: 0, to: 1 },
      { text: '반갑습니다', from: 1.5, to: 2 },
    ]);
  });
});

describe('screenMetrics: what a viewer saw at each moment', () => {
  // Korean line 0 on screen 10-13, line 1 13-16.
  const korean = [
    { text: 'k0', from: 10, to: 13 },
    { text: 'k1', from: 13, to: 16 },
  ];

  it('right on time: the overlay shows the translation of the Korean line on screen', () => {
    const samples = [s(10, 'k0', 'e0'), s(11, 'k0', 'e0'), s(13, 'k1', 'e1'), s(14, 'k1', 'e1')];
    const overlay = [
      { text: 'e0', from: 10, to: 13 },
      { text: 'e1', from: 13, to: 16 },
    ];
    const m = screenMetrics(samples, korean, overlay, [
      { overlayIndex: 0, koreanIndex: 0, correct: true },
      { overlayIndex: 1, koreanIndex: 1, correct: true },
    ]);
    expect(m.right).toBe(1);
    expect(m.lagP50).toBe(0);
    expect(m.linesTranslated).toBe(1);
  });

  it('late: the previous line still showing counts as late (after a 0.5 s grace), lag measured per line', () => {
    const samples = [s(10, 'k0', null), s(11, 'k0', null), s(12, 'k0', 'e0'), s(13.3, 'k1', 'e0'), s(14, 'k1', 'e0'), s(15, 'k1', 'e1')];
    const overlay = [
      { text: 'e0', from: 12, to: 15 },
      { text: 'e1', from: 15, to: 16 },
    ];
    const m = screenMetrics(samples, korean, overlay, [
      { overlayIndex: 0, koreanIndex: 0, correct: true },
      { overlayIndex: 1, koreanIndex: 1, correct: true },
    ]);
    expect(m.missing).toBeCloseTo(2 / 6); // 10, 11
    expect(m.right).toBeCloseTo(3 / 6); // 12, 13.3 (grace), 15
    expect(m.late).toBeCloseTo(1 / 6); // 14
    expect(m.lagP50).toBeCloseTo(2); // e0 at 12 for k0 at 10; e1 at 15 for k1 at 13
  });

  it('wrong: an overlay that translates no Korean line, or a bad translation', () => {
    const samples = [s(10, 'k0', 'junk'), s(13, 'k1', 'bad')];
    const overlay = [
      { text: 'junk', from: 10, to: 13 },
      { text: 'bad', from: 13, to: 16 },
    ];
    const m = screenMetrics(samples, korean, overlay, [
      { overlayIndex: 0, koreanIndex: null, correct: false },
      { overlayIndex: 1, koreanIndex: 1, correct: false },
    ]);
    expect(m.wrong).toBe(1);
  });

  it('moments without a Korean subtitle are not scored', () => {
    const m = screenMetrics([s(5, null, null), s(10, 'k0', 'e0')], korean, [{ text: 'e0', from: 10, to: 13 }], [{ overlayIndex: 0, koreanIndex: 0, correct: true }]);
    expect(m.scored).toBe(1);
    expect(m.right).toBe(1);
  });
});

describe('screenMetrics: lingering', () => {
  it('counts moments with an English subtitle on screen but no Korean subtitle (share of all moments)', () => {
    const korean = [{ text: 'k0', from: 10, to: 12 }];
    const overlay = [{ text: 'e0', from: 10, to: 14 }];
    const samples = [s(10, 'k0', 'e0'), s(11, 'k0', 'e0'), s(12.5, null, 'e0'), s(13.5, null, 'e0'), s(15, null, null)];
    const m = screenMetrics(samples, korean, overlay, [{ overlayIndex: 0, koreanIndex: 0, correct: true }]);
    expect(m.shownWithoutSubtitle).toBeCloseTo(2 / 5);
  });
});
