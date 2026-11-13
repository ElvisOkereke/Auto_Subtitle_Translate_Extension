import {
  coverageByDuration,
  matchLines,
  minDisplaySeconds,
  missBuckets,
  missesBySize,
  readyBeforeShown,
  shownWhilePaused,
  staleWhilePaused,
  timeOnScreen,
  upgradesOnScreen,
  type RefLine,
  type ShownRecord,
} from '../metrics';

const rec = (over: Partial<ShownRecord>): ShownRecord => ({
  shownAt: 0,
  hiddenAt: null,
  lineStart: 0,
  text: '',
  pausedAtShow: false,
  wallShownAt: 0,
  wallHiddenAt: null,
  ...over,
});

describe('benchmark metrics', () => {
  it('matches a line shown inside its window', () => {
    const ref: RefLine = { start: 10, end: 12, ko: '안녕' };
    const [m] = matchLines([ref], [rec({ lineStart: 9.5, shownAt: 9.5, text: '[EN-US] 안녕' })]);
    expect(m.shown).not.toBeNull();
    expect(m.cer).toBe(0);
  });

  it('does not match a line shown too early or with the wrong text', () => {
    const ref: RefLine = { start: 10, end: 12, ko: '안녕하세요' };
    const [early] = matchLines([ref], [rec({ lineStart: 9.2, text: '[EN-US] 안녕하세요' })]);
    const [wrong] = matchLines([ref], [rec({ lineStart: 10.5, text: '[EN-US] 전혀다른문장' })]);
    expect(early.shown).toBeNull();
    expect(wrong.shown).toBeNull();
  });

  it('buckets misses by on-screen duration', () => {
    const refs: RefLine[] = [0.3, 0.7, 1.5, 3].map((d, i) => ({ start: i * 10, end: i * 10 + d, ko: '가' }));
    expect(missBuckets(matchLines(refs, []))).toEqual({ '<0.5': 1, '0.5-1': 1, '1-2': 1, '>2': 1 });
  });

  it('buckets misses by text size when known', () => {
    const refs: RefLine[] = [
      { start: 0, end: 1, ko: '가', h: 20 },
      { start: 2, end: 3, ko: '나', h: 30 },
      { start: 4, end: 5, ko: '다', h: 50 },
      { start: 6, end: 7, ko: '라' },
    ];
    expect(missesBySize(matchLines(refs, []))).toEqual({ '<24px': 1, '24-40px': 1, '>40px': 1, unknown: 1 });
  });

  it('coverage splits at 0.5 s', () => {
    const refs: RefLine[] = [
      { start: 0, end: 2, ko: '하나' },
      { start: 5, end: 7, ko: '둘' },
      { start: 10, end: 10.3, ko: '셋' },
    ];
    const shown = [rec({ lineStart: 0, text: '[EN-US] 하나' }), rec({ lineStart: 10, text: '[EN-US] 셋' })];
    const c = coverageByDuration(matchLines(refs, shown));
    expect(c.long).toEqual({ lines: 2, matched: 1, ratio: 0.5 });
    expect(c.short).toEqual({ lines: 1, matched: 1, ratio: 1 });
  });

  it('minimum display time', () => {
    expect(minDisplaySeconds('Hi')).toBe(1.5);
    expect(minDisplaySeconds('x'.repeat(45))).toBe(3);
    expect(minDisplaySeconds('x'.repeat(200))).toBe(6);
  });

  it('a replaced line is not too short; one that vanished early is', () => {
    const replaced = [rec({ lineStart: 10, shownAt: 10, hiddenAt: 10.4, text: 'Hi' }), rec({ lineStart: 10.4, shownAt: 10.4, hiddenAt: 12, text: 'Next line' })];
    expect(timeOnScreen(replaced)).toEqual({ checked: 2, tooShort: 0 });
    const vanished = [rec({ lineStart: 10, shownAt: 10, hiddenAt: 10.4, text: 'Hi' })];
    expect(timeOnScreen(vanished)).toEqual({ checked: 1, tooShort: 1 });
  });

  it('an in-place upgrade (DeepL -> Claude) of the same line counts as one span', () => {
    const upgraded = [
      rec({ lineStart: 10, shownAt: 10, hiddenAt: 10.8, text: 'Fast line', quality: 'fast' }),
      rec({ lineStart: 10, shownAt: 10.8, hiddenAt: 11.6, text: 'Better line', quality: 'better' }),
    ];
    expect(timeOnScreen(upgraded)).toEqual({ checked: 1, tooShort: 0 });
    expect(upgradesOnScreen(upgraded)).toBe(1);
  });

  it('counts lines shown while paused', () => {
    expect(shownWhilePaused([rec({ pausedAtShow: true }), rec({}), rec({ pausedAtShow: true })])).toBe(2);
  });

  it('a line appearing while paused is stale only if it is not the subtitle on screen then', () => {
    const timeline = [
      { start: 79.5, end: 82 },
      { start: 90, end: null },
    ];
    const current = rec({ lineStart: 79.5, shownAt: 80.4, pausedAtShow: true }); // translation of the visible subtitle
    const stale = rec({ lineStart: 79.5, shownAt: 85, pausedAtShow: true }); // that subtitle ended at 82
    const open = rec({ lineStart: 90, shownAt: 95, pausedAtShow: true }); // still on screen (no end yet)
    expect(staleWhilePaused([current, open], timeline)).toBe(0);
    expect(staleWhilePaused([stale], timeline)).toBe(1);
    expect(staleWhilePaused([rec({ lineStart: 50, shownAt: 51, pausedAtShow: true })], timeline)).toBe(1); // unknown line
  });

  it('ratio of reference lines translated before they appeared', () => {
    const refs: RefLine[] = [
      { start: 10, end: 11, ko: '가' },
      { start: 20, end: 21, ko: '나' },
    ];
    const timeline = [
      { start: 10.05, translatedAt: 8 },
      { start: 20.1, translatedAt: 20.6 },
    ];
    expect(readyBeforeShown(timeline, refs)).toBe(0.5);
  });
});
