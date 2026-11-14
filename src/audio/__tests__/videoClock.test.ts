import { VideoClock } from '../videoClock';

describe('VideoClock', () => {
  it('maps a wall time to video time while playing, at the playback rate', () => {
    const c = VideoClock.fromEvents([
      { epochMs: 1000, type: 'play', videoTime: 10 },
      { epochMs: 3000, type: 'rate', videoTime: 12, rate: 2 },
    ]);
    expect(c.videoTimeAt(2000)).toBeCloseTo(11, 5);
    expect(c.videoTimeAt(4000)).toBeCloseTo(14, 5); // 12 + 1 s x 2
  });

  it('a pause freezes video time', () => {
    const c = VideoClock.fromEvents([
      { epochMs: 1000, type: 'play', videoTime: 10 },
      { epochMs: 2000, type: 'pause', videoTime: 11 },
    ]);
    expect(c.videoTimeAt(5000)).toBeCloseTo(11, 5);
    expect(c.paused).toBe(true);
    expect(c.pausedSince(1500)).toBe(true);
    expect(c.pausedSince(2500)).toBe(true); // still paused
  });

  it('a pause that started before a wall time and ended after it counts; one that ended before does not', () => {
    const c = VideoClock.fromEvents([
      { epochMs: 1000, type: 'play', videoTime: 10 },
      { epochMs: 2000, type: 'pause', videoTime: 11 },
      { epochMs: 3000, type: 'play', videoTime: 11 },
    ]);
    expect(c.pausedSince(2500)).toBe(true);
    expect(c.pausedSince(3500)).toBe(false);
    expect(c.videoTimeAt(3500)).toBeCloseTo(11.5, 5);
  });

  it('knows whether a seek happened after a given wall time', () => {
    const c = VideoClock.fromEvents([
      { epochMs: 1000, type: 'play', videoTime: 10 },
      { epochMs: 2000, type: 'seek', videoTime: 50 },
    ]);
    expect(c.seekedSince(1500)).toBe(true);
    expect(c.seekedSince(2500)).toBe(false);
    expect(c.videoTimeAt(1500)).toBeCloseTo(10.5, 5); // before the seek
    expect(c.videoTimeAt(3000)).toBeCloseTo(51, 5); // after it
  });

  it('ads count as paused', () => {
    const c = VideoClock.fromEvents([
      { epochMs: 1000, type: 'play', videoTime: 10 },
      { epochMs: 2000, type: 'ad-start', videoTime: 11 },
    ]);
    expect(c.paused).toBe(true);
    expect(c.pausedSince(1500)).toBe(true);
    expect(c.videoTimeAt(3000)).toBeCloseTo(11, 5);
  });

  it('unknown before the first event', () => {
    expect(VideoClock.fromEvents([{ epochMs: 1000, type: 'play', videoTime: 10 }]).videoTimeAt(500)).toBeNull();
  });
});
