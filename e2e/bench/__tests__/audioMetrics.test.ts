import { captionDelays, speechCovered, transcriptCer, wordsCovered, type RefLine, type ShownRecord } from '../metrics';

const cap = (over: Partial<ShownRecord & { source: string }>): ShownRecord & { source: string } => ({
  shownAt: 0,
  hiddenAt: null,
  lineStart: 0,
  text: '',
  pausedAtShow: false,
  wallShownAt: 0,
  wallHiddenAt: null,
  source: '',
  ...over,
});

describe('audio metrics', () => {
  const ref: RefLine[] = [
    { start: 10, end: 12, ko: '안녕하세요' },
    { start: 12.5, end: 14, ko: '반갑습니다' },
  ];

  it('transcript CER over a window, ignoring how the speech was split into captions', () => {
    const shown = [cap({ shownAt: 13, source: '안녕하세요 반갑' }), cap({ shownAt: 15, source: '습니다' })];
    expect(transcriptCer(ref, shown, [9, 20])).toBe(0);
  });

  it('caption delay from the end of the speech it carries', () => {
    const shown = [cap({ shownAt: 13.1, source: '안녕하세요' }), cap({ shownAt: 15.5, source: '반갑습니다' })];
    const d = captionDelays(ref, shown);
    expect(d.matched).toBe(2);
    expect(d.fromSpeechEndP50).toBeCloseTo(1.1, 5);
  });

  it('share of the reference that made it on screen near its time', () => {
    const shown = [cap({ shownAt: 13, source: '안녕하세요' })];
    expect(wordsCovered(ref, shown)).toBeCloseTo(0.5, 5);
    expect(wordsCovered(ref, [cap({ shownAt: 40, source: '안녕하세요' })])).toBe(0); // far from its time
  });
});

describe('speechCovered: is a caption on screen while someone is talking', () => {
  // Talking 10-20 and 30-40 (20 s of speech in the window 0-60).
  const ref: RefLine[] = [
    { start: 10, end: 15, ko: 'a' },
    { start: 15, end: 20, ko: 'b' },
    { start: 30, end: 40, ko: 'c' },
  ];

  it('the share of talking time with a caption on screen, and the longest talking stretch without one', () => {
    const shown = [cap({ shownAt: 12, hiddenAt: 16 }), cap({ shownAt: 31, hiddenAt: 35 })];
    const r = speechCovered(ref, shown, [0, 60]);
    expect(r.share).toBeCloseTo(8 / 20); // 12-16 and 31-35
    expect(r.longestGap).toBeCloseTo(5); // 35-40
  });

  it('overlapping captions count once; time outside speech does not count', () => {
    const shown = [cap({ shownAt: 5, hiddenAt: 14 }), cap({ shownAt: 13, hiddenAt: 25 })];
    const r = speechCovered(ref, shown, [0, 60]);
    expect(r.share).toBeCloseTo(10 / 20); // 10-20 covered, 30-40 not
    expect(r.longestGap).toBeCloseTo(10);
  });

  it('a caption still up when the run ended counts until the window end', () => {
    const r = speechCovered(ref, [cap({ shownAt: 36, hiddenAt: null })], [0, 38]);
    expect(r.share).toBeCloseTo(2 / 18); // speech in window: 10-20, 30-38
  });
});
