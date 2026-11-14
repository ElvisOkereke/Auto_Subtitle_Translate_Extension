import { captionDelays, transcriptCer, wordsCovered, type RefLine, type ShownRecord } from '../metrics';

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
