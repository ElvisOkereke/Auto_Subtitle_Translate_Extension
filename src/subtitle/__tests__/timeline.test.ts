import 'fake-indexeddb/auto';
import { Timeline, TimelineStore } from '../timeline';

describe('Timeline', () => {
  function sample() {
    const tl = new Timeline();
    tl.upsert({ start: 1, end: 3, source: '하나' });
    tl.upsert({ start: 5, end: 7, source: '둘' });
    tl.upsert({ start: 8, end: null, source: '셋' }); // still on screen
    return tl;
  }

  it('returns the line covering a time and null in gaps', () => {
    const tl = sample();
    expect(tl.at(2)?.source).toBe('하나');
    expect(tl.at(4)).toBeNull();
    expect(tl.at(6.99)?.source).toBe('둘');
    expect(tl.at(9)?.source).toBe('셋'); // open-ended line
  });

  it('starts lines with no translation and quality none', () => {
    expect(sample().at(2)).toEqual({ start: 1, end: 3, source: '하나', translation: null, quality: 'none' });
  });

  it('upgrades fast translations to better but never downgrades', () => {
    const tl = sample();
    tl.setTranslation(1, 'one (fast)', 'fast');
    expect(tl.at(2)).toMatchObject({ translation: 'one (fast)', quality: 'fast' });
    tl.setTranslation(1, 'One', 'better');
    tl.setTranslation(1, 'one (late fast)', 'fast');
    expect(tl.at(2)).toMatchObject({ translation: 'One', quality: 'better' });
  });

  it('closes an open line', () => {
    const tl = sample();
    tl.close(8, 9.5);
    expect(tl.at(9)?.source).toBe('셋');
    expect(tl.at(10)).toBeNull();
  });

  it('upsert with the same start replaces the source and keeps order', () => {
    const tl = sample();
    tl.upsert({ start: 5, end: 7.5, source: '둘!' });
    expect(tl.at(7.2)?.source).toBe('둘!');
    tl.upsert({ start: 4, end: 4.5, source: '사이' });
    expect(tl.neighbours(4, 1)).toEqual({ previous: ['하나'], next: ['둘!'] });
  });

  it('returns up to n previous and next sources in order', () => {
    expect(sample().neighbours(5, 2)).toEqual({ previous: ['하나'], next: ['셋'] });
  });
});

describe('TimelineStore', () => {
  it('round-trips a timeline per video id', async () => {
    const store = await TimelineStore.open();
    const tl = new Timeline();
    tl.upsert({ start: 1, end: 2, source: '하나' });
    tl.setTranslation(1, 'One', 'better');
    await store.save('vid1', tl);
    const loaded = await store.load('vid1');
    expect(loaded.at(1.5)).toEqual({ start: 1, end: 2, source: '하나', translation: 'One', quality: 'better' });
    expect((await store.load('other')).at(1.5)).toBeNull();
  });
});
