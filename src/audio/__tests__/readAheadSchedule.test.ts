import { ReadAheadSchedule } from '../readAheadSchedule';

const ids = (s: ReadAheadSchedule, t: number) => s.visibleAt(t).map(c => c.id);

describe('ReadAheadSchedule (read-ahead captions shown by video time)', () => {
  it('a caption appears at its start, not before', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'Hello there, everyone', start: 10, end: 12 });
    expect(ids(s, 9.9)).toEqual([]);
    expect(ids(s, 10)).toEqual(['a']);
  });

  it('it stays until its end (plus 0.3 s) or its reading time, whichever is later', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'long', text: 'x'.repeat(30), start: 10, end: 14 }); // 2 s reading < 4 s speech
    s.add({ id: 'short', text: 'Hi', start: 20, end: 20.4 }); // 1.5 s reading > 0.4 s speech
    expect(ids(s, 14.2)).toEqual(['long']);
    expect(ids(s, 14.3)).toEqual([]);
    expect(ids(s, 21.4)).toEqual(['short']);
    expect(ids(s, 21.5)).toEqual([]);
  });

  it('at most two lines: the newest two, oldest first', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'one', start: 10, end: 13 });
    s.add({ id: 'b', text: 'two', start: 11, end: 13 });
    s.add({ id: 'c', text: 'three', start: 12, end: 13 });
    expect(ids(s, 11.5)).toEqual(['a', 'b']);
    expect(ids(s, 12.5)).toEqual(['b', 'c']);
  });

  it('a seek back shows a caption made earlier again', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'again', start: 10, end: 12 });
    expect(ids(s, 30)).toEqual([]);
    expect(ids(s, 10.5)).toEqual(['a']);
  });

  it('an upgrade before the start is what appears; a longer one extends the reading time', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'Hi', start: 10, end: 10.4 });
    expect(s.upgrade('a', 'x'.repeat(60))).toBe(true); // 4 s reading
    expect(s.visibleAt(10)[0].text).toBe('x'.repeat(60));
    expect(ids(s, 13.9)).toEqual(['a']);
    expect(ids(s, 14)).toEqual([]);
    expect(s.upgrade('missing', 'y')).toBe(false);
  });

  it('at 2x, the reading time is real seconds (twice the video time)', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'Hi', start: 10, end: 10.4 }, 2);
    expect(ids(s, 12.9)).toEqual(['a']);
    expect(ids(s, 13)).toEqual([]);
  });

  it('clear forgets everything (another video)', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'x', start: 10, end: 12 });
    s.clear();
    expect(ids(s, 10.5)).toEqual([]);
  });

  it('keeps a bounded number of captions', () => {
    const s = new ReadAheadSchedule();
    for (let i = 0; i < 1600; i++) s.add({ id: `c${i}`, text: 'x', start: i, end: i + 1 });
    expect(s.size).toBe(1500);
    expect(ids(s, 1599.5)).toEqual(['c1599']);
  });
});

describe('ReadAheadSchedule: re-made captions and coverage (final review)', () => {
  it('a caption re-made for the same words (a seek back re-transcribed them) is not added twice', () => {
    const s = new ReadAheadSchedule();
    expect(s.add({ id: 'a', text: 'first take', start: 50, end: 53 })).toBe(true);
    expect(s.add({ id: 'b', text: 'second take', start: 50.3, end: 53.2 })).toBe(false);
    expect(s.visibleAt(51).map(c => c.id)).toEqual(['a']);
  });

  it('covering(t): a caption spans video time t (live captions for that speech are duplicates)', () => {
    const s = new ReadAheadSchedule();
    s.add({ id: 'a', text: 'x', start: 10, end: 12 });
    expect(s.covering(11)).toBe(true);
    expect(s.covering(9.6)).toBe(true); // just before it starts
    expect(s.covering(20)).toBe(false);
  });
});
