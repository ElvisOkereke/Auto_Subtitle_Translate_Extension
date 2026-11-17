import { captionDelays, captionStartOffsets, speechCovered, transcriptCer, wordsCovered, type RefLine, type ShownRecord } from '../metrics';

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

describe('captionStartOffsets: does a caption start when its words do (read-ahead target ±0.5 s)', () => {
  const ref: RefLine[] = [
    { start: 10, end: 12, ko: '안녕하세요 여러분' },
    { start: 12.5, end: 14, ko: '오늘 경기 시작합니다' },
    { start: 20, end: 22, ko: '골입니다' },
  ];

  it('offset from the earliest reference line the caption covers; share within 0.5 s', () => {
    const shown = [
      cap({ shownAt: 10.2, source: '안녕하세요 여러분 오늘 경기 시작합니다' }), // covers lines 1-2: +0.2
      cap({ shownAt: 21, source: '골입니다' }), // +1.0
    ];
    const r = captionStartOffsets(ref, shown);
    expect(r.matched).toBe(2);
    expect(r.absP50).toBeCloseTo(0.2);
    expect(r.absP90).toBeCloseTo(1.0);
    expect(r.within05).toBeCloseTo(0.5);
  });

  it('a caption early by 0.3 s counts as within', () => {
    const r = captionStartOffsets(ref, [cap({ shownAt: 19.7, source: '골입니다' })]);
    expect(r.within05).toBe(1);
  });

  it('captions matching nothing are not counted', () => {
    expect(captionStartOffsets(ref, [cap({ shownAt: 30, source: '전혀 다른 말' })]).matched).toBe(0);
  });
});

describe('wordsCovered counts captions on screen during the line, even if they appeared before it', () => {
  it('a caption that appeared 3 s before a long reference cue and is still up when it starts counts', () => {
    const ref: RefLine[] = [{ start: 20, end: 28, ko: '골입니다 정말 대단합니다' }];
    expect(wordsCovered(ref, [cap({ shownAt: 17, hiddenAt: 21, source: '골입니다 정말 대단합니다' })])).toBeCloseTo(1);
    expect(wordsCovered(ref, [cap({ shownAt: 14, hiddenAt: 17, source: '골입니다 정말 대단합니다' })])).toBe(0); // gone before the line
  });
});
